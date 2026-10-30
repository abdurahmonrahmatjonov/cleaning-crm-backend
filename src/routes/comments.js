import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { logActivity } from '../utils/activity.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { id as idSchema } from '../utils/schemas.js';
import { nowDateTime } from '../utils/time.js';

// What can be commented on, who may see/write comments there, and how to check the record exists.
const TARGETS = {
  order: { perm: 'orders.view', exists: 'SELECT 1 FROM orders WHERE docNum = ?' },
  client: { perm: 'clients.view', exists: 'SELECT 1 FROM clients WHERE id = ?' },
  expense: { perm: 'expenses.manage', exists: 'SELECT 1 FROM expenses WHERE id = ?' },
};
const entity = z.enum(Object.keys(TARGETS));
const target = z.object({ entity, entityId: idSchema });
const createSchema = target.extend({ body: z.string().trim().min(1).max(1000) });
const countsQuery = z.object({
  entity,
  ids: z.string().regex(/^\d+(,\d+){0,199}$/, 'Expected up to 200 comma separated ids'),
});
const params = z.object({ id: idSchema });

/** Comments on orders, clients and expenses. You need the same permission that lets you see the record. */
export function commentsRouter(db) {
  const router = Router();

  const guard = (req, kind) => {
    const t = TARGETS[kind];
    if (!req.user.permissions.includes(t.perm)) throw new HttpError(403, 'Forbidden for your role');
    return t;
  };
  const present = (c) => ({ id: c.id, userId: c.userId, userName: c.userName, body: c.body, createdAt: c.createdAt });

  router.get('/', validate(target, 'query'), (req, res) => {
    const { entity: kind, entityId } = req.valid.query;
    const t = guard(req, kind);
    if (!db.prepare(t.exists).get(entityId)) throw notFound('Record not found');
    const rows = db.prepare('SELECT * FROM comments WHERE entity = ? AND entityId = ? ORDER BY id').all(kind, String(entityId));
    res.json({ data: rows.map(present) });
  });

  // { "<id>": count } for the comment badges in lists
  router.get('/counts', validate(countsQuery, 'query'), (req, res) => {
    const { entity: kind, ids } = req.valid.query;
    guard(req, kind);
    const list = ids.split(',');
    const rows = db
      .prepare(`SELECT entityId, COUNT(*) c FROM comments WHERE entity = ? AND entityId IN (${list.map(() => '?').join(',')}) GROUP BY entityId`)
      .all(kind, ...list);
    res.json({ data: Object.fromEntries(rows.map((r) => [r.entityId, r.c])) });
  });

  router.post('/', validate(createSchema), (req, res) => {
    const { entity: kind, entityId, body } = req.valid.body;
    const t = guard(req, kind);
    if (!db.prepare(t.exists).get(entityId)) throw notFound('Record not found');
    const created = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO comments (entity, entityId, userId, userName, body, createdAt) VALUES (?,?,?,?,?,?)')
        .run(kind, String(entityId), req.user.id, req.user.fullName, body, nowDateTime());
      // shows up in the record's history too
      logActivity(db, req.user, kind, entityId, 'comment.added', { text: body.slice(0, 300) });
      return db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);
    })();
    res.status(201).json(present(created));
  });

  // The author can remove their own comment; admins can remove any.
  router.delete('/:id', validate(params, 'params'), (req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.valid.params.id);
    if (!c) throw notFound('Comment not found');
    guard(req, c.entity);
    if (c.userId !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'You can only delete your own comments');
    db.transaction(() => {
      db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
      logActivity(db, req.user, c.entity, c.entityId, 'comment.deleted', { text: c.body.slice(0, 300), author: c.userName });
    })();
    res.status(204).end();
  });

  return router;
}
