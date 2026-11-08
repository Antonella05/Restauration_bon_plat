'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const asyncHandler = require('./async-handler');
const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const { router: orderRoutes } = require('./routes/orders');
const productRoutes = require('./routes/products');
const settingsRoutes = require('./routes/settings');
const realtime = require('./realtime');
const { extractToken, verifyToken } = require('./auth');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api', asyncHandler(async (req, res, next) => {
  await db.withRequest(async () => {
    const responseComplete = new Promise((resolve) => {
      if (res.writableEnded || res.destroyed) return resolve();
      res.once('finish', resolve);
      res.once('close', resolve);
    });
    await db.initialize();
    if (!res.writableEnded && !res.destroyed) next();
    await responseComplete;
  });
}));

app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/settings', settingsRoutes);

app.get('/api/events', asyncHandler(async (req, res) => {
  const token = extractToken(req);
  if (token) {
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Authentification requise.' });
    req.user = user;
  }
  const rawAfter = req.query.after;
  if (rawAfter === undefined) {
    return res.json({ events: [], cursor: await realtime.latestEventId() });
  }
  const after = Number(rawAfter);
  if (!Number.isSafeInteger(after) || after < 0) {
    return res.status(400).json({ error: 'Curseur de synchronisation invalide.' });
  }
  const events = req.user ? await realtime.readEvents(req.user, after) : [];
  res.json({
    events,
    cursor: events.length ? events[events.length - 1].id : after,
  });
}));

app.get('/api/health', asyncHandler(async (req, res) => {
  res.json({ ok: true, ts: Date.now() });
}));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route API introuvable.' });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('Erreur API :', error);
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  res.status(status).json({
    error: status === 500 ? 'Erreur serveur. Vérifiez la configuration et les journaux.' : error.message,
  });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`\n🍽️  Restaurant MVP — serveur web démarré sur le port ${port}`);
    console.log(`    Client  : http://localhost:${port}/`);
    console.log(`    Staff   : http://localhost:${port}/staff.html\n`);
  });
}

module.exports = app;
