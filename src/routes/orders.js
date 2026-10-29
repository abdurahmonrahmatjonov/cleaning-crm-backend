import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { ORDER_STATUS } from '../db.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { dateString, dateTimeString, id as idSchema, money, pagination, phoneString } from '../utils/schemas.js';
import { nowDateTime, today } from '../utils/time.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------- request schemas ----------

const createSchema = z.object({
  clientName: z.string().trim().min(1).max(150),
  clientPhone: phoneString,
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  landmark: z.string().trim().max(300).default(''), // orientir
  pickupTime: dateTimeString, // olib ketilish vaqti
  lines: z
    .array(
      z.object({
        serviceId: idSchema,
        price: money, // price per 1 kv.m
      }),
    )
    .min(1)
    .max(50),
});

const pickupSchema = z.object({
  waybillNumber: z.string().trim().min(1).max(50), // nakladnoy
  deliveryTime: dateTimeString, // yetkazilish vaqti
  lines: z
    .array(z.object({ id: idSchema, quantity: z.number().int().min(1).max(100000) }))
    .min(1),
});

const deliverSchema = z.object({
  deliveredDate: dateString.optional(), // defaults to today
  paid: money, // mijozdan olingan summa
  lines: z.array(z.object({ id: idSchema, sqm: z.number().positive().max(1e6) })).min(1),
});

const editSchema = z
  .object({
    clientName: createSchema.shape.clientName,
    clientPhone: createSchema.shape.clientPhone,
    location: createSchema.shape.location,
    landmark: createSchema.shape.landmark.unwrap(),
    pickupTime: createSchema.shape.pickupTime,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const cancelSchema = z.object({ reason: z.string().trim().min(1).max(300) });

const paymentSchema = z.object({
  amount: z.number().positive().max(1e12),
  paidDate: dateString.optional(), // defaults to today
});

const listQuery = pagination.extend({ search: z.string().trim().max(100).optional() });
const params = z.object({ docNum: idSchema });

// ---------- helpers ----------

export function orderRouter(db) {
  const router = Router();

  const getOrder = db.prepare('SELECT * FROM orders WHERE docNum = ?');
  const getLines = db.prepare('SELECT * FROM order_lines WHERE docNum = ? ORDER BY id');
  const findClient = db.prepare('SELECT id FROM clients WHERE phone = ?');
  const insertClient = db.prepare('INSERT INTO clients (name, phone, createdAt) VALUES (?,?,?)');
  // One client per phone number: reuse the record if this phone was seen before.
  const clientIdFor = (name, phone) =>
    findClient.get(phone)?.id ?? insertClient.run(name, phone, nowDateTime()).lastInsertRowid;

  const insertPayment = (docNum, amount, paidDate, user) =>
    db
      .prepare(
        `INSERT INTO payments (docNum, amount, paidDate, createdAt, creatorId, creatorName) VALUES (?,?,?,?,?,?)`,
      )
      .run(docNum, amount, paidDate, nowDateTime(), user.id, user.fullName);

  const getService = db.prepare('SELECT id, name FROM services WHERE id = ? AND isActive = 1');

  const presentLine = (l) => ({
    id: l.id,
    serviceId: l.serviceId,
    serviceName: l.serviceName,
    status: l.status,
    price: l.price,
    customerPrice: l.customerPrice, // per-kv.m price actually charged (defaults to price; for discounts)
    quantity: l.quantity,
    sqm: l.sqm,
    lineTotal: l.lineTotal,
    currency: l.currency,
  });

  const presentOrder = (o, lines) => ({
    docNum: o.docNum,
    status: o.status,
    docStatus: o.docStatus,
    clientId: o.clientId,
    clientName: o.clientName,
    clientPhone: o.clientPhone,
    location: { latitude: o.latitude, longitude: o.longitude },
    landmark: o.landmark,
    pickupTime: o.pickupPlannedAt,
    createdBy: { id: o.createdById, name: o.createdByName },
    docTotal: o.docTotal,
    paid: o.paid,
    debt: Math.max(round2(o.docTotal - o.paid), 0),
    docRate: o.docRate,
    createdAt: o.createdAt,
    orderTakenAt: o.orderTakenAt,
    deliveryTime: o.deliveryTime,
    pickedUpAt: o.pickedUpAt,
    deliveredDate: o.deliveredDate,
    deliveredAt: o.deliveredAt,
    waybillNumber: o.waybillNumber,
    pickedUpBy: o.pickedUpByName,
    deliveredBy: o.deliveredByName,
    cancelReason: o.cancelReason,
    cancelledAt: o.cancelledAt,
    lines: lines.map(presentLine),
  });

  const loadOrder = (docNum) => {
    const o = getOrder.get(docNum);
    return o ? presentOrder(o, getLines.all(docNum)) : null;
  };

  /** Make sure `given` ids are exactly the order's line ids: no missing, extra or duplicate. */
  const assertAllLines = (docNum, given) => {
    const existing = getLines.all(docNum).map((l) => l.id);
    const ids = given.map((l) => l.id);
    const unique = new Set(ids);
    if (
      unique.size !== ids.length ||
      ids.length !== existing.length ||
      !existing.every((x) => unique.has(x))
    ) {
      throw badRequest('lines must contain every line of this order exactly once', { expectedLineIds: existing });
    }
  };

  const listByStatus = (status) => (req, res) => {
    const { page, limit, search } = req.valid.query;
    const where = ['status = @status'];
    const args = { status, limit, offset: (page - 1) * limit };
    if (search) {
      where.push(`(clientName LIKE @q ESCAPE '\\' OR clientPhone LIKE @q ESCAPE '\\' OR CAST(docNum AS TEXT) = @exact)`);
      args.q = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      args.exact = search;
    }
    const w = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM orders WHERE ${w}`).get(args).c;
    const orders = db
      .prepare(`SELECT * FROM orders WHERE ${w} ORDER BY docNum DESC LIMIT @limit OFFSET @offset`)
      .all(args);

    // one query for all lines of the page instead of one per order
    const byDoc = new Map(orders.map((o) => [o.docNum, []]));
    if (orders.length) {
      const marks = orders.map(() => '?').join(',');
      for (const l of db
        .prepare(`SELECT * FROM order_lines WHERE docNum IN (${marks}) ORDER BY id`)
        .all(...orders.map((o) => o.docNum))) {
        byDoc.get(l.docNum).push(l);
      }
    }
    res.json({
      data: orders.map((o) => presentOrder(o, byDoc.get(o.docNum))),
      meta: { page, limit, total },
    });
  };

  // ---------- 1.1 Olingan zakazlar ----------

  router.get('/received', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.RECEIVED));

  router.post('/', requireRole('admin', 'operator'), validate(createSchema), (req, res) => {
    const b = req.valid.body;
    const now = nowDateTime();

    const docNum = db.transaction(() => {
      // resolve services first so a bad id fails the whole request
      const lines = b.lines.map((l, i) => {
        const svc = getService.get(l.serviceId);
        if (!svc) throw badRequest(`Unknown or inactive service`, { path: `lines.${i}.serviceId` });
        return { ...l, serviceName: svc.name };
      });
      const info = db
        .prepare(
          `INSERT INTO orders (status, clientId, clientName, clientPhone, latitude, longitude, landmark, pickupPlannedAt,
                               createdById, createdByName, createdAt, orderTakenAt)
           VALUES (@status, @clientId, @clientName, @clientPhone, @latitude, @longitude, @landmark, @pickupTime,
                   @userId, @userName, @createdAt, @now)`,
        )
        .run({
          status: ORDER_STATUS.RECEIVED,
          clientId: clientIdFor(b.clientName, b.clientPhone),
          clientName: b.clientName,
          clientPhone: b.clientPhone,
          latitude: b.location.latitude,
          longitude: b.location.longitude,
          landmark: b.landmark,
          pickupTime: b.pickupTime,
          userId: req.user.id,
          userName: req.user.fullName,
          createdAt: today(),
          now,
        });
      const insertLine = db.prepare(
        `INSERT INTO order_lines (docNum, serviceId, serviceName, price, customerPrice) VALUES (?,?,?,?,?)`,
      );
      for (const l of lines) insertLine.run(info.lastInsertRowid, l.serviceId, l.serviceName, l.price, l.price);
      return info.lastInsertRowid;
    })();

    res.status(201).json(loadOrder(docNum));
  });

  // Driver picked the laundry up: waybill no., planned delivery time, item counts.
  router.patch('/:docNum/pickup', validate(params, 'params'), validate(pickupSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;

    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.RECEIVED) {
        throw conflict(`Order is "${order.status}", expected "${ORDER_STATUS.RECEIVED}"`);
      }
      assertAllLines(docNum, b.lines);
      const setQty = db.prepare('UPDATE order_lines SET quantity = ? WHERE id = ? AND docNum = ?');
      for (const l of b.lines) setQty.run(l.quantity, l.id, docNum);
      db.prepare(
        `UPDATE orders SET status = ?, waybillNumber = ?, deliveryTime = ?, pickedUpAt = ?,
                           pickedUpById = ?, pickedUpByName = ? WHERE docNum = ?`,
      ).run(ORDER_STATUS.PICKED_UP, b.waybillNumber, b.deliveryTime, nowDateTime(), req.user.id, req.user.fullName, docNum);
    })();

    res.json(loadOrder(docNum));
  });

  // ---------- 1.2 Olib ketildi ----------

  router.get('/picked-up', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.PICKED_UP));

  // Delivered: real kv.m per line -> docTotal = sum(kv.m * price).
  router.patch('/:docNum/deliver', validate(params, 'params'), validate(deliverSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;

    const deliveredDate = b.deliveredDate ?? today();
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.PICKED_UP) {
        throw conflict(`Order is "${order.status}", expected "${ORDER_STATUS.PICKED_UP}"`);
      }
      assertAllLines(docNum, b.lines);

      const prices = new Map(getLines.all(docNum).map((l) => [l.id, l.price]));
      const setLine = db.prepare(
        `UPDATE order_lines SET sqm = ?, lineTotal = ?, status = 'Closed' WHERE id = ? AND docNum = ?`,
      );
      let docTotal = 0;
      for (const l of b.lines) {
        const lineTotal = round2(l.sqm * prices.get(l.id));
        docTotal += lineTotal;
        setLine.run(l.sqm, lineTotal, l.id, docNum);
      }
      db.prepare(
        `UPDATE orders SET status = ?, docStatus = 'Closed', docTotal = ?, paid = ?,
                           deliveredDate = ?, deliveredAt = ?,
                           deliveredById = ?, deliveredByName = ? WHERE docNum = ?`,
      ).run(
        ORDER_STATUS.DELIVERED,
        round2(docTotal),
        b.paid,
        deliveredDate,
        nowDateTime(),
        req.user.id,
        req.user.fullName,
        docNum,
      );
      if (b.paid > 0) insertPayment(docNum, b.paid, deliveredDate, req.user);
    })();

    res.json(loadOrder(docNum));
  });

  // ---------- 1.3 Tugallangan sotuvlar (read only) ----------

  router.get('/completed', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.DELIVERED));

  // ---------- cancel / edit / debt payments ----------

  router.get('/cancelled', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.CANCELLED));

  // Fix a typo in client / location / pickup time. Only while nobody has picked the order up yet.
  router.patch('/:docNum', requireRole('admin', 'operator'), validate(params, 'params'), validate(editSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.RECEIVED) {
        throw conflict(`Only "${ORDER_STATUS.RECEIVED}" orders can be edited`);
      }
      const name = b.clientName ?? order.clientName;
      const phone = b.clientPhone ?? order.clientPhone;
      db.prepare(
        `UPDATE orders SET clientId = ?, clientName = ?, clientPhone = ?, latitude = ?, longitude = ?,
                           landmark = ?, pickupPlannedAt = ? WHERE docNum = ?`,
      ).run(
        clientIdFor(name, phone),
        name,
        phone,
        b.location?.latitude ?? order.latitude,
        b.location?.longitude ?? order.longitude,
        b.landmark ?? order.landmark,
        b.pickupTime ?? order.pickupPlannedAt,
        docNum,
      );
    })();
    res.json(loadOrder(docNum));
  });

  router.post('/:docNum/cancel', requireRole('admin', 'operator'), validate(params, 'params'), validate(cancelSchema), (req, res) => {
    const { docNum } = req.valid.params;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (![ORDER_STATUS.RECEIVED, ORDER_STATUS.PICKED_UP].includes(order.status)) {
        throw conflict(`Order is "${order.status}" and cannot be cancelled`);
      }
      db.prepare(
        `UPDATE orders SET status = ?, docStatus = 'Closed', cancelReason = ?, cancelledAt = ? WHERE docNum = ?`,
      ).run(ORDER_STATUS.CANCELLED, req.valid.body.reason, nowDateTime(), docNum);
      db.prepare(`UPDATE order_lines SET status = 'Closed' WHERE docNum = ?`).run(docNum);
    })();
    res.json(loadOrder(docNum));
  });

  // Client pays (part of) the debt of an already delivered order.
  router.post('/:docNum/payments', requireRole('admin', 'operator'), validate(params, 'params'), validate(paymentSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const { amount, paidDate } = req.valid.body;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.DELIVERED) throw conflict('Payments are only for delivered orders');
      const debt = round2(order.docTotal - order.paid);
      if (amount > debt) throw badRequest(`Amount is more than the debt (${debt})`);
      insertPayment(docNum, amount, paidDate ?? today(), req.user);
      db.prepare('UPDATE orders SET paid = ? WHERE docNum = ?').run(round2(order.paid + amount), docNum);
    })();
    res.status(201).json(loadOrder(docNum));
  });

  router.get('/:docNum/payments', validate(params, 'params'), (req, res) => {
    const { docNum } = req.valid.params;
    if (!getOrder.get(docNum)) throw notFound('Order not found');
    res.json({ data: db.prepare('SELECT * FROM payments WHERE docNum = ? ORDER BY id').all(docNum) });
  });

  // Single order, any status (needed to open an order and edit it).
  router.get('/:docNum', validate(params, 'params'), (req, res) => {
    const order = loadOrder(req.valid.params.docNum);
    if (!order) throw notFound('Order not found');
    res.json(order);
  });

  return router;
}
