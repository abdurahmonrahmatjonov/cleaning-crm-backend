import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import bcrypt from 'bcryptjs';
import { requirePerm, requireRole } from '../middleware/auth.js';
import { ORDER_STATUS } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../utils/httpError.js';
import { dateString, id as idSchema, money, pagination, phoneString } from '../utils/schemas.js';
import { diff, logActivity } from '../utils/activity.js';
import { presentAddress, rememberAddress } from '../utils/addresses.js';
import { nowDateTime, today } from '../utils/time.js';
import { round2 } from '../utils/sizes.js';
import { buildStatement, MONTH_RE } from '../utils/statement.js';

const lumpSchema = z
  .object({ amount: money.default(0), discount: money.default(0), paidDate: dateString.optional() })
  .strict()
  .refine((o) => round2(o.amount) + round2(o.discount) > 0, 'Enter an amount, a discount, or both');
const batchParams = z.object({ id: idSchema, batchId: z.string().min(1).max(64) });
const statementQuery = z.object({ month: z.string().regex(MONTH_RE, 'Expected YYYY-MM').optional() });

const listQuery = pagination.extend({ search: z.string().trim().max(100).optional() });
const params = z.object({ id: idSchema });
const addressParams = z.object({ id: idSchema, addressId: idSchema });

const name = z.string().trim().min(1).max(150);
const createSchema = z.object({ name, phone: phoneString, address: addressInput().optional() });
const patchSchema = z
  .object({ name, phone: phoneString, isPartner: z.boolean() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const pricesSchema = z
  .object({
    prices: z
      .array(z.object({ serviceId: idSchema, price: z.number().finite().min(0).max(1e9) }))
      .max(500)
      .refine((a) => new Set(a.map((p) => p.serviceId)).size === a.length, 'Duplicate service'),
  })
  .strict();
const loginSchema = z
  .object({
    username: z.string().trim().min(3).max(50).regex(/^[\w.-]+$/, 'Letters, digits, _ . - only'),
    fullName: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(8).max(100),
  })
  .strict();
const loginPatchSchema = z.object({ isActive: z.boolean() }).strict();

function addressInput() {
  return z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), landmark: z.string().trim().max(300).default('') });
}
const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const addressSchema = location.extend({ landmark: z.string().trim().max(300).default('') });
const addressPatch = location.extend({ landmark: z.string().trim().max(300) }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update');

// Debt of a client = unpaid part of their delivered orders.
const DEBT_SQL = `COALESCE(SUM(CASE WHEN o.status = @delivered AND o.docTotal - o.discount > o.paid THEN o.docTotal - o.discount - o.paid ELSE 0 END), 0)`;

export function clientsRouter(db) {
  const router = Router();
  const base = { delivered: ORDER_STATUS.DELIVERED };
  const manage = requirePerm('clients.manage');

  const summary = (id) =>
    db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.isPartner, c.createdAt, COUNT(o.docNum) ordersCount, ${DEBT_SQL} debt
         FROM clients c LEFT JOIN orders o ON o.clientId = c.id WHERE c.id = @id GROUP BY c.id`,
      )
      .get({ ...base, id });
  const addressesOf = (id) =>
    db.prepare('SELECT * FROM client_addresses WHERE clientId = ? ORDER BY lastUsedAt DESC, id DESC').all(id).map(presentAddress);
  const getClient = (id) => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
    if (!c) throw notFound('Client not found');
    return c;
  };
  const dup = (e) => {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('A client with this phone number already exists');
    throw e;
  };

  router.get('/', validate(listQuery, 'query'), (req, res) => {
    const { page, limit, search } = req.valid.query;
    const args = { ...base, limit, offset: (page - 1) * limit };
    let where = '';
    if (search) {
      where = `WHERE c.name LIKE @q ESCAPE '\\' OR c.phone LIKE @q ESCAPE '\\'`;
      args.q = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    }
    const total = db.prepare(`SELECT COUNT(*) c FROM clients c ${where}`).get(args).c;
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.isPartner, c.createdAt, COUNT(o.docNum) ordersCount, ${DEBT_SQL} debt
         FROM clients c LEFT JOIN orders o ON o.clientId = c.id
         ${where} GROUP BY c.id ORDER BY c.id DESC LIMIT @limit OFFSET @offset`,
      )
      .all(args);
    res.json({ data: rows, meta: { page, limit, total } });
  });

  router.post('/', manage, validate(createSchema), (req, res) => {
    const { name: n, phone, address } = req.valid.body;
    try {
      const id = db.transaction(() => {
        const info = db.prepare('INSERT INTO clients (name, phone, createdAt) VALUES (?,?,?)').run(n, phone, nowDateTime());
        logActivity(db, req.user, 'client', info.lastInsertRowid, 'client.created', { name: n, phone, ...(address && { address: address.landmark || `${address.latitude}, ${address.longitude}` }) });
        if (address) rememberAddress(db, info.lastInsertRowid, address, address.landmark);
        return info.lastInsertRowid;
      })();
      res.status(201).json({ ...summary(id), orders: [], addresses: addressesOf(id) });
    } catch (e) { dup(e); }
  });

  router.get('/:id', validate(params, 'params'), (req, res) => {
    const { id } = req.valid.params;
    const client = summary(id);
    if (!client) throw notFound('Client not found');
    const orders = db
      .prepare(
        `SELECT docNum, kind, status, docTotal, discount, paid, createdAt, deliveredDate FROM orders
         WHERE clientId = ? ORDER BY docNum DESC`,
      )
      .all(id);
    res.json({ ...client, orders, addresses: addressesOf(id) });
  });

  // The client record is the source of truth: orders show the new name/phone too.
  router.patch('/:id', manage, validate(params, 'params'), validate(patchSchema), (req, res) => {
    const { id } = req.valid.params;
    const before = getClient(id);
    const b = req.valid.body;
    if (b.isPartner === false && before.isPartner && db.prepare('SELECT 1 FROM users WHERE clientId = ? AND isActive = 1').get(id)) {
      throw conflict('Deactivate the saygak login first');
    }
    if (b.isPartner === false && before.isPartner) {
      const owing = db
        .prepare(`SELECT docTotal, discount, paid FROM orders WHERE clientId = ? AND kind = 'partner' AND status = ?`)
        .all(id, ORDER_STATUS.DELIVERED)
        .some((o) => round2(o.docTotal - o.discount - o.paid) > 0);
      if (owing) throw conflict('Settle the saygak debt first');
      const inProgress = db
        .prepare(`SELECT 1 FROM orders WHERE clientId = ? AND kind = 'partner' AND status IN (?,?,?,?)`)
        .get(id, ORDER_STATUS.RECEIVED, ORDER_STATUS.PICKED_UP, ORDER_STATUS.WASHED, ORDER_STATUS.PACKED);
      if (inProgress) throw conflict('Finish or cancel the saygak orders in progress first');
    }
    const next = { name: b.name ?? before.name, phone: b.phone ?? before.phone, isPartner: b.isPartner === undefined ? before.isPartner : b.isPartner ? 1 : 0 };
    try {
      db.transaction(() => {
        db.prepare('UPDATE clients SET name = ?, phone = ?, isPartner = ? WHERE id = ?').run(next.name, next.phone, next.isPartner, id);
        db.prepare('UPDATE orders SET clientName = ?, clientPhone = ? WHERE clientId = ?').run(next.name, next.phone, id);
        logActivity(db, req.user, 'client', id, 'client.updated', { changes: diff(before, next, ['name', 'phone', 'isPartner']) });
      })();
    } catch (e) { dup(e); }
    res.json({ ...summary(id), addresses: addressesOf(id) });
  });

  // ----- saygak (partner) prices and login: admin only -----
  const adminOnly = requireRole('admin');
  const getPartner = (id) => {
    const c = getClient(id);
    if (!c.isPartner) throw conflict('This client is not a saygak');
    return c;
  };
  const pricesOf = (id) =>
    db
      .prepare(
        `SELECT s.id serviceId, s.name serviceName, s.unit, p.price
         FROM services s LEFT JOIN client_prices p ON p.serviceId = s.id AND p.clientId = ?
         WHERE s.isActive = 1 ORDER BY s.id`,
      )
      .all(id);

  router.get('/:id/prices', validate(params, 'params'), (req, res) => {
    getClient(req.valid.params.id);
    res.json({ data: pricesOf(req.valid.params.id) });
  });

  router.put('/:id/prices', adminOnly, validate(params, 'params'), validate(pricesSchema), (req, res) => {
    const { id } = req.valid.params;
    getPartner(id);
    const next = req.valid.body.prices;
    const activeSvc = db.prepare('SELECT 1 FROM services WHERE id = ? AND isActive = 1');
    for (const p of next) if (!activeSvc.get(p.serviceId)) throw badRequest('Unknown or inactive service', { path: 'prices' });
    db.transaction(() => {
      const old = new Map(db.prepare('SELECT serviceId, price FROM client_prices WHERE clientId = ?').all(id).map((r) => [r.serviceId, r.price]));
      db.prepare('DELETE FROM client_prices WHERE clientId = ?').run(id);
      const ins = db.prepare('INSERT INTO client_prices (clientId, serviceId, price) VALUES (?,?,?)');
      for (const p of next) ins.run(id, p.serviceId, p.price);
      const changes = [];
      for (const p of next) if (old.get(p.serviceId) !== p.price) changes.push({ serviceId: p.serviceId, from: old.get(p.serviceId) ?? null, to: p.price });
      for (const [serviceId, price] of old) if (!next.some((p) => p.serviceId === serviceId)) changes.push({ serviceId, from: price, to: null });
      logActivity(db, req.user, 'client', id, 'client.prices', { changes });
    })();
    res.json({ data: pricesOf(id) });
  });

  const loginOf = (id) => {
    const u = db.prepare('SELECT username, isActive FROM users WHERE clientId = ?').get(id);
    return u ? { username: u.username, isActive: !!u.isActive } : null;
  };

  router.get('/:id/login', adminOnly, validate(params, 'params'), (req, res) => {
    getClient(req.valid.params.id);
    res.json(loginOf(req.valid.params.id));
  });

  router.put('/:id/login', adminOnly, validate(params, 'params'), validate(loginSchema), (req, res) => {
    const { id } = req.valid.params;
    const client = getPartner(id);
    const { username, fullName, password } = req.valid.body;
    const hash = bcrypt.hashSync(password, 10);
    try {
      db.transaction(() => {
        const existing = db.prepare('SELECT id, username FROM users WHERE clientId = ?').get(id);
        if (existing) {
          db.prepare('UPDATE users SET username = ?, passwordHash = ?, fullName = COALESCE(?, fullName) WHERE id = ?').run(username, hash, fullName ?? null, existing.id);
          logActivity(db, req.user, 'client', id, 'client.login.reset', { username, previousUsername: existing.username, passwordChanged: true });
        } else {
          db.prepare("INSERT INTO users (username, fullName, passwordHash, role, createdAt, clientId) VALUES (?,?,?,'saygak',?,?)").run(username, fullName ?? client.name, hash, nowDateTime(), id);
          logActivity(db, req.user, 'client', id, 'client.login.created', { username });
        }
      })();
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Username already exists');
      throw e;
    }
    res.json(loginOf(id));
  });

  router.patch('/:id/login', adminOnly, validate(params, 'params'), validate(loginPatchSchema), (req, res) => {
    const { id } = req.valid.params;
    if (req.valid.body.isActive) getPartner(id);
    else getClient(id);
    const u = db.prepare('SELECT id, username FROM users WHERE clientId = ?').get(id);
    if (!u) throw notFound('This client has no login');
    db.prepare('UPDATE users SET isActive = ? WHERE id = ?').run(req.valid.body.isActive ? 1 : 0, u.id);
    logActivity(db, req.user, 'client', id, 'client.login.active', { username: u.username, isActive: req.valid.body.isActive });
    res.json(loginOf(id));
  });

  // ----- saygak lump payments (FIFO), reversal and monthly statement -----
  router.post('/:id/payments', requirePerm('orders.payments'), validate(params, 'params'), validate(lumpSchema), (req, res) => {
    const { id } = req.valid.params;
    const amount = round2(req.valid.body.amount);
    const discount = round2(req.valid.body.discount);
    const date = req.valid.body.paidDate ?? today();
    if (date > today()) throw badRequest('paidDate cannot be in the future', { path: 'paidDate' });
    getPartner(id);
    if (discount > 0 && !req.user.permissions.includes('orders.discount')) throw new HttpError(403, 'You are not allowed to give discounts');
    const result = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT docNum, docTotal, discount, paid FROM orders
           WHERE clientId = ? AND kind = 'partner' AND status = ? ORDER BY deliveredDate, docNum`,
        )
        .all(id, ORDER_STATUS.DELIVERED);
      const owed = (o) => round2(o.docTotal - o.discount - o.paid);
      const open = rows.filter((o) => owed(o) > 0);
      const totalDebt = round2(open.reduce((s, o) => s + owed(o), 0));
      if (round2(amount + discount) > totalDebt) throw badRequest(`Amount and discount exceed the debt (${totalDebt})`);
      const batchId = randomUUID();
      const now = nowDateTime();
      let cashLeft = amount;
      let discLeft = discount;
      const allocations = [];
      const upd = db.prepare('UPDATE orders SET paid = ?, discount = ? WHERE docNum = ?');
      const insPay = db.prepare(
        `INSERT INTO payments (docNum, amount, discount, paidDate, createdAt, creatorId, creatorName, batchId) VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const o of open) {
        const debt = owed(o);
        const disc = Math.min(discLeft, debt);
        discLeft = round2(discLeft - disc);
        const cash = Math.min(cashLeft, round2(debt - disc));
        cashLeft = round2(cashLeft - cash);
        if (!cash && !disc) continue;
        upd.run(round2(o.paid + cash), round2(o.discount + disc), o.docNum);
        if (cash > 0) insPay.run(o.docNum, cash, disc, date, now, req.user.id, req.user.fullName, batchId);
        allocations.push({ docNum: o.docNum, cash, disc });
        if (cashLeft === 0 && discLeft === 0) break;
      }
      db.prepare(
        `INSERT INTO payment_batches (batchId, clientId, amount, discount, paidDate, createdAt, creatorId, creatorName, allocations) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(batchId, id, amount, discount, date, now, req.user.id, req.user.fullName, JSON.stringify(allocations));
      logActivity(db, req.user, 'client', id, 'client.payment', {
        batchId, amount, discount, paidDate: date, orders: allocations.length, allocations,
      });
      return { batchId, allocations, debtLeft: round2(totalDebt - amount - discount) };
    })();
    res.status(201).json(result);
  });

  router.get('/:id/payments', validate(params, 'params'), (req, res) => {
    const { id } = req.valid.params;
    getClient(id);
    const rows = db.prepare('SELECT * FROM payment_batches WHERE clientId = ? ORDER BY createdAt DESC, rowid DESC').all(id);
    res.json({ data: rows.map((b) => ({ ...b, allocations: JSON.parse(b.allocations) })) });
  });

  router.delete('/:id/payments/:batchId', adminOnly, validate(batchParams, 'params'), (req, res) => {
    const { id, batchId } = req.valid.params;
    getClient(id);
    db.transaction(() => {
      const b = db.prepare('SELECT * FROM payment_batches WHERE batchId = ? AND clientId = ?').get(batchId, id);
      if (!b) throw notFound('Payment batch not found');
      if (b.reversedAt) throw conflict('This payment is already reversed');
      const get = db.prepare('SELECT paid, discount FROM orders WHERE docNum = ?');
      const upd = db.prepare('UPDATE orders SET paid = ?, discount = ? WHERE docNum = ?');
      for (const a of JSON.parse(b.allocations)) {
        const o = get.get(a.docNum);
        if (!o) throw conflict(`Order ${a.docNum} no longer exists`);
        const paid = round2(o.paid - a.cash);
        const discount = round2(o.discount - a.disc);
        if (paid < 0 || discount < 0) throw conflict(`Cannot reverse: order ${a.docNum} would go negative`);
        upd.run(paid, discount, a.docNum);
      }
      db.prepare('DELETE FROM payments WHERE batchId = ?').run(batchId);
      db.prepare('UPDATE payment_batches SET reversedAt = ?, reversedByName = ? WHERE batchId = ?').run(nowDateTime(), req.user.fullName, batchId);
      logActivity(db, req.user, 'client', id, 'client.payment.reversed', { batchId, amount: b.amount, discount: b.discount });
    })();
    res.json({ reversed: true });
  });

  router.get('/:id/statement', validate(params, 'params'), validate(statementQuery, 'query'), (req, res) => {
    const { id } = req.valid.params;
    getClient(id);
    res.json(buildStatement(db, id, req.valid.query.month ?? today().slice(0, 7)));
  });

  // Only clients with no orders can go; the rest keep their history.
  router.delete('/:id', manage, validate(params, 'params'), (req, res) => {
    const { id } = req.valid.params;
    const c = getClient(id);
    if (db.prepare('SELECT COUNT(*) n FROM orders WHERE clientId = ?').get(id).n > 0) {
      throw conflict('This client has orders and cannot be deleted');
    }
    if (db.prepare('SELECT 1 FROM users WHERE clientId = ?').get(id) || db.prepare('SELECT 1 FROM client_prices WHERE clientId = ?').get(id)) {
      throw conflict('This saygak has a login or prices and cannot be deleted; deactivate the login instead');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM comments WHERE entity = ? AND entityId = ?').run('client', String(id));
      db.prepare('DELETE FROM clients WHERE id = ?').run(id); // saved addresses go with it (ON DELETE CASCADE)
      logActivity(db, req.user, 'client', id, 'client.deleted', { name: c.name, phone: c.phone });
    })();
    res.status(204).end();
  });

  // ----- saved addresses -----
  router.get('/:id/addresses', validate(params, 'params'), (req, res) => {
    getClient(req.valid.params.id);
    res.json({ data: addressesOf(req.valid.params.id) });
  });

  router.post('/:id/addresses', manage, validate(params, 'params'), validate(addressSchema), (req, res) => {
    const { id } = req.valid.params;
    getClient(id);
    const b = req.valid.body;
    const now = nowDateTime();
    const info = db
      .prepare('INSERT INTO client_addresses (clientId, latitude, longitude, landmark, createdAt, lastUsedAt) VALUES (?,?,?,?,?,?)')
      .run(id, b.latitude, b.longitude, b.landmark, now, now);
    logActivity(db, req.user, 'client', id, 'client.address_added', { landmark: b.landmark, latitude: b.latitude, longitude: b.longitude });
    res.status(201).json(presentAddress(db.prepare('SELECT * FROM client_addresses WHERE id = ?').get(info.lastInsertRowid)));
  });

  router.patch('/:id/addresses/:addressId', manage, validate(addressParams, 'params'), validate(addressPatch), (req, res) => {
    const { id, addressId } = req.valid.params;
    const a = db.prepare('SELECT * FROM client_addresses WHERE id = ? AND clientId = ?').get(addressId, id);
    if (!a) throw notFound('Address not found');
    const next = { ...a, ...req.valid.body };
    db.prepare('UPDATE client_addresses SET latitude = ?, longitude = ?, landmark = ? WHERE id = ?').run(next.latitude, next.longitude, next.landmark, addressId);
    logActivity(db, req.user, 'client', id, 'client.address_updated', { changes: diff(a, next, ['latitude', 'longitude', 'landmark']) });
    res.json(presentAddress(db.prepare('SELECT * FROM client_addresses WHERE id = ?').get(addressId)));
  });

  router.delete('/:id/addresses/:addressId', manage, validate(addressParams, 'params'), (req, res) => {
    const { id, addressId } = req.valid.params;
    const a = db.prepare('SELECT * FROM client_addresses WHERE id = ? AND clientId = ?').get(addressId, id);
    if (!a) throw notFound('Address not found');
    db.prepare('DELETE FROM client_addresses WHERE id = ?').run(addressId);
    logActivity(db, req.user, 'client', id, 'client.address_deleted', { landmark: a.landmark });
    res.status(204).end();
  });

  return router;
}
