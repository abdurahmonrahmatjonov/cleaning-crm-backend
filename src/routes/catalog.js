import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { conflict, notFound } from '../utils/httpError.js';
import { id as idSchema } from '../utils/schemas.js';

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });
const patchSchema = z
  .object({ name: z.string().trim().min(1).max(100), isActive: z.boolean() })
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
  const get = db.prepare(`SELECT id, name, isActive FROM ${table} WHERE id = ?`);

  router.get('/', (req, res) => {
    const all = req.query.all === 'true' && req.user.role === 'admin';
    const rows = db
      .prepare(`SELECT id, name, isActive FROM ${table} ${all ? '' : 'WHERE isActive = 1'} ORDER BY id`)
      .all();
    res.json({ data: rows });
  });

  router.post('/', requireRole('admin'), validate(createSchema), (req, res) => {
    try {
      const info = db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(req.valid.body.name);
      res.status(201).json(get.get(info.lastInsertRowid));
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Name already exists');
      throw e;
    }
  });

  router.patch('/:id', requireRole('admin'), validate(params, 'params'), validate(patchSchema), (req, res) => {
    const { id } = req.valid.params;
    const { name, isActive } = req.valid.body;
    if (!get.get(id)) throw notFound();
    try {
      if (name !== undefined) db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, id);
      if (isActive !== undefined) db.prepare(`UPDATE ${table} SET isActive = ? WHERE id = ?`).run(isActive ? 1 : 0, id);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Name already exists');
      throw e;
    }
    res.json(get.get(id));
  });

  return router;
}
