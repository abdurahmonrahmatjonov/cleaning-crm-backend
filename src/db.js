import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const ORDER_STATUS = Object.freeze({
  RECEIVED: 'Zakaz Qabul qilindi',
  PICKED_UP: 'Olib Ketildi',
  WASHED: "Yuvib bo'lingan",
  PACKED: 'Upakovka qilingan',
  DELIVERED: 'Yetkazib berildi',
  CANCELLED: 'Bekor qilindi',
});

/** Everything a role can be allowed to do. Admin always has all of them. */
export const PERMISSIONS = Object.freeze([
  'orders.view',
  'orders.create',
  'orders.edit', // edit + cancel
  'orders.pickup',
  'orders.wash',
  'orders.pack',
  'orders.deliver',
  'orders.payments',
  'orders.discount', // give a discount when delivering / taking payment
  'clients.view',
  'clients.manage', // add / edit / delete clients and their saved addresses
  'debtors.view',
  'expenses.manage',
  'reports.view',
]);

export const DEFAULT_ROLES = [
  { key: 'admin', name: 'Admin', isSystem: 1, permissions: PERMISSIONS },
  {
    key: 'operator',
    name: 'Operator',
    isSystem: 1,
    permissions: ['orders.view', 'orders.create', 'orders.edit', 'orders.payments', 'orders.discount', 'clients.view', 'clients.manage', 'debtors.view', 'expenses.manage'],
  },
  { key: 'driver', name: 'Haydovchi', isSystem: 1, permissions: ['orders.view', 'orders.pickup', 'orders.deliver', 'clients.view'] },
  { key: 'packer', name: 'Upakovkachi', isSystem: 1, permissions: ['orders.view', 'orders.wash', 'orders.pack'] },
  { key: 'saygak', name: 'Saygak', isSystem: 1, permissions: [] },
];

/** How a service is measured and priced: per square metre, per metre, or per piece. */
export const UNITS = Object.freeze(['kv.m', 'metr', 'dona']);

export const DEFAULT_SERVICES = ['Gilam yuvish', 'Adyol yuvish', "Ko'rpa yuvish", 'Parda yuvish'];
export const DEFAULT_EXPENSE_TYPES = ['Oylik', 'Avans', 'Obed', 'Transport', 'Kommunal', 'Boshqa'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  fullName     TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  role         TEXT NOT NULL,
  isActive     INTEGER NOT NULL DEFAULT 1,
  createdAt    TEXT NOT NULL
);

-- Roles are data: admins edit which permissions each role has (and can add roles).
CREATE TABLE IF NOT EXISTS roles (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  permissions TEXT NOT NULL DEFAULT '[]',
  isSystem    INTEGER NOT NULL DEFAULT 0
);

-- Chat: recipientId NULL = the global room everyone sees; otherwise a private message.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  senderId    INTEGER NOT NULL REFERENCES users(id),
  senderName  TEXT NOT NULL,
  recipientId INTEGER REFERENCES users(id),
  body        TEXT NOT NULL,
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(recipientId, id);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(senderId, recipientId, id);

-- Last message each user has seen per conversation: peer is 'g' (global) or the other user's id.
CREATE TABLE IF NOT EXISTS chat_reads (
  userId     INTEGER NOT NULL REFERENCES users(id),
  peer       TEXT NOT NULL,
  lastReadId INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (userId, peer)
);

-- Audit trail of every change, for orders and for the admin pages (users, roles, services, ...).
CREATE TABLE IF NOT EXISTS activity_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  userId   INTEGER,
  userName TEXT NOT NULL,
  entity   TEXT NOT NULL,
  entityId TEXT NOT NULL,
  action   TEXT NOT NULL,
  details  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity, entityId, id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(userId, id);

-- Free-text notes people attach to an order, client or expense.
CREATE TABLE IF NOT EXISTS comments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entityId  TEXT NOT NULL,
  userId    INTEGER NOT NULL REFERENCES users(id),
  userName  TEXT NOT NULL,
  body      TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(entity, entityId, id);

-- Places a client has asked us to pick up from. Filled automatically from orders, and editable by hand.
CREATE TABLE IF NOT EXISTS client_addresses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  clientId   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  latitude   REAL NOT NULL,
  longitude  REAL NOT NULL,
  landmark   TEXT NOT NULL DEFAULT '',
  createdAt  TEXT NOT NULL,
  lastUsedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addresses_client ON client_addresses(clientId, lastUsedAt);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  isActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expense_types (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  isActive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  phone     TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL
);

-- All sales live in this one table; the three sales menus are just status filters.
CREATE TABLE IF NOT EXISTS orders (
  docNum         INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT NOT NULL,
  docStatus      TEXT NOT NULL DEFAULT 'Open',
  clientId       INTEGER NOT NULL REFERENCES clients(id),
  clientName     TEXT NOT NULL,
  clientPhone    TEXT NOT NULL,
  latitude       REAL NOT NULL,
  longitude      REAL NOT NULL,
  landmark       TEXT NOT NULL DEFAULT '',
  pickupPlannedAt TEXT NOT NULL,
  createdById    INTEGER NOT NULL REFERENCES users(id),
  createdByName  TEXT NOT NULL,
  docTotal       REAL NOT NULL DEFAULT 0,
  paid           REAL NOT NULL DEFAULT 0,
  docRate        REAL NOT NULL DEFAULT 0,
  createdAt      TEXT NOT NULL,
  orderTakenAt   TEXT NOT NULL,
  deliveryTime   TEXT NOT NULL DEFAULT '',
  pickedUpAt     TEXT NOT NULL DEFAULT '',
  deliveredDate  TEXT NOT NULL DEFAULT '',
  deliveredAt    TEXT NOT NULL DEFAULT '',
  waybillNumber  TEXT NOT NULL DEFAULT '',
  pickedUpById   INTEGER,
  pickedUpByName TEXT NOT NULL DEFAULT '',
  deliveredById  INTEGER,
  deliveredByName TEXT NOT NULL DEFAULT '',
  cancelReason   TEXT NOT NULL DEFAULT '',
  cancelledAt    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(clientId);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  docNum           INTEGER NOT NULL REFERENCES orders(docNum) ON DELETE CASCADE,
  serviceId        INTEGER NOT NULL REFERENCES services(id),
  serviceName      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Open',
  price            REAL NOT NULL,
  customerPrice    REAL NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 0,
  sqm              REAL NOT NULL DEFAULT 0,
  lineTotal        REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'UZS'
);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON order_lines(docNum);

-- Every sum of money received for an order (at delivery and later debt payments).
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  docNum      INTEGER NOT NULL REFERENCES orders(docNum),
  amount      REAL NOT NULL CHECK (amount > 0),
  paidDate    TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  creatorId   INTEGER NOT NULL REFERENCES users(id),
  creatorName TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_doc ON payments(docNum);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(paidDate);

CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  expenseTypeId INTEGER NOT NULL REFERENCES expense_types(id),
  expenseType   TEXT NOT NULL,
  amount        REAL NOT NULL CHECK (amount > 0),
  expenseDate   TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  creatorId     INTEGER NOT NULL REFERENCES users(id),
  creatorName   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expenseDate);
`;

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

/** Idempotent upgrades for databases created by older versions. */
function migrate(db) {
  // 1. users.role used to be limited to admin/operator/driver by a CHECK; roles are data now.
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
  if (/CHECK\s*\(\s*role\s+IN/i.test(usersSql)) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
          fullName     TEXT NOT NULL,
          passwordHash TEXT NOT NULL,
          role         TEXT NOT NULL,
          isActive     INTEGER NOT NULL DEFAULT 1,
          createdAt    TEXT NOT NULL
        );
        INSERT INTO users_new (id, username, fullName, passwordHash, role, isActive, createdAt)
          SELECT id, username, fullName, passwordHash, role, isActive, createdAt FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    })();
    db.pragma('foreign_keys = ON');
  }
  // 2. who washed / packed an order and when
  for (const [col, def] of [
    ['washedAt', "TEXT NOT NULL DEFAULT ''"],
    ['washedById', 'INTEGER'],
    ['washedByName', "TEXT NOT NULL DEFAULT ''"],
    ['packedAt', "TEXT NOT NULL DEFAULT ''"],
    ['packedById', 'INTEGER'],
    ['packedByName', "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!hasColumn(db, 'orders', col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${def}`);
  }
  // 2b. chat attachments (file / image / voice message) live on disk; the row keeps their metadata
  for (const [col, def] of [
    ['fileKey', "TEXT NOT NULL DEFAULT ''"],
    ['fileName', "TEXT NOT NULL DEFAULT ''"],
    ['fileMime', "TEXT NOT NULL DEFAULT ''"],
    ['fileSize', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!hasColumn(db, 'messages', col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${def}`);
  }
  // 2c. unit of measure per service (and a snapshot on each order line so old orders never change)
  for (const table of ['services', 'order_lines']) {
    if (!hasColumn(db, table, 'unit')) db.exec(`ALTER TABLE ${table} ADD COLUMN unit TEXT NOT NULL DEFAULT 'kv.m'`);
  }
  // 2d. discount given on an order (reduces what the client owes) and on a payment
  for (const table of ['orders', 'payments']) {
    if (!hasColumn(db, table, 'discount')) db.exec(`ALTER TABLE ${table} ADD COLUMN discount REAL NOT NULL DEFAULT 0`);
  }
  // 2e. one-time: turn the addresses of existing orders into saved client addresses
  const once = (key, fn) => {
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) return;
    db.transaction(() => { fn(); db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, '1'); })();
  };
  once('addresses_backfilled', () => {
    db.exec(`INSERT INTO client_addresses (clientId, latitude, longitude, landmark, createdAt, lastUsedAt)
             SELECT clientId, latitude, longitude, landmark, MIN(orderTakenAt), MAX(orderTakenAt) FROM orders
             GROUP BY clientId, ROUND(latitude, 3), ROUND(longitude, 3)`);
  });
  // operators already created clients implicitly through orders, so they keep that ability as a permission
  once('perm_clients_manage', () => {
    const op = db.prepare("SELECT permissions FROM roles WHERE key = 'operator'").get();
    if (!op) return;
    const perms = JSON.parse(op.permissions);
    if (!perms.includes('clients.manage')) {
      db.prepare("UPDATE roles SET permissions = ? WHERE key = 'operator'").run(JSON.stringify([...perms, 'clients.manage']));
    }
  });
  // 2f. quantities along the way: counted at pickup, counted again after washing, and the final one at packing
  //     (`quantity` is what the client is charged for; it becomes the packed count)
  for (const col of ['pickedQuantity', 'washedQuantity']) {
    if (!hasColumn(db, 'order_lines', col)) db.exec(`ALTER TABLE order_lines ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
  once('picked_quantity_backfilled', () => db.exec('UPDATE order_lines SET pickedQuantity = quantity WHERE pickedQuantity = 0 AND quantity > 0'));
  // 2g. saygak (partner) accounts: special prices, own login, no-delivery orders, gilam sizes, lump payments
  if (!hasColumn(db, 'clients', 'isPartner')) db.exec('ALTER TABLE clients ADD COLUMN isPartner INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn(db, 'users', 'clientId')) db.exec('ALTER TABLE users ADD COLUMN clientId INTEGER REFERENCES clients(id)');
  if (!hasColumn(db, 'orders', 'kind')) db.exec("ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular'");
  if (!hasColumn(db, 'order_lines', 'expectedQuantity')) db.exec('ALTER TABLE order_lines ADD COLUMN expectedQuantity INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn(db, 'payments', 'batchId')) db.exec("ALTER TABLE payments ADD COLUMN batchId TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_client ON users(clientId) WHERE clientId IS NOT NULL;
    CREATE TABLE IF NOT EXISTS order_line_sizes (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      lineId INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
      width  REAL NOT NULL,
      length REAL NOT NULL,
      area   REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sizes_line ON order_line_sizes(lineId);
    CREATE TABLE IF NOT EXISTS client_prices (
      clientId  INTEGER NOT NULL REFERENCES clients(id),
      serviceId INTEGER NOT NULL REFERENCES services(id),
      price     REAL NOT NULL CHECK (price >= 0),
      PRIMARY KEY (clientId, serviceId)
    );
    CREATE TABLE IF NOT EXISTS payment_batches (
      batchId        TEXT PRIMARY KEY,
      clientId       INTEGER NOT NULL REFERENCES clients(id),
      amount         REAL NOT NULL,
      discount       REAL NOT NULL DEFAULT 0,
      paidDate       TEXT NOT NULL,
      createdAt      TEXT NOT NULL,
      creatorId      INTEGER NOT NULL,
      creatorName    TEXT NOT NULL,
      allocations    TEXT NOT NULL,
      reversedAt     TEXT NOT NULL DEFAULT '',
      reversedByName TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_batches_client ON payment_batches(clientId);
    CREATE TRIGGER IF NOT EXISTS users_saygak_pair_ins BEFORE INSERT ON users
      WHEN (NEW.role = 'saygak') != (NEW.clientId IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'saygak role and clientId must go together'); END;
    CREATE TRIGGER IF NOT EXISTS users_saygak_pair_upd BEFORE UPDATE OF role, clientId ON users
      WHEN (NEW.role = 'saygak') != (NEW.clientId IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'saygak role and clientId must go together'); END;
  `);
  // the saygak role is fixed: also covers a DB where an admin had already created a custom role with this key
  once('saygak_role_locked', () => db.prepare("UPDATE roles SET isSystem = 1, permissions = '[]', name = 'Saygak' WHERE key = 'saygak'").run());
  // 3. built-in roles (never overwrite permissions an admin has already edited)
  const ins = db.prepare('INSERT OR IGNORE INTO roles (key, name, permissions, isSystem) VALUES (?,?,?,?)');
  for (const r of DEFAULT_ROLES) ins.run(r.key, r.name, JSON.stringify(r.permissions), r.isSystem);
}

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  // Migration: default price per sq.m on services (existing DBs predate it)
  if (!db.prepare('PRAGMA table_info(services)').all().some((c) => c.name === 'defaultPrice')) {
    db.exec('ALTER TABLE services ADD COLUMN defaultPrice INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}

export function seed(db, { adminPassword = config.admin.password, now }) {
  const insertName = (table, names) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (name) VALUES (?)`);
    for (const n of names) stmt.run(n);
  };
  if (db.prepare('SELECT COUNT(*) c FROM services').get().c === 0) insertName('services', DEFAULT_SERVICES);
  if (db.prepare('SELECT COUNT(*) c FROM expense_types').get().c === 0) {
    insertName('expense_types', DEFAULT_EXPENSE_TYPES);
  }
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    if (!adminPassword) {
      throw new Error('No users yet: set ADMIN_PASSWORD in .env to create the first admin');
    }
    db.prepare(
      `INSERT INTO users (username, fullName, passwordHash, role, createdAt) VALUES (?,?,?,?,?)`,
    ).run(config.admin.username, config.admin.fullName, bcrypt.hashSync(adminPassword, 10), 'admin', now);
  }
}
