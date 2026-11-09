'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');

const usePostgres = Boolean(process.env.DATABASE_URL);

let sqlite = null;
let PgPool = null;
let initialization;
let localTransactionGate = null;
let transactionQueue = Promise.resolve();
const requestContext = new AsyncLocalStorage();

if (usePostgres) {
  const { Pool, neonConfig } = require('@neondatabase/serverless');
  const { WebSocket } = require('ws');
  neonConfig.webSocketConstructor = WebSocket;
  PgPool = Pool;
} else {
  let Database = null;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    Database = null;
  }

  const defaultDbPath = process.env.VERCEL
    ? path.join('/tmp', 'restaurant.db')
    : path.join(__dirname, '..', 'data', 'restaurant.db');
  const dbPath = process.env.DB_PATH || defaultDbPath;
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (!Database) {
    if (process.env.VERCEL) {
      console.warn('better-sqlite3 non disponible sur Vercel. Configurez DATABASE_URL (Neon PostgreSQL) pour activer l\'API.');
    } else {
      throw new Error('better-sqlite3 est requis en local. Exécutez "npm install" pour l\'installer.');
    }
  } else {
    sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, name TEXT NOT NULL,
      phone TEXT, username TEXT UNIQUE, password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT, price INTEGER NOT NULL DEFAULT 0, image_url TEXT,
      available INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      featured INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER REFERENCES users(id),
      customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, comment TEXT,
      payment_method TEXT NOT NULL DEFAULT 'cash', status TEXT NOT NULL DEFAULT 'pending',
      cancel_reason TEXT, total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      fulfillment TEXT NOT NULL DEFAULT 'delivery', delivery_address TEXT, latitude REAL, longitude REAL,
      location_accuracy REAL, pickup_time TEXT, ready_at TEXT, completed_at TEXT, modified_at TEXT,
      client_ack INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id), product_name TEXT NOT NULL,
      unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS order_modifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id), user_name TEXT, summary TEXT NOT NULL, note TEXT,
      old_total INTEGER NOT NULL, new_total INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS realtime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT,
      venue_type TEXT NOT NULL DEFAULT 'restaurant',
      venue_name TEXT NOT NULL,
      location TEXT NOT NULL,
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      badge TEXT,
      organizer TEXT,
      featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ticket_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL DEFAULT 0,
      quantity_available INTEGER NOT NULL DEFAULT 50,
      quantity_sold INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS event_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT NOT NULL UNIQUE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES users(id),
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'momo_mtn',
      payment_status TEXT NOT NULL DEFAULT 'confirmed',
      status TEXT NOT NULL DEFAULT 'valid',
      used_at TEXT,
      qr_data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_mods_order ON order_modifications(order_id);
    CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completed_at);
    CREATE INDEX IF NOT EXISTS idx_realtime_events_customer ON realtime_events(customer_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
    CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON ticket_types(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_tickets_code ON event_tickets(ticket_code);
    CREATE INDEX IF NOT EXISTS idx_event_tickets_phone ON event_tickets(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_event_tickets_event ON event_tickets(event_id);
  `);

  function addColumn(table, column, definition) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  addColumn('users', 'address', 'TEXT');
  addColumn('users', 'latitude', 'REAL');
  addColumn('users', 'longitude', 'REAL');
  addColumn('users', 'fulfillment', 'TEXT');
  addColumn('products', 'featured', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('orders', 'fulfillment', "TEXT NOT NULL DEFAULT 'delivery'");
  addColumn('orders', 'delivery_address', 'TEXT');
  addColumn('orders', 'latitude', 'REAL');
  addColumn('orders', 'longitude', 'REAL');
  addColumn('orders', 'location_accuracy', 'REAL');
  addColumn('orders', 'pickup_time', 'TEXT');
  addColumn('orders', 'ready_at', 'TEXT');
  addColumn('orders', 'completed_at', 'TEXT');
  addColumn('orders', 'modified_at', 'TEXT');
  addColumn('orders', 'client_ack', 'INTEGER NOT NULL DEFAULT 1');
  }
}

function currentPool() {
  const context = requestContext.getStore();
  if (!context) throw new Error('Connexion PostgreSQL indisponible hors du contexte de requête.');
  return context.pool;
}

async function withRequest(callback) {
  if (!usePostgres || requestContext.getStore()) return callback();

  const pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 1 });
  pool.on('error', (error) => console.error('Erreur de connexion Neon :', error));
  return requestContext.run({ pool }, async () => {
    try {
      return await callback();
    } finally {
      await pool.end();
    }
  });
}

function postgresSql(statement) {
  let index = 0;
  return statement.replace(/\?/g, () => `$${++index}`);
}

function sqliteQuery(statement, params) {
  if (!sqlite) {
    throw new Error('Base de données SQLite non disponible. Sur Vercel, configurez DATABASE_URL (Neon PostgreSQL).');
  }
  const result = sqlite.prepare(statement);
  if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(statement)) {
    const rows = result.all(...params);
    return { rows, rowCount: rows.length };
  }
  if (/\bRETURNING\b/i.test(statement)) {
    const rows = result.all(...params);
    return { rows, rowCount: rows.length };
  }
  const info = result.run(...params);
  return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
}

function executor(queryFn) {
  return {
    query: queryFn,
    async all(statement, ...params) {
      return (await queryFn(statement, params)).rows;
    },
    async one(statement, ...params) {
      return (await queryFn(statement, params)).rows[0] || null;
    },
    async run(statement, ...params) {
      return queryFn(statement, params);
    },
  };
}

const rootExecutor = executor(async (statement, params = []) => {
  if (usePostgres) return currentPool().query(postgresSql(statement), params);
  if (localTransactionGate) await localTransactionGate;
  return sqliteQuery(statement, params);
});

async function transaction(callback) {
  if (usePostgres) {
    const client = await currentPool().connect();
    try {
      await client.query('BEGIN');
      const tx = executor((statement, params = []) => client.query(postgresSql(statement), params));
      const result = await callback(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  let releaseQueue;
  const previous = transactionQueue;
  transactionQueue = new Promise((resolve) => { releaseQueue = resolve; });
  await previous;
  let releaseGate;
  localTransactionGate = new Promise((resolve) => { releaseGate = resolve; });
  const tx = executor(async (statement, params = []) => sqliteQuery(statement, params));
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const result = await callback(tx);
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    localTransactionGate = null;
    releaseGate();
    releaseQueue();
  }
}

async function initialize() {
  if (!initialization) {
    initialization = (async () => {
      if (usePostgres) {
        await transaction(async (tx) => {
          await tx.query('SELECT pg_advisory_xact_lock(729418260)');
          const schema = fs.readFileSync(path.join(__dirname, 'schema.postgres.sql'), 'utf8');
          for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
            await tx.query(statement);
          }
          await require('./seed').ensureSeed(tx);
        });
      } else {
        await transaction((tx) => require('./seed').ensureSeed(tx));
      }
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

async function close() {
  if (sqlite && sqlite.open) sqlite.close();
}

module.exports = {
  ...rootExecutor,
  withRequest,
  initialize,
  transaction,
  close,
  isPostgres: usePostgres,
};
