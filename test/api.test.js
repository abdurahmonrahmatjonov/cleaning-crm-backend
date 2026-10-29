import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-secret';
const { openDb, seed } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

let server, base, db;
let admin, operator, driver;

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
  for (const [username, role] of [['oper', 'operator'], ['driv', 'driver']]) {
    const r = await call('POST', '/api/users', { token: admin, body: { username, fullName: `${role} user`, password: 'password123', role } });
    assert.equal(r.status, 201);
  }
  operator = await login('oper', 'password123');
  driver = await login('driv', 'password123');
});
after(() => server.close());

test('requires auth', async () => {
  assert.equal((await call('GET', '/api/orders/received')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } })).status, 401);
});

test('full order lifecycle', async () => {
  const created = await call('POST', '/api/orders', { token: operator, body: newOrder() });
  assert.equal(created.status, 201);
  const o = created.body;
  assert.equal(o.status, 'Zakaz Qabul qilindi');
  assert.equal(o.docStatus, 'Open');
  assert.equal(o.createdBy.name, 'operator user');
  assert.equal(o.docTotal, 0);
  assert.equal(o.pickupTime, '2026-11-01 10:00:00');
  assert.match(o.orderTakenAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(o.deliveryTime, '');
  assert.deepEqual(o.lines.map((l) => [l.status, l.customerPrice, l.quantity, l.sqm, l.currency]),
    [['Open', 15000, 0, 0, 'UZS'], ['Open', 10000, 0, 0, 'UZS']]);

  // shows in received only
  const rec = await call('GET', '/api/orders/received', { token: operator });
  assert.ok(rec.body.data.some((x) => x.docNum === o.docNum));
  assert.equal((await call('GET', '/api/orders/picked-up', { token: operator })).body.meta.total, 0);

  // can't deliver before pickup
  const [l1, l2] = o.lines;
  const early = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: driver, body: { paid: 0, lines: [{ id: l1.id, sqm: 1 }, { id: l2.id, sqm: 1 }] } });
  assert.equal(early.status, 409);

  // pickup: must cover all lines
  const bad = await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { waybillNumber: 'N-1', deliveryTime: '2026-11-03 18:00', lines: [{ id: l1.id, quantity: 2 }] } });
  assert.equal(bad.status, 400);

  const pick = await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { waybillNumber: 'N-1', deliveryTime: '2026-11-03 18:00', lines: [{ id: l1.id, quantity: 2 }, { id: l2.id, quantity: 3 }] } });
  assert.equal(pick.status, 200);
  assert.equal(pick.body.status, 'Olib Ketildi');
  assert.equal(pick.body.waybillNumber, 'N-1');
  assert.notEqual(pick.body.pickedUpAt, '');
  assert.deepEqual(pick.body.lines.map((l) => l.quantity), [2, 3]);

  // twice -> conflict; gone from received
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: driver, body: { waybillNumber: 'N-1', deliveryTime: '2026-11-03 18:00', lines: [{ id: l1.id, quantity: 2 }, { id: l2.id, quantity: 3 }] } })).status, 409);
  assert.ok(!(await call('GET', '/api/orders/received', { token: operator })).body.data.some((x) => x.docNum === o.docNum));
  assert.ok((await call('GET', '/api/orders/picked-up', { token: operator })).body.data.some((x) => x.docNum === o.docNum));

  // deliver: docTotal = sum(sqm * price) = 6.5*15000 + 4*10000 = 137500
  const del = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: driver, body: { deliveredDate: '2026-11-03', paid: 100000, lines: [{ id: l1.id, sqm: 6.5 }, { id: l2.id, sqm: 4 }] } });
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'Yetkazib berildi');
  assert.equal(del.body.docTotal, 137500);
  assert.equal(del.body.paid, 100000);
  assert.equal(del.body.debt, 37500);
  assert.equal(del.body.deliveredDate, '2026-11-03');
  assert.notEqual(del.body.deliveredAt, '');
  assert.deepEqual(del.body.lines.map((l) => l.lineTotal), [97500, 40000]);

  const done = await call('GET', '/api/orders/completed', { token: operator });
  assert.ok(done.body.data.some((x) => x.docNum === o.docNum));
  assert.equal((await call('GET', `/api/orders/${o.docNum}`, { token: operator })).body.docNum, o.docNum);
});

test('docNum auto-increments and search works', async () => {
  const a = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Zafar_Unique' }) })).body;
  const b = (await call('POST', '/api/orders', { token: operator, body: newOrder() })).body;
  assert.equal(b.docNum, a.docNum + 1);
  const s = await call('GET', '/api/orders/received?search=zafar_unique', { token: operator });
  assert.deepEqual(s.body.data.map((x) => x.docNum), [a.docNum]);
});

test('order validation and permissions', async () => {
  assert.equal((await call('POST', '/api/orders', { token: driver, body: newOrder() })).status, 403);
  assert.equal((await call('POST', '/api/orders', { token: operator, body: newOrder({ lines: [] }) })).status, 400);
  assert.equal((await call('POST', '/api/orders', { token: operator, body: newOrder({ lines: [{ serviceId: 999, price: 1 }] }) })).status, 400);
  assert.equal((await call('POST', '/api/orders', { token: operator, body: newOrder({ pickupTime: '2026-02-31 10:00' }) })).status, 400);
  assert.equal((await call('POST', '/api/orders', { token: operator, body: newOrder({ location: { latitude: 200, longitude: 0 } }) })).status, 400);
  assert.equal((await call('GET', '/api/orders/99999', { token: operator })).status, 404);
});

test('expenses', async () => {
  const types = (await call('GET', '/api/expense-types', { token: operator })).body.data;
  assert.ok(types.length > 0);
  const created = await call('POST', '/api/expenses', { token: operator, body: { expenseTypeId: types[0].id, amount: 500000, expenseDate: '2026-10-28' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.creator.name, 'operator user');
  assert.equal(created.body.expenseType, types[0].name);
  assert.match(created.body.createdAt, /^\d{4}-\d{2}-\d{2}$/);

  const list = await call('GET', '/api/expenses?from=2026-10-01&to=2026-10-31', { token: operator });
  assert.equal(list.body.meta.total, 1);
  assert.equal(list.body.meta.totalAmount, 500000);

  assert.equal((await call('POST', '/api/expenses', { token: operator, body: { expenseTypeId: 999, amount: 1, expenseDate: '2026-10-28' } })).status, 400);
  assert.equal((await call('POST', '/api/expenses', { token: operator, body: { expenseTypeId: types[0].id, amount: -5, expenseDate: '2026-10-28' } })).status, 400);
  assert.equal((await call('GET', '/api/expenses', { token: driver })).status, 403);
});

test('admin-only management', async () => {
  assert.equal((await call('GET', '/api/users', { token: operator })).status, 403);
  assert.equal((await call('POST', '/api/services', { token: operator, body: { name: 'X' } })).status, 403);
  const r = await call('POST', '/api/services', { token: admin, body: { name: 'Palas yuvish' } });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/api/services', { token: admin, body: { name: 'palas yuvish' } })).status, 409);
  // disabled user can't use an old token
  const users = (await call('GET', '/api/users', { token: admin })).body.data;
  const drv = users.find((u) => u.username === 'driv');
  await call('PATCH', `/api/users/${drv.id}`, { token: admin, body: { isActive: false } });
  assert.equal((await call('GET', '/api/orders/received', { token: driver })).status, 401);
});

test('clients, edit, cancel, debt payments, reports', async () => {
  // same phone written differently -> one client
  const a = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Karim', clientPhone: '+998 91 000 11 22' }) })).body;
  const b = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Karim', clientPhone: '+998910001122' }) })).body;
  assert.equal(a.clientId, b.clientId);
  assert.equal(a.clientPhone, '+998910001122');

  // edit while received
  const ed = await call('PATCH', `/api/orders/${a.docNum}`, { token: operator, body: { landmark: 'Yangi orientir' } });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.landmark, 'Yangi orientir');
  assert.equal((await call('PATCH', `/api/orders/${a.docNum}`, { token: operator, body: {} })).status, 400);

  // cancel b
  assert.equal((await call('POST', `/api/orders/${b.docNum}/cancel`, { token: operator, body: {} })).status, 400);
  const c = await call('POST', `/api/orders/${b.docNum}/cancel`, { token: operator, body: { reason: 'Mijoz rad etdi' } });
  assert.equal(c.body.status, 'Bekor qilindi');
  assert.ok((await call('GET', '/api/orders/cancelled', { token: operator })).body.data.some((x) => x.docNum === b.docNum));
  assert.equal((await call('PATCH', `/api/orders/${b.docNum}/pickup`, { token: driver, body: {} })).status, 401); // driver was disabled earlier

  // deliver a with a debt, then pay it off
  const [l1, l2] = a.lines;
  await call('PATCH', `/api/orders/${a.docNum}/pickup`, { token: admin, body: { waybillNumber: 'N-9', deliveryTime: '2026-11-03 18:00', lines: [{ id: l1.id, quantity: 1 }, { id: l2.id, quantity: 1 }] } });
  const d = await call('PATCH', `/api/orders/${a.docNum}/deliver`, { token: admin, body: { deliveredDate: '2026-11-03', paid: 10000, lines: [{ id: l1.id, sqm: 2 }, { id: l2.id, sqm: 1 }] } });
  assert.equal(d.body.docTotal, 40000);
  assert.equal(d.body.deliveredBy, 'Administrator');

  const client = (await call('GET', `/api/clients/${a.clientId}`, { token: operator })).body;
  assert.equal(client.debt, 30000);
  assert.equal(client.ordersCount, 2);
  const debtors = (await call('GET', '/api/reports/debtors', { token: operator })).body;
  assert.ok(debtors.data.some((x) => x.clientId === a.clientId && x.debt === 30000));

  assert.equal((await call('POST', `/api/orders/${a.docNum}/payments`, { token: operator, body: { amount: 99999 } })).status, 400);
  const pay = await call('POST', `/api/orders/${a.docNum}/payments`, { token: operator, body: { amount: 30000, paidDate: '2026-11-04' } });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.debt, 0);
  assert.equal((await call('GET', `/api/orders/${a.docNum}/payments`, { token: operator })).body.data.length, 2);
  assert.equal((await call('GET', `/api/clients/${a.clientId}`, { token: operator })).body.debt, 0);

  // reports
  assert.equal((await call('GET', '/api/reports/summary?from=2026-11-01&to=2026-11-30', { token: operator })).status, 403);
  const sum = (await call('GET', '/api/reports/summary?from=2026-11-04&to=2026-11-04', { token: admin })).body;
  assert.equal(sum.collected, 30000);
  const sum2 = (await call('GET', '/api/reports/summary?from=2026-11-03&to=2026-11-03', { token: admin })).body;
  assert.equal(sum2.sales.total >= 40000, true);
  assert.equal(sum2.sales.totalSqm >= 3, true);
});
