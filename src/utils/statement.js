import { ORDER_STATUS } from '../db.js';
import { round2 } from './sizes.js';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Monthly statement of a saygak. Months are by deliveredDate (charges) and paidDate (credits).
 *
 * INVARIANT: for the current month, closing === the client's current debt
 * (sum over delivered partner orders of docTotal - discount - paid). It holds because every
 * delivered order has deliveredDate <= today and every non-reversed batch has paidDate <= today.
 * It can break for a past month's statement-vs-today comparison (later payments/deliveries
 * fall outside that month), for a payment dated in a later month than the statement month,
 * or for deliveries/payments with future dates; the invariant is only asserted for the current month.
 */
export function buildStatement(db, clientId, month) {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month ${month}`);
  const from = `${month}-01`;
  const to = `${month}-${String(lastDay(month)).padStart(2, '0')}`;
  const D = ORDER_STATUS.DELIVERED;
  const sum = (sql, ...args) => round2(db.prepare(sql).get(...args).s);

  const charges = sum(
    `SELECT COALESCE(SUM(docTotal),0) s FROM orders WHERE clientId = ? AND kind = 'partner' AND status = ? AND deliveredDate BETWEEN ? AND ?`,
    clientId, D, from, to,
  );
  const credits = sum(
    `SELECT COALESCE(SUM(amount + discount),0) s FROM payment_batches WHERE clientId = ? AND reversedAt = '' AND paidDate BETWEEN ? AND ?`,
    clientId, from, to,
  );
  const opening = round2(
    sum(`SELECT COALESCE(SUM(docTotal),0) s FROM orders WHERE clientId = ? AND kind = 'partner' AND status = ? AND deliveredDate != '' AND deliveredDate < ?`, clientId, D, from) -
      sum(`SELECT COALESCE(SUM(amount + discount),0) s FROM payment_batches WHERE clientId = ? AND reversedAt = '' AND paidDate < ?`, clientId, from),
  );
  const orders = db
    .prepare(
      `SELECT o.docNum, o.deliveredDate, o.docTotal,
              COALESCE((SELECT SUM(l.sqm) FROM order_lines l WHERE l.docNum = o.docNum AND l.unit = 'kv.m'), 0) sqmTotal
       FROM orders o WHERE o.clientId = ? AND o.kind = 'partner' AND o.status = ? AND o.deliveredDate BETWEEN ? AND ?
       ORDER BY o.deliveredDate, o.docNum`,
    )
    .all(clientId, D, from, to)
    .map((o) => ({ ...o, sqmTotal: round2(o.sqmTotal) }));
  const payments = db
    .prepare(
      `SELECT batchId, paidDate, amount, discount FROM payment_batches
       WHERE clientId = ? AND reversedAt = '' AND paidDate BETWEEN ? AND ? ORDER BY paidDate, createdAt, batchId`,
    )
    .all(clientId, from, to);
  const inProgress = db
    .prepare(
      `SELECT docNum, status, createdAt FROM orders WHERE clientId = ? AND kind = 'partner' AND status IN (?,?,?,?) ORDER BY docNum`,
    )
    .all(clientId, ORDER_STATUS.RECEIVED, ORDER_STATUS.PICKED_UP, ORDER_STATUS.WASHED, ORDER_STATUS.PACKED);

  return { month, opening, charges, credits, closing: round2(opening + charges - credits), orders, payments, inProgress };
}
