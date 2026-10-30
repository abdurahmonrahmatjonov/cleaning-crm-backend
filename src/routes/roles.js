import { Router } from 'express';
import { logActivity } from '../utils/activity.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { PERMISSIONS } from '../db.js';
import { conflict, notFound } from '../utils/httpError.js';

const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const name = z.string().trim().min(2).max(40);
const createSchema = z.object({ name, permissions: permissions.default([]) });
const patchSchema = z
  .object({ name, permissions })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const params = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/) });

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'role';

/** Role management: which permissions each role has. Admin only; the admin role itself is fixed. */
export function rolesRouter(db) {
  const router = Router();
  router.use(requireRole('admin'));

  const present = (r) => ({
    key: r.key,
    name: r.name,
    isSystem: !!r.isSystem,
    permissions: r.key === 'admin' ? [...PERMISSIONS] : JSON.parse(r.permissions),
    usersCount: db.prepare('SELECT COUNT(*) c FROM users WHERE role = ?').get(r.key).c,
  });
  const get = (key) => db.prepare('SELECT * FROM roles WHERE key = ?').get(key);

  router.get('/', (_req, res) => {
    res.json({
      data: db.prepare('SELECT * FROM roles ORDER BY isSystem DESC, name').all().map(present),
      meta: { permissions: PERMISSIONS },
    });
  });

  router.post('/', validate(createSchema), (req, res) => {
    const { name: n, permissions: perms } = req.valid.body;
    let key = slug(n);
    for (let i = 2; get(key); i++) key = `${slug(n).slice(0, 26)}_${i}`;
    try {
      db.prepare('INSERT INTO roles (key, name, permissions, isSystem) VALUES (?,?,?,0)').run(key, n, JSON.stringify([...new Set(perms)]));
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Role name already exists');
      throw e;
    }
    logActivity(db, req.user, 'role', key, 'role.created', { name: n, permissions: [...new Set(perms)] });
    res.status(201).json(present(get(key)));
  });

  router.patch('/:key', validate(params, 'params'), validate(patchSchema), (req, res) => {
    const { key } = req.valid.params;
    const role = get(key);
    if (!role) throw notFound('Role not found');
    if (key === 'admin') throw conflict('The admin role cannot be changed');
    const { name: n, permissions: perms } = req.valid.body;
    try {
      if (n !== undefined) db.prepare('UPDATE roles SET name = ? WHERE key = ?').run(n, key);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Role name already exists');
      throw e;
    }
    if (perms !== undefined) {
      db.prepare('UPDATE roles SET permissions = ? WHERE key = ?').run(JSON.stringify([...new Set(perms)]), key);
    }
    logActivity(db, req.user, 'role', key, 'role.updated', {
      name: n !== undefined && n !== role.name ? { from: role.name, to: n } : undefined,
      permissions: perms !== undefined ? { from: JSON.parse(role.permissions), to: [...new Set(perms)] } : undefined,
    });
    res.json(present(get(key)));
  });

  router.delete('/:key', validate(params, 'params'), (req, res) => {
    const { key } = req.valid.params;
    const role = get(key);
    if (!role) throw notFound('Role not found');
    if (role.isSystem) throw conflict('Built-in roles cannot be deleted');
    if (db.prepare('SELECT COUNT(*) c FROM users WHERE role = ?').get(key).c > 0) {
      throw conflict('Some users still have this role; move them to another role first');
    }
    db.prepare('DELETE FROM roles WHERE key = ?').run(key);
    logActivity(db, req.user, 'role', key, 'role.deleted', { name: role.name });
    res.status(204).end();
  });

  return router;
}
