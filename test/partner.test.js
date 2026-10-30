import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-secret';
const { openDb, seed } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

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
