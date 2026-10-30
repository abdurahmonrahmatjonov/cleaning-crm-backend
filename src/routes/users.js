import { Router } from 'express';
import { diff, logActivity } from '../utils/activity.js';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { badRequest, conflict, notFound } from '../utils/httpError.js';
import { id as idSchema } from '../utils/schemas.js';
import { nowDateTime } from '../utils/time.js';

const role = z.string().regex(/^[a-z0-9_]{1,40}$/);
const password = z.string().min(8).max(100);

const createSchema = z.object({
  username: z.string().trim().min(3).max(50).regex(/^[\w.-]+$/, 'Letters, digits, _ . - only'),
  fullName: z.string().trim().min(1).max(100),
  password,
  role,
});
const patchSchema = z
  .object({
    fullName: z.string().trim().min(1).max(100),
    password,
    role,
    isActive: z.boolean(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');
const params = z.object({ id: idSchema });

const SAYGAK_MSG = 'Saygak accounts are managed from the client profile';
const publicCols = 'id, username, fullName, role, isActive, createdAt';

export function usersRouter(db) {
  const router = Router();
  router.use(requireRole('admin'));
  const assertRole = (key) => {
    if (key === 'saygak') throw badRequest(SAYGAK_MSG);
    if (key !== undefined && !db.prepare('SELECT 1 FROM roles WHERE key = ?').get(key)) throw badRequest('Unknown role');
  };

  router.get('/', (_req, res) => {
    res.json({ data: db.prepare(`SELECT ${publicCols} FROM users WHERE role != 'saygak' ORDER BY id`).all() });
  });

  router.post('/', validate(createSchema), (req, res) => {
    const { username, fullName, password: pw, role: r } = req.valid.body;
    assertRole(r);
    try {
      const info = db
        .prepare('INSERT INTO users (username, fullName, passwordHash, role, createdAt) VALUES (?,?,?,?,?)')
        .run(username, fullName, bcrypt.hashSync(pw, 10), r, nowDateTime());
      const created = db.prepare(`SELECT ${publicCols} FROM users WHERE id = ?`).get(info.lastInsertRowid);
      logActivity(db, req.user, 'user', created.id, 'user.created', { username: created.username, fullName: created.fullName, role: created.role });
      res.status(201).json(created);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Username already exists');
      throw e;
    }
  });

  router.patch('/:id', validate(params, 'params'), validate(patchSchema), (req, res) => {
    const { id } = req.valid.params;
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (target?.role === 'saygak') throw badRequest(SAYGAK_MSG);
    const { password: pw, isActive, ...rest } = req.valid.body;
    assertRole(rest.role);
    const sets = { ...rest };
    if (pw) sets.passwordHash = bcrypt.hashSync(pw, 10);
    if (isActive !== undefined) sets.isActive = isActive ? 1 : 0;
    // don't let an admin lock themselves out
    if (id === req.user.id && (sets.isActive === 0 || (sets.role && sets.role !== 'admin'))) {
      throw conflict('You cannot disable or demote your own account');
    }
    const before = db.prepare(`SELECT ${publicCols} FROM users WHERE id = ?`).get(id);
    const cols = Object.keys(sets);
    const info = db
      .prepare(`UPDATE users SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...sets, id });
    if (!info.changes) throw notFound('User not found');
    const after = db.prepare(`SELECT ${publicCols} FROM users WHERE id = ?`).get(id);
    logActivity(db, req.user, 'user', id, 'user.updated', {
      username: after.username,
      changes: diff(before, after, ['fullName', 'role', 'isActive']),
      passwordChanged: !!pw, // never the password itself
    });
    res.json(after);
  });

  return router;
}
