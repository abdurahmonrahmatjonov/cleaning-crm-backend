import { test } from 'node:test';
import assert from 'node:assert/strict';
const { openDb } = await import('../src/db.js');

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
