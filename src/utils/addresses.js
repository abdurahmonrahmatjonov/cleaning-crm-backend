import { nowDateTime } from './time.js';

// Two pins closer than this (about 30 m) are the same place.
const SAME_PLACE = 0.0003;

/**
 * Save the address a client gave on an order. A place the client already used just becomes the most recent one
 * (and gets a landmark if it had none); a new place is added. Returns the address row.
 */
export function rememberAddress(db, clientId, { latitude, longitude }, landmark = '') {
  const now = nowDateTime();
  const near = db
    .prepare(
      `SELECT * FROM client_addresses WHERE clientId = ? AND ABS(latitude - ?) < ? AND ABS(longitude - ?) < ?
       ORDER BY lastUsedAt DESC LIMIT 1`,
    )
    .get(clientId, latitude, SAME_PLACE, longitude, SAME_PLACE);
  if (near) {
    db.prepare('UPDATE client_addresses SET lastUsedAt = ?, landmark = ? WHERE id = ?').run(now, landmark || near.landmark, near.id);
    return db.prepare('SELECT * FROM client_addresses WHERE id = ?').get(near.id);
  }
  const info = db
    .prepare('INSERT INTO client_addresses (clientId, latitude, longitude, landmark, createdAt, lastUsedAt) VALUES (?,?,?,?,?,?)')
    .run(clientId, latitude, longitude, landmark, now, now);
  return db.prepare('SELECT * FROM client_addresses WHERE id = ?').get(info.lastInsertRowid);
}

export const presentAddress = (a) => ({
  id: a.id,
  latitude: a.latitude,
  longitude: a.longitude,
  landmark: a.landmark,
  lastUsedAt: a.lastUsedAt,
});
