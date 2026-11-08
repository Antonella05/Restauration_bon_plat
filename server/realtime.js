'use strict';

const db = require('./db');

const STAFF_ROLES = ['callcenter', 'manager', 'admin', 'developer'];

async function broadcast(event, { customerId = null } = {}, executor = db) {
  if (db.isPostgres) {
    await executor.query('SELECT pg_advisory_xact_lock(729418261::bigint)');
  }
  await executor.run(
    'INSERT INTO realtime_events (customer_id, payload) VALUES (?, ?)',
    customerId,
    JSON.stringify(event)
  );
  await executor.run(
    'DELETE FROM realtime_events WHERE id < (SELECT COALESCE(MAX(id), 0) - 10000 FROM realtime_events)'
  );
}

async function latestEventId(executor = db) {
  const row = await executor.one('SELECT COALESCE(MAX(id), 0) AS id FROM realtime_events');
  return Number(row.id);
}

async function readEvents(user, afterId) {
  const isStaff = STAFF_ROLES.includes(user.role);
  const rows = isStaff
    ? await db.all('SELECT id, payload FROM realtime_events WHERE id > ? ORDER BY id LIMIT 100', afterId)
    : await db.all(
      'SELECT id, payload FROM realtime_events WHERE customer_id = ? AND id > ? ORDER BY id LIMIT 100',
      user.id,
      afterId
    );
  return rows.map((row) => ({
    id: Number(row.id),
    event: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }));
}

module.exports = { broadcast, latestEventId, readEvents, STAFF_ROLES };
