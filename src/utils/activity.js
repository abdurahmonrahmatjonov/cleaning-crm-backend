import { nowDateTime } from './time.js';

/**
 * Append-only audit trail: who did what, to which record, and when.
 * Call it inside the same transaction as the change it describes, so the log can never disagree with the data.
 * Never put secrets (passwords, tokens) in `details`.
 */
export function logActivity(db, user, entity, entityId, action, details = {}) {
  db.prepare(
    'INSERT INTO activity_log (at, userId, userName, entity, entityId, action, details) VALUES (?,?,?,?,?,?,?)',
  ).run(nowDateTime(), user?.id ?? null, user?.fullName ?? 'system', entity, String(entityId), action, JSON.stringify(details));
}

/** Shallow diff of two plain objects, limited to `fields`: { field: { from, to } } for the ones that changed. */
export function diff(before, after, fields) {
  const out = {};
  for (const f of fields) if (before[f] !== after[f]) out[f] = { from: before[f], to: after[f] };
  return out;
}
