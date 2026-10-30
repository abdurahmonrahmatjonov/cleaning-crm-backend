import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { dateString, id as idSchema, pagination } from '../utils/schemas.js';

const query = pagination.extend({
  entity: z.string().regex(/^[a-z_]{1,30}$/).optional(),
  entityId: z.string().max(60).optional(),
  userId: idSchema.optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  search: z.string().trim().max(100).optional(),
});

/** The full audit trail, for admins. Order timelines are served by /orders/:docNum/history. */
export function activityRouter(db) {
  const router = Router();
  router.use(requireRole('admin'));

  router.get('/', validate(query, 'query'), (req, res) => {
    const q = req.valid.query;
    const where = [];
    const args = { limit: q.limit, offset: (q.page - 1) * q.limit };
    if (q.entity) (where.push('entity = @entity'), (args.entity = q.entity));
    if (q.entityId) (where.push('entityId = @entityId'), (args.entityId = q.entityId));
    if (q.userId) (where.push('userId = @userId'), (args.userId = q.userId));
    if (q.from) (where.push('at >= @from'), (args.from = `${q.from} 00:00:00`));
    if (q.to) (where.push('at <= @to'), (args.to = `${q.to} 23:59:59`));
    if (q.search) {
      where.push(`(userName LIKE @s ESCAPE '\\' OR entityId LIKE @s ESCAPE '\\' OR action LIKE @s ESCAPE '\\' OR details LIKE @s ESCAPE '\\')`);
      args.s = `%${q.search.replace(/[\\%_]/g, '\\$&')}%`;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM activity_log ${w}`).get(args).c;
    const rows = db.prepare(`SELECT * FROM activity_log ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all(args);
    res.json({
      data: rows.map((r) => ({
        id: r.id, at: r.at, userId: r.userId, userName: r.userName,
        entity: r.entity, entityId: r.entityId, action: r.action, details: JSON.parse(r.details),
      })),
      meta: { page: q.page, limit: q.limit, total },
    });
  });

  return router;
}
