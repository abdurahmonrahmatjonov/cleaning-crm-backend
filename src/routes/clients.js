import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { ORDER_STATUS } from '../db.js';
import { conflict, notFound } from '../utils/httpError.js';
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
  .object({ name, phone: phoneString })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

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
        `SELECT c.id, c.name, c.phone, c.createdAt, COUNT(o.docNum) ordersCount, ${DEBT_SQL} debt
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
        `SELECT c.id, c.name, c.phone, c.createdAt, COUNT(o.docNum) ordersCount, ${DEBT_SQL} debt
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
    const next = { name: req.valid.body.name ?? before.name, phone: req.valid.body.phone ?? before.phone };
    try {
      db.transaction(() => {
        db.prepare('UPDATE clients SET name = ?, phone = ? WHERE id = ?').run(next.name, next.phone, id);
        db.prepare('UPDATE orders SET clientName = ?, clientPhone = ? WHERE clientId = ?').run(next.name, next.phone, id);
        logActivity(db, req.user, 'client', id, 'client.updated', { changes: diff(before, next, ['name', 'phone']) });
      })();
    } catch (e) { dup(e); }
    res.json({ ...summary(id), addresses: addressesOf(id) });
  });

  // Only clients with no orders can go; the rest keep their history.
  router.delete('/:id', manage, validate(params, 'params'), (req, res) => {
    const { id } = req.valid.params;
    const c = getClient(id);
    if (db.prepare('SELECT COUNT(*) n FROM orders WHERE clientId = ?').get(id).n > 0) {
      throw conflict('This client has orders and cannot be deleted');
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
