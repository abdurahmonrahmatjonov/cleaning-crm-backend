import { z } from 'zod';
import { badRequest } from './httpError.js';

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const sizeRow = z.object({ width: z.number().positive().max(100), length: z.number().positive().max(100) });
export const sizesTotal = (rows) => round2(rows.reduce((s, r) => s + r.area, 0));

export function normalizeSizes(rows) {
  return rows.map((r) => {
    const width = round2(r.width), length = round2(r.length);
    if (!width || !length) throw badRequest('Size must be at least 0.01 m');
    return { width, length, area: round2(width * length) };
  });
}

export function loadSizes(db, docNums) {
  const map = new Map();
  if (!docNums.length) return map;
  const rows = db.prepare(
    `SELECT s.lineId, s.width, s.length, s.area FROM order_line_sizes s JOIN order_lines l ON l.id = s.lineId
     WHERE l.docNum IN (${docNums.map(() => '?').join(',')}) ORDER BY s.id`).all(...docNums);
  for (const r of rows) (map.get(r.lineId) ?? map.set(r.lineId, []).get(r.lineId)).push({ width: r.width, length: r.length, area: r.area });
  return map;
}

export function replaceSizes(db, lineId, rows) {
  db.prepare('DELETE FROM order_line_sizes WHERE lineId = ?').run(lineId);
  const ins = db.prepare('INSERT INTO order_line_sizes (lineId, width, length, area) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(lineId, r.width, r.length, r.area);
}
