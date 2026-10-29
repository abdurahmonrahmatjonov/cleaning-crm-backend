import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { ORDER_STATUS } from '../db.js';
import { badRequest } from '../utils/httpError.js';
import { dateString } from '../utils/schemas.js';

const rangeQuery = z.object({ from: dateString, to: dateString });

export function reportsRouter(db) {
  const router = Router();

  // Money overview for a date range. Admin only.
  router.get('/summary', requireRole('admin'), validate(rangeQuery, 'query'), (req, res) => {
    const { from, to } = req.valid.query;
    if (from > to) throw badRequest('"from" must not be after "to"');
    const r = { from, to };

    const ordersByStatus = db
      .prepare('SELECT status, COUNT(*) count FROM orders WHERE createdAt BETWEEN @from AND @to GROUP BY status')
      .all(r);

    // Sales = orders delivered in the range
    const sales = db
      .prepare(
        `SELECT COUNT(*) ordersCount, COALESCE(SUM(docTotal),0) total
         FROM orders WHERE status = @delivered AND deliveredDate BETWEEN @from AND @to`,
      )
      .get({ ...r, delivered: ORDER_STATUS.DELIVERED });
    const totalSqm = db
      .prepare(
        `SELECT COALESCE(SUM(l.sqm),0) v FROM order_lines l JOIN orders o ON o.docNum = l.docNum
         WHERE o.status = @delivered AND o.deliveredDate BETWEEN @from AND @to`,
      )
      .get({ ...r, delivered: ORDER_STATUS.DELIVERED }).v;

    // Money actually received in the range (includes late debt payments)
    const collected = db
      .prepare('SELECT COALESCE(SUM(amount),0) v FROM payments WHERE paidDate BETWEEN @from AND @to')
      .get(r).v;

    const expensesByType = db
      .prepare(
        `SELECT expenseType, SUM(amount) total FROM expenses
         WHERE expenseDate BETWEEN @from AND @to GROUP BY expenseType ORDER BY total DESC`,
      )
      .all(r);
    const expensesTotal = expensesByType.reduce((a, e) => a + e.total, 0);

    const outstandingDebt = db
      .prepare(
        `SELECT COALESCE(SUM(docTotal - paid),0) v FROM orders WHERE status = ? AND docTotal > paid`,
      )
      .get(ORDER_STATUS.DELIVERED).v;

    res.json({
      from,
      to,
      ordersByStatus,
      sales: { ordersCount: sales.ordersCount, total: sales.total, totalSqm },
      collected,
      expenses: { total: expensesTotal, byType: expensesByType },
      netCash: collected - expensesTotal, // money in minus money out
      outstandingDebt, // all-time, not limited to the range
    });
  });

  // Clients who still owe money.
  router.get('/debtors', requireRole('admin', 'operator'), (_req, res) => {
    const rows = db
      .prepare(
        `SELECT c.id clientId, c.name, c.phone, COUNT(*) ordersCount, SUM(o.docTotal - o.paid) debt
         FROM orders o JOIN clients c ON c.id = o.clientId
         WHERE o.status = ? AND o.docTotal > o.paid GROUP BY c.id ORDER BY debt DESC`,
      )
      .all(ORDER_STATUS.DELIVERED);
    res.json({ data: rows, meta: { totalDebt: rows.reduce((a, r) => a + r.debt, 0) } });
  });

  return router;
}
