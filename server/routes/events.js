'use strict';

const express = require('express');
const db = require('../db');
const asyncHandler = require('../async-handler');
const { requireRole } = require('../auth');
const realtime = require('../realtime');

const router = express.Router();
const staffOnly = requireRole('admin', 'manager', 'developer');

/**
 * GET /api/events
 * Liste publique des événements avec types de billets associés.
 */
router.get('/', asyncHandler(async (req, res) => {
  const { search, venue_type, status } = req.query;

  let query = 'SELECT * FROM events WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  } else {
    // Par défaut pour le public : uniquement les publiés
    query += " AND status IN ('published', 'sold_out')";
  }

  if (venue_type && venue_type !== 'all') {
    query += ' AND venue_type = ?';
    params.push(venue_type);
  }

  if (search && search.trim()) {
    const s = `%${search.trim().toLowerCase()}%`;
    query += ' AND (LOWER(title) LIKE ? OR LOWER(subtitle) LIKE ? OR LOWER(venue_name) LIKE ? OR LOWER(location) LIKE ? OR LOWER(description) LIKE ?)';
    params.push(s, s, s, s, s);
  }

  query += ' ORDER BY event_date ASC, event_time ASC';

  const events = await db.all(query, ...params);
  if (!events.length) {
    return res.json({ events: [] });
  }

  const allTickets = await db.all('SELECT * FROM ticket_types ORDER BY event_id, sort_order, price ASC');
  const ticketsByEvent = {};
  for (const t of allTickets) {
    if (!ticketsByEvent[t.event_id]) ticketsByEvent[t.event_id] = [];
    ticketsByEvent[t.event_id].push({
      ...t,
      available_left: Math.max(0, t.quantity_available - t.quantity_sold),
    });
  }

  const enriched = events.map((ev) => {
    const tickets = ticketsByEvent[ev.id] || [];
    const prices = tickets.map((t) => t.price);
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    const totalAvailable = tickets.reduce((acc, t) => acc + t.available_left, 0);

    return {
      ...ev,
      ticket_types: tickets,
      min_price: minPrice,
      max_price: maxPrice,
      is_sold_out: tickets.length > 0 && totalAvailable === 0,
    };
  });

  res.json({ events: enriched });
}));

/**
 * GET /api/events/:id
 * Détail complet d'un événement.
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const event = await db.one('SELECT * FROM events WHERE id = ?', id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });

  const tickets = await db.all('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, price ASC', id);
  const enrichedTickets = tickets.map((t) => ({
    ...t,
    available_left: Math.max(0, t.quantity_available - t.quantity_sold),
  }));

  const prices = enrichedTickets.map((t) => t.price);
  const totalAvailable = enrichedTickets.reduce((acc, t) => acc + t.available_left, 0);

  res.json({
    event: {
      ...event,
      ticket_types: enrichedTickets,
      min_price: prices.length ? Math.min(...prices) : 0,
      max_price: prices.length ? Math.max(...prices) : 0,
      is_sold_out: enrichedTickets.length > 0 && totalAvailable === 0,
    },
  });
}));

/**
 * POST /api/events
 * Création d'événement (staff)
 */
router.post('/', staffOnly, asyncHandler(async (req, res) => {
  const {
    title,
    subtitle,
    venue_type = 'restaurant',
    venue_name,
    location,
    event_date,
    event_time,
    description,
    image_url,
    badge,
    organizer,
    featured = 0,
    status = 'published',
    ticket_types = [],
  } = req.body;

  if (!title || !venue_name || !location || !event_date || !event_time) {
    return res.status(400).json({ error: 'Champs obligatoires manquants (titre, lieu, ville, date, heure).' });
  }

  const result = await db.transaction(async (tx) => {
    const createdEvent = await tx.one(`
      INSERT INTO events (title, subtitle, venue_type, venue_name, location, event_date, event_time, description, image_url, badge, organizer, featured, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `,
      title.trim(),
      subtitle ? subtitle.trim() : null,
      venue_type,
      venue_name.trim(),
      location.trim(),
      event_date.trim(),
      event_time.trim(),
      description ? description.trim() : null,
      image_url ? image_url.trim() : null,
      badge ? badge.trim() : null,
      organizer ? organizer.trim() : null,
      featured ? 1 : 0,
      status
    );

    const insertedTickets = [];
    if (Array.isArray(ticket_types) && ticket_types.length > 0) {
      for (const [idx, t] of ticket_types.entries()) {
        const tRow = await tx.one(`
          INSERT INTO ticket_types (event_id, name, description, price, quantity_available, quantity_sold, sort_order)
          VALUES (?, ?, ?, ?, ?, 0, ?) RETURNING *
        `,
          createdEvent.id,
          (t.name || 'Pass Standard').trim(),
          t.description ? t.description.trim() : null,
          Math.max(0, parseInt(t.price, 10) || 0),
          Math.max(1, parseInt(t.quantity_available, 10) || 50),
          idx
        );
        insertedTickets.push(tRow);
      }
    }

    return { ...createdEvent, ticket_types: insertedTickets };
  });

  await realtime.broadcast({ type: 'event:new', eventId: result.id });
  res.status(201).json({ event: result });
}));

/**
 * PUT /api/events/:id
 * Modification d'un événement (staff)
 */
router.put('/:id', staffOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.one('SELECT * FROM events WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Événement introuvable.' });

  const {
    title,
    subtitle,
    venue_type,
    venue_name,
    location,
    event_date,
    event_time,
    description,
    image_url,
    badge,
    organizer,
    featured,
    status,
    ticket_types,
  } = req.body;

  const updated = await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE events SET
        title = ?, subtitle = ?, venue_type = ?, venue_name = ?, location = ?,
        event_date = ?, event_time = ?, description = ?, image_url = ?, badge = ?,
        organizer = ?, featured = ?, status = ?
      WHERE id = ?
    `,
      title !== undefined ? title.trim() : existing.title,
      subtitle !== undefined ? (subtitle ? subtitle.trim() : null) : existing.subtitle,
      venue_type !== undefined ? venue_type : existing.venue_type,
      venue_name !== undefined ? venue_name.trim() : existing.venue_name,
      location !== undefined ? location.trim() : existing.location,
      event_date !== undefined ? event_date.trim() : existing.event_date,
      event_time !== undefined ? event_time.trim() : existing.event_time,
      description !== undefined ? (description ? description.trim() : null) : existing.description,
      image_url !== undefined ? (image_url ? image_url.trim() : null) : existing.image_url,
      badge !== undefined ? (badge ? badge.trim() : null) : existing.badge,
      organizer !== undefined ? (organizer ? organizer.trim() : null) : existing.organizer,
      featured !== undefined ? (featured ? 1 : 0) : existing.featured,
      status !== undefined ? status : existing.status,
      id
    );

    if (Array.isArray(ticket_types)) {
      // Pour chaque ticket fourni, mise à jour ou ajout
      for (const [idx, t] of ticket_types.entries()) {
        if (t.id) {
          await tx.run(`
            UPDATE ticket_types SET
              name = ?, description = ?, price = ?, quantity_available = ?, sort_order = ?
            WHERE id = ? AND event_id = ?
          `,
            t.name.trim(),
            t.description ? t.description.trim() : null,
            Math.max(0, parseInt(t.price, 10) || 0),
            Math.max(t.quantity_sold || 0, parseInt(t.quantity_available, 10) || 1),
            idx,
            t.id,
            id
          );
        } else {
          await tx.run(`
            INSERT INTO ticket_types (event_id, name, description, price, quantity_available, quantity_sold, sort_order)
            VALUES (?, ?, ?, ?, ?, 0, ?)
          `,
            id,
            (t.name || 'Pass').trim(),
            t.description ? t.description.trim() : null,
            Math.max(0, parseInt(t.price, 10) || 0),
            Math.max(1, parseInt(t.quantity_available, 10) || 50),
            idx
          );
        }
      }
    }

    const event = await tx.one('SELECT * FROM events WHERE id = ?', id);
    const tickets = await tx.all('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, price ASC', id);
    return { ...event, ticket_types: tickets };
  });

  await realtime.broadcast({ type: 'event:update', eventId: id });
  res.json({ event: updated });
}));

/**
 * DELETE /api/events/:id
 * Suppression d'un événement (staff)
 */
router.delete('/:id', staffOnly, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.run('DELETE FROM events WHERE id = ?', id);
  await realtime.broadcast({ type: 'event:delete', eventId: id });
  res.json({ ok: true });
}));

module.exports = router;

