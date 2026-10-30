import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-secret';
const { openDb, seed } = await import('../src/db.js');
const { createApp, STAFF_MOUNTS } = await import('../src/app.js');
const { partnerGate, requirePartner, authenticate, requirePerm } = await import('../src/middleware/auth.js');
const { default: express } = await import('express');

let server, base, db;
let admin, operator, driver, packer;
let partnerA, partnerB, clientA, clientB; // saygak tokens and client ids, shared with later tests

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (username, password) => (await call('POST', '/api/auth/login', { body: { username, password } })).body.token;

const newOrder = (over = {}) => ({
  clientName: 'Ali Valiyev',
  clientPhone: '+998 90 123 45 67',
  location: { latitude: 41.31, longitude: 69.24 },
  landmark: 'Korzinka yonida',
  pickupTime: '2026-11-01T10:00',
  lines: [{ serviceId: 1, price: 15000 }, { serviceId: 2, price: 10000 }],
  ...over,
});

before(async () => {
  db = openDb(':memory:');
  seed(db, { adminPassword: 'admin12345', now: '2026-10-29 10:00:00' });
  server = createApp(db, { loginLimit: 1000 }).listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await login('admin', 'admin12345');
  for (const [username, role] of [['oper', 'operator'], ['driv', 'driver'], ['pack', 'packer']]) {
    const r = await call('POST', '/api/users', { token: admin, body: { username, fullName: `${role} user`, password: 'password123', role } });
    assert.equal(r.status, 201);
  }
  operator = await login('oper', 'password123');
  driver = await login('driv', 'password123');
  packer = await login('pack', 'password123');
});
after(() => server.close());

test('migration adds partner schema and enforces role/clientId pairing', () => {
  const db = openDb(':memory:');
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('clients').includes('isPartner'));
  assert.ok(cols('users').includes('clientId'));
  assert.ok(cols('orders').includes('kind'));
  assert.ok(cols('order_lines').includes('expectedQuantity'));
  assert.ok(cols('payments').includes('batchId'));
  for (const t of ['order_line_sizes', 'client_prices', 'payment_batches']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
  }
  assert.equal(db.prepare("SELECT isSystem FROM roles WHERE key = 'saygak'").get().isSystem, 1);
  db.prepare("INSERT INTO clients (name, phone, createdAt) VALUES ('P','+998900000001','2026-10-01')").run();
  const ins = (role, clientId) =>
    db.prepare("INSERT INTO users (username, fullName, passwordHash, role, createdAt, clientId) VALUES (?,?,?,?,?,?)")
      .run(`u${Math.random()}`, 'x', 'h', role, '2026-10-01', clientId);
  assert.throws(() => ins('saygak', null), /saygak/);
  assert.throws(() => ins('operator', 1), /saygak/);
  assert.doesNotThrow(() => ins('saygak', 1));
  assert.throws(() => ins('saygak', 1), /UNIQUE/); // one login per saygak
  openDb(':memory:'); // idempotent open
});

const pickedOrder = async (lines) => {
  const o = (await call('POST', '/api/orders', { token: operator, body: newOrder({ lines }) })).body;
  const p = await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { waybillNumber: 'N1', deliveryTime: '2026-11-02T10:00', lines: o.lines.map((l) => ({ id: l.id, quantity: 2 })) } });
  assert.equal(p.status, 200);
  return p.body;
};
const wash = (o, lines) => call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer, body: { lines } });

test('sizes: wash saves, pack replaces, [] clears, absent keeps', async () => {
  const a = await pickedOrder([{ serviceId: 1, price: 15000 }]);
  const w = await wash(a, [{ id: a.lines[0].id, quantity: 2, sizes: [{ width: 12.4, length: 3.1 }, { width: 2, length: 3 }] }]);
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.lines[0].sizes.map((s) => s.area), [38.44, 6]);
  assert.equal(w.body.lines[0].sizesTotal, 44.44);
  const pack = await call('PATCH', `/api/orders/${a.docNum}/pack`, { token: packer, body: { lines: [{ id: a.lines[0].id, quantity: 2, sizes: [{ width: 5, length: 4 }] }] } });
  assert.equal(pack.body.lines[0].sizesTotal, 20);
  assert.equal(pack.body.lines[0].sizes.length, 1);

  const b = await pickedOrder([{ serviceId: 1, price: 15000 }]);
  const cleared = await wash(b, [{ id: b.lines[0].id, quantity: 2, sizes: [] }]);
  assert.deepEqual(cleared.body.lines[0].sizes, []);

  const c = await pickedOrder([{ serviceId: 1, price: 15000 }]);
  const kept = await wash(c, [{ id: c.lines[0].id, quantity: 2 }]);
  assert.deepEqual(kept.body.lines[0].sizes, []);
  const packNoSizes = await call('PATCH', `/api/orders/${c.docNum}/pack`, { token: packer, body: { lines: [{ id: c.lines[0].id, quantity: 2 }] } });
  assert.equal(packNoSizes.status, 200);
});

test('sizes: absent keeps previous sizes; activity logs and deliver log carry sizes', async () => {
  const a = await pickedOrder([{ serviceId: 1, price: 15000 }]);
  await wash(a, [{ id: a.lines[0].id, quantity: 2, sizes: [{ width: 5, length: 4 }] }]);
  const pack = await call('PATCH', `/api/orders/${a.docNum}/pack`, { token: packer, body: { lines: [{ id: a.lines[0].id, quantity: 2 }] } });
  assert.equal(pack.body.lines[0].sizesTotal, 20);
  const del = await call('PATCH', `/api/orders/${a.docNum}/deliver`, { token: admin, body: { paid: 0, lines: [{ id: a.lines[0].id, sqm: 19 }] } });
  assert.equal(del.status, 200);
  const logs = db.prepare("SELECT action, details FROM activity_log WHERE entityId = ? ORDER BY id").all(String(a.docNum));
  const washed = JSON.parse(logs.find((l) => l.action === 'order.washed').details);
  assert.deepEqual(washed.counts[0].sizes.from, []);
  assert.equal(washed.counts[0].sizes.to[0].area, 20);
  const delivered = JSON.parse(logs.find((l) => l.action === 'order.delivered').details);
  assert.equal(delivered.lines[0].sizesTotal, 20);
  assert.equal(delivered.lines[0].sqm, 19);
});

test('sizes: invalid input and non kv.m lines are rejected', async () => {
  const dona = (await call('POST', '/api/services', { token: admin, body: { name: 'Dona test', unit: 'dona' } })).body;
  const d = await pickedOrder([{ serviceId: dona.id, price: 3000 }]);
  assert.equal((await wash(d, [{ id: d.lines[0].id, quantity: 2, sizes: [{ width: 1, length: 1 }] }])).status, 400);
  const k = await pickedOrder([{ serviceId: 1, price: 15000 }]);
  for (const bad of [{ width: -1, length: 1 }, { width: 0, length: 1 }, { width: 101, length: 1 }, { width: 0.001, length: 1 }]) {
    assert.equal((await wash(k, [{ id: k.lines[0].id, quantity: 2, sizes: [bad] }])).status, 400, JSON.stringify(bad));
  }
});

// Creates a partner client with prices and a login; returns { client, token }.
const makePartner = async (name, phone, username, prices = [{ serviceId: 1, price: 6000 }]) => {
  const client = (await call('POST', '/api/clients', { token: operator, body: { name, phone } })).body;
  assert.equal((await call('PATCH', `/api/clients/${client.id}`, { token: operator, body: { isPartner: true } })).status, 200);
  assert.equal((await call('PUT', `/api/clients/${client.id}/prices`, { token: admin, body: { prices } })).status, 200);
  assert.equal((await call('PUT', `/api/clients/${client.id}/login`, { token: admin, body: { username, password: 'password123' } })).status, 200);
  return { client, token: await login(username, 'password123') };
};

test('partner setup: admin-only prices/logins, role locked, token revoked on deactivate', async () => {
  const mk = async (name, phone) => (await call('POST', '/api/clients', { token: operator, body: { name, phone } })).body;
  const A = await mk('Saygak A', '+998901111111');
  assert.equal((await call('PUT', `/api/clients/${A.id}/prices`, { token: operator, body: { prices: [{ serviceId: 1, price: 6000 }] } })).status, 403);
  assert.equal((await call('PUT', `/api/clients/${A.id}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: 6000 }] } })).status, 409); // not a partner yet
  assert.equal((await call('PUT', `/api/clients/${A.id}/login`, { token: admin, body: { username: 'saygakA', password: 'password123' } })).status, 409);
  assert.equal((await call('PATCH', `/api/clients/${A.id}`, { token: operator, body: { isPartner: true } })).status, 200);
  assert.equal((await call('PUT', `/api/clients/${A.id}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: 6000 }] } })).status, 200);
  assert.equal((await call('PUT', `/api/clients/${A.id}/login`, { token: operator, body: { username: 'saygakA', password: 'password123' } })).status, 403);
  assert.equal((await call('PUT', `/api/clients/${A.id}/login`, { token: admin, body: { username: 'saygakA', password: 'password123' } })).status, 200);
  const t = await login('saygakA', 'password123');
  const me = await call('GET', '/api/auth/me', { token: t });
  assert.equal(me.body.clientId, A.id);
  assert.equal((await call('GET', '/api/users', { token: admin })).body.data.some((u) => u.role === 'saygak'), false);
  assert.equal((await call('POST', '/api/users', { token: admin, body: { username: 'x1x', fullName: 'x', password: 'password123', role: 'saygak' } })).status, 400);
  assert.equal((await call('PATCH', '/api/roles/saygak', { token: admin, body: { permissions: ['expenses.manage'] } })).status, 409);
  assert.equal((await call('PATCH', `/api/clients/${A.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: t })).status, 401);
});

test('partner setup: makePartner fixtures, login endpoints, prices listing', async () => {
  ({ client: { id: clientA }, token: partnerA } = await makePartner('Saygak PA', '+998902222221', 'partnerA', [{ serviceId: 1, price: 6000 }]));
  ({ client: { id: clientB }, token: partnerB } = await makePartner('Saygak PB', '+998902222222', 'partnerB', [{ serviceId: 1, price: 7000 }]));
  const me = await call('GET', '/api/auth/me', { token: partnerA });
  assert.equal(me.body.clientId, clientA);
  assert.equal(me.body.role, 'saygak');
  const lg = await call('POST', '/api/auth/login', { body: { username: 'partnerB', password: 'password123' } });
  assert.equal(lg.body.user.clientId, clientB);
  assert.equal((await call('GET', '/api/auth/me', { token: operator })).body.clientId, null);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'oper', password: 'password123' } })).body.user.clientId, null);

  const prices = (await call('GET', `/api/clients/${clientA}/prices`, { token: operator })).body.data;
  assert.equal(prices.find((p) => p.serviceId === 1).price, 6000);
  assert.equal(prices.find((p) => p.serviceId === 2).price, null);
  assert.ok(prices[0].serviceName && prices[0].unit);
  // replace set: serviceId 1 dropped, 2 added
  assert.equal((await call('PUT', `/api/clients/${clientB}/prices`, { token: admin, body: { prices: [{ serviceId: 2, price: 5000 }] } })).status, 200);
  const after = (await call('GET', `/api/clients/${clientB}/prices`, { token: operator })).body.data;
  assert.equal(after.find((p) => p.serviceId === 1).price, null);
  assert.equal(after.find((p) => p.serviceId === 2).price, 5000);
  assert.equal((await call('PUT', `/api/clients/${clientB}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: 7000 }] } })).status, 200);
  const log = db.prepare("SELECT details FROM activity_log WHERE action = 'client.prices' AND entityId = ?").all(String(clientB));
  assert.ok(log.length >= 2);
  assert.ok(!JSON.stringify(log).includes('password'));
  // validation
  assert.equal((await call('PUT', `/api/clients/${clientB}/prices`, { token: admin, body: { prices: [{ serviceId: 9999, price: 1 }] } })).status, 400);
  assert.equal((await call('PUT', `/api/clients/${clientB}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: 1 }, { serviceId: 1, price: 2 }] } })).status, 400);
  assert.equal((await call('PUT', `/api/clients/${clientB}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: -1 }] } })).status, 400);

  // login: GET, reset, uniqueness, deactivate/reactivate
  const g = await call('GET', `/api/clients/${clientA}/login`, { token: admin });
  assert.deepEqual(g.body, { username: 'partnerA', isActive: true });
  assert.equal((await call('GET', `/api/clients/${clientA}/login`, { token: operator })).status, 403);
  const plain = (await call('POST', '/api/clients', { token: operator, body: { name: 'Plain', phone: '+998903333331' } })).body;
  assert.equal((await call('GET', `/api/clients/${plain.id}/login`, { token: admin })).body, null);
  assert.equal((await call('PUT', `/api/clients/${clientA}/login`, { token: admin, body: { username: 'partnerB', password: 'password123' } })).status, 409);
  assert.equal((await call('PUT', `/api/clients/${clientA}/login`, { token: admin, body: { username: 'oper', password: 'password123' } })).status, 409);
  assert.equal((await call('PUT', `/api/clients/${clientA}/login`, { token: admin, body: { username: 'partnerA', password: 'short' } })).status, 400);
  const reset = await call('PUT', `/api/clients/${clientA}/login`, { token: admin, body: { username: 'partnerA', password: 'newpassword1' } });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body, { username: 'partnerA', isActive: true });
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'partnerA', password: 'password123' } })).status, 401);
  partnerA = await login('partnerA', 'newpassword1');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE clientId = ?").get(clientA).n, 1);
  assert.equal((await call('PATCH', `/api/clients/${plain.id}/login`, { token: admin, body: { isActive: false } })).status, 404);
  assert.equal((await call('PATCH', `/api/clients/${clientB}/login`, { token: admin, body: { isActive: false } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'partnerB', password: 'password123' } })).status, 401);
  assert.equal((await call('PATCH', `/api/clients/${clientB}/login`, { token: admin, body: { isActive: true } })).status, 200);
  partnerB = await login('partnerB', 'password123');
  // no password / hash ever in logs or responses
  const logs = JSON.stringify(db.prepare("SELECT details FROM activity_log WHERE action LIKE 'client.login%'").all());
  assert.ok(logs.includes('client.login') || logs.length > 2);
  assert.ok(!/password123|newpassword1|\$2[aby]\$/.test(logs));
  assert.ok(!JSON.stringify(g.body).includes('Hash'));
  assert.equal((await call('DELETE', `/api/clients/${clientA}`, { token: admin })).status, 409); // has a login: never a 500
  // isPartner exposed on get + list
  assert.equal((await call('GET', `/api/clients/${clientA}`, { token: operator })).body.isPartner, 1);
  const list = (await call('GET', '/api/clients?limit=100', { token: operator })).body.data;
  assert.equal(list.find((c) => c.id === clientA).isPartner, 1);
  assert.equal(list.find((c) => c.id === plain.id).isPartner, 0);
});

test('partner setup: users API cannot touch saygak users, roles locked, no clientId accepted', async () => {
  const sayId = db.prepare('SELECT id FROM users WHERE clientId = ?').get(clientA).id;
  const patch = (body) => call('PATCH', `/api/users/${sayId}`, { token: admin, body });
  assert.equal((await patch({ fullName: 'Hacked' })).status, 400);
  assert.equal((await patch({ password: 'password999' })).status, 400);
  const opId = db.prepare("SELECT id FROM users WHERE username = 'oper'").get().id;
  assert.equal((await call('PATCH', `/api/users/${opId}`, { token: admin, body: { role: 'saygak' } })).status, 400);
  // clientId is not an accepted field: it is ignored or rejected, never applied
  await call('PATCH', `/api/users/${opId}`, { token: admin, body: { clientId: clientB } });
  await call('POST', '/api/users', { token: admin, body: { username: 'withcid', fullName: 'x', password: 'password123', role: 'operator', clientId: clientB } });
  assert.equal(db.prepare('SELECT clientId FROM users WHERE id = ?').get(opId).clientId, null);
  assert.equal(db.prepare("SELECT clientId FROM users WHERE username = 'withcid'").get()?.clientId ?? null, null);
  // roles
  assert.equal((await call('DELETE', '/api/roles/saygak', { token: admin })).status, 409);
  assert.equal((await call('PATCH', '/api/roles/saygak', { token: admin, body: { name: 'Hijack' } })).status, 409);
  assert.equal((await call('POST', '/api/roles', { token: admin, body: { name: 'Saygak', permissions: [] } })).status, 409);
  assert.equal((await call('POST', '/api/roles', { token: admin, body: { name: 'SAYGAK!', permissions: [] } })).status, 409);
  const r = db.prepare("SELECT name, isSystem, permissions FROM roles WHERE key = 'saygak'").get();
  assert.deepEqual(r, { name: 'Saygak', isSystem: 1, permissions: '[]' });
});

test('migration fix-up locks a pre-existing custom saygak role', () => {
  const path = `${process.env.TMPDIR || '/tmp'}/saygak-lock-${process.pid}.db`;
  const d = openDb(path);
  d.prepare("DELETE FROM settings WHERE key = 'saygak_role_locked'").run();
  d.prepare("UPDATE roles SET isSystem = 0, permissions = '[\"expenses.manage\"]', name = 'Custom' WHERE key = 'saygak'").run();
  d.close();
  const d2 = openDb(path);
  assert.deepEqual(d2.prepare("SELECT name, isSystem, permissions FROM roles WHERE key = 'saygak'").get(), { name: 'Saygak', isSystem: 1, permissions: '[]' });
  d2.close();
  for (const f of [path, `${path}-wal`, `${path}-shm`]) { try { process.getBuiltinModule('fs').unlinkSync(f); } catch {} }
});

test('un-flagging a saygak is blocked while the login is active', async () => {
  const { client } = await makePartner('Saygak Unflag', '+998902222231', 'unflagP');
  const unflag = () => call('PATCH', `/api/clients/${client.id}`, { token: operator, body: { isPartner: false } });
  assert.equal((await unflag()).status, 409);
  assert.equal(db.prepare('SELECT isPartner FROM clients WHERE id = ?').get(client.id).isPartner, 1);
  assert.equal((await call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  assert.equal((await unflag()).status, 200);
  assert.equal(db.prepare('SELECT isPartner FROM clients WHERE id = ?').get(client.id).isPartner, 0);
  // a partner with no login can be un-flagged
  const c = (await call('POST', '/api/clients', { token: operator, body: { name: 'Saygak NoLogin', phone: '+998902222232' } })).body;
  assert.equal((await call('PATCH', `/api/clients/${c.id}`, { token: operator, body: { isPartner: true } })).status, 200);
  assert.equal((await call('PATCH', `/api/clients/${c.id}`, { token: operator, body: { isPartner: false } })).status, 200);
});

test('prices reject an inactive service', async () => {
  const svc = (await call('POST', '/api/services', { token: admin, body: { name: 'Inactive price svc', unit: 'metr' } })).body;
  assert.equal((await call('PATCH', `/api/services/${svc.id}`, { token: admin, body: { isActive: false } })).status, 200);
  const r = await call('PUT', `/api/clients/${clientA}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: 6000 }, { serviceId: svc.id, price: 1000 }] } });
  assert.equal(r.status, 400);
});

test('access gate: saygak denied on every staff mount; staff denied on /partner', async () => {
  assert.ok(Array.isArray(STAFF_MOUNTS));
  assert.ok(STAFF_MOUNTS.length >= 11);
  for (const m of ['users', 'roles', 'chat', 'activity', 'comments', 'services', 'expense-types', 'orders', 'expenses', 'clients', 'reports']) {
    assert.ok(STAFF_MOUNTS.includes(`/api/${m}`), m);
  }
  assert.ok(!STAFF_MOUNTS.includes('/api/auth') && !STAFF_MOUNTS.includes('/api/branding') && !STAFF_MOUNTS.includes('/api/partner'));
  for (const m of STAFF_MOUNTS) {
    assert.equal((await call('GET', m, { token: partnerA })).status, 403, m);
    assert.equal((await call('GET', m)).status, 401, `${m} unauthenticated`);
  }
  for (const p of ['/api/services', '/api/chat/global', '/api/orders/received', '/api/comments', '/api/clients', '/api/reports/summary', '/api/activity', '/api/users', '/api/roles', '/api/expenses', '/api/expense-types']) {
    assert.equal((await call('GET', p, { token: partnerA })).status, 403, p);
  }
  const ping = await call('GET', '/api/partner/ping', { token: partnerA });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.body, { ok: true });
  for (const t of [admin, operator, driver, packer]) assert.equal((await call('GET', '/api/partner/ping', { token: t })).status, 403);
  assert.equal((await call('GET', '/api/partner/ping')).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: partnerA })).status, 200);
  assert.equal((await call('GET', '/api/branding', { token: partnerA })).status, 200);
  // creating another app must not duplicate mounts
  const n = STAFF_MOUNTS.length;
  createApp(db, { loginLimit: 1000 });
  assert.equal(STAFF_MOUNTS.length, n);
});

const { notFoundHandler, errorHandler } = await import('../src/middleware/error.js');
const PASSIVE_SRC = new Set();
let AUTH_SRC;
// The only layers allowed to run on every path: matched by exact handle name (helmet/cors/json are factory
// closures) or by identity. Anything else path-less or on '/' is reported as `global:<name>`.
const KNOWN_GLOBAL = (h) =>
  ['helmetMiddleware', 'corsMiddleware', 'jsonParser'].includes(h.name) || h === notFoundHandler || h === errorHandler;
/**
 * Walks the real Express 5 stack and proves that every layer able to answer a request is preceded, within its
 * own mount group (the consecutive layers Express 5 creates for one `app.use(path, a, b, c)`) or, for a route,
 * within the handlers of each HTTP method, by `authenticate` and then partnerGate (requirePartner only on
 * /api/partner). A gate without authenticate in front fails open (req.user undefined), so it does not count.
 * Global layers (`layer.slash`, the predicate Express dispatches on, see router/lib/layer.js) must be in
 * KNOWN_GLOBAL; their names are pushed to `skipped` so the caller can pin the exact list. A path-bound layer
 * whose path is not among the probes is reported as `#index` (fail closed).
 */
function ungatedMounts(app, extraProbes = [], skipped = []) {
  if (!AUTH_SRC) {
    AUTH_SRC = String(authenticate(db));
    for (const f of [authenticate(db), requirePerm('x')]) PASSIVE_SRC.add(String(f));
  }
  const stack = app.router.stack;
  const hits = (l, p) => l.slash || l.matchers.some((m) => m(p));
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const at = (l, p) => !l.slash && !l.route && hits(l, p) && hits(l, `${p}/x`) && !hits(l, parent(p));
  const isGate = (h, p) => h === partnerGate || (h === requirePartner && p === '/api/partner');
  const passive = (h) => h === partnerGate || h === requirePartner || h.name === 'jsonParser' || PASSIVE_SRC.has(String(h));
  // true when the handlers in `before` contain authenticate followed (later) by a gate
  const authThenGate = (before, p) => {
    const a = before.findIndex((h) => String(h) === AUTH_SRC);
    return a >= 0 && before.slice(a + 1).some((h) => isGate(h, p));
  };
  const probes = [...new Set([...STAFF_MOUNTS, '/api/auth', '/api/branding', '/api/partner', ...extraProbes])];
  const out = [];
  stack.forEach((layer, i) => {
    if (layer.route) {
      const { path, stack: rs } = layer.route;
      const methods = new Set(rs.map((s) => s.method));
      // each method sees the `.all()` entries (method undefined) plus its own, in order
      const ok = [...methods].every((m) => {
        const hs = rs.filter((s) => s.method === m || s.method === undefined).map((s) => s.handle);
        const f = hs.findIndex((h) => !passive(h));
        return f < 0 || authThenGate(hs.slice(0, f), path);
      });
      if (!ok) out.push(`route:${path}`);
      return;
    }
    if (layer.slash) {
      if (KNOWN_GLOBAL(layer.handle)) skipped.push(layer.handle.name);
      else out.push(`global:${layer.handle.name || `#${i}`}`);
      return;
    }
    if (passive(layer.handle)) return;
    const p = probes.find((q) => at(layer, q));
    if (p === undefined) return void out.push(`#${i}`);
    let j = i;
    while (j > 0 && at(stack[j - 1], p)) j--;
    if (!authThenGate(stack.slice(j, i).map((l) => l.handle), p)) out.push(p);
  });
  return out;
}

test('access gate (structural): every path-bound layer sits behind the gate except auth, branding and /health', () => {
  // positive control: the real stack has exactly the allowlist, and exactly the known global layers
  const skipped = [];
  assert.deepEqual(ungatedMounts(createApp(db, { loginLimit: 1000 }), [], skipped).sort(), ['/api/auth', '/api/branding', 'route:/health']);
  assert.deepEqual(skipped, ['helmetMiddleware', 'corsMiddleware', 'jsonParser', 'notFoundHandler', 'errorHandler']);
  const leak = (add) => {
    const app = createApp(db, { loginLimit: 1000 });
    add(app);
    return ungatedMounts(app, ['/api/x', '/api/sub', '/api/a', '/api/b', '/api/s', '/api/leak']);
  };
  const extra = (out) => out.filter((m) => !['/api/auth', '/api/branding', 'route:/health'].includes(m));
  const ok = (_q, r) => r.json({ leaked: true });
  // negative controls, each through the same walker
  assert.deepEqual(extra(leak((a) => a.use('/api/leak', express.Router().get('/', ok)))), ['/api/leak']);
  assert.deepEqual(extra(leak((a) => a.use('/api/x', ok))), ['/api/x']);
  assert.deepEqual(extra(leak((a) => a.use('/api/sub', express()))), ['/api/sub']);
  assert.deepEqual(extra(leak((a) => { a.use('/api/a', authenticate(db), partnerGate); a.use('/api/b', express.Router()); })), ['/api/b']);
  assert.deepEqual(extra(leak((a) => a.use('/api/s', authenticate(db), requirePartner, express.Router()))), ['/api/s']);
  // path-less or '/' mounts are not a hiding place
  assert.deepEqual(extra(leak((a) => a.use(express.Router().get('/api/leak', ok)))), ['global:router']);
  assert.deepEqual(extra(leak((a) => a.use(express()))), ['global:mounted_app']);
  assert.deepEqual(extra(leak((a) => a.use('/', express.Router()))), ['global:router']);
  assert.deepEqual(extra(leak((a) => a.use(ok))).length, 1);
  assert.match(extra(leak((a) => a.use(ok)))[0] ?? '', /^global:/);
  // every method of a route needs the gate
  assert.deepEqual(extra(leak((a) => a.route('/api/r').get(authenticate(db), partnerGate, ok).post(ok))), ['route:/api/r']);
  assert.deepEqual(extra(leak((a) => a.route('/api/r').all(authenticate(db), partnerGate).get(ok).post(ok))), []);
  // a gate without authenticate in front fails open (req.user is undefined), so it does not count
  assert.deepEqual(extra(leak((a) => a.use('/api/x', partnerGate, express.Router()))), ['/api/x']);
  assert.deepEqual(extra(leak((a) => a.use('/api/x', partnerGate, authenticate(db), express.Router()))), ['/api/x']);
  assert.deepEqual(extra(leak((a) => a.route('/api/r').get(partnerGate, ok))), ['route:/api/r']);
  // a gated mount on a new path passes; an unknown path is flagged (fail closed)
  assert.deepEqual(extra(leak((a) => a.use('/api/x', authenticate(db), partnerGate, express.Router()))), []);
  assert.deepEqual(extra(leak((a) => a.use('/api/unprobed', authenticate(db), partnerGate, express.Router()))).length, 1);
});

test('partnerGate / requirePartner fail closed on odd clientIds', () => {
  const run = (mw, user) => { let arg = 'unset'; mw({ user }, {}, (e) => { arg = e; }); return arg; };
  const denied = (mw, user) => {
    const e = run(mw, user);
    return e?.status === 403 && e.message === 'Forbidden for your role';
  };
  // clientId 0 is locked out of both staff and partner routes
  assert.ok(denied(partnerGate, { clientId: 0 }));
  assert.ok(denied(requirePartner, { clientId: 0 }));
  // requirePartner admits only a positive integer
  assert.ok(denied(requirePartner, { clientId: '5' }));
  assert.ok(denied(requirePartner, { clientId: -1 }));
  assert.ok(denied(requirePartner, { clientId: 1.5 }));
  assert.equal(run(requirePartner, { clientId: 5 }), undefined);
  assert.ok(denied(partnerGate, { clientId: 5 }));
  assert.ok(denied(partnerGate, { clientId: '5' }));
  for (const clientId of [null, undefined]) {
    assert.equal(run(partnerGate, { clientId }), undefined);
    assert.ok(denied(requirePartner, { clientId }));
  }
});

test('access gate: deactivated saygak gets 401, not 403', async () => {
  const { client, token } = await makePartner('Saygak Gate', '+998902222241', 'gateP');
  assert.equal((await call('GET', '/api/partner/ping', { token })).status, 200);
  assert.equal((await call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  assert.equal((await call('GET', '/api/partner/ping', { token })).status, 401);
  assert.equal((await call('GET', '/api/services', { token })).status, 401);
});

// ---------- Task 5: partner-kind orders ----------

const partnerOrder = (clientId, over = {}) => call('POST', '/api/orders', { token: operator, body: { clientId, lines: [{ serviceId: 1, price: 1 }], ...over } });

test('partner order: staff create locks prices, no location needed, unpriced service rejected', async () => {
  const r = await partnerOrder(clientA);
  assert.equal(r.status, 201);
  assert.equal(r.body.kind, 'partner');
  assert.equal(r.body.lines[0].price, 6000);
  assert.equal(r.body.lines[0].customerPrice, 6000);
  assert.equal(r.body.lines[0].expectedQuantity, 0);
  assert.deepEqual(r.body.location, { latitude: 0, longitude: 0 });
  const bad = await partnerOrder(clientA, { lines: [{ serviceId: 2, price: 1 }] });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /lines\.0\.serviceId/);
  const exp = await partnerOrder(clientA, { lines: [{ serviceId: 1, expectedQuantity: 7 }] });
  assert.equal(exp.body.lines[0].expectedQuantity, 7);
  assert.equal((await partnerOrder(clientA, { lines: [{ serviceId: 1, expectedQuantity: 0 }] })).status, 400);
});

test('regular orders: unchanged shape works; missing location/pickupTime/price is 400; kind regular', async () => {
  const ok = await call('POST', '/api/orders', { token: operator, body: newOrder() });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.kind, 'regular');
  const { location, ...noLoc } = newOrder();
  assert.equal((await call('POST', '/api/orders', { token: operator, body: noLoc })).status, 400);
  const { pickupTime, ...noTime } = newOrder();
  assert.equal((await call('POST', '/api/orders', { token: operator, body: noTime })).status, 400);
  assert.equal((await call('POST', '/api/orders', { token: operator, body: newOrder({ lines: [{ serviceId: 1 }] }) })).status, 400);
  // regular pickup still needs waybill and delivery time
  const o = ok.body;
  const lines = o.lines.map((l) => ({ id: l.id, quantity: 2 }));
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { deliveryTime: '2026-11-02T10:00', lines } })).status, 400);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { waybillNumber: 'N9', lines } })).status, 400);
});

test('partner order: pickup without waybill, sizes, handover with no money, no payments, no location edit', async () => {
  const o = (await partnerOrder(clientA)).body;
  const ed = await call('PATCH', `/api/orders/${o.docNum}`, { token: operator, body: { location: { latitude: 41, longitude: 69 } } });
  assert.equal(ed.status, 409);
  const pk = await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { lines: [{ id: o.lines[0].id, quantity: 2 }] } });
  assert.equal(pk.status, 200);
  assert.equal(pk.body.waybillNumber, '');
  assert.equal(pk.body.deliveryTime, '');
  const id = o.lines[0].id;
  assert.equal((await wash(pk.body, [{ id, quantity: 2, sizes: [{ width: 5, length: 4 }] }])).status, 200);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/pack`, { token: packer, body: { lines: [{ id, quantity: 2 }] } })).status, 200);
  const dl = (body) => call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body });
  assert.equal((await dl({ paid: 1000, lines: [{ id, sqm: 20 }] })).status, 400);
  assert.equal((await dl({ discount: 500, lines: [{ id, sqm: 20 }] })).status, 400);
  const done = await dl({ lines: [{ id, sqm: 20 }] });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'Yetkazib berildi');
  assert.equal(done.body.docTotal, 120000);
  assert.equal(done.body.paid, 0);
  assert.equal(done.body.debt, 120000);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payments WHERE docNum = ?').get(o.docNum).c, 0);
  const pay = await call('POST', `/api/orders/${o.docNum}/payments`, { token: admin, body: { amount: 1000 } });
  assert.equal(pay.status, 409);
  assert.match(pay.body.error?.message ?? JSON.stringify(pay.body), /Saygak orders are paid from the client page/);
});

test('partner order: 11th open order is 409', async () => {
  const { client } = await makePartner('Saygak Cap', '+998902222251', 'capP');
  for (let i = 0; i < 10; i++) assert.equal((await partnerOrder(client.id)).status, 201);
  const r = await partnerOrder(client.id);
  assert.equal(r.status, 409);
  const { createPartnerOrder } = await import('../src/routes/orders.js');
  assert.equal(typeof createPartnerOrder, 'function');
});
