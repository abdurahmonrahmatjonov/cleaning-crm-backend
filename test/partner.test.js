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
  assert.equal((await call('GET', '/api/partner/me', { token: partnerA })).status, 200);
  for (const t of [admin, operator, driver, packer]) assert.equal((await call('GET', '/api/partner/me', { token: t })).status, 403);
  assert.equal((await call('GET', '/api/partner/me')).status, 401);
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
  assert.equal((await call('GET', '/api/partner/me', { token })).status, 200);
  assert.equal((await call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  assert.equal((await call('GET', '/api/partner/me', { token })).status, 401);
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

test('order edit cannot re-point orders between partner and regular clients', async () => {
  const { client: sg } = await makePartner('Saygak Edit', '+998902222261', 'editP');
  const cid = (docNum) => db.prepare('SELECT clientId FROM orders WHERE docNum = ?').get(docNum).clientId;
  const edit = (docNum, body) => call('PATCH', `/api/orders/${docNum}`, { token: operator, body });

  // partner order: identity/address edits rejected, clientId untouched
  const po = (await partnerOrder(sg.id)).body;
  for (const body of [{ clientPhone: '+998902222262' }, { clientName: 'Someone Else' }, { landmark: 'x' }, { location: { latitude: 41, longitude: 69 } }]) {
    assert.equal((await edit(po.docNum, body)).status, 409);
  }
  assert.equal(cid(po.docNum), sg.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients WHERE phone = ?').get('+998902222262').c, 0);
  assert.equal((await edit(po.docNum, { pickupTime: '2026-11-05T10:00' })).status, 200);
  assert.equal(cid(po.docNum), sg.id);

  // regular order: phone of a saygak is refused, nothing written
  const ro = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Regular Edit', clientPhone: '+998902222263' }) })).body;
  const before = cid(ro.docNum);
  const clientsBefore = db.prepare('SELECT COUNT(*) c FROM clients').get().c;
  const r = await edit(ro.docNum, { clientPhone: '+998902222261' });
  assert.equal(r.status, 409);
  assert.equal(cid(ro.docNum), before);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM clients').get().c, clientsBefore);
  assert.equal(db.prepare('SELECT clientPhone FROM orders WHERE docNum = ?').get(ro.docNum).clientPhone, '+998902222263');
  // a normal phone change on a regular order still works
  assert.equal((await edit(ro.docNum, { clientPhone: '+998902222264' })).status, 200);
});

test('staff create by name+phone detects an existing partner', async () => {
  await makePartner('Saygak ByPhone', '+998902222271', 'byPhoneP', [{ serviceId: 1, price: 6500 }]);
  const r = await call('POST', '/api/orders', { token: operator, body: { clientName: 'Typed Name', clientPhone: '+998902222271', lines: [{ serviceId: 1, price: 1 }] } });
  assert.equal(r.status, 201);
  assert.equal(r.body.kind, 'partner');
  assert.equal(r.body.lines[0].price, 6500);
});

// ---------- Task 6: lump payments, reversal, statement ----------
const { today: todayStr } = await import('../src/utils/time.js');
const MONTH = todayStr().slice(0, 7);
const prevMonth = (() => { const [y, m] = MONTH.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
const D = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;

// delivered partner order inserted directly: [docTotal, deliveredDate, kv.m sqm]
const seedDelivered = (clientId, docTotal, deliveredDate, sqm = 0, kind = 'partner') => {
  const c = db.prepare('SELECT name, phone FROM clients WHERE id = ?').get(clientId);
  const info = db.prepare(
    `INSERT INTO orders (status, clientId, clientName, clientPhone, latitude, longitude, pickupPlannedAt, createdById, createdByName, docTotal, createdAt, orderTakenAt, deliveredDate, kind)
     VALUES (?,?,?,?,0,0,'',1,'seed',?,?,?,?,?)`,
  ).run('Yetkazib berildi', clientId, c.name, c.phone, docTotal, `${deliveredDate} 10:00:00`, `${deliveredDate} 10:00:00`, deliveredDate, kind);
  if (sqm) {
    const svc = db.prepare("SELECT id, name FROM services WHERE unit = 'kv.m' LIMIT 1").get();
    db.prepare('INSERT INTO order_lines (docNum, serviceId, serviceName, price, customerPrice, quantity, sqm, lineTotal) VALUES (?,?,?,?,?,?,?,?)')
      .run(info.lastInsertRowid, svc.id, svc.name, 1, 1, 1, sqm, docTotal);
  }
  return Number(info.lastInsertRowid);
};
const ord = (docNum) => db.prepare('SELECT paid, discount FROM orders WHERE docNum = ?').get(docNum);
const debtOf = (id) => db.prepare("SELECT COALESCE(SUM(docTotal - discount - paid),0) d FROM orders WHERE clientId = ? AND kind = 'partner' AND status = 'Yetkazib berildi'").get(id).d;
const pay = (id, body, token = operator) => call('POST', `/api/clients/${id}/payments`, { token, body });
const stmt = (id, month, token = operator) => call('GET', `/api/clients/${id}/statement${month ? `?month=${month}` : ''}`, { token });

test('lump payment: FIFO partial, statement, invariant, reversal', async () => {
  const { client } = await makePartner('Lump A', '+998903000001', 'lumpA');
  const o3 = seedDelivered(client.id, 300000, D(3), 12.5);
  const o1 = seedDelivered(client.id, 100000, D(1), 4);
  const o2 = seedDelivered(client.id, 200000, D(2));
  const s0 = (await stmt(client.id)).body;
  assert.equal(s0.charges, 600000);
  assert.equal(s0.closing, debtOf(client.id));
  assert.deepEqual(s0.orders.map((o) => o.docNum), [o1, o2, o3]);
  assert.equal(s0.orders[0].sqmTotal, 4);

  const r = await pay(client.id, { amount: 250000 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.allocations, [{ docNum: o1, cash: 100000, disc: 0 }, { docNum: o2, cash: 150000, disc: 0 }]);
  assert.equal(r.body.debtLeft, 350000);
  assert.deepEqual([ord(o1).paid, ord(o2).paid, ord(o3).paid], [100000, 150000, 0]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE batchId = ?').get(r.body.batchId).n, 2);
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'client.payment'").get());
  const s1 = (await stmt(client.id)).body;
  assert.equal(s1.charges, 600000);
  assert.equal(s1.credits, 250000);
  assert.equal(s1.closing, 350000);
  assert.equal(s1.closing, debtOf(client.id));
  assert.equal(s1.payments.length, 1);

  // second sequential payment continues where the first stopped
  const r2 = await pay(client.id, { amount: 50000, discount: 10000 });
  assert.equal(r2.status, 201); // operator has orders.discount
  assert.deepEqual(r2.body.allocations, [{ docNum: o2, cash: 40000, disc: 10000 }, { docNum: o3, cash: 10000, disc: 0 }]);
  assert.equal((await stmt(client.id)).body.closing, debtOf(client.id));
  assert.equal(debtOf(client.id), 290000);

  // reverse the first batch (admin): paid back, payments rows gone, closing equals debt
  assert.equal((await call('DELETE', `/api/clients/${client.id}/payments/${r.body.batchId}`, { token: operator })).status, 403);
  const rev = await call('DELETE', `/api/clients/${client.id}/payments/${r.body.batchId}`, { token: admin });
  assert.equal(rev.status, 200);
  assert.deepEqual(rev.body, { reversed: true });
  assert.deepEqual([ord(o1).paid, ord(o2).paid, ord(o2).discount, ord(o3).paid], [0, 40000, 10000, 10000]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE batchId = ?').get(r.body.batchId).n, 0);
  assert.equal((await call('DELETE', `/api/clients/${client.id}/payments/${r.body.batchId}`, { token: admin })).status, 409);
  const s2 = (await stmt(client.id)).body;
  assert.equal(s2.credits, 60000); // reversed batch excluded
  assert.equal(s2.closing, debtOf(client.id));
  assert.equal(debtOf(client.id), 540000);
  const list = (await call('GET', `/api/clients/${client.id}/payments`, { token: operator })).body.data;
  assert.equal(list.length, 2);
  assert.ok(list.find((b) => b.batchId === r.body.batchId).reversedAt);
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'client.payment.reversed'").get());
});

test('lump payment: discount-only, overpayment, validation, permissions', async () => {
  const { client } = await makePartner('Lump B', '+998903000002', 'lumpB');
  const o1 = seedDelivered(client.id, 100000, D(1));
  const o2 = seedDelivered(client.id, 200000, D(2));
  const over = await pay(client.id, { amount: 300000, discount: 1 });
  assert.equal(over.status, 400);
  assert.match(over.body.error?.message ?? over.body.message ?? JSON.stringify(over.body), /300000/);
  assert.equal(ord(o1).paid, 0);
  assert.equal((await pay(client.id, { amount: 0 })).status, 400);
  assert.equal((await pay(client.id, { amount: 10, paidDate: '2026-13-40' })).status, 400);
  const d = await pay(client.id, { discount: 50000 });
  assert.equal(d.status, 201);
  assert.deepEqual(d.body.allocations, [{ docNum: o1, cash: 0, disc: 50000 }]);
  assert.deepEqual(ord(o1), { paid: 0, discount: 50000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE batchId = ?').get(d.body.batchId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_batches WHERE batchId = ?').get(d.body.batchId).n, 1);
  // exact full payoff
  assert.equal((await pay(client.id, { amount: 250000 })).body.debtLeft, 0);
  assert.equal((await pay(client.id, { amount: 1 })).status, 400);
  // reverse the discount-only batch
  assert.equal((await call('DELETE', `/api/clients/${client.id}/payments/${d.body.batchId}`, { token: admin })).status, 200);
  assert.deepEqual(ord(o1), { paid: 50000, discount: 0 });
  assert.equal(ord(o2).paid, 200000);

  // permissions: a role with orders.payments only cannot give a discount
  const role = await call('POST', '/api/roles', { token: admin, body: { name: 'Cashier Only', permissions: ['orders.payments', 'clients.view'] } });
  assert.equal(role.status, 201);
  assert.equal((await call('POST', '/api/users', { token: admin, body: { username: 'cashier1', fullName: 'Cash', password: 'password123', role: role.body.key } })).status, 201);
  const cashier = await login('cashier1', 'password123');
  const { client: c2 } = await makePartner('Lump B2', '+998903000003', 'lumpB2');
  seedDelivered(c2.id, 100000, D(1));
  assert.equal((await pay(c2.id, { amount: 1000, discount: 500 }, cashier)).status, 403);
  assert.equal((await pay(c2.id, { amount: 1000 }, cashier)).status, 201);
  assert.equal(ord(db.prepare('SELECT docNum FROM orders WHERE clientId = ?').get(c2.id).docNum).paid, 1000);
  // no token / saygak
  assert.equal((await pay(c2.id, { amount: 1 }, partnerA)).status, 403);
});

test('lump payment: batches are per client, non-partner refused, rounding stays exact', async () => {
  const { client: a } = await makePartner('Lump C', '+998903000004', 'lumpC');
  const { client: b } = await makePartner('Lump D', '+998903000005', 'lumpD');
  seedDelivered(a.id, 1000, D(1));
  seedDelivered(b.id, 1000, D(1));
  const rb = await pay(b.id, { amount: 100 });
  assert.equal((await call('DELETE', `/api/clients/${a.id}/payments/${rb.body.batchId}`, { token: admin })).status, 404);
  assert.equal((await call('DELETE', `/api/clients/${b.id}/payments/nope`, { token: admin })).status, 404);
  assert.equal(ord(db.prepare('SELECT docNum FROM orders WHERE clientId = ?').get(b.id).docNum).paid, 100);
  const plain = (await call('POST', '/api/clients', { token: operator, body: { name: 'Plain Lump', phone: '+998903000006' } })).body;
  assert.equal((await pay(plain.id, { amount: 10 })).status, 409);
  assert.equal((await pay(999999, { amount: 10 })).status, 404);
  // cents: 0.1 + 0.2 style amounts must not drift or be rejected as overpayment
  const { client: c } = await makePartner('Lump E', '+998903000007', 'lumpE');
  const o = seedDelivered(c.id, 0.3, D(1));
  assert.equal((await pay(c.id, { amount: 0.1 })).status, 201);
  const last = await pay(c.id, { amount: 0.2 });
  assert.equal(last.status, 201);
  assert.equal(last.body.debtLeft, 0);
  assert.equal(ord(o).paid, 0.3);
  // regular (non-partner kind) orders of a saygak are not touched
  seedDelivered(c.id, 5000, D(1), 0, 'regular');
  assert.equal((await pay(c.id, { amount: 1 })).status, 400);
});

test('statement: opening from earlier months, month validation, in-progress without amounts', async () => {
  const { client } = await makePartner('Stmt A', '+998903000008', 'stmtA');
  seedDelivered(client.id, 70000, `${prevMonth}-15`);
  seedDelivered(client.id, 30000, D(1));
  const prevPaid = await pay(client.id, { amount: 20000, paidDate: `${prevMonth}-20` });
  assert.equal(prevPaid.status, 201);
  const prev = (await stmt(client.id, prevMonth)).body;
  assert.deepEqual([prev.opening, prev.charges, prev.credits, prev.closing], [0, 70000, 20000, 50000]);
  const cur = (await stmt(client.id, MONTH)).body;
  assert.deepEqual([cur.opening, cur.charges, cur.credits, cur.closing], [50000, 30000, 0, 80000]);
  assert.equal(cur.closing, debtOf(client.id));
  for (const m of ['2026-13', '2026-00', '26-10', 'abc', '2026-1']) assert.equal((await stmt(client.id, m)).status, 400, m);
  assert.equal((await stmt(client.id)).body.month, MONTH);
  // in-progress orders carry no amounts
  const ip = seedDelivered(client.id, 999, D(1));
  db.prepare("UPDATE orders SET status = 'Olib Ketildi', deliveredDate = '' WHERE docNum = ?").run(ip);
  const s = (await stmt(client.id)).body;
  assert.deepEqual(s.inProgress.map((x) => x.docNum), [ip]);
  assert.deepEqual(Object.keys(s.inProgress[0]).sort(), ['createdAt', 'docNum', 'status']);
  assert.equal(s.closing, debtOf(client.id));
  assert.equal((await stmt(client.id, MONTH, partnerA)).status, 403);
});

test('lump payment: future paidDate is rejected with no writes; past date keeps the invariant', async () => {
  const { client } = await makePartner('Lump Future', '+998903000020', 'lumpFut');
  const o = seedDelivered(client.id, 100000, D(1));
  const batches = () => db.prepare('SELECT COUNT(*) n FROM payment_batches WHERE clientId = ?').get(client.id).n;
  const nextYear = `${Number(MONTH.slice(0, 4)) + 1}-01-15`;
  const bad = await pay(client.id, { amount: 10000, paidDate: nextYear });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error ?? bad.body.message ?? JSON.stringify(bad.body), /future/);
  assert.equal(ord(o).paid, 0);
  assert.equal(batches(), 0);
  // past date in an earlier month is allowed
  const ok = await pay(client.id, { amount: 10000, paidDate: `${prevMonth}-10` });
  assert.equal(ok.status, 201);
  assert.equal(batches(), 1);
  assert.equal((await stmt(client.id, prevMonth)).body.credits, 10000);
  const cur = (await stmt(client.id)).body;
  assert.equal(cur.closing, debtOf(client.id));
  // today itself is allowed
  assert.equal((await pay(client.id, { amount: 1000, paidDate: todayStr() })).status, 201);
});

test('un-flagging a saygak is blocked while partner debt remains', async () => {
  const { client } = await makePartner('Saygak Debt Unflag', '+998903000021', 'debtUnflag');
  seedDelivered(client.id, 50000, D(1));
  const unflag = () => call('PATCH', `/api/clients/${client.id}`, { token: operator, body: { isPartner: false } });
  assert.equal((await call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  assert.equal((await unflag()).status, 409);
  assert.equal(db.prepare('SELECT isPartner FROM clients WHERE id = ?').get(client.id).isPartner, 1);
  assert.equal((await pay(client.id, { amount: 50000 })).status, 201);
  assert.equal((await unflag()).status, 200);
  assert.equal(db.prepare('SELECT isPartner FROM clients WHERE id = ?').get(client.id).isPartner, 0);
});

// ---------- Task 7: saygak-facing API ----------
const P = (method, path, token, body) => call(method, `/api/partner${path}`, { token, body });
const FORBIDDEN = ['createdBy', 'pickedUpBy', 'washedBy', 'packedBy', 'deliveredBy', 'waybillNumber', 'latitude', 'longitude', 'landmark', 'pickupTime', 'cancelReason'];
const AMOUNT_KEYS = ['price', 'sqm', 'lineTotal'];
const ORDER_AMOUNT_KEYS = ['docTotal', 'paid', 'discount', 'debt'];

// walk a partner order through the staff API up to and including delivery
const staffWalk = async (docNum, upTo = 'deliver') => {
  const o = (await call('GET', `/api/orders/${docNum}`, { token: admin })).body;
  const id = o.lines[0].id;
  const step = async (name, who, body) => assert.equal((await call('PATCH', `/api/orders/${docNum}/${name}`, { token: who, body })).status, 200, name);
  await step('pickup', driver, { lines: [{ id, quantity: 2 }] });
  if (upTo === 'pickup') return id;
  await step('wash', packer, { lines: [{ id, quantity: 2, sizes: [{ width: 5, length: 4 }] }] });
  if (upTo === 'wash') return id;
  await step('pack', packer, { lines: [{ id, quantity: 2 }] });
  if (upTo === 'pack') return id;
  await step('deliver', admin, { lines: [{ id, sqm: 20 }] });
  return id;
};

test('partner api: staff token is refused, identity comes only from the token', async () => {
  assert.equal((await P('GET', '/me', admin)).status, 403);
  assert.equal((await P('GET', '/me', undefined)).status, 401);
  const me = await P('GET', `/me?clientId=${clientB}`, partnerA);
  assert.equal(me.status, 200);
  assert.equal(me.body.client.id, clientA);
});

test('partner api: /services lists only own priced active services without defaultPrice', async () => {
  db.prepare('UPDATE services SET defaultPrice = 99999 WHERE id = 1').run();
  const a = await P('GET', '/services', partnerA);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.map((s) => s.id), [1]);
  assert.equal(a.body[0].price, 6000);
  assert.deepEqual(Object.keys(a.body[0]).sort(), ['id', 'name', 'price', 'unit']);
  assert.equal((await P('GET', '/services', partnerB)).body[0].price, 7000);
  // deactivated service disappears
  const { client, token } = await makePartner('Svc Inactive', '+998904000001', 'svcInact', [{ serviceId: 1, price: 5000 }, { serviceId: 2, price: 4000 }]);
  db.prepare('UPDATE services SET isActive = 0 WHERE id = 2').run();
  assert.deepEqual((await P('GET', '/services', token)).body.map((s) => s.id), [1]);
  db.prepare('UPDATE services SET isActive = 1 WHERE id = 2').run();
  assert.ok(client.id);
});

test('partner api: POST /orders uses own price, ignores client-sent identity and price, validates', async () => {
  const r = await P('POST', '/orders', partnerA, { clientId: clientB, clientName: 'Hacker', clientPhone: '+998900000000', lines: [{ serviceId: 1, price: 1, expectedQuantity: 3, customerPrice: 1 }] });
  assert.equal(r.status, 201);
  const row = db.prepare('SELECT * FROM orders WHERE docNum = ?').get(r.body.docNum);
  assert.equal(row.clientId, clientA);
  assert.equal(row.kind, 'partner');
  assert.notEqual(row.clientName, 'Hacker');
  const line = db.prepare('SELECT * FROM order_lines WHERE docNum = ?').get(r.body.docNum);
  assert.equal(line.price, 6000);
  assert.equal(line.customerPrice, 6000);
  assert.equal(r.body.lines[0].expectedQuantity, 3);
  assert.equal(r.body.status, 'Zakaz Qabul qilindi');
  assert.equal(JSON.parse(db.prepare("SELECT details FROM activity_log WHERE entityId = ? AND action = 'order.created'").get(String(r.body.docNum)).details).via, 'partner');
  // unpriced service
  assert.equal((await P('POST', '/orders', partnerA, { lines: [{ serviceId: 2 }] })).status, 400);
  // duplicate service
  assert.equal((await P('POST', '/orders', partnerA, { lines: [{ serviceId: 1 }, { serviceId: 1 }] })).status, 400);
  assert.equal((await P('POST', '/orders', partnerA, { lines: [] })).status, 400);
  assert.equal((await P('POST', '/orders', partnerA, { lines: [{ serviceId: 1, expectedQuantity: 0 }] })).status, 400);
});

test('partner api: 11th open order is 409', async () => {
  const { token } = await makePartner('Api Cap', '+998904000002', 'apiCap');
  for (let i = 0; i < 10; i++) assert.equal((await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).status, 201);
  assert.equal((await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).status, 409);
  const me = (await P('GET', '/me', token)).body;
  assert.equal(me.receivedOrders, 10);
  assert.equal(me.inProgressOrders, 10);
  assert.equal(me.orderCap, 10);
  assert.equal(me.openOrders, undefined);
});

test('partner api: cross-client and non-partner orders are 404 on every :docNum route', async () => {
  const b = (await P('POST', '/orders', partnerB, { lines: [{ serviceId: 1 }] })).body;
  const lineB = b.lines[0].id;
  assert.equal((await P('GET', `/orders/${b.docNum}`, partnerA)).status, 404);
  assert.equal((await P('PATCH', `/orders/${b.docNum}`, partnerA, { lines: [{ id: lineB, expectedQuantity: 5 }] })).status, 404);
  assert.equal((await P('POST', `/orders/${b.docNum}/cancel`, partnerA, { reason: 'x' })).status, 404);
  assert.equal(db.prepare('SELECT status FROM orders WHERE docNum = ?').get(b.docNum).status, 'Zakaz Qabul qilindi');
  assert.equal((await P('GET', `/orders/${b.docNum}`, partnerB)).status, 200);
  // a staff-created regular order for the same phone as A
  const reg = db.prepare(
    `INSERT INTO orders (kind, status, clientId, clientName, clientPhone, latitude, longitude, pickupPlannedAt, createdById, createdByName, createdAt, orderTakenAt)
     VALUES ('regular', 'Zakaz Qabul qilindi', ?, 'n', 'p', 1, 1, 'x', 1, 'admin', 'x', 'x')`).run(clientA).lastInsertRowid;
  assert.equal((await P('GET', `/orders/${reg}`, partnerA)).status, 404);
  assert.equal((await P('POST', `/orders/${reg}/cancel`, partnerA, { reason: 'x' })).status, 404);
  assert.equal((await P('GET', '/orders/999999', partnerA)).status, 404);
  const list = (await P('GET', '/orders?limit=200', partnerA)).body;
  assert.ok(!list.data.some((o) => o.docNum === reg || o.docNum === b.docNum));
});

test('partner api: edit and cancel only in RECEIVED, line ids must belong to the order, both logged', async () => {
  const o = (await P('POST', '/orders', partnerA, { lines: [{ serviceId: 1, expectedQuantity: 2 }] })).body;
  const other = (await P('POST', '/orders', partnerA, { lines: [{ serviceId: 1 }] })).body;
  const lineId = o.lines[0].id;
  assert.equal((await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: other.lines[0].id, expectedQuantity: 9 }] })).status, 400);
  assert.equal((await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: lineId, expectedQuantity: -1 }] })).status, 400);
  const ed = await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: lineId, expectedQuantity: 9, price: 1 }] });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.lines[0].expectedQuantity, 9);
  assert.equal(db.prepare('SELECT price FROM order_lines WHERE id = ?').get(lineId).price, 6000);
  const log = (action) => db.prepare('SELECT * FROM activity_log WHERE entity = ? AND entityId = ? AND action = ?').get('order', String(o.docNum), action);
  assert.equal(log('order.edited').userName, db.prepare('SELECT fullName FROM users WHERE clientId = ?').get(clientA).fullName);
  assert.equal(JSON.parse(log('order.edited').details).via, 'partner');
  // cancel
  assert.equal((await P('POST', `/orders/${o.docNum}/cancel`, partnerA, {})).status, 400);
  const c = await P('POST', `/orders/${o.docNum}/cancel`, partnerA, { reason: 'Kerak emas' });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, ORDER_STATUS.CANCELLED);
  assert.equal(db.prepare('SELECT status FROM orders WHERE docNum = ?').get(o.docNum).status, ORDER_STATUS.CANCELLED);
  assert.equal(JSON.parse(log('order.cancelled').details).via, 'partner');
  assert.equal((await P('POST', `/orders/${o.docNum}/cancel`, partnerA, { reason: 'again' })).status, 409);
  assert.equal((await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: lineId, expectedQuantity: 1 }] })).status, 409);
  // after pickup
  const p = (await P('POST', '/orders', partnerA, { lines: [{ serviceId: 1 }] })).body;
  await staffWalk(p.docNum, 'pickup');
  assert.equal((await P('POST', `/orders/${p.docNum}/cancel`, partnerA, { reason: 'late' })).status, 409);
  assert.equal((await P('PATCH', `/orders/${p.docNum}`, partnerA, { lines: [{ id: p.lines[0].id, expectedQuantity: 1 }] })).status, 409);
});
const { ORDER_STATUS } = await import('../src/db.js');

test('partner api: amounts hidden before handover, visible after; sizes and counts follow the stage', async () => {
  const { client, token } = await makePartner('Api Amounts', '+998904000003', 'apiAmt');
  const o = (await P('POST', '/orders', token, { lines: [{ serviceId: 1, expectedQuantity: 3 }] })).body;
  const check = (body, { amounts, quantity, sizes }) => {
    const l = body.lines[0];
    for (const k of AMOUNT_KEYS) assert.equal(k in l ? l[k] !== null : false, amounts, `line.${k}`);
    for (const k of ORDER_AMOUNT_KEYS) assert.equal(k in body ? body[k] !== null : false, amounts, k);
    assert.equal(l.quantity, quantity);
    assert.equal(l.sizes.length, sizes ? 1 : 0);
    assert.equal(l.sizesTotal, sizes ? 20 : 0);
  };
  check((await P('GET', `/orders/${o.docNum}`, token)).body, { amounts: false, quantity: null, sizes: false });
  await staffWalk(o.docNum, 'pickup');
  check((await P('GET', `/orders/${o.docNum}`, token)).body, { amounts: false, quantity: null, sizes: false });
  const id = o.lines[0].id;
  await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer, body: { lines: [{ id, quantity: 2, sizes: [{ width: 5, length: 4 }] }] } });
  check((await P('GET', `/orders/${o.docNum}`, token)).body, { amounts: false, quantity: null, sizes: true });
  await call('PATCH', `/api/orders/${o.docNum}/pack`, { token: packer, body: { lines: [{ id, quantity: 2 }] } });
  check((await P('GET', `/orders/${o.docNum}`, token)).body, { amounts: false, quantity: 2, sizes: true });
  await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: { lines: [{ id, sqm: 20 }] } });
  const d = (await P('GET', `/orders/${o.docNum}`, token)).body;
  check(d, { amounts: true, quantity: 2, sizes: true });
  assert.equal(d.docTotal, 120000);
  assert.equal(d.debt, 120000);
  assert.equal(d.lines[0].price, 6000);
  assert.equal(d.lines[0].lineTotal, 120000);
  assert.ok(d.deliveredDate);
  // list + detail never leak staff-only fields
  const list = await P('GET', '/orders', token);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.meta, { page: 1, limit: 20, total: 1 });
  for (const body of [list.body, d]) {
    const s = JSON.stringify(body);
    for (const f of FORBIDDEN) assert.ok(!s.includes(f), `leaked ${f}`);
  }
  // cancelled order does not leak the reason either
  const c = (await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).body;
  await P('POST', `/orders/${c.docNum}/cancel`, token, { reason: 'secret-reason-text' });
  const cs = JSON.stringify((await P('GET', `/orders/${c.docNum}`, token)).body);
  assert.ok(!cs.includes('cancelReason') && !cs.includes('secret-reason-text'));
  assert.ok(cs.includes('cancelledAt'));
  // /me debt equals staff side
  const staff = (await call('GET', `/api/clients/${client.id}`, { token: admin })).body;
  assert.equal((await P('GET', '/me', token)).body.debt, staff.debt);
  assert.equal((await P('GET', '/me', token)).body.debt, 120000);
  // status filter
  assert.equal((await P('GET', `/orders?status=${encodeURIComponent('Yetkazib berildi')}`, token)).body.meta.total, 1);
  assert.equal((await P('GET', '/orders?status=Bogus', token)).status, 400);
});

test('partner api: /statement matches the staff statement and validates month', async () => {
  const { client, token } = await makePartner('Api Stmt', '+998904000004', 'apiStmt');
  seedDelivered(client.id, 80000, D(1));
  assert.equal((await pay(client.id, { amount: 30000 })).status, 201);
  const mine = await P('GET', '/statement', token);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, (await stmt(client.id)).body);
  const m = await P('GET', `/statement?month=${prevMonth}`, token);
  assert.deepEqual(m.body, (await stmt(client.id, prevMonth)).body);
  assert.equal((await P('GET', '/statement?month=2026-13', token)).status, 400);
  // another client's statement is unreachable by param
  assert.deepEqual((await P('GET', `/statement?clientId=${clientB}`, token)).body, mine.body);
});

test('partner api: edit logs staff-readable changes with real old values; 0 clears; unchanged logs nothing', async () => {
  const o = (await P('POST', '/orders', partnerA, { lines: [{ serviceId: 1, expectedQuantity: 2 }] })).body;
  const l = o.lines[0];
  const hist = async () => (await call('GET', `/api/orders/${o.docNum}/history`, { token: admin })).body.data.filter((h) => h.action === 'order.edited');
  assert.equal((await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: l.id, expectedQuantity: 2 }] })).status, 200);
  assert.equal((await hist()).length, 0);
  assert.equal((await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: l.id, expectedQuantity: 9 }] })).status, 200);
  let h = await hist();
  assert.equal(h.length, 1);
  assert.equal(h[0].details.via, 'partner');
  assert.deepEqual(h[0].details.changes, { [`${l.serviceName} (expected qty)`]: { from: 2, to: 9 } });
  const clr = await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: l.id, expectedQuantity: 0 }] });
  assert.equal(clr.status, 200);
  assert.equal(clr.body.lines[0].expectedQuantity, 0);
  h = await hist();
  assert.deepEqual(h[1].details.changes[`${l.serviceName} (expected qty)`], { from: 9, to: 0 });
  assert.equal((await P('PATCH', `/orders/${o.docNum}`, partnerA, { lines: [{ id: l.id, expectedQuantity: 100001 }] })).status, 400);
});

test('partner api: /me counters and per-order debt floor', async () => {
  const { client, token } = await makePartner('Api Me', '+998904000009', 'apiMe');
  const a = (await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).body;
  await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] });
  await staffWalk(a.docNum, 'pickup');
  let me = (await P('GET', '/me', token)).body;
  assert.equal(me.receivedOrders, 1);
  assert.equal(me.inProgressOrders, 2);
  assert.equal(me.orderCap, 10);
  // an overpaid delivered order must not offset another order's debt
  seedDelivered(client.id, 100, D(1));
  seedDelivered(client.id, 100, D(2));
  const rows = db.prepare("SELECT docNum FROM orders WHERE clientId = ? AND status = 'Yetkazib berildi' ORDER BY docNum").all(client.id);
  db.prepare('UPDATE orders SET paid = 150 WHERE docNum = ?').run(rows[0].docNum);
  me = (await P('GET', '/me', token)).body;
  assert.equal(me.debt, 100);
});

test('partner api: router exposes exactly the expected routes', async () => {
  const { partnerRouter } = await import('../src/routes/partner.js');
  const got = partnerRouter(db).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`)).sort();
  const want = ['GET /me', 'GET /services', 'GET /orders', 'POST /orders', 'GET /orders/:docNum', 'PATCH /orders/:docNum', 'POST /orders/:docNum/cancel', 'GET /statement'].sort();
  assert.deepEqual(got, want);
});

// ---------- Task 8: reports and end-to-end ----------
test('reports: saygak delivered money shows in debtors, summary and shrinks with lump payments', async () => {
  const { client, token } = await makePartner('Report Saygak', '+998905000001', 'reportSay');
  const day = `${prevMonth}-27`; // a past day (previous month) no other test delivers on
  const summary = async () => (await call('GET', `/api/reports/summary?from=${day}&to=${day}`, { token: admin })).body;
  const debtors = async () => (await call('GET', '/api/reports/debtors', { token: operator })).body.data;
  const before = await summary();
  const o = (await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).body;
  const id = await staffWalk(o.docNum, 'pack');
  const del = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: { deliveredDate: day, lines: [{ id, sqm: 20 }] } });
  assert.equal(del.status, 200);
  assert.equal(del.body.docTotal, 120000); // 20 kv.m x 6000

  assert.equal((await debtors()).find((d) => d.clientId === client.id).debt, 120000);
  let s = await summary();
  assert.equal(s.sales.total - before.sales.total, 120000);
  assert.equal(s.outstandingDebt - before.outstandingDebt, 120000);
  assert.equal(s.collected, before.collected); // nothing paid yet

  assert.equal((await pay(client.id, { amount: 50000 })).status, 201);
  assert.equal((await debtors()).find((d) => d.clientId === client.id).debt, 70000);
  s = await summary();
  assert.equal(s.outstandingDebt - before.outstandingDebt, 70000);

  assert.equal((await pay(client.id, { amount: 70000, paidDate: day })).status, 201);
  assert.equal((await debtors()).find((d) => d.clientId === client.id), undefined);
  s = await summary();
  assert.equal(s.outstandingDebt, before.outstandingDebt);
  assert.equal(s.collected - before.collected, 70000); // only the payment dated inside the range
});

test('end to end: saygak from setup to settled statement and back via reversal', async () => {
  const { client, token } = await makePartner('E2E Saygak', '+998905000002', 'e2eSay', [{ serviceId: 1, price: 5000 }]);
  assert.equal((await call('GET', '/api/auth/me', { token })).body.clientId, client.id);

  const o = (await P('POST', '/orders', token, { lines: [{ serviceId: 1, expectedQuantity: 3 }] })).body;
  assert.equal(o.status, 'Zakaz Qabul qilindi');
  assert.equal(o.lines[0].price, undefined); // no amounts before handover
  const id = o.lines[0].id;

  const step = async (name, who, body) => assert.equal((await call('PATCH', `/api/orders/${o.docNum}/${name}`, { token: who, body })).status, 200, name);
  await step('pickup', driver, { lines: [{ id, quantity: 3 }] }); // no waybill / delivery time
  await step('wash', packer, { lines: [{ id, quantity: 3, sizes: [{ width: 2, length: 3 }, { width: 3, length: 3 }] }] });
  const packed = await call('PATCH', `/api/orders/${o.docNum}/pack`, { token: packer, body: { lines: [{ id, quantity: 3, sizes: [{ width: 2.5, length: 4 }, { width: 3, length: 3 }] }] } });
  assert.equal(packed.body.lines[0].sizesTotal, 19);
  await step('deliver', admin, { lines: [{ id, sqm: packed.body.lines[0].sizesTotal }] });

  const seen = (await P('GET', `/orders/${o.docNum}`, token)).body;
  assert.equal(seen.docTotal, 95000); // 19 x 5000
  assert.equal(seen.debt, 95000);
  assert.equal(seen.lines[0].sqm, 19);

  assert.equal((await pay(client.id, { amount: 30000 })).status, 201);
  const batch = (await pay(client.id, { amount: 15000 })).body.batchId;
  const me = (await P('GET', '/me', token)).body;
  const st = (await P('GET', '/statement', token)).body;
  const staffSt = (await stmt(client.id)).body;
  assert.equal(me.debt, 50000);
  assert.equal(st.closing, 50000);
  assert.deepEqual(st, staffSt);
  assert.equal((await P('GET', `/orders/${o.docNum}`, token)).body.paid, 45000);

  assert.equal((await call('DELETE', `/api/clients/${client.id}/payments/${batch}`, { token: admin })).status, 200);
  assert.equal((await P('GET', '/me', token)).body.debt, 65000);
  assert.equal((await P('GET', '/statement', token)).body.closing, 65000);
});

test('client detail: orders carry kind (regular before flagging, partner after)', async () => {
  const c = (await call('POST', '/api/clients', { token: operator, body: { name: 'Late Saygak', phone: '+998902222299' } })).body;
  const reg = await call('POST', '/api/orders', { token: operator, body: newOrder({ clientId: c.id }) });
  assert.equal(reg.status, 201);
  assert.equal((await call('PATCH', `/api/clients/${c.id}`, { token: operator, body: { isPartner: true } })).status, 200);
  assert.equal((await call('PUT', `/api/clients/${c.id}/prices`, { token: admin, body: { prices: [{ serviceId: 1, price: 6000 }] } })).status, 200);
  const par = await partnerOrder(c.id);
  assert.equal(par.status, 201);
  const d = (await call('GET', `/api/clients/${c.id}`, { token: operator })).body;
  const kindOf = (n) => d.orders.find((o) => o.docNum === n).kind;
  assert.equal(kindOf(reg.body.docNum), 'regular');
  assert.equal(kindOf(par.body.docNum), 'partner');
});

// ---------- Final review fixes ----------
const tomorrow = () => { const t = new Date(`${todayStr()}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

test('deliver: future deliveredDate is rejected before any write; today and past are allowed', async () => {
  const { client, token } = await makePartner('Deliver Future', '+998906000001', 'delFut');
  const o = (await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).body;
  const id = await staffWalk(o.docNum, 'pack');
  const body = (deliveredDate) => ({ deliveredDate, lines: [{ id, sqm: 5 }] });
  const bad = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: body(tomorrow()) });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare('SELECT status, docTotal, deliveredDate FROM orders WHERE docNum = ?').get(o.docNum).status, 'Upakovka qilingan');
  assert.equal(db.prepare('SELECT docTotal, deliveredDate FROM orders WHERE docNum = ?').get(o.docNum).docTotal, 0);
  assert.equal(db.prepare('SELECT sqm FROM order_lines WHERE id = ?').get(id).sqm, 0);
  const farFuture = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: body('2099-01-01') });
  assert.equal(farFuture.status, 400);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: body(todayStr()) })).status, 200);
  assert.equal(debtOf(client.id), 30000);
});

test('un-flag is blocked while a saygak order is in progress', async () => {
  const { client, token } = await makePartner('Unflag Progress', '+998906000002', 'unflagProg');
  const o = (await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).body;
  assert.equal((await call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  const unflag = () => call('PATCH', `/api/clients/${client.id}`, { token: operator, body: { isPartner: false } });
  assert.equal((await unflag()).status, 409); // RECEIVED
  const id = await staffWalk(o.docNum, 'pickup');
  assert.equal((await unflag()).status, 409); // PICKED_UP
  await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer, body: { lines: [{ id, quantity: 2 }] } });
  assert.equal((await unflag()).status, 409); // WASHED
  await call('PATCH', `/api/orders/${o.docNum}/pack`, { token: packer, body: { lines: [{ id, quantity: 2 }] } });
  assert.equal((await unflag()).status, 409); // PACKED
  assert.equal(db.prepare('SELECT isPartner FROM clients WHERE id = ?').get(client.id).isPartner, 1);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: { lines: [{ id, sqm: 10 }] } })).status, 200);
  assert.equal((await unflag()).status, 409); // now owes
  assert.equal((await pay(client.id, { amount: 60000 })).status, 201);
  assert.equal((await unflag()).status, 200);
});

test('un-flag is allowed after an in-progress saygak order is cancelled', async () => {
  const { client, token } = await makePartner('Unflag Cancel', '+998906000003', 'unflagCan');
  const o = (await P('POST', '/orders', token, { lines: [{ serviceId: 1 }] })).body;
  assert.equal((await call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive: false } })).status, 200);
  const unflag = () => call('PATCH', `/api/clients/${client.id}`, { token: operator, body: { isPartner: false } });
  assert.equal((await unflag()).status, 409);
  assert.equal((await call('POST', `/api/orders/${o.docNum}/cancel`, { token: admin, body: { reason: 'test' } })).status, 200);
  assert.equal((await unflag()).status, 200);
});

test('login can only be reactivated for a current saygak', async () => {
  const { client } = await makePartner('Reactivate', '+998906000004', 'reactP');
  const login = (isActive) => call('PATCH', `/api/clients/${client.id}/login`, { token: admin, body: { isActive } });
  assert.equal((await login(false)).status, 200);
  assert.equal((await call('PATCH', `/api/clients/${client.id}`, { token: operator, body: { isPartner: false } })).status, 200);
  assert.equal((await login(true)).status, 409);
  assert.equal(db.prepare('SELECT isActive FROM users WHERE clientId = ?').get(client.id).isActive, 0);
  assert.equal((await login(false)).status, 200); // deactivation stays allowed
});

test('staff chat user list does not include saygak logins', async () => {
  await makePartner('Chat Hidden', '+998906000005', 'chatHid');
  const list = (await call('GET', '/api/chat/users', { token: operator })).body.data;
  assert.ok(list.length > 0);
  assert.equal(list.some((u) => u.fullName === 'Chat Hidden'), false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'saygak'").get().c > 0, true);
});

test('statement sqmTotal uses the line unit snapshot, not the current service unit', async () => {
  const { client } = await makePartner('Snapshot Unit', '+998906000006', 'snapUnit');
  const o = seedDelivered(client.id, 1000, D(1), 4);
  db.prepare("UPDATE order_lines SET unit = 'metr' WHERE docNum = ?").run(o);
  const s = (await stmt(client.id, todayStr().slice(0, 7))).body;
  assert.equal(s.orders.find((x) => x.docNum === o).sqmTotal, 0);
});
