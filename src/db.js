import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const ORDER_STATUS = Object.freeze({
  RECEIVED: 'Zakaz Qabul qilindi',
  PICKED_UP: 'Olib Ketildi',
  DELIVERED: 'Yetkazib berildi',
  CANCELLED: 'Bekor qilindi',
});

export const DEFAULT_SERVICES = ['Gilam yuvish', 'Adyol yuvish', "Ko'rpa yuvish", 'Parda yuvish'];
export const DEFAULT_EXPENSE_TYPES = ['Oylik', 'Avans', 'Obed', 'Transport', 'Kommunal', 'Boshqa'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  fullName     TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin','operator','driver')),
  isActive     INTEGER NOT NULL DEFAULT 1,
  createdAt    TEXT NOT NULL
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

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
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
