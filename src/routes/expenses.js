import { Router } from 'express';
import { logActivity } from '../utils/activity.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { badRequest } from '../utils/httpError.js';
import { dateString, id as idSchema, pagination } from '../utils/schemas.js';
import { nowDateTime, today } from '../utils/time.js';

const createSchema = z.object({
  expenseTypeId: idSchema,
  amount: z.number().positive().max(1e12),
  expenseDate: dateString,
});

const listQuery = pagination.extend({
  expenseTypeId: idSchema.optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

export function expensesRouter(db) {
  const router = Router();
  const getType = db.prepare('SELECT id, name FROM expense_types WHERE id = ? AND isActive = 1');
  const getExpense = db.prepare('SELECT * FROM expenses WHERE id = ?');

  const present = (e) => ({
    id: e.id,
    expenseTypeId: e.expenseTypeId,
    expenseType: e.expenseType,
    amount: e.amount,
    expenseDate: e.expenseDate,
    createdAt: e.createdAt,
    creator: { id: e.creatorId, name: e.creatorName },
  });

  router.post('/', validate(createSchema), (req, res) => {
    const b = req.valid.body;
    const type = getType.get(b.expenseTypeId);
    if (!type) throw badRequest('Unknown or inactive expense type', { path: 'expenseTypeId' });
    const info = db
      .prepare(
        `INSERT INTO expenses (expenseTypeId, expenseType, amount, expenseDate, createdAt, creatorId, creatorName)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(type.id, type.name, b.amount, b.expenseDate, today(), req.user.id, req.user.fullName);
    logActivity(db, req.user, 'expense', info.lastInsertRowid, 'expense.created', { type: type.name, amount: b.amount, date: b.expenseDate });
    res.status(201).json(present(getExpense.get(info.lastInsertRowid)));
  });

  router.get('/', validate(listQuery, 'query'), (req, res) => {
    const { page, limit, expenseTypeId, from, to } = req.valid.query;
    const where = [];
    const args = { limit, offset: (page - 1) * limit };
    if (expenseTypeId) (where.push('expenseTypeId = @expenseTypeId'), (args.expenseTypeId = expenseTypeId));
    if (from) (where.push('expenseDate >= @from'), (args.from = from));
    if (to) (where.push('expenseDate <= @to'), (args.to = to));
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { count, totalAmount } = db
      .prepare(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) totalAmount FROM expenses ${w}`)
      .get(args);
    const rows = db
      .prepare(`SELECT * FROM expenses ${w} ORDER BY expenseDate DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all(args);
    res.json({ data: rows.map(present), meta: { page, limit, total: count, totalAmount } });
  });

  return router;
}
