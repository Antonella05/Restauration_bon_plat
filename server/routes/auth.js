'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../async-handler');
const { signToken, authRequired, ROLE_LABELS } = require('../auth');

const router = express.Router();

function clientProfile(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    phone: user.phone,
    address: user.address || '',
    latitude: user.latitude,
    longitude: user.longitude,
    fulfillment: user.fulfillment || null,
  };
}

router.post('/client-login', asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone requis.' });

  let user = await db.one("SELECT * FROM users WHERE role = 'client' AND phone = ?", phone);
  if (!user) {
    user = await db.one(
      "INSERT INTO users (role, name, phone) VALUES ('client', ?, ?) RETURNING *",
      name,
      phone
    );
  } else if (user.name !== name) {
    await db.run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
    user.name = name;
  }

  res.json({ token: signToken(user), user: clientProfile(user) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!username || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  }

  const user = await db.one('SELECT * FROM users WHERE username = ?', username);
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  res.json({
    token: signToken(user),
    user: {
      id: user.id,
      role: user.role,
      name: user.name,
      roleLabel: ROLE_LABELS[user.role] || user.role,
    },
  });
}));

router.get('/me', authRequired, asyncHandler(async (req, res) => {
  if (req.user.role === 'client') {
    const user = await db.one('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
    return res.json({ user: clientProfile(user) });
  }
  res.json({
    user: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.name,
      roleLabel: ROLE_LABELS[req.user.role] || req.user.role,
    },
  });
}));

module.exports = router;
