import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { ORDER_STATUS } from '../db.js';
import { notFound } from '../utils/httpError.js';
import { id as idSchema, pagination } from '../utils/schemas.js';

const listQuery = pagination.extend({ search: z.string().trim().max(100).optional() });
const params = z.object({ id: idSchema });

// Debt of a client = unpaid part of their delivered orders.
const DEBT_SQL = `COALESCE(SUM(CASE WHEN o.status = @delivered AND o.docTotal > o.paid THEN o.docTotal - o.paid ELSE 0 END), 0)`;

export function clientsRouter(db) {
  const router = Router();
  const base = { delivered: ORDER_STATUS.DELIVERED };

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

  router.get('/:id', validate(params, 'params'), (req, res) => {
    const { id } = req.valid.params;
    const client = db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.createdAt, COUNT(o.docNum) ordersCount, ${DEBT_SQL} debt
         FROM clients c LEFT JOIN orders o ON o.clientId = c.id WHERE c.id = @id GROUP BY c.id`,
      )
      .get({ ...base, id });
    if (!client) throw notFound('Client not found');
    const orders = db
      .prepare(
        `SELECT docNum, status, docTotal, paid, createdAt, deliveredDate FROM orders
         WHERE clientId = ? ORDER BY docNum DESC`,
      )
      .all(id);
    res.json({ ...client, orders });
  });

  return router;
}
