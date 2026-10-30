import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-secret';
const { openDb, seed } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

let server, base, db;
let admin, operator, driver, packer;

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
