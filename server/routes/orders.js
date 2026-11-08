'use strict';

const express = require('express');
const db = require('../db');
const asyncHandler = require('../async-handler');
const { authRequired, requireRole } = require('../auth');
const { getSettings } = require('../settings');
const realtime = require('../realtime');

const router = express.Router();

const STATUSES = [
  'pending', 'accepted', 'preparing',
  'delivering', 'delivered',
  'ready', 'picked_up', 'no_show',
  'cancelled',
];
const STATUS_LABELS = {
  pending: 'En attente',
  accepted: 'Acceptée',
  preparing: 'En préparation',
  delivering: 'En livraison',
  delivered: 'Livrée',
  ready: 'Prête à retirer',
  picked_up: 'Retirée',
  no_show: 'Non récupérée',
  cancelled: 'Annulée',
};
const FULFILLMENTS = ['delivery', 'pickup'];
const FINAL_STATUSES = ['delivered', 'picked_up', 'no_show', 'cancelled'];
const DELIVERY_ONLY = ['delivering', 'delivered'];
const PICKUP_ONLY = ['ready', 'picked_up', 'no_show'];
const EDITABLE_STATUSES = ['pending', 'accepted', 'preparing'];
const STAFF_ROLES = ['callcenter', 'manager', 'admin', 'developer'];

function toSqlDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function fmtMoney(amount) {
  return (amount || 0).toLocaleString('fr-FR') + ' FCFA';
}

async function loadOrder(id, executor = db) {
  const order = await executor.one('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return null;
  order.items = await executor.all('SELECT * FROM order_items WHERE order_id = ?', id);
  order.modifications = await executor.all(
    'SELECT * FROM order_modifications WHERE order_id = ? ORDER BY id DESC',
    id
  );
  order.statusLabel = STATUS_LABELS[order.status] || order.status;
  return order;
}

function parseCoord(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}

router.post('/', authRequired, asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const comment = (req.body.comment || '').trim();
  const paymentMethod = req.body.payment_method === 'mobile_money' ? 'mobile_money' : 'cash';
  const name = (req.body.customer_name || req.user.name || '').trim();
  const phone = (req.body.customer_phone || '').trim();
  const fulfillment = FULFILLMENTS.includes(req.body.fulfillment) ? req.body.fulfillment : 'delivery';
  const settings = await getSettings();

  if (!items.length) return res.status(400).json({ error: 'Le panier est vide.' });
  if (!name || !phone) return res.status(400).json({ error: 'Nom et contact requis.' });
  if (settings[fulfillment + '_enabled'] !== '1') {
    return res.status(400).json({
      error: fulfillment === 'pickup'
        ? 'Le retrait sur place n\'est pas proposé.'
        : 'La livraison n\'est pas proposée.',
    });
  }

  let address = null, latitude = null, longitude = null, accuracy = null;
  if (fulfillment === 'delivery') {
    address = (req.body.delivery_address || '').trim().slice(0, 500) || null;
    latitude = parseCoord(req.body.latitude, 90);
    longitude = parseCoord(req.body.longitude, 180);
    if (latitude === null || longitude === null) { latitude = null; longitude = null; }
    accuracy = latitude !== null ? parseCoord(req.body.location_accuracy, 1e6) : null;
    if (!address && latitude === null) {
      return res.status(400).json({ error: 'Indiquez l\'adresse de livraison ou partagez votre position.' });
    }
  }

  let pickupTime = null;
  if (fulfillment === 'pickup' && req.body.pickup_time) {
    const time = new Date(req.body.pickup_time);
    const now = Date.now();
    if (Number.isNaN(time.getTime())) return res.status(400).json({ error: 'Heure de retrait invalide.' });
    if (time.getTime() < now - 5 * 60000) {
      return res.status(400).json({ error: 'L\'heure de retrait est déjà passée.' });
    }
    if (time.getTime() > now + 7 * 86400000) {
      return res.status(400).json({ error: 'Le retrait doit être prévu dans les 7 jours.' });
    }
    pickupTime = toSqlDate(time);
  }

  const resolved = [];
  for (const item of items) {
    const product = await db.one('SELECT * FROM products WHERE id = ? AND available = 1', item.product_id);
    if (product) {
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      resolved.push({ product, quantity });
    }
  }
  if (!resolved.length) {
    return res.status(400).json({ error: 'Aucun article valide dans le panier.' });
  }

  const total = resolved.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const order = await db.transaction(async (tx) => {
    const inserted = await tx.one(`
      INSERT INTO orders (customer_id, customer_name, customer_phone, comment, payment_method, status, total,
                          fulfillment, delivery_address, latitude, longitude, location_accuracy, pickup_time)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, req.user.id, name, phone, comment || null, paymentMethod, total,
    fulfillment, address, latitude, longitude, accuracy, pickupTime);

    for (const item of resolved) {
      await tx.run(`
        INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
        VALUES (?, ?, ?, ?, ?)
      `, inserted.id, item.product.id, item.product.name, item.product.price, item.quantity);
    }

    if (req.user.role === 'client' && req.body.remember !== false) {
      if (fulfillment === 'delivery') {
        await tx.run(
          'UPDATE users SET address = ?, latitude = ?, longitude = ?, fulfillment = ? WHERE id = ?',
          address,
          latitude,
          longitude,
          fulfillment,
          req.user.id
        );
      } else {
        await tx.run('UPDATE users SET fulfillment = ? WHERE id = ?', fulfillment, req.user.id);
      }
    }

    const createdOrder = await loadOrder(inserted.id, tx);
    await realtime.broadcast(
      { type: 'order:new', order: createdOrder },
      { customerId: createdOrder.customer_id },
      tx
    );
    return createdOrder;
  });

  res.status(201).json({ order });
}));

router.get('/mine', authRequired, asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', req.user.id);
  const orders = await Promise.all(rows.map((order) => loadOrder(order.id)));
  res.json({ orders });
}));

function dayRange(date, timezoneOffset) {
  const [year, month, day] = date.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day) - timezoneOffset * 60000;
  return [toSqlDate(new Date(start)), toSqlDate(new Date(start + 86400000))];
}

async function dayStats(date, timezoneOffset) {
  const [from, to] = dayRange(date, timezoneOffset);
  const completed = await db.all(`
    SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders
    WHERE status IN ('delivered', 'picked_up', 'no_show', 'cancelled')
      AND COALESCE(completed_at, updated_at) >= ? AND COALESCE(completed_at, updated_at) < ?
    GROUP BY status
  `, from, to);
  const byStatus = Object.fromEntries(completed.map((row) => [row.status, row]));
  const created = await db.all(`
    SELECT fulfillment, COUNT(*) AS n FROM orders
    WHERE created_at >= ? AND created_at < ? GROUP BY fulfillment
  `, from, to);
  const byFulfillment = Object.fromEntries(created.map((row) => [row.fulfillment, Number(row.n)]));
  const count = (status) => Number(byStatus[status] ? byStatus[status].n : 0);
  const amount = (status) => Number(byStatus[status] ? byStatus[status].amount : 0);

  return {
    date,
    delivered: count('delivered'),
    picked_up: count('picked_up'),
    no_show: count('no_show'),
    cancelled: count('cancelled'),
    revenue: amount('delivered') + amount('picked_up'),
    revenue_delivery: amount('delivered'),
    revenue_pickup: amount('picked_up'),
    created_delivery: byFulfillment.delivery || 0,
    created_pickup: byFulfillment.pickup || 0,
    created_total: (byFulfillment.delivery || 0) + (byFulfillment.pickup || 0),
  };
}

router.get('/stats', requireRole('manager', 'admin'), asyncHandler(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  const timezoneOffset = Math.max(-840, Math.min(840, parseInt(req.query.tz, 10) || 0));
  const day = await dayStats(date, timezoneOffset);

  const [year, month, dateOfMonth] = date.split('-').map(Number);
  const history = [];
  for (let offset = 6; offset >= 0; offset--) {
    const dayInHistory = new Date(Date.UTC(year, month - 1, dateOfMonth - offset))
      .toISOString().slice(0, 10);
    const stats = await dayStats(dayInHistory, timezoneOffset);
    history.push({
      date: stats.date,
      delivered: stats.delivered,
      picked_up: stats.picked_up,
      revenue: stats.revenue,
    });
  }

  const [from, to] = dayRange(date, timezoneOffset);
  const top = await db.all(`
    SELECT oi.product_name AS name, SUM(oi.quantity) AS qty FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.status NOT IN ('cancelled')
    GROUP BY oi.product_name ORDER BY qty DESC LIMIT 6
  `, from, to);
  const progress = await db.one(`
    SELECT COUNT(*) AS n FROM orders
    WHERE status NOT IN ('delivered', 'picked_up', 'no_show', 'cancelled')
  `);
  res.json({ day, history, top, in_progress: Number(progress.n) });
}));

router.get('/', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const where = [];
  const params = [];
  if (STATUSES.includes(req.query.status)) {
    where.push('status = ?');
    params.push(req.query.status);
  }
  if (FULFILLMENTS.includes(req.query.fulfillment)) {
    where.push('fulfillment = ?');
    params.push(req.query.fulfillment);
  }
  const rows = await db.all(
    `SELECT id FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`,
    ...params
  );
  const orders = await Promise.all(rows.map((order) => loadOrder(order.id)));
  res.json({ orders });
}));

router.get('/:id', authRequired, asyncHandler(async (req, res) => {
  const order = await loadOrder(parseInt(req.params.id, 10));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  const isStaff = STAFF_ROLES.includes(req.user.role);
  if (!isStaff && order.customer_id !== req.user.id) {
    return res.status(403).json({ error: 'Accès non autorisé.' });
  }
  res.json({ order });
}));

router.patch('/:id/status', requireRole('callcenter', 'manager', 'admin'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newStatus = req.body.status;
  const cancelReason = (req.body.cancel_reason || '').trim();
  if (!STATUSES.includes(newStatus)) return res.status(400).json({ error: 'Statut invalide.' });

  const order = await db.one('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (req.user.role === 'callcenter' && !['accepted', 'cancelled'].includes(newStatus)) {
    return res.status(403).json({ error: 'Le call center peut seulement accepter ou annuler.' });
  }
  if (FINAL_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: 'Cette commande est déjà clôturée.' });
  }
  if (order.fulfillment === 'pickup' && DELIVERY_ONLY.includes(newStatus)) {
    return res.status(400).json({ error: 'Commande à retirer sur place : pas de livraison.' });
  }
  if (order.fulfillment !== 'pickup' && PICKUP_ONLY.includes(newStatus)) {
    return res.status(400).json({ error: 'Commande en livraison : statut de retrait non applicable.' });
  }
  if (newStatus === 'no_show' && order.status !== 'ready') {
    return res.status(400).json({ error: 'Seule une commande prête peut être déclarée non récupérée.' });
  }

  const reason = newStatus === 'cancelled' ? (cancelReason || null)
    : newStatus === 'no_show' ? (cancelReason || 'Commande non récupérée par le client.')
    : null;
  const now = toSqlDate(new Date());
  const updated = await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE orders SET status = ?, cancel_reason = ?, updated_at = ?,
        ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END,
        completed_at = CASE WHEN ? IN ('delivered', 'picked_up', 'no_show', 'cancelled') THEN ? ELSE completed_at END
      WHERE id = ?
    `, newStatus, reason, now, newStatus, now, newStatus, now, id);
    const changedOrder = await loadOrder(id, tx);
    await realtime.broadcast(
      { type: 'order:update', order: changedOrder, by: req.user.role },
      { customerId: changedOrder.customer_id },
      tx
    );
    return changedOrder;
  });
  res.json({ order: updated });
}));

router.put('/:id/items', requireRole('callcenter', 'manager', 'admin'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = await loadOrder(id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (!EDITABLE_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: 'Cette commande ne peut plus être modifiée (' + order.statusLabel + ').' });
  }
  if (req.body.client_agreed !== true) {
    return res.status(400).json({ error: 'L\'accord du client est requis avant toute modification.' });
  }
  const note = (req.body.note || '').trim().slice(0, 500);
  const input = Array.isArray(req.body.items) ? req.body.items : [];
  if (!input.length) {
    return res.status(400).json({
      error: 'La commande doit contenir au moins un article. Pour tout retirer, annulez-la.',
    });
  }

  const oldByProduct = new Map();
  for (const item of order.items) {
    const key = item.product_id != null ? item.product_id : 'name:' + item.product_name;
    const previous = oldByProduct.get(key);
    if (previous) previous.quantity += item.quantity;
    else oldByProduct.set(key, { ...item });
  }

  const next = new Map();
  for (const item of input) {
    const productId = parseInt(item.product_id, 10);
    const quantity = Math.min(99, Math.max(1, parseInt(item.quantity, 10) || 1));
    if (!productId) continue;
    const replaces = item.replaces != null ? parseInt(item.replaces, 10) : null;
    if (next.has(productId)) {
      next.get(productId).quantity += quantity;
      continue;
    }

    const old = oldByProduct.get(productId);
    if (old) {
      next.set(productId, {
        product_id: productId,
        product_name: old.product_name,
        unit_price: old.unit_price,
        quantity,
        replaces,
      });
    } else {
      const product = await db.one('SELECT * FROM products WHERE id = ?', productId);
      if (!product) return res.status(400).json({ error: 'Produit introuvable (#' + productId + ').' });
      if (!product.available) {
        return res.status(400).json({ error: product.name + ' est indisponible.' });
      }
      next.set(productId, {
        product_id: productId,
        product_name: product.name,
        unit_price: product.price,
        quantity,
        replaces,
      });
    }
  }
  if (!next.size) return res.status(400).json({ error: 'Aucun article valide.' });

  const changes = [];
  const replacedOld = new Set();
  for (const item of next.values()) {
    if (oldByProduct.has(item.product_id)) continue;
    const old = item.replaces != null ? oldByProduct.get(item.replaces) : null;
    if (old && !next.has(item.replaces)) {
      replacedOld.add(item.replaces);
      changes.push(
        `Remplacé : ${old.quantity} × ${old.product_name} (${fmtMoney(old.unit_price)}) → ${item.quantity} × ${item.product_name} (${fmtMoney(item.unit_price)})`
      );
    } else {
      changes.push(`Ajouté : ${item.quantity} × ${item.product_name} (${fmtMoney(item.unit_price)})`);
    }
  }
  for (const [key, old] of oldByProduct) {
    if (replacedOld.has(key)) continue;
    const item = next.get(key);
    if (!item) changes.push(`Retiré : ${old.quantity} × ${old.product_name}`);
    else if (item.quantity !== old.quantity) {
      changes.push(`Quantité : ${old.product_name} ${old.quantity} → ${item.quantity}`);
    }
  }
  if (!changes.length) return res.status(400).json({ error: 'Aucune modification à enregistrer.' });

  const newTotal = [...next.values()]
    .reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const now = toSqlDate(new Date());
  const updated = await db.transaction(async (tx) => {
    await tx.run('DELETE FROM order_items WHERE order_id = ?', id);
    for (const item of next.values()) {
      await tx.run(`
        INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
        VALUES (?, ?, ?, ?, ?)
      `, id, item.product_id, item.product_name, item.unit_price, item.quantity);
    }
    await tx.run(`
      UPDATE orders SET total = ?, modified_at = ?, updated_at = ?, client_ack = 0 WHERE id = ?
    `, newTotal, now, now, id);
    await tx.run(`
      INSERT INTO order_modifications (order_id, user_id, user_name, summary, note, old_total, new_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, id, req.user.id, req.user.name, changes.join('\n'), note || null, order.total, newTotal);
    const changedOrder = await loadOrder(id, tx);
    await realtime.broadcast(
      { type: 'order:update', order: changedOrder, by: req.user.role, modified: true },
      { customerId: changedOrder.customer_id },
      tx
    );
    return changedOrder;
  });
  res.json({ order: updated });
}));

router.post('/:id/ack', authRequired, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = await db.one('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.customer_id !== req.user.id) {
    return res.status(403).json({ error: 'Accès non autorisé.' });
  }

  const updated = await db.transaction(async (tx) => {
    await tx.run('UPDATE orders SET client_ack = 1 WHERE id = ?', id);
    const changedOrder = await loadOrder(id, tx);
    await realtime.broadcast(
      { type: 'order:update', order: changedOrder, by: 'client' },
      { customerId: changedOrder.customer_id },
      tx
    );
    return changedOrder;
  });
  res.json({ order: updated });
}));

module.exports = { router, STATUS_LABELS, STATUSES };
