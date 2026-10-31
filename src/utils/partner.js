/** Most open ("Qabul qilindi") orders a saygak may have at once. */
export const PARTNER_OPEN_ORDER_CAP = 10;

/** The saygak's special prices as Map<serviceId, price>. */
export const priceMap = (db, clientId) =>
  new Map(db.prepare('SELECT serviceId, price FROM client_prices WHERE clientId = ?').all(clientId).map((r) => [r.serviceId, r.price]));
