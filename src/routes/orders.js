import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { ORDER_STATUS } from '../db.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { dateString, dateTimeString, id as idSchema, money, pagination, phoneString } from '../utils/schemas.js';
import { nowDateTime, today } from '../utils/time.js';
import { diff, logActivity } from '../utils/activity.js';
import { HttpError } from '../utils/httpError.js';
import { rememberAddress } from '../utils/addresses.js';
import { PARTNER_OPEN_ORDER_CAP, priceMap } from '../utils/partner.js';
import { loadSizes, normalizeSizes, replaceSizes, round2, sizeRow, sizesTotal } from '../utils/sizes.js';


// ---------- request schemas ----------

const clientNameField = z.string().trim().min(1).max(150);
const locationField = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const pickupTimeField = dateTimeString; // olib ketilish vaqti
const createSchema = z
  .object({
  // Pick an existing client (their saved name/phone are used), or give a name and phone for a new one.
  clientId: idSchema.optional(),
  clientName: clientNameField.optional(),
  clientPhone: phoneString.optional(),
  // Required for regular orders (checked in the handler); saygak orders have no address.
  location: locationField.optional(),
  landmark: z.string().trim().max(300).default(''), // orientir
  pickupTime: pickupTimeField.optional(),
  lines: z
    .array(
      z.object({
        serviceId: idSchema,
        price: money.optional(), // price per 1 kv.m; required for regular orders, ignored for saygak clients
        expectedQuantity: z.number().int().min(1).max(100000).optional(), // saygak: how many pieces they expect to bring
      }),
    )
    .min(1)
    .max(50),
  })
  .refine((o) => o.clientId || (o.clientName && o.clientPhone), 'Choose a client, or enter a name and phone number');

const pickupSchema = z.object({
  waybillNumber: z.string().trim().min(1).max(50).optional(), // nakladnoy (required for regular orders)
  deliveryTime: dateTimeString.optional(), // yetkazilish vaqti (required for regular orders)
  lines: z
    .array(z.object({ id: idSchema, quantity: z.number().int().min(1).max(100000) }))
    .min(1),
});

// Washing and packing each re-count the pieces: every line of the order, exactly once.
const countSchema = z.object({
  lines: z.array(z.object({ id: idSchema, quantity: z.number().int().min(1).max(100000), sizes: z.array(sizeRow).max(100).optional() })).min(1),
});

const deliverSchema = z.object({
  deliveredDate: dateString.optional(), // defaults to today
  paid: money.default(0), // mijozdan olingan summa
  discount: money.optional(), // chegirma (needs the orders.discount permission)
  // `sqm` is the measured amount in the line's unit (kv.m or metr). Not needed for per-piece (dona) lines.
  lines: z.array(z.object({ id: idSchema, sqm: z.number().positive().max(1e6).optional() })).min(1),
});

const editSchema = z
  .object({
    clientName: clientNameField,
    clientPhone: phoneString,
    location: locationField,
    landmark: createSchema.shape.landmark.unwrap(),
    pickupTime: pickupTimeField,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const cancelSchema = z.object({ reason: z.string().trim().min(1).max(300) });

const paymentSchema = z
  .object({
    amount: money.default(0),
    discount: money.default(0), // chegirma: written off instead of paid
    paidDate: dateString.optional(), // defaults to today
  })
  .refine((o) => o.amount + o.discount > 0, 'Enter an amount, a discount, or both');

const listQuery = pagination.extend({ search: z.string().trim().max(100).optional() });
const params = z.object({ docNum: idSchema });

// ---------- helpers ----------

/**
 * Create a saygak (partner) order: prices come from client_prices, no address, no pickup time.
 * `user` is the staff member or the saygak's own user row. The open-order cap is checked in the same transaction as the insert.
 * Returns the new docNum.
 */
export function createPartnerOrder(db, user, client, { lines, via = 'partner' }) {
  return db.transaction(() => {
    if (!client?.isPartner) throw badRequest('Client is not a saygak');
    const open = db
      .prepare("SELECT COUNT(*) c FROM orders WHERE kind = 'partner' AND clientId = ? AND status = ?")
      .get(client.id, ORDER_STATUS.RECEIVED).c;
    if (open >= PARTNER_OPEN_ORDER_CAP) {
      throw conflict(`Saygak already has ${PARTNER_OPEN_ORDER_CAP} open orders; wait until some are picked up`);
    }
    const prices = priceMap(db, client.id);
    const getSvc = db.prepare('SELECT id, name, unit FROM services WHERE id = ? AND isActive = 1');
    const resolved = lines.map((l, i) => {
      const svc = getSvc.get(l.serviceId);
      if (!svc) throw badRequest('Unknown or inactive service', { path: `lines.${i}.serviceId` });
      const price = prices.get(l.serviceId);
      if (price === undefined) throw badRequest('No price set for this service', { path: `lines.${i}.serviceId` });
      return { serviceId: svc.id, serviceName: svc.name, unit: svc.unit, price, expectedQuantity: l.expectedQuantity ?? 0 };
    });
    const now = nowDateTime();
    const info = db
      .prepare(
        `INSERT INTO orders (kind, status, clientId, clientName, clientPhone, latitude, longitude, landmark, pickupPlannedAt,
                             createdById, createdByName, createdAt, orderTakenAt)
         VALUES ('partner', ?, ?, ?, ?, 0, 0, '', ?, ?, ?, ?, ?)`,
      )
      .run(ORDER_STATUS.RECEIVED, client.id, client.name, client.phone, now, user.id, user.fullName, today(), now);
    const insertLine = db.prepare(
      `INSERT INTO order_lines (docNum, serviceId, serviceName, unit, price, customerPrice, expectedQuantity) VALUES (?,?,?,?,?,?,?)`,
    );
    for (const l of resolved) insertLine.run(info.lastInsertRowid, l.serviceId, l.serviceName, l.unit, l.price, l.price, l.expectedQuantity);
    logActivity(db, user, 'order', info.lastInsertRowid, 'order.created', {
      client: client.name,
      phone: client.phone,
      clientId: client.id,
      partner: true,
      via,
      prices: resolved.map((l) => ({ serviceId: l.serviceId, price: l.price })),
      services: resolved.map((l) => `${l.serviceName} (${l.price}/${l.unit})`),
    });
    return info.lastInsertRowid;
  })();
}

export function orderRouter(db) {
  const router = Router();

  const getOrder = db.prepare('SELECT * FROM orders WHERE docNum = ?');
  const getLines = db.prepare('SELECT * FROM order_lines WHERE docNum = ? ORDER BY id');
  const findClient = db.prepare('SELECT id FROM clients WHERE phone = ?');
  const insertClient = db.prepare('INSERT INTO clients (name, phone, createdAt) VALUES (?,?,?)');
  // One client per phone number: reuse the record if this phone was seen before.
  const clientIdFor = (name, phone, user) => {
    const existing = findClient.get(phone)?.id;
    if (existing) return existing;
    const id = insertClient.run(name, phone, nowDateTime()).lastInsertRowid;
    logActivity(db, user, 'client', id, 'client.created', { name, phone, via: 'order' });
    return id;
  };

  const insertPayment = (docNum, amount, paidDate, user, discount = 0) =>
    db
      .prepare(
        `INSERT INTO payments (docNum, amount, discount, paidDate, createdAt, creatorId, creatorName) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(docNum, amount, discount, paidDate, nowDateTime(), user.id, user.fullName);

  const needDiscountPerm = (user) => {
    if (!user.permissions.includes('orders.discount')) throw new HttpError(403, 'You are not allowed to give discounts');
  };

  const getService = db.prepare('SELECT id, name, unit FROM services WHERE id = ? AND isActive = 1');

  const presentLine = (l, sizes = []) => ({
    id: l.id,
    expectedQuantity: l.expectedQuantity,
    serviceId: l.serviceId,
    serviceName: l.serviceName,
    status: l.status,
    unit: l.unit,
    price: l.price,
    customerPrice: l.customerPrice, // per-kv.m price actually charged (defaults to price; for discounts)
    quantity: l.quantity, // what the client is charged for (the packed count once packed)
    pickedQuantity: l.pickedQuantity,
    washedQuantity: l.washedQuantity,
    sqm: l.sqm,
    lineTotal: l.lineTotal,
    currency: l.currency,
    sizes,
    sizesTotal: sizesTotal(sizes),
  });

  const presentOrder = (o, lines, sizeMap = new Map()) => ({
    docNum: o.docNum,
    kind: o.kind,
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
    discount: o.discount,
    paid: o.paid,
    debt: Math.max(round2(o.docTotal - o.discount - o.paid), 0),
    docRate: o.docRate,
    createdAt: o.createdAt,
    orderTakenAt: o.orderTakenAt,
    deliveryTime: o.deliveryTime,
    pickedUpAt: o.pickedUpAt,
    washedAt: o.washedAt,
    packedAt: o.packedAt,
    deliveredDate: o.deliveredDate,
    deliveredAt: o.deliveredAt,
    waybillNumber: o.waybillNumber,
    pickedUpBy: o.pickedUpByName,
    washedBy: o.washedByName,
    packedBy: o.packedByName,
    deliveredBy: o.deliveredByName,
    cancelReason: o.cancelReason,
    cancelledAt: o.cancelledAt,
    lines: lines.map((l) => presentLine(l, sizeMap.get(l.id) ?? [])),
  });

  const loadOrder = (docNum) => {
    const o = getOrder.get(docNum);
    return o ? presentOrder(o, getLines.all(docNum), loadSizes(db, [docNum])) : null;
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
    const sizeMap = loadSizes(db, orders.map((o) => o.docNum));
    res.json({
      data: orders.map((o) => presentOrder(o, byDoc.get(o.docNum), sizeMap)),
      meta: { page, limit, total },
    });
  };

  // ---------- 1.1 Olingan zakazlar ----------

  router.get('/received', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.RECEIVED));

  router.post('/', requirePerm('orders.create'), validate(createSchema), (req, res) => {
    const b = req.valid.body;
    const now = nowDateTime();

    const docNum = db.transaction(() => {
      let client;
      if (b.clientId) {
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(b.clientId);
        if (!client) throw badRequest('Unknown client', { path: 'clientId' });
      } else {
        const id = clientIdFor(b.clientName, b.clientPhone, req.user);
        client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
      }
      // the server decides the kind from the client; typed prices are ignored for saygak clients
      if (client.isPartner) {
        return createPartnerOrder(db, req.user, client, { lines: b.lines, via: 'staff' });
      }

      if (!b.location) throw badRequest('Location is required', { path: 'location' });
      if (!b.pickupTime) throw badRequest('Pickup time is required', { path: 'pickupTime' });
      const lines = b.lines.map((l, i) => {
        const svc = getService.get(l.serviceId);
        if (!svc) throw badRequest(`Unknown or inactive service`, { path: `lines.${i}.serviceId` });
        if (l.price === undefined) throw badRequest('Price is required', { path: `lines.${i}.price` });
        return { ...l, serviceName: svc.name, unit: svc.unit };
      });
      // a typed name/phone is kept on the order as typed (the client record keeps its own)
      const clientId = client.id;
      const clientName = b.clientId ? client.name : b.clientName;
      const clientPhone = b.clientId ? client.phone : b.clientPhone;
      rememberAddress(db, clientId, b.location, b.landmark);
      const info = db
        .prepare(
          `INSERT INTO orders (status, clientId, clientName, clientPhone, latitude, longitude, landmark, pickupPlannedAt,
                               createdById, createdByName, createdAt, orderTakenAt)
           VALUES (@status, @clientId, @clientName, @clientPhone, @latitude, @longitude, @landmark, @pickupTime,
                   @userId, @userName, @createdAt, @now)`,
        )
        .run({
          status: ORDER_STATUS.RECEIVED,
          clientId,
          clientName,
          clientPhone,
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
        `INSERT INTO order_lines (docNum, serviceId, serviceName, unit, price, customerPrice) VALUES (?,?,?,?,?,?)`,
      );
      for (const l of lines) insertLine.run(info.lastInsertRowid, l.serviceId, l.serviceName, l.unit, l.price, l.price);
      logActivity(db, req.user, 'order', info.lastInsertRowid, 'order.created', {
        client: clientName,
        phone: clientPhone,
        clientId,
        services: lines.map((l) => `${l.serviceName} (${l.price}/${l.unit})`),
      });
      return info.lastInsertRowid;
    })();

    res.status(201).json(loadOrder(docNum));
  });

  // Driver picked the laundry up: waybill no., planned delivery time, item counts.
  router.patch('/:docNum/pickup', requirePerm('orders.pickup'), validate(params, 'params'), validate(pickupSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;

    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.RECEIVED) {
        throw conflict(`Order is "${order.status}", expected "${ORDER_STATUS.RECEIVED}"`);
      }
      if (order.kind !== 'partner' && (!b.waybillNumber || !b.deliveryTime)) {
        throw badRequest('waybillNumber and deliveryTime are required', { path: b.waybillNumber ? 'deliveryTime' : 'waybillNumber' });
      }
      const waybill = b.waybillNumber ?? '';
      const planned = b.deliveryTime ?? '';
      assertAllLines(docNum, b.lines);
      const setQty = db.prepare('UPDATE order_lines SET quantity = ?, pickedQuantity = ? WHERE id = ? AND docNum = ?');
      for (const l of b.lines) setQty.run(l.quantity, l.quantity, l.id, docNum);
      db.prepare(
        `UPDATE orders SET status = ?, waybillNumber = ?, deliveryTime = ?, pickedUpAt = ?,
                           pickedUpById = ?, pickedUpByName = ? WHERE docNum = ?`,
      ).run(ORDER_STATUS.PICKED_UP, waybill, planned, nowDateTime(), req.user.id, req.user.fullName, docNum);
      logActivity(db, req.user, 'order', docNum, 'order.pickedup', {
        from: order.status, to: ORDER_STATUS.PICKED_UP, waybill, deliveryTime: planned,
        quantities: b.lines.length ? b.lines.map((l) => l.quantity) : [],
      });
    })();

    res.json(loadOrder(docNum));
  });

  // ---------- 1.2 Olib ketildi ----------

  router.get('/picked-up', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.PICKED_UP));

  // ---------- washed -> packed (workshop steps between pickup and delivery) ----------

  router.get('/washed', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.WASHED));
  router.get('/packed', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.PACKED));

  /**
   * Move an order one step forward in the workshop (`from` -> `to`) with a fresh count of the pieces:
   * stamps who did it and when, and lets `column` store each line's count.
   */
  const step = (from, to, cols, column, action) => (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== from) throw conflict(`Order is "${order.status}", expected "${from}"`);
      assertAllLines(docNum, b.lines);
      const before = new Map(getLines.all(docNum).map((l) => [l.id, l]));
      const set = db.prepare(`UPDATE order_lines SET ${column} = ? WHERE id = ? AND docNum = ?`);
      const oldSizes = loadSizes(db, [docNum]);
      const sizeLog = new Map();
      for (const l of b.lines) {
        set.run(l.quantity, l.id, docNum);
        if (l.sizes === undefined) continue;
        if (before.get(l.id).unit !== 'kv.m') throw badRequest('Sizes are only for kv.m services', { lineId: l.id });
        const rows = normalizeSizes(l.sizes);
        sizeLog.set(l.id, { from: oldSizes.get(l.id) ?? [], to: rows });
        replaceSizes(db, l.id, rows);
      }
      db.prepare(`UPDATE orders SET status = ?, ${cols.at} = ?, ${cols.byId} = ?, ${cols.byName} = ? WHERE docNum = ?`).run(
        to,
        nowDateTime(),
        req.user.id,
        req.user.fullName,
        docNum,
      );
      logActivity(db, req.user, 'order', docNum, action, {
        from,
        to,
        counts: b.lines.map((l) => {
          const old = before.get(l.id);
          const entry = column === 'quantity'
            ? { service: old.serviceName, picked: old.pickedQuantity, washed: old.washedQuantity, packed: l.quantity }
            : { service: old.serviceName, picked: old.pickedQuantity, washed: l.quantity };
          if (sizeLog.has(l.id)) entry.sizes = sizeLog.get(l.id);
          return entry;
        }),
      });
    })();
    res.json(loadOrder(docNum));
  };

  // Laundry finished washing: re-count the pieces (kept separately as washedQuantity).
  router.patch(
    '/:docNum/wash',
    requirePerm('orders.wash'),
    validate(params, 'params'),
    validate(countSchema),
    step(ORDER_STATUS.PICKED_UP, ORDER_STATUS.WASHED, { at: 'washedAt', byId: 'washedById', byName: 'washedByName' }, 'washedQuantity', 'order.washed'),
  );
  // Packed and ready for the driver: this count becomes the quantity the client pays for.
  router.patch(
    '/:docNum/pack',
    requirePerm('orders.pack'),
    validate(params, 'params'),
    validate(countSchema),
    step(ORDER_STATUS.WASHED, ORDER_STATUS.PACKED, { at: 'packedAt', byId: 'packedById', byName: 'packedByName' }, 'quantity', 'order.packed'),
  );

  // Delivered: real kv.m per line -> docTotal = sum(kv.m * price).
  router.patch('/:docNum/deliver', requirePerm('orders.deliver'), validate(params, 'params'), validate(deliverSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;

    const deliveredDate = b.deliveredDate ?? today();
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.PACKED) {
        throw conflict(`Order is "${order.status}", expected "${ORDER_STATUS.PACKED}"`);
      }
      assertAllLines(docNum, b.lines);
      const discount = b.discount ?? 0;
      if (order.kind === 'partner' && (b.paid > 0 || discount > 0)) {
        throw badRequest('Saygak orders take no money at handover', { path: b.paid > 0 ? 'paid' : 'discount' });
      }
      if (discount > 0) needDiscountPerm(req.user);

      const existing = new Map(getLines.all(docNum).map((l) => [l.id, l]));
      const setLine = db.prepare(
        `UPDATE order_lines SET sqm = ?, lineTotal = ?, status = 'Closed' WHERE id = ? AND docNum = ?`,
      );
      let docTotal = 0;
      const sizeMap = loadSizes(db, [docNum]);
      const logLines = [];
      for (const l of b.lines) {
        const line = existing.get(l.id);
        // per-piece lines are charged by the counted pieces; the others need a measured amount
        const amount = line.unit === 'dona' ? line.quantity : l.sqm;
        if (!amount) throw badRequest(`Enter the measured amount (${line.unit}) for "${line.serviceName}"`, { lineId: l.id });
        const lineTotal = round2(amount * line.price);
        docTotal += lineTotal;
        setLine.run(amount, lineTotal, l.id, docNum);
        if (line.unit === 'kv.m') logLines.push({ service: line.serviceName, sizesTotal: sizesTotal(sizeMap.get(l.id) ?? []), sqm: amount });
      }
      if (discount > round2(docTotal)) throw badRequest('Discount cannot be more than the order total');
      db.prepare(
        `UPDATE orders SET status = ?, docStatus = 'Closed', docTotal = ?, discount = ?, paid = ?,
                           deliveredDate = ?, deliveredAt = ?,
                           deliveredById = ?, deliveredByName = ? WHERE docNum = ?`,
      ).run(
        ORDER_STATUS.DELIVERED,
        round2(docTotal),
        discount,
        b.paid,
        deliveredDate,
        nowDateTime(),
        req.user.id,
        req.user.fullName,
        docNum,
      );
      if (b.paid > 0 && order.kind !== 'partner') insertPayment(docNum, b.paid, deliveredDate, req.user, discount);
      logActivity(db, req.user, 'order', docNum, 'order.delivered', {
        from: order.status, to: ORDER_STATUS.DELIVERED, docTotal: round2(docTotal), discount, paid: b.paid,
        debt: Math.max(round2(docTotal - discount - b.paid), 0), deliveredDate, lines: logLines,
      });
    })();

    res.json(loadOrder(docNum));
  });

  // ---------- 1.3 Tugallangan sotuvlar (read only) ----------

  router.get('/completed', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.DELIVERED));

  // ---------- cancel / edit / debt payments ----------

  router.get('/cancelled', validate(listQuery, 'query'), listByStatus(ORDER_STATUS.CANCELLED));

  // Fix a typo in client / location / pickup time. Only while nobody has picked the order up yet.
  router.patch('/:docNum', requirePerm('orders.edit'), validate(params, 'params'), validate(editSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const b = req.valid.body;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.status !== ORDER_STATUS.RECEIVED) {
        throw conflict(`Only "${ORDER_STATUS.RECEIVED}" orders can be edited`);
      }
      if (order.kind === 'partner' && b.location) throw conflict('Saygak orders have no address');
      const name = b.clientName ?? order.clientName;
      const phone = b.clientPhone ?? order.clientPhone;
      const next = {
        clientName: name, clientPhone: phone,
        latitude: b.location?.latitude ?? order.latitude, longitude: b.location?.longitude ?? order.longitude,
        landmark: b.landmark ?? order.landmark, pickupPlannedAt: b.pickupTime ?? order.pickupPlannedAt,
      };
      logActivity(db, req.user, 'order', docNum, 'order.edited', {
        changes: diff(order, next, ['clientName', 'clientPhone', 'latitude', 'longitude', 'landmark', 'pickupPlannedAt']),
      });
      const clientId = clientIdFor(name, phone, req.user);
      if (b.location) rememberAddress(db, clientId, b.location, b.landmark ?? order.landmark);
      db.prepare(
        `UPDATE orders SET clientId = ?, clientName = ?, clientPhone = ?, latitude = ?, longitude = ?,
                           landmark = ?, pickupPlannedAt = ? WHERE docNum = ?`,
      ).run(
        clientId,
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

  router.post('/:docNum/cancel', requirePerm('orders.edit'), validate(params, 'params'), validate(cancelSchema), (req, res) => {
    const { docNum } = req.valid.params;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (![ORDER_STATUS.RECEIVED, ORDER_STATUS.PICKED_UP, ORDER_STATUS.WASHED, ORDER_STATUS.PACKED].includes(order.status)) {
        throw conflict(`Order is "${order.status}" and cannot be cancelled`);
      }
      db.prepare(
        `UPDATE orders SET status = ?, docStatus = 'Closed', cancelReason = ?, cancelledAt = ? WHERE docNum = ?`,
      ).run(ORDER_STATUS.CANCELLED, req.valid.body.reason, nowDateTime(), docNum);
      db.prepare(`UPDATE order_lines SET status = 'Closed' WHERE docNum = ?`).run(docNum);
      logActivity(db, req.user, 'order', docNum, 'order.cancelled', { from: order.status, to: ORDER_STATUS.CANCELLED, reason: req.valid.body.reason });
    })();
    res.json(loadOrder(docNum));
  });

  // Client pays (part of) the debt of an already delivered order, and/or is given a discount on it.
  router.post('/:docNum/payments', requirePerm('orders.payments'), validate(params, 'params'), validate(paymentSchema), (req, res) => {
    const { docNum } = req.valid.params;
    const { amount, discount, paidDate } = req.valid.body;
    db.transaction(() => {
      const order = getOrder.get(docNum);
      if (!order) throw notFound('Order not found');
      if (order.kind === 'partner') throw conflict('Saygak orders are paid from the client page');
      if (order.status !== ORDER_STATUS.DELIVERED) throw conflict('Payments are only for delivered orders');
      if (discount > 0) needDiscountPerm(req.user);
      const debt = round2(order.docTotal - order.discount - order.paid);
      if (discount > debt) throw badRequest(`Discount is more than the debt (${debt})`);
      if (amount > round2(debt - discount)) throw badRequest(`Amount is more than the debt left after the discount (${round2(debt - discount)})`);
      const date = paidDate ?? today();
      if (amount > 0) insertPayment(docNum, amount, date, req.user, discount);
      db.prepare('UPDATE orders SET paid = ?, discount = ? WHERE docNum = ?').run(
        round2(order.paid + amount),
        round2(order.discount + discount),
        docNum,
      );
      logActivity(db, req.user, 'order', docNum, 'order.payment', {
        amount, discount, paidDate: date, debtLeft: round2(debt - discount - amount),
      });
    })();
    res.status(201).json(loadOrder(docNum));
  });

  // Everything that happened to an order, oldest first.
  router.get('/:docNum/history', validate(params, 'params'), (req, res) => {
    const { docNum } = req.valid.params;
    if (!getOrder.get(docNum)) throw notFound('Order not found');
    const rows = db
      .prepare("SELECT * FROM activity_log WHERE entity = 'order' AND entityId = ? ORDER BY id")
      .all(String(docNum));
    res.json({ data: rows.map((r) => ({ id: r.id, at: r.at, userId: r.userId, userName: r.userName, action: r.action, details: JSON.parse(r.details) })) });
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
