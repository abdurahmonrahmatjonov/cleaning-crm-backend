import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { conflict, notFound } from '../utils/httpError.js';
import { id as idSchema } from '../utils/schemas.js';
import { nowDateTime } from '../utils/time.js';

const role = z.enum(['admin', 'operator', 'driver']);
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

const publicCols = 'id, username, fullName, role, isActive, createdAt';

export function usersRouter(db) {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', (_req, res) => {
    res.json({ data: db.prepare(`SELECT ${publicCols} FROM users ORDER BY id`).all() });
  });

  router.post('/', validate(createSchema), (req, res) => {
    const { username, fullName, password: pw, role: r } = req.valid.body;
    try {
      const info = db
        .prepare('INSERT INTO users (username, fullName, passwordHash, role, createdAt) VALUES (?,?,?,?,?)')
        .run(username, fullName, bcrypt.hashSync(pw, 10), r, nowDateTime());
      res.status(201).json(db.prepare(`SELECT ${publicCols} FROM users WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Username already exists');
      throw e;
    }
  });

  router.patch('/:id', validate(params, 'params'), validate(patchSchema), (req, res) => {
    const { id } = req.valid.params;
    const { password: pw, isActive, ...rest } = req.valid.body;
    const sets = { ...rest };
    if (pw) sets.passwordHash = bcrypt.hashSync(pw, 10);
    if (isActive !== undefined) sets.isActive = isActive ? 1 : 0;
    // don't let an admin lock themselves out
    if (id === req.user.id && (sets.isActive === 0 || (sets.role && sets.role !== 'admin'))) {
      throw conflict('You cannot disable or demote your own account');
    }
    const cols = Object.keys(sets);
    const info = db
      .prepare(`UPDATE users SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...sets, id });
    if (!info.changes) throw notFound('User not found');
    res.json(db.prepare(`SELECT ${publicCols} FROM users WHERE id = ?`).get(id));
  });

  return router;
}
