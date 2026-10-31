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

// washed -> packed, as the workshop does between pickup and delivery
// Each step re-counts the pieces; by default the counts stay what they were.
const counts = (order, qtys) => ({ lines: order.lines.map((l, i) => ({ id: l.id, quantity: qtys ? qtys[i] : l.quantity })) });
const washAndPack = async (docNum, { washed, packed } = {}) => {
  const get = async () => (await call('GET', `/api/orders/${docNum}`, { token: admin })).body;
  assert.equal((await call('PATCH', `/api/orders/${docNum}/wash`, { token: packer, body: counts(await get(), washed) })).status, 200);
  assert.equal((await call('PATCH', `/api/orders/${docNum}/pack`, { token: packer, body: counts(await get(), packed) })).status, 200);
};

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

  // driver can't wash/pack; can't deliver until packed
  const cnt = (a, b) => ({ lines: [{ id: l1.id, quantity: a }, { id: l2.id, quantity: b }] });
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: driver, body: cnt(2, 3) })).status, 403);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/pack`, { token: packer, body: cnt(2, 3) })).status, 409); // not washed yet
  // washing and packing each need every line, with a real count
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer })).status, 400);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer, body: { lines: [{ id: l1.id, quantity: 2 }] } })).status, 400);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer, body: cnt(0, 3) })).status, 400);
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: driver, body: { paid: 0, lines: [{ id: l1.id, sqm: 1 }, { id: l2.id, sqm: 1 }] } })).status, 409);
  const washed = await call('PATCH', `/api/orders/${o.docNum}/wash`, { token: packer, body: cnt(2, 2) }); // one piece fewer after washing
  assert.equal(washed.body.status, "Yuvib bo'lingan");
  assert.deepEqual(washed.body.lines.map((l) => [l.pickedQuantity, l.washedQuantity, l.quantity]), [[2, 2, 2], [3, 2, 3]]);
  assert.equal(washed.body.washedBy, 'packer user');
  assert.ok((await call('GET', '/api/orders/washed', { token: driver })).body.data.some((x) => x.docNum === o.docNum));
  assert.equal((await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: driver, body: { paid: 0, lines: [{ id: l1.id, sqm: 1 }, { id: l2.id, sqm: 1 }] } })).status, 409);
  const packed = await call('PATCH', `/api/orders/${o.docNum}/pack`, { token: packer, body: cnt(2, 3) }); // the packed count is what is charged
  assert.equal(packed.body.status, 'Upakovka qilingan');
  assert.deepEqual(packed.body.lines.map((l) => [l.pickedQuantity, l.washedQuantity, l.quantity]), [[2, 2, 2], [3, 2, 3]]);
  assert.equal(packed.body.packedBy, 'packer user');
  assert.ok((await call('GET', '/api/orders/packed', { token: driver })).body.data.some((x) => x.docNum === o.docNum));

  // deliver: docTotal = sum(sqm * price) = 6.5*15000 + 4*10000 = 137500
  const del = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: driver, body: { deliveredDate: '2026-10-03', paid: 100000, lines: [{ id: l1.id, sqm: 6.5 }, { id: l2.id, sqm: 4 }] } });
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'Yetkazib berildi');
  assert.equal(del.body.docTotal, 137500);
  assert.equal(del.body.paid, 100000);
  assert.equal(del.body.debt, 37500);
  assert.equal(del.body.deliveredDate, '2026-10-03');
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
  assert.equal(r.body.defaultPrice, 0);
  const pr = await call('PATCH', `/api/services/${r.body.id}`, { token: admin, body: { defaultPrice: 15000 } });
  assert.equal(pr.body.defaultPrice, 15000);
  assert.equal((await call('PATCH', `/api/services/${r.body.id}`, { token: admin, body: { defaultPrice: -1 } })).status, 400);
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
  await washAndPack(a.docNum);
  const d = await call('PATCH', `/api/orders/${a.docNum}/deliver`, { token: admin, body: { deliveredDate: '2026-10-03', paid: 10000, lines: [{ id: l1.id, sqm: 2 }, { id: l2.id, sqm: 1 }] } });
  assert.equal(d.body.docTotal, 40000);
  assert.equal(d.body.deliveredBy, 'Administrator');

  const client = (await call('GET', `/api/clients/${a.clientId}`, { token: operator })).body;
  assert.equal(client.debt, 30000);
  assert.equal(client.ordersCount, 2);
  const debtors = (await call('GET', '/api/reports/debtors', { token: operator })).body;
  assert.ok(debtors.data.some((x) => x.clientId === a.clientId && x.debt === 30000));

  assert.equal((await call('POST', `/api/orders/${a.docNum}/payments`, { token: operator, body: { amount: 99999 } })).status, 400);
  const pay = await call('POST', `/api/orders/${a.docNum}/payments`, { token: operator, body: { amount: 30000, paidDate: '2026-10-04' } });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.debt, 0);
  assert.equal((await call('GET', `/api/orders/${a.docNum}/payments`, { token: operator })).body.data.length, 2);
  assert.equal((await call('GET', `/api/clients/${a.clientId}`, { token: operator })).body.debt, 0);

  // reports
  assert.equal((await call('GET', '/api/reports/summary?from=2026-10-01&to=2026-10-30', { token: operator })).status, 403);
  const sum = (await call('GET', '/api/reports/summary?from=2026-10-04&to=2026-10-04', { token: admin })).body;
  assert.equal(sum.collected, 30000);
  const sum2 = (await call('GET', '/api/reports/summary?from=2026-10-03&to=2026-10-03', { token: admin })).body;
  assert.equal(sum2.sales.total >= 40000, true);
  assert.equal(sum2.sales.totalSqm >= 3, true);
});

test('roles: permissions, custom roles, packer scope', async () => {
  // login/me expose permissions
  const me = (await call('GET', '/api/auth/me', { token: packer })).body;
  assert.equal(me.role, 'packer');
  assert.deepEqual(me.permissions.sort(), ['orders.pack', 'orders.view', 'orders.wash']);
  assert.equal((await call('GET', '/api/expenses', { token: packer })).status, 403);
  assert.equal((await call('GET', '/api/clients', { token: packer })).status, 403);
  assert.equal((await call('POST', '/api/orders', { token: packer, body: newOrder() })).status, 403);

  // only admin manages roles
  assert.equal((await call('GET', '/api/roles', { token: operator })).status, 403);
  const list = await call('GET', '/api/roles', { token: admin });
  assert.deepEqual(list.body.data.map((r) => r.key).sort(), ['admin', 'driver', 'operator', 'packer', 'saygak']);
  assert.equal((await call('PATCH', '/api/roles/admin', { token: admin, body: { permissions: [] } })).status, 409);

  // create a custom role, assign it, change its permissions live
  const created = await call('POST', '/api/roles', { token: admin, body: { name: 'Kassir', permissions: ['orders.view'] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.key, 'kassir');
  assert.equal((await call('POST', '/api/roles', { token: admin, body: { name: 'kassir' } })).status, 409);
  assert.equal((await call('POST', '/api/roles', { token: admin, body: { name: 'Bad', permissions: ['nope'] } })).status, 400);
  const u = await call('POST', '/api/users', { token: admin, body: { username: 'kass', fullName: 'Kassir', password: 'password123', role: 'kassir' } });
  assert.equal(u.status, 201);
  assert.equal((await call('POST', '/api/users', { token: admin, body: { username: 'bad1', fullName: 'x', password: 'password123', role: 'ghost' } })).status, 400);
  const kass = await login('kass', 'password123');
  assert.equal((await call('GET', '/api/expenses', { token: kass })).status, 403);
  await call('PATCH', '/api/roles/kassir', { token: admin, body: { permissions: ['orders.view', 'expenses.manage'] } });
  assert.equal((await call('GET', '/api/expenses', { token: kass })).status, 200);

  // can't delete built-in or in-use roles; can delete once empty
  assert.equal((await call('DELETE', '/api/roles/driver', { token: admin })).status, 409);
  assert.equal((await call('DELETE', '/api/roles/kassir', { token: admin })).status, 409);
  await call('PATCH', `/api/users/${u.body.id}`, { token: admin, body: { role: 'operator' } });
  assert.equal((await call('DELETE', '/api/roles/kassir', { token: admin })).status, 204);
});

test('branding: public read, admin-only write', async () => {
  const def = await call('GET', '/api/branding');
  assert.equal(def.status, 200);
  assert.deepEqual(def.body, { name: 'BIS CRM', logo: null, loginTitle: null, loginSubtitle: null, loginBackground: null, loginColor: null });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await call('PUT', '/api/branding', { token: operator, body: { name: 'X', logo: null } })).status, 403);
  assert.equal((await call('PUT', '/api/branding', { body: { name: 'X', logo: null } })).status, 401);
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: { name: 'X', logo: 'http://evil/x.png' } })).status, 400);
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: { name: '  ', logo: null } })).status, 400);
  const ok = await call('PUT', '/api/branding', { token: admin, body: { name: 'Yuvish Markazi', logo: png } });
  assert.equal(ok.body.name, 'Yuvish Markazi');
  assert.equal(ok.body.logo, png);
  assert.equal((await call('GET', '/api/branding')).body.logo, png);
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: { name: 'Yuvish Markazi', logo: null } })).body.logo, null);

  // login banner: text, color, background; partial updates leave the rest alone
  const banner = await call('PUT', '/api/branding', { token: admin, body: { loginTitle: 'Xush kelibsiz', loginSubtitle: 'Yuvish markazi', loginColor: '#112233', loginBackground: png } });
  assert.equal(banner.body.loginTitle, 'Xush kelibsiz');
  assert.equal(banner.body.loginColor, '#112233');
  assert.equal(banner.body.loginBackground, png);
  assert.equal(banner.body.name, 'Yuvish Markazi');
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: { loginTitle: 'Yangi' } })).body.loginSubtitle, 'Yuvish markazi');
  assert.equal((await call('PUT', '/api/branding', { token: operator, body: { loginTitle: 'x' } })).status, 403);
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: { loginColor: 'red' } })).status, 400);
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: { loginBackground: 'http://evil/x.png' } })).status, 400);
  assert.equal((await call('PUT', '/api/branding', { token: admin, body: {} })).status, 400);
  const reset = await call('PUT', '/api/branding', { token: admin, body: { loginTitle: null, loginSubtitle: '', loginColor: null, loginBackground: null } });
  assert.deepEqual([reset.body.loginTitle, reset.body.loginSubtitle, reset.body.loginColor, reset.body.loginBackground], [null, null, null, null]);
});

test('chat: global room and private messages', async () => {
  const ids = Object.fromEntries((await call('GET', '/api/users', { token: admin })).body.data.map((u) => [u.username, u.id]));
  // global: visible to everyone, unread tracked per user
  assert.equal((await call('GET', '/api/chat/unread', { token: packer })).body.total, 0); // first look = caught up
  assert.equal((await call('POST', '/api/chat/global', { token: operator, body: { body: '   ' } })).status, 400);
  const g = await call('POST', '/api/chat/global', { token: operator, body: { body: 'Salom hammaga' } });
  assert.equal(g.status, 201);
  assert.equal(g.body.recipientId, null);
  assert.equal((await call('GET', '/api/chat/unread', { token: packer })).body.global, 1);
  assert.equal((await call('GET', '/api/chat/unread', { token: operator })).body.global, 0); // own message
  const seen = await call('GET', '/api/chat/global', { token: admin });
  assert.ok(seen.body.data.some((m) => m.body === 'Salom hammaga' && m.senderName === 'operator user'));
  await call('PUT', '/api/chat/read/global', { token: packer, body: { upTo: g.body.id } });
  assert.equal((await call('GET', '/api/chat/unread', { token: packer })).body.global, 0);
  assert.equal((await call('GET', `/api/chat/global?after=${g.body.id}`, { token: packer })).body.data.length, 0);

  // private: only the two people see it
  const pm = await call('POST', `/api/chat/with/${ids.pack}`, { token: operator, body: { body: 'Zakaz tayyor' } });
  assert.equal(pm.status, 201);
  assert.equal(pm.body.recipientId, ids.pack);
  assert.ok((await call('GET', `/api/chat/with/${ids.oper}`, { token: packer })).body.data.some((m) => m.body === 'Zakaz tayyor'));
  assert.ok(!(await call('GET', `/api/chat/with/${ids.oper}`, { token: admin })).body.data.some((m) => m.body === 'Zakaz tayyor'));
  assert.ok(!(await call('GET', '/api/chat/global', { token: admin })).body.data.some((m) => m.body === 'Zakaz tayyor'));
  const unread = (await call('GET', '/api/chat/unread', { token: packer })).body;
  assert.equal(unread.direct[ids.oper], 1);
  assert.equal(unread.total, 1);
  const list = (await call('GET', '/api/chat/users', { token: packer })).body.data;
  const withOper = list.find((u) => u.id === ids.oper);
  assert.equal(withOper.unread, 1);
  assert.equal(withOper.last.body, 'Zakaz tayyor');
  await call('PUT', `/api/chat/read/${ids.oper}`, { token: packer, body: { upTo: pm.body.id } });
  assert.equal((await call('GET', '/api/chat/unread', { token: packer })).body.total, 0);

  // guards
  assert.equal((await call('POST', `/api/chat/with/${ids.pack}`, { token: packer, body: { body: 'x' } })).status, 400); // self
  assert.equal((await call('POST', '/api/chat/with/99999', { token: packer, body: { body: 'x' } })).status, 404);
  assert.equal((await call('GET', '/api/chat/global')).status, 401);
});

const upload = async (path, token, bytes, q = 'name=hello.txt&type=text/plain') => {
  const res = await fetch(`${base}${path}?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('chat: files, images and voice messages', async () => {
  const ids = Object.fromEntries((await call('GET', '/api/users', { token: admin })).body.data.map((u) => [u.username, u.id]));
  const bytes = Buffer.from('hello file');

  // global file visible to everyone, with metadata
  const g = await upload('/api/chat/global/file', operator, bytes);
  assert.equal(g.status, 201);
  assert.deepEqual(g.body.file, { name: 'hello.txt', mime: 'text/plain', size: 10, kind: 'file' });
  assert.equal(g.body.body, '');
  const dl = await fetch(`${base}/api/chat/files/${g.body.id}`, { headers: { authorization: `Bearer ${packer}` } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello file');
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream'); // unknown types are never served as html etc.
  assert.equal((await fetch(`${base}/api/chat/files/${g.body.id}`)).status, 401);

  // voice message + image are inline and keep their type
  const v = await upload('/api/chat/global/file', operator, Buffer.from('xx'), 'name=voice.webm&type=audio/webm');
  assert.equal(v.body.file.kind, 'audio');
  const img = await upload('/api/chat/global/file', operator, Buffer.from('xx'), 'name=a.png&type=image/png');
  assert.equal(img.body.file.kind, 'image');
  const html = await upload('/api/chat/global/file', operator, Buffer.from('<script>'), 'name=x.html&type=text/html');
  assert.equal(html.body.file.kind, 'file');
  const dlHtml = await fetch(`${base}/api/chat/files/${html.body.id}`, { headers: { authorization: `Bearer ${operator}` } });
  assert.equal(dlHtml.headers.get('content-type'), 'application/octet-stream');

  // private file: only sender and recipient
  const p = await upload(`/api/chat/with/${ids.pack}/file`, operator, bytes);
  assert.equal(p.status, 201);
  const get = (id, t) => fetch(`${base}/api/chat/files/${id}`, { headers: { authorization: `Bearer ${t}` } }).then((r) => r.status);
  assert.equal(await get(p.body.id, packer), 200);
  assert.equal(await get(p.body.id, operator), 200);
  assert.equal(await get(p.body.id, admin), 404);
  assert.ok((await call('GET', `/api/chat/with/${ids.oper}`, { token: packer })).body.data.some((m) => m.id === p.body.id && m.file));

  // validation
  assert.equal((await upload('/api/chat/global/file', operator, Buffer.alloc(0))).status, 400);
  assert.equal((await upload('/api/chat/global/file', operator, bytes, 'name=&type=text/plain')).status, 400);
  assert.equal((await upload('/api/chat/global/file', operator, bytes, 'name=a&type=not-a-mime')).status, 400);
  assert.equal((await upload(`/api/chat/with/${ids.oper}/file`, operator, bytes)).status, 400); // self
});

test('calls: signaling reaches only the online callee', async () => {
  const ids = Object.fromEntries((await call('GET', '/api/users', { token: admin })).body.data.map((u) => [u.username, u.id]));
  const offer = { to: ids.pack, callId: 'call-12345678', type: 'offer', media: 'video', data: { sdp: 'v=0' } };
  assert.equal((await call('GET', '/api/chat/ice', { token: operator })).body.iceServers[0].urls[0].startsWith('stun:'), true);

  // callee offline -> caller is told immediately
  assert.equal((await call('POST', '/api/chat/call/signal', { token: operator, body: offer })).status, 409);
  assert.equal((await call('POST', '/api/chat/call/signal', { token: operator, body: { ...offer, to: ids.oper } })).status, 400);

  // callee connects to the event stream, then receives the offer
  const ac = new AbortController();
  const res = await fetch(`${base}/api/chat/events`, { headers: { authorization: `Bearer ${packer}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const until = async (re) => {
    while (!re.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
  };
  await until(/retry: 3000/);

  assert.equal((await call('POST', '/api/chat/call/signal', { token: operator, body: offer })).body.delivered, true);
  await until(/event: signal\ndata: .*\n\n/);
  const data = JSON.parse(buf.match(/event: signal\ndata: (.*)\n\n/)[1]);
  assert.equal(data.type, 'offer');
  assert.equal(data.from.id, ids.oper);
  assert.equal(data.from.fullName, 'operator user');
  assert.equal(data.media, 'video');
  assert.deepEqual(data.data, { sdp: 'v=0' });

  // other users never see it, validation holds
  assert.equal((await call('POST', '/api/chat/call/signal', { token: operator, body: { ...offer, type: 'bogus' } })).status, 400);
  assert.equal((await call('GET', '/api/chat/events')).status, 401);
  ac.abort();
});

test('blank query filters are ignored', async () => {
  const r = await call('GET', '/api/expenses?page=1&limit=20&from=&to=&expenseTypeId=', { token: operator });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/expenses?from=2026-13-45', { token: operator })).status, 400); // real bad values still fail
  assert.equal((await call('GET', '/api/orders/received?search=', { token: operator })).status, 200);
});

test('services have a unit: kv.m, metr or dona', async () => {
  const list = (await call('GET', '/api/services', { token: operator })).body.data;
  assert.ok(list.every((x) => x.unit === 'kv.m')); // existing services keep working as before
  const dona = (await call('POST', '/api/services', { token: admin, body: { name: 'Yostiq yuvish', defaultPrice: 5000, unit: 'dona' } })).body;
  const metr = (await call('POST', '/api/services', { token: admin, body: { name: 'Karniz', defaultPrice: 2000, unit: 'metr' } })).body;
  assert.equal(dona.unit, 'dona');
  assert.equal((await call('POST', '/api/services', { token: admin, body: { name: 'Bad unit', unit: 'kg' } })).status, 400);

  const o = (await call('POST', '/api/orders', { token: operator, body: newOrder({ lines: [{ serviceId: dona.id, price: 5000 }, { serviceId: metr.id, price: 2000 }, { serviceId: 1, price: 10000 }] }) })).body;
  assert.deepEqual(o.lines.map((l) => l.unit), ['dona', 'metr', 'kv.m']);
  // changing a service's unit later does not touch existing orders
  await call('PATCH', `/api/services/${dona.id}`, { token: admin, body: { unit: 'kv.m' } });
  assert.equal((await call('GET', `/api/orders/${o.docNum}`, { token: operator })).body.lines[0].unit, 'dona');

  const [a, b, c] = o.lines;
  await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: admin, body: { waybillNumber: 'U-1', deliveryTime: '2026-11-03 18:00', lines: [{ id: a.id, quantity: 4 }, { id: b.id, quantity: 1 }, { id: c.id, quantity: 1 }] } });
  await washAndPack(o.docNum, { washed: [3, 1, 1], packed: [5, 1, 1] }); // 4 picked up, 3 after washing, 5 packed
  const noMeasure = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: { paid: 0, lines: [{ id: a.id }, { id: b.id }, { id: c.id }] } });
  assert.equal(noMeasure.status, 400); // metr and kv.m lines need a measurement
  const del = await call('PATCH', `/api/orders/${o.docNum}/deliver`, { token: admin, body: { paid: 0, lines: [{ id: a.id }, { id: b.id, sqm: 7.5 }, { id: c.id, sqm: 2 }] } });
  assert.equal(del.status, 200);
  // dona is charged by the PACKED count: 5 pcs * 5000 = 25000, metr: 7.5 * 2000 = 15000, kv.m: 2 * 10000 = 20000
  assert.deepEqual(del.body.lines.map((l) => l.lineTotal), [25000, 15000, 20000]);
  assert.equal(del.body.docTotal, 60000);
  assert.deepEqual([del.body.lines[0].pickedQuantity, del.body.lines[0].washedQuantity, del.body.lines[0].quantity, del.body.lines[0].sqm], [4, 3, 5, 5]);
  const log = (await call('GET', `/api/orders/${o.docNum}/history`, { token: admin })).body.data;
  assert.deepEqual(log.find((h) => h.action === 'order.packed').details.counts[0], { service: 'Yostiq yuvish', picked: 4, washed: 3, packed: 5 });
});

test('discounts: at delivery and when paying later, permission-gated, debt everywhere', async () => {
  const mk = async () => {
    const o = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Chegirma Mijoz', clientPhone: '+998935550001', lines: [{ serviceId: 1, price: 10000 }] }) })).body;
    const [l] = o.lines;
    await call('PATCH', `/api/orders/${o.docNum}/pickup`, { token: admin, body: { waybillNumber: 'D-1', deliveryTime: '2026-11-03 18:00', lines: [{ id: l.id, quantity: 1 }] } });
    await washAndPack(o.docNum);
    return { o, l };
  };

  // a role without orders.discount can't give one (driver delivers, no discount permission)
  const a = await mk();
  const deliverBody = { deliveredDate: '2026-10-03', paid: 0, lines: [{ id: a.l.id, sqm: 10 }] }; // total 100000
  assert.equal((await call('PATCH', `/api/orders/${a.o.docNum}/deliver`, { token: packer, body: { ...deliverBody, discount: 1000 } })).status, 403);
  assert.equal((await call('PATCH', `/api/orders/${a.o.docNum}/deliver`, { token: admin, body: { ...deliverBody, discount: 100001 } })).status, 400); // more than total
  const del = await call('PATCH', `/api/orders/${a.o.docNum}/deliver`, { token: admin, body: { ...deliverBody, paid: 60000, discount: 10000 } });
  assert.equal(del.status, 200);
  assert.equal(del.body.docTotal, 100000);
  assert.equal(del.body.discount, 10000);
  assert.equal(del.body.debt, 30000); // 100000 - 10000 - 60000

  // client debt and reports use the discounted figure
  const debtors = (await call('GET', '/api/reports/debtors', { token: admin })).body.data;
  assert.equal(debtors.find((d) => d.phone === '+998935550001').debt, 30000);

  // later payment with an extra discount: 30000 debt -> discount 5000 + pay 25000
  assert.equal((await call('POST', `/api/orders/${a.o.docNum}/payments`, { token: operator, body: { amount: 0, discount: 0 } })).status, 400);
  assert.equal((await call('POST', `/api/orders/${a.o.docNum}/payments`, { token: operator, body: { amount: 26000, discount: 5000 } })).status, 400); // too much
  const pay = await call('POST', `/api/orders/${a.o.docNum}/payments`, { token: operator, body: { amount: 25000, discount: 5000, paidDate: '2026-10-04' } });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.discount, 15000);
  assert.equal(pay.body.paid, 85000);
  assert.equal(pay.body.debt, 0);

  // discount-only (no money) is allowed on a fresh debt
  const b = await mk();
  await call('PATCH', `/api/orders/${b.o.docNum}/deliver`, { token: admin, body: { deliveredDate: '2026-10-03', paid: 0, lines: [{ id: b.l.id, sqm: 5 }] } });
  const only = await call('POST', `/api/orders/${b.o.docNum}/payments`, { token: operator, body: { discount: 20000 } });
  assert.equal(only.body.debt, 30000);
  assert.equal(only.body.paid, 0);

  // history: who did what, in order, with details
  const hist = (await call('GET', `/api/orders/${a.o.docNum}/history`, { token: packer })).body.data;
  assert.deepEqual(hist.map((h) => h.action), ['order.created', 'order.pickedup', 'order.washed', 'order.packed', 'order.delivered', 'order.payment']);
  assert.equal(hist[0].userName, 'operator user');
  assert.equal(hist[2].userName, 'packer user');
  assert.deepEqual([hist[2].details.from, hist[2].details.to], ['Olib Ketildi', "Yuvib bo'lingan"]);
  assert.equal(hist[4].details.discount, 10000);
  assert.equal(hist[5].details.debtLeft, 0);
});

test('activity log: edits, cancels, admin changes; admin-only listing', async () => {
  const o = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Log Mijoz', clientPhone: '+998935550002' }) })).body;
  await call('PATCH', `/api/orders/${o.docNum}`, { token: operator, body: { landmark: 'Yangi orientir', clientName: 'Log Mijoz 2' } });
  await call('POST', `/api/orders/${o.docNum}/cancel`, { token: operator, body: { reason: 'Fikridan qaytdi' } });
  const hist = (await call('GET', `/api/orders/${o.docNum}/history`, { token: operator })).body.data;
  assert.deepEqual(hist.map((h) => h.action), ['order.created', 'order.edited', 'order.cancelled']);
  assert.deepEqual(hist[1].details.changes, { clientName: { from: 'Log Mijoz', to: 'Log Mijoz 2' }, landmark: { from: 'Korzinka yonida', to: 'Yangi orientir' } });
  assert.equal(hist[2].details.reason, 'Fikridan qaytdi');
  assert.equal((await call('GET', '/api/orders/99999/history', { token: operator })).status, 404);

  // admin changes are logged without secrets
  const u = (await call('POST', '/api/users', { token: admin, body: { username: 'logu', fullName: 'Log User', password: 'password123', role: 'operator' } })).body;
  await call('PATCH', `/api/users/${u.id}`, { token: admin, body: { password: 'newpassword123', role: 'driver' } });
  await call('POST', '/api/services', { token: admin, body: { name: 'Log xizmati', unit: 'metr' } });
  await call('POST', '/api/roles', { token: admin, body: { name: 'Log role', permissions: ['orders.view'] } });
  await call('PUT', '/api/branding', { token: admin, body: { name: 'Log brand' } });

  const all = await call('GET', '/api/activity?limit=200', { token: admin });
  assert.equal(all.status, 200);
  const actions = all.body.data.map((a) => a.action);
  for (const want of ['user.created', 'user.updated', 'service.created', 'role.created', 'branding.updated', 'order.cancelled']) assert.ok(actions.includes(want), want);
  const upd = all.body.data.find((a) => a.action === 'user.updated' && a.entityId === String(u.id));
  assert.deepEqual(upd.details.changes, { role: { from: 'operator', to: 'driver' } });
  assert.equal(upd.details.passwordChanged, true);
  assert.ok(!JSON.stringify(all.body).includes('newpassword123'));
  assert.equal(upd.userName, 'Administrator');

  // filters + permissions
  const byUser = await call('GET', `/api/activity?entity=user&entityId=${u.id}`, { token: admin });
  assert.ok(byUser.body.data.length >= 2 && byUser.body.data.every((a) => a.entity === 'user'));
  assert.equal((await call('GET', '/api/activity', { token: operator })).status, 403);
  assert.equal((await call('GET', '/api/activity')).status, 401);
});

test('comments on orders, clients and expenses', async () => {
  const o = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Izoh Mijoz', clientPhone: '+998935550003' }) })).body;

  // add + list
  const c1 = await call('POST', '/api/comments', { token: operator, body: { entity: 'order', entityId: o.docNum, body: 'Mijoz soat 5 dan keyin uyda' } });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.userName, 'operator user');
  await call('POST', '/api/comments', { token: admin, body: { entity: 'order', entityId: o.docNum, body: 'Qabul qilindi' } });
  const list = (await call('GET', `/api/comments?entity=order&entityId=${o.docNum}`, { token: packer })).body.data;
  assert.deepEqual(list.map((c) => c.body), ['Mijoz soat 5 dan keyin uyda', 'Qabul qilindi']);

  // counts for list badges
  const counts = (await call('GET', `/api/comments/counts?entity=order&ids=${o.docNum},99999`, { token: operator })).body.data;
  assert.deepEqual(counts, { [o.docNum]: 2 });

  // permission follows the record: a packer has no clients.view / expenses.manage
  const clientId = o.clientId;
  assert.equal((await call('POST', '/api/comments', { token: packer, body: { entity: 'client', entityId: clientId, body: 'x' } })).status, 403);
  assert.equal((await call('GET', `/api/comments?entity=client&entityId=${clientId}`, { token: packer })).status, 403);
  assert.equal((await call('POST', '/api/comments', { token: operator, body: { entity: 'client', entityId: clientId, body: 'Doimiy mijoz' } })).status, 201);
  const exp = (await call('GET', '/api/expenses', { token: operator })).body.data[0];
  assert.equal((await call('POST', '/api/comments', { token: operator, body: { entity: 'expense', entityId: exp.id, body: 'Chek yo\'q' } })).status, 201);

  // validation
  assert.equal((await call('POST', '/api/comments', { token: operator, body: { entity: 'order', entityId: o.docNum, body: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/comments', { token: operator, body: { entity: 'order', entityId: 99999, body: 'x' } })).status, 404);
  assert.equal((await call('POST', '/api/comments', { token: operator, body: { entity: 'user', entityId: 1, body: 'x' } })).status, 400);
  assert.equal((await call('GET', '/api/comments?entity=order&entityId=1')).status, 401);

  // comments appear in the order history
  const hist = (await call('GET', `/api/orders/${o.docNum}/history`, { token: operator })).body.data;
  assert.deepEqual(hist.filter((h) => h.action === 'comment.added').map((h) => h.details.text), ['Mijoz soat 5 dan keyin uyda', 'Qabul qilindi']);

  // delete: own or admin only
  assert.equal((await call('DELETE', `/api/comments/${c1.body.id}`, { token: packer })).status, 403);
  assert.equal((await call('DELETE', `/api/comments/${c1.body.id}`, { token: operator })).status, 204);
  const second = list[1].id;
  assert.equal((await call('DELETE', `/api/comments/${second}`, { token: admin })).status, 204);
  assert.equal((await call('DELETE', `/api/comments/${second}`, { token: admin })).status, 404);
  assert.equal((await call('GET', `/api/comments?entity=order&entityId=${o.docNum}`, { token: operator })).body.data.length, 0);
});

test('clients: CRUD, saved addresses, ordering for an existing client', async () => {
  // permissions: operator manages clients, packer can't even see them
  assert.equal((await call('POST', '/api/clients', { token: packer, body: { name: 'X', phone: '+998901110000' } })).status, 403);
  const created = await call('POST', '/api/clients', { token: operator, body: { name: 'Qo\'lda Mijoz', phone: '+998 90 111 00 01' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.phone, '+998901110001');
  assert.deepEqual([created.body.ordersCount, created.body.debt, created.body.addresses], [0, 0, []]);
  const id = created.body.id;
  assert.equal((await call('POST', '/api/clients', { token: operator, body: { name: 'Dup', phone: '+998901110001' } })).status, 409);
  assert.equal((await call('POST', '/api/clients', { token: operator, body: { name: '', phone: '+998901110002' } })).status, 400);

  // manual address
  const addr = await call('POST', `/api/clients/${id}/addresses`, { token: operator, body: { latitude: 41.3, longitude: 69.2, landmark: 'Uy' } });
  assert.equal(addr.status, 201);

  // an order for the EXISTING client: clientId alone is enough, name/phone come from the client record
  const o1 = await call('POST', '/api/orders', { token: operator, body: { clientId: id, location: { latitude: 41.3, longitude: 69.2001 }, landmark: '', pickupTime: '2026-11-01 10:00', lines: [{ serviceId: 1, price: 1000 }] } });
  assert.equal(o1.status, 201);
  assert.equal(o1.body.clientName, "Qo'lda Mijoz");
  assert.equal(o1.body.clientPhone, '+998901110001');
  assert.equal(o1.body.clientId, id);
  // same place (within ~30 m) is not saved twice; it keeps its landmark
  let detail = (await call('GET', `/api/clients/${id}`, { token: operator })).body;
  assert.equal(detail.addresses.length, 1);
  assert.equal(detail.addresses[0].landmark, 'Uy');

  // a different place is added and becomes the most recent (what the sales form pre-selects)
  await call('POST', '/api/orders', { token: operator, body: { clientId: id, location: { latitude: 41.35, longitude: 69.3 }, landmark: 'Ish joyi', pickupTime: '2026-11-02 10:00', lines: [{ serviceId: 1, price: 1000 }] } });
  detail = (await call('GET', `/api/clients/${id}`, { token: operator })).body;
  assert.deepEqual(detail.addresses.map((a) => a.landmark), ['Ish joyi', 'Uy']);
  assert.equal(detail.ordersCount, 2);

  // a NEW client typed on the order is saved automatically, with the address
  const o3 = (await call('POST', '/api/orders', { token: operator, body: newOrder({ clientName: 'Yangi Avto', clientPhone: '+998935559999' }) })).body;
  const auto = (await call('GET', `/api/clients/${o3.clientId}`, { token: operator })).body;
  assert.equal(auto.name, 'Yangi Avto');
  assert.equal(auto.addresses.length, 1);
  assert.equal(auto.addresses[0].landmark, 'Korzinka yonida');

  // validation
  assert.equal((await call('POST', '/api/orders', { token: operator, body: { ...newOrder(), clientName: undefined, clientPhone: undefined } })).status, 400);
  assert.equal((await call('POST', '/api/orders', { token: operator, body: { ...newOrder(), clientId: 99999 } })).status, 400);

  // edit: renames the client everywhere, phone must stay unique
  assert.equal((await call('PATCH', `/api/clients/${id}`, { token: operator, body: { phone: '+998935559999' } })).status, 409);
  const ed = await call('PATCH', `/api/clients/${id}`, { token: operator, body: { name: 'Yangi Nom' } });
  assert.equal(ed.body.name, 'Yangi Nom');
  assert.equal((await call('GET', `/api/orders/${o1.body.docNum}`, { token: operator })).body.clientName, 'Yangi Nom');

  // address edit/delete
  assert.equal((await call('PATCH', `/api/clients/${id}/addresses/${addr.body.id}`, { token: operator, body: { landmark: 'Yangi uy' } })).body.landmark, 'Yangi uy');
  assert.equal((await call('DELETE', `/api/clients/${id}/addresses/${addr.body.id}`, { token: operator })).status, 204);
  assert.equal((await call('DELETE', `/api/clients/${id}/addresses/${addr.body.id}`, { token: operator })).status, 404);

  // delete: only without orders
  assert.equal((await call('DELETE', `/api/clients/${id}`, { token: operator })).status, 409);
  const empty = (await call('POST', '/api/clients', { token: operator, body: { name: 'Bo\'sh', phone: '+998901110003' } })).body;
  assert.equal((await call('DELETE', `/api/clients/${empty.id}`, { token: operator })).status, 204);
  assert.equal((await call('GET', `/api/clients/${empty.id}`, { token: operator })).status, 404);

  // everything is in the activity log
  const log = (await call('GET', '/api/activity?entity=client&limit=100', { token: admin })).body.data.map((a) => a.action);
  for (const want of ['client.created', 'client.updated', 'client.deleted', 'client.address_added', 'client.address_updated', 'client.address_deleted']) assert.ok(log.includes(want), want);
});

test('creating a client can include an address', async () => {
  const r = await call('POST', '/api/clients', { token: operator, body: { name: 'Manzilli', phone: '+998901110077', address: { latitude: 41.2, longitude: 69.1, landmark: 'Bozor yonida' } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.addresses.length, 1);
  assert.equal(r.body.addresses[0].landmark, 'Bozor yonida');
  const bare = await call('POST', '/api/clients', { token: operator, body: { name: 'Manzilsiz', phone: '+998901110078' } });
  assert.deepEqual(bare.body.addresses, []);
  assert.equal((await call('POST', '/api/clients', { token: operator, body: { name: 'Bad', phone: '+998901110079', address: { latitude: 300, longitude: 0 } } })).status, 400);
});
