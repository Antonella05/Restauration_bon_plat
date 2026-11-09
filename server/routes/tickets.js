'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../async-handler');
const { extractToken, verifyToken, requireRole } = require('../auth');
const realtime = require('../realtime');

const router = express.Router();
const staffOnly = requireRole('admin', 'manager', 'callcenter', 'developer');

function generateTicketCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    rand += chars[bytes[i] % chars.length];
  }
  return `TKT-${new Date().getFullYear()}-${rand}`;
}

/**
 * POST /api/tickets/book
 * Achat / réservation de billets par le client
 */
router.post('/book', asyncHandler(async (req, res) => {
  const {
    event_id,
    ticket_type_id,
    quantity = 1,
    customer_name,
    customer_phone,
    customer_email,
    payment_method = 'momo_mtn',
  } = req.body;

  const eventId = parseInt(event_id, 10);
  const ticketTypeId = parseInt(ticket_type_id, 10);
  const qty = Math.max(1, Math.min(20, parseInt(quantity, 10) || 1));

  if (!eventId || !ticketTypeId) {
    return res.status(400).json({ error: 'Événement et type de billet requis.' });
  }

  const name = (customer_name || '').trim();
  const phone = (customer_phone || '').trim();
  if (!name || !phone) {
    return res.status(400).json({ error: 'Nom et numéro de téléphone requis.' });
  }

  let customerId = null;
  const token = extractToken(req);
  if (token) {
    const user = verifyToken(token);
    if (user && user.role === 'client') customerId = user.id;
  }

  const result = await db.transaction(async (tx) => {
    const event = await tx.one('SELECT * FROM events WHERE id = ?', eventId);
    if (!event) throw Object.assign(new Error('Événement introuvable.'), { status: 404 });
    if (event.status === 'cancelled') throw Object.assign(new Error('Cet événement a été annulé.'), { status: 400 });

    const ticketType = await tx.one('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', ticketTypeId, eventId);
    if (!ticketType) throw Object.assign(new Error('Type de billet introuvable.'), { status: 404 });

    const remaining = ticketType.quantity_available - ticketType.quantity_sold;
    if (remaining < qty) {
      throw Object.assign(
        new Error(`Plus assez de places disponibles (${remaining} place(s) restante(s)).`),
        { status: 400 }
      );
    }

    const unitPrice = ticketType.price;
    const totalPrice = unitPrice * qty;
    const ticketCode = generateTicketCode();
    const qrData = JSON.stringify({
      code: ticketCode,
      event: event.title,
      venue: event.venue_name,
      holder: name,
      qty,
      type: ticketType.name,
    });

    // Mettre à jour les ventes
    await tx.run(
      'UPDATE ticket_types SET quantity_sold = quantity_sold + ? WHERE id = ?',
      qty,
      ticketTypeId
    );

    // Insérer le ticket
    const ticket = await tx.one(`
      INSERT INTO event_tickets (
        ticket_code, event_id, ticket_type_id, customer_id, customer_name,
        customer_phone, customer_email, quantity, unit_price, total_price,
        payment_method, payment_status, status, qr_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'valid', ?)
      RETURNING *
    `,
      ticketCode,
      eventId,
      ticketTypeId,
      customerId,
      name,
      phone,
      customer_email ? customer_email.trim() : null,
      qty,
      unitPrice,
      totalPrice,
      payment_method,
      qrData
    );

    return {
      ticket,
      event,
      ticket_type: ticketType,
    };
  });

  await realtime.broadcast({
    type: 'ticket:new',
    ticketId: result.ticket.id,
    eventTitle: result.event.title,
    customerName: result.ticket.customer_name,
    quantity: result.ticket.quantity,
  });

  res.status(201).json(result);
}));

/**
 * GET /api/tickets/my
 * Récupère les billets d'un client par son numéro de téléphone ou son token
 */
router.get('/my', asyncHandler(async (req, res) => {
  let phone = (req.query.phone || '').trim();
  let customerId = null;

  const token = extractToken(req);
  if (token) {
    const user = verifyToken(token);
    if (user && user.role === 'client') {
      customerId = user.id;
      const userRow = await db.one('SELECT phone FROM users WHERE id = ?', user.id);
      if (userRow && userRow.phone && !phone) phone = userRow.phone;
    }
  }

  if (!phone && !customerId) {
    return res.status(400).json({ error: 'Numéro de téléphone requis pour consulter vos billets.' });
  }

  let query = `
    SELECT
      t.*,
      e.title AS event_title,
      e.subtitle AS event_subtitle,
      e.venue_type,
      e.venue_name,
      e.location AS event_location,
      e.event_date,
      e.event_time,
      e.badge AS event_badge,
      e.image_url AS event_image_url,
      tt.name AS ticket_type_name,
      tt.description AS ticket_type_desc
    FROM event_tickets t
    JOIN events e ON t.event_id = e.id
    JOIN ticket_types tt ON t.ticket_type_id = tt.id
    WHERE (t.customer_phone = ? OR (t.customer_id IS NOT NULL AND t.customer_id = ?))
    ORDER BY t.created_at DESC
  `;

  const tickets = await db.all(query, phone || '', customerId || 0);
  res.json({ tickets });
}));

/**
 * GET /api/tickets/verify/:code
 * Vérifie un billet par son code (public ou contrôleur)
 */
router.get('/verify/:code', asyncHandler(async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  const ticket = await db.one(`
    SELECT
      t.*,
      e.title AS event_title,
      e.venue_name,
      e.location AS event_location,
      e.event_date,
      e.event_time,
      e.status AS event_status,
      tt.name AS ticket_type_name
    FROM event_tickets t
    JOIN events e ON t.event_id = e.id
    JOIN ticket_types tt ON t.ticket_type_id = tt.id
    WHERE UPPER(t.ticket_code) = ?
  `, code);

  if (!ticket) return res.status(404).json({ error: 'Billet non trouvé ou code erroné.' });

  res.json({
    ticket,
    is_valid: ticket.status === 'valid' && ticket.event_status !== 'cancelled',
  });
}));

/**
 * POST /api/tickets/checkin
 * Compostage / validation du billet à l'entrée (staff)
 */
router.post('/checkin', staffOnly, asyncHandler(async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Code de billet requis.' });

  const ticket = await db.one(`
    SELECT
      t.*,
      e.title AS event_title,
      e.venue_name,
      e.event_date,
      e.event_time,
      e.status AS event_status,
      tt.name AS ticket_type_name
    FROM event_tickets t
    JOIN events e ON t.event_id = e.id
    JOIN ticket_types tt ON t.ticket_type_id = tt.id
    WHERE UPPER(t.ticket_code) = ?
  `, code);

  if (!ticket) {
    return res.status(404).json({ ok: false, error: 'Billet introuvable.' });
  }

  if (ticket.status === 'used') {
    return res.status(400).json({
      ok: false,
      error: `Attention ! Ce billet a DÉJÀ ÉTÉ UTILISÉ le ${ticket.used_at || 'antérieurement'}. Entrée refusée.`,
      ticket,
    });
  }

  if (ticket.status === 'cancelled') {
    return res.status(400).json({
      ok: false,
      error: 'Ce billet a été annulé.',
      ticket,
    });
  }

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await db.run(
    "UPDATE event_tickets SET status = 'used', used_at = ? WHERE id = ?",
    nowStr,
    ticket.id
  );

  const updatedTicket = { ...ticket, status: 'used', used_at: nowStr };

  await realtime.broadcast({
    type: 'ticket:checkin',
    ticketId: ticket.id,
    ticketCode: ticket.ticket_code,
    holder: ticket.customer_name,
  });

  res.json({
    ok: true,
    message: `Entrée validée avec succès pour ${ticket.customer_name} (${ticket.quantity} place(s) - ${ticket.ticket_type_name}).`,
    ticket: updatedTicket,
  });
}));

/**
 * GET /api/tickets/stats
 * Statistiques billetterie (staff)
 */
router.get('/stats', staffOnly, asyncHandler(async (req, res) => {
  const totalStats = await db.one(`
    SELECT
      COALESCE(COUNT(*), 0) AS total_orders,
      COALESCE(SUM(quantity), 0) AS total_tickets_sold,
      COALESCE(SUM(total_price), 0) AS total_revenue,
      COALESCE(SUM(CASE WHEN status = 'used' THEN quantity ELSE 0 END), 0) AS total_checked_in
    FROM event_tickets
  `);

  const eventBreakdown = await db.all(`
    SELECT
      e.id,
      e.title,
      e.event_date,
      e.venue_type,
      e.venue_name,
      COALESCE(SUM(t.quantity), 0) AS tickets_sold,
      COALESCE(SUM(t.total_price), 0) AS revenue,
      COALESCE(SUM(CASE WHEN t.status = 'used' THEN t.quantity ELSE 0 END), 0) AS checked_in
    FROM events e
    LEFT JOIN event_tickets t ON e.id = t.event_id
    GROUP BY e.id, e.title, e.event_date, e.venue_type, e.venue_name
    ORDER BY e.event_date ASC
  `);

  res.json({
    total: {
      orders: Number(totalStats.total_orders),
      tickets_sold: Number(totalStats.total_tickets_sold),
      revenue: Number(totalStats.total_revenue),
      checked_in: Number(totalStats.total_checked_in),
    },
    events: eventBreakdown,
  });
}));

/**
 * GET /api/tickets/list
 * Liste complète des réservations de billets pour le staff
 */
router.get('/list', staffOnly, asyncHandler(async (req, res) => {
  const { event_id, status, search } = req.query;

  let query = `
    SELECT
      t.*,
      e.title AS event_title,
      e.venue_name,
      e.event_date,
      e.event_time,
      tt.name AS ticket_type_name
    FROM event_tickets t
    JOIN events e ON t.event_id = e.id
    JOIN ticket_types tt ON t.ticket_type_id = tt.id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) {
    query += ' AND t.event_id = ?';
    params.push(parseInt(event_id, 10));
  }

  if (status) {
    query += ' AND t.status = ?';
    params.push(status);
  }

  if (search && search.trim()) {
    const s = `%${search.trim().toLowerCase()}%`;
    query += ' AND (LOWER(t.ticket_code) LIKE ? OR LOWER(t.customer_name) LIKE ? OR LOWER(t.customer_phone) LIKE ?)';
    params.push(s, s, s);
  }

  query += ' ORDER BY t.created_at DESC LIMIT 200';

  const tickets = await db.all(query, ...params);
  res.json({ tickets });
}));

module.exports = router;

