'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'le-bon-plat-test-'));
process.env.DB_PATH = path.join(testDirectory, 'restaurant.db');
process.env.JWT_SECRET = 'unit-test-secret-with-at-least-thirty-two-characters';

const app = require('../server');
const db = require('../server/db');

test('API locale : menu, commandes, rôles, statistiques et événements', async (t) => {
  await db.initialize();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = process.env.DB_PATH + suffix;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    fs.rmdirSync(testDirectory);
  });

  async function request(url, { method = 'GET', body, token } = {}) {
    const response = await fetch(baseUrl + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    return { response, data };
  }

  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.ok, true);

  const menu = await request('/api/menu');
  assert.equal(menu.response.status, 200);
  assert.ok(menu.data.categories.length >= 7);
  const product = menu.data.categories[0].products[0];
  assert.ok(product);

  const staffLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'callcenter', password: 'call123' },
  });
  assert.equal(staffLogin.response.status, 200);

  const clientLogin = await request('/api/auth/client-login', {
    method: 'POST',
    body: { name: 'Client de test', phone: '99000001' },
  });
  assert.equal(clientLogin.response.status, 200);

  const orderResponse = await request('/api/orders', {
    method: 'POST',
    token: clientLogin.data.token,
    body: {
      customer_name: 'Client de test',
      customer_phone: '99000001',
      fulfillment: 'pickup',
      items: [{ product_id: product.id, quantity: 2 }],
    },
  });
  assert.equal(orderResponse.response.status, 201);
  assert.equal(orderResponse.data.order.total, product.price * 2);

  const unauthorizedOrders = await request('/api/orders');
  assert.equal(unauthorizedOrders.response.status, 401);

  const updateResponse = await request(`/api/orders/${orderResponse.data.order.id}/status`, {
    method: 'PATCH',
    token: staffLogin.data.token,
    body: { status: 'accepted' },
  });
  assert.equal(updateResponse.response.status, 200);
  assert.equal(updateResponse.data.order.status, 'accepted');

  const events = await request('/api/events?after=0', { token: staffLogin.data.token });
  assert.ok(events.data.events.some((entry) => entry.event.type === 'order:new'));
  assert.ok(events.data.events.some((entry) => entry.event.type === 'order:update'));

  const clientOrders = await request('/api/orders/mine', { token: clientLogin.data.token });
  assert.equal(clientOrders.response.status, 200);
  assert.equal(clientOrders.data.orders.length, 1);
});
