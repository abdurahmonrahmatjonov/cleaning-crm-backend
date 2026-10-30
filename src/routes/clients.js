import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import bcrypt from 'bcryptjs';
import { requirePerm, requireRole } from '../middleware/auth.js';
import { ORDER_STATUS } from '../db.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { id as idSchema, pagination, phoneString } from '../utils/schemas.js';
import { diff, logActivity } from '../utils/activity.js';
import { presentAddress, rememberAddress } from '../utils/addresses.js';
import { nowDateTime } from '../utils/time.js';

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
        `SELECT docNum, status, docTotal, discount, paid, createdAt, deliveredDate FROM orders
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
    for (const p of next) if (!db.prepare('SELECT 1 FROM services WHERE id = ?').get(p.serviceId)) throw badRequest('Unknown service', { path: 'prices' });
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
    getClient(id);
    const u = db.prepare('SELECT id, username FROM users WHERE clientId = ?').get(id);
    if (!u) throw notFound('This client has no login');
    db.prepare('UPDATE users SET isActive = ? WHERE id = ?').run(req.valid.body.isActive ? 1 : 0, u.id);
    logActivity(db, req.user, 'client', id, 'client.login.active', { username: u.username, isActive: req.valid.body.isActive });
    res.json(loginOf(id));
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
