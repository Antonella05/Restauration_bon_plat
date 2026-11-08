'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const { getSettings, updateSettings } = require('../settings');
const realtime = require('../realtime');
const db = require('../db');
const asyncHandler = require('../async-handler');

const router = express.Router();

/** Public : identité et informations du restaurant (affichées côté client et staff). */
router.get('/', asyncHandler(async (req, res) => {
  res.json({ settings: await getSettings() });
}));

/** Personnalisation : Administrateur + Développeur (paramétrage à l'installation). */
router.put('/', requireRole('admin', 'developer'), asyncHandler(async (req, res) => {
  const settings = await db.transaction(async (tx) => {
    const updated = await updateSettings(req.body || {}, tx);
    await realtime.broadcast({ type: 'settings:update' }, {}, tx);
    return updated;
  });
  res.json({ settings });
}));

module.exports = router;
