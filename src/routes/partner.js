import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { ORDER_STATUS } from '../db.js';
import { conflict, notFound, badRequest } from '../utils/httpError.js';
import { id as idSchema, pagination } from '../utils/schemas.js';
import { today, nowDateTime } from '../utils/time.js';
import { logActivity, diff } from '../utils/activity.js';
import { createPartnerOrder } from './orders.js';
import { buildStatement, MONTH_RE } from '../utils/statement.js';
import { priceMap, PARTNER_OPEN_ORDER_CAP } from '../utils/partner.js';
import { loadSizes, round2, sizesTotal } from '../utils/sizes.js';

const qty = z.number().int().min(1).max(100000);
const editQty = z.number().int().min(0).max(100000); // 0 = clear ("not given")
const createSchema = z
  .object({
    lines: z
      .array(z.object({ serviceId: idSchema, expectedQuantity: qty.optional() }).strip())
      .min(1)
      .max(20),
  })
  .strip()
  .refine((o) => new Set(o.lines.map((l) => l.serviceId)).size === o.lines.length, 'Each service may appear only once');
const editSchema = z
  .object({ lines: z.array(z.object({ id: idSchema, expectedQuantity: editQty }).strip()).min(1).max(20) })
  .strip()
  .refine((o) => new Set(o.lines.map((l) => l.id)).size === o.lines.length, 'Duplicate line ids');
const cancelSchema = z.object({ reason: z.string().trim().min(1).max(300) }).strip();
const listQuery = pagination.extend({ status: z.enum(Object.values(ORDER_STATUS)).optional() });
const params = z.object({ docNum: idSchema });
const statementQuery = z.object({ month: z.string().regex(MONTH_RE, 'Expected YYYY-MM').optional() });

/** What a delivered order still owes, never negative (overpaying one order does not offset another). */
const orderDebt = (o) => Math.max(round2(o.docTotal - o.discount - o.paid), 0);

/**
 * The saygak's view of an order. Built field by field (never spread a DB row) so that staff-only data
 * (workers, waybill, address, cancel reason, ...) cannot leak. Money appears only once the order is delivered.
 */
export function presentPartnerOrder(o, lines, sizeMap) {
  const delivered = o.status === ORDER_STATUS.DELIVERED;
  const counted = delivered || o.status === ORDER_STATUS.PACKED;
  const out = {
    docNum: o.docNum,
    status: o.status,
    createdAt: o.createdAt,
    deliveredDate: o.deliveredDate,
    cancelledAt: o.cancelledAt,
    lines: lines.map((l) => {
      const sizes = sizeMap.get(l.id) ?? [];
      const line = {
        id: l.id,
        serviceName: l.serviceName,
        unit: l.unit,
        expectedQuantity: l.expectedQuantity,
        quantity: counted ? l.quantity : null,
        sizes,
        sizesTotal: sizesTotal(sizes),
      };
      if (delivered) {
        line.price = l.customerPrice;
        line.sqm = l.sqm;
        line.lineTotal = l.lineTotal;
      }
      return line;
    }),
  };
  if (delivered) {
    out.docTotal = o.docTotal;
    out.discount = o.discount;
    out.paid = o.paid;
    out.debt = orderDebt(o);
  }
  return out;
}

export function partnerRouter(db) {
  const r = Router();
  // The ONLY way to read an order in this router: scoped to the caller's clientId and partner kind.
  const ownOrderStmt = db.prepare("SELECT * FROM orders WHERE docNum = ? AND clientId = ? AND kind = 'partner'");
  const ownOrder = (docNum, clientId) => ownOrderStmt.get(docNum, clientId);
  const getLines = db.prepare('SELECT * FROM order_lines WHERE docNum = ? ORDER BY id');
  const getClient = db.prepare('SELECT id, name, phone, isPartner FROM clients WHERE id = ?');

  const present = (o) => presentPartnerOrder(o, getLines.all(o.docNum), loadSizes(db, [o.docNum]));
  const mustOwn = (docNum, clientId) => {
    const o = ownOrder(docNum, clientId);
    if (!o) throw notFound('Order not found');
    return o;
  };

  r.get('/me', (req, res) => {
    const cid = req.user.clientId;
    const c = getClient.get(cid);
    if (!c) throw notFound('Client not found');
    const inProgressOrders = db
      .prepare("SELECT COUNT(*) n FROM orders WHERE clientId = ? AND kind = 'partner' AND status IN (?,?,?,?)")
      .get(cid, ORDER_STATUS.RECEIVED, ORDER_STATUS.PICKED_UP, ORDER_STATUS.WASHED, ORDER_STATUS.PACKED).n;
    const receivedOrders = db
      .prepare("SELECT COUNT(*) n FROM orders WHERE clientId = ? AND kind = 'partner' AND status = ?")
      .get(cid, ORDER_STATUS.RECEIVED).n;
    const debt = db
      .prepare("SELECT docTotal, discount, paid FROM orders WHERE clientId = ? AND kind = 'partner' AND status = ?")
      .all(cid, ORDER_STATUS.DELIVERED)
      .reduce((s, o) => s + orderDebt(o), 0);
    res.json({ client: { id: c.id, name: c.name, phone: c.phone }, inProgressOrders, receivedOrders, orderCap: PARTNER_OPEN_ORDER_CAP, debt: round2(debt) });
  });

  r.get('/services', (req, res) => {
    const prices = priceMap(db, req.user.clientId);
    const out = db
      .prepare('SELECT id, name, unit FROM services WHERE isActive = 1 ORDER BY name')
      .all()
      .filter((s) => prices.has(s.id))
      .map((s) => ({ id: s.id, name: s.name, unit: s.unit, price: prices.get(s.id) }));
    res.json(out);
  });

  r.get('/orders', validate(listQuery, 'query'), (req, res) => {
    const { page, limit, status } = req.valid.query;
    const cid = req.user.clientId;
    const where = "clientId = @cid AND kind = 'partner'" + (status ? ' AND status = @status' : '');
    const args = { cid, status, limit, offset: (page - 1) * limit };
    if (!status) delete args.status;
    const total = db.prepare(`SELECT COUNT(*) c FROM orders WHERE ${where}`).get(args).c;
    const orders = db.prepare(`SELECT * FROM orders WHERE ${where} ORDER BY docNum DESC LIMIT @limit OFFSET @offset`).all(args);
    const sizeMap = loadSizes(db, orders.map((o) => o.docNum));
    res.json({ data: orders.map((o) => presentPartnerOrder(o, getLines.all(o.docNum), sizeMap)), meta: { page, limit, total } });
  });

  r.post('/orders', validate(createSchema), (req, res) => {
    const client = getClient.get(req.user.clientId);
    const docNum = createPartnerOrder(db, req.user, client, { lines: req.valid.body.lines, via: 'partner' });
    res.status(201).json(present(mustOwn(Number(docNum), req.user.clientId)));
  });

  r.get('/orders/:docNum', validate(params, 'params'), (req, res) => {
    res.json(present(mustOwn(req.valid.params.docNum, req.user.clientId)));
  });

  r.patch('/orders/:docNum', validate(params, 'params'), validate(editSchema), (req, res) => {
    const { docNum } = req.valid.params;
    db.transaction(() => {
      const o = mustOwn(docNum, req.user.clientId);
      if (o.status !== ORDER_STATUS.RECEIVED) throw conflict('Order can only be changed before pickup');
      const own = new Map(getLines.all(docNum).map((l) => [l.id, l]));
      const changes = req.valid.body.lines;
      if (!changes.every((l) => own.has(l.id))) throw badRequest('Line does not belong to this order');
      const upd = db.prepare('UPDATE order_lines SET expectedQuantity = ? WHERE id = ? AND docNum = ?');
      const logged = {};
      for (const l of changes) {
        const before = own.get(l.id);
        upd.run(l.expectedQuantity, l.id, docNum);
        const d = diff(before, { expectedQuantity: l.expectedQuantity }, ['expectedQuantity']);
        if (d.expectedQuantity) logged[`${before.serviceName} (expected qty)`] = d.expectedQuantity;
      }
      if (Object.keys(logged).length) logActivity(db, req.user, 'order', docNum, 'order.edited', { via: 'partner', changes: logged });
    })();
    res.json(present(mustOwn(docNum, req.user.clientId)));
  });

  r.post('/orders/:docNum/cancel', validate(params, 'params'), validate(cancelSchema), (req, res) => {
    const { docNum } = req.valid.params;
    db.transaction(() => {
      const o = mustOwn(docNum, req.user.clientId);
      if (o.status !== ORDER_STATUS.RECEIVED) throw conflict('Order can only be cancelled before pickup');
      db.prepare("UPDATE orders SET status = ?, docStatus = 'Closed', cancelReason = ?, cancelledAt = ? WHERE docNum = ?")
        .run(ORDER_STATUS.CANCELLED, req.valid.body.reason, nowDateTime(), docNum);
      db.prepare("UPDATE order_lines SET status = 'Closed' WHERE docNum = ?").run(docNum);
      logActivity(db, req.user, 'order', docNum, 'order.cancelled', { from: o.status, to: ORDER_STATUS.CANCELLED, reason: req.valid.body.reason, via: 'partner' });
    })();
    res.json(present(mustOwn(docNum, req.user.clientId)));
  });

  r.get('/statement', validate(statementQuery, 'query'), (req, res) => {
    res.json(buildStatement(db, req.user.clientId, req.valid.query.month ?? today().slice(0, 7)));
  });

  return r;
}
