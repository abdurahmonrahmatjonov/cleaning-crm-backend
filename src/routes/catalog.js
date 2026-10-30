import { Router } from 'express';
import { diff, logActivity } from '../utils/activity.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { conflict, notFound } from '../utils/httpError.js';
import { id as idSchema } from '../utils/schemas.js';
import { UNITS } from '../db.js';

const price = z.number().int().min(0).max(1_000_000_000);
const createSchema = z.object({ name: z.string().trim().min(1).max(100), defaultPrice: price.optional(), unit: z.enum(UNITS).optional() });
const patchSchema = z
  .object({ name: z.string().trim().min(1).max(100), isActive: z.boolean(), defaultPrice: price, unit: z.enum(UNITS) })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const params = z.object({ id: idSchema });

/**
 * Simple name list backed by `table` (services, expense_types).
 * Anyone logged in can read it (for the dropdowns); only admins change it.
 * `table` is always a hardcoded literal from app.js, never user input.
 */
export function catalogRouter(db, table) {
  const router = Router();
  // Only services carry a default price (per sq.m), used to prefill order lines.
  const cols = table === 'services' ? 'id, name, isActive, defaultPrice, unit' : 'id, name, isActive';
  const get = db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?`);
  const entityOf = (t) => (t === 'services' ? 'service' : 'expense_type');

  router.get('/', (req, res) => {
    const all = req.query.all === 'true' && req.user.role === 'admin';
    const rows = db
      .prepare(`SELECT ${cols} FROM ${table} ${all ? '' : 'WHERE isActive = 1'} ORDER BY id`)
      .all();
    res.json({ data: rows });
  });

  router.post('/', requireRole('admin'), validate(createSchema), (req, res) => {
    try {
      const { name, defaultPrice } = req.valid.body;
      const info =
        table === 'services'
          ? db.prepare('INSERT INTO services (name, defaultPrice, unit) VALUES (?, ?, ?)').run(name, defaultPrice ?? 0, req.valid.body.unit ?? 'kv.m')
          : db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name);
      const created = get.get(info.lastInsertRowid);
      logActivity(db, req.user, entityOf(table), created.id, `${entityOf(table)}.created`, { ...created });
      res.status(201).json(created);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Name already exists');
      throw e;
    }
  });

  router.patch('/:id', requireRole('admin'), validate(params, 'params'), validate(patchSchema), (req, res) => {
    const { id } = req.valid.params;
    const { name, isActive, defaultPrice } = req.valid.body;
    const before = get.get(id);
    if (!before) throw notFound();
    try {
      if (name !== undefined) db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, id);
      if (isActive !== undefined) db.prepare(`UPDATE ${table} SET isActive = ? WHERE id = ?`).run(isActive ? 1 : 0, id);
      if (defaultPrice !== undefined && table === 'services') {
        db.prepare('UPDATE services SET defaultPrice = ? WHERE id = ?').run(defaultPrice, id);
      }
      // Changing the unit only affects new orders; existing order lines keep the unit they were created with.
      if (req.valid.body.unit !== undefined && table === 'services') {
        db.prepare('UPDATE services SET unit = ? WHERE id = ?').run(req.valid.body.unit, id);
      }
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Name already exists');
      throw e;
    }
    const after = get.get(id);
    logActivity(db, req.user, entityOf(table), id, `${entityOf(table)}.updated`, { name: after.name, changes: diff(before, after, Object.keys(after)) });
    res.json(after);
  });

  return router;
}
