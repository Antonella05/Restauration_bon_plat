'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'resto-mvp-dev-secret-change-me';
const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
if (isProduction && (!process.env.JWT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error('En production, JWT_SECRET doit être défini avec au moins 32 caractères.');
}
const TOKEN_TTL = '7d';

const ROLES = ['client', 'callcenter', 'manager', 'admin', 'developer'];

const ROLE_LABELS = {
  client: 'Client',
  callcenter: 'Gestionnaire de commandes',
  manager: 'Gérant',
  admin: 'Administrateur',
  developer: 'Développeur',
};

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

/** Récupère le token depuis le header Authorization ou le cookie. */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

/** Middleware: exige un utilisateur authentifié (n'importe quel rôle). */
function authRequired(req, res, next) {
  const payload = verifyToken(extractToken(req));
  if (!payload) return res.status(401).json({ error: 'Authentification requise.' });
  req.user = payload;
  next();
}

/** Middleware factory: exige l'un des rôles fournis. */
function requireRole(...roles) {
  return (req, res, next) => {
    const payload = verifyToken(extractToken(req));
    if (!payload) return res.status(401).json({ error: 'Authentification requise.' });
    if (!roles.includes(payload.role)) {
      return res.status(403).json({ error: 'Accès non autorisé pour votre rôle.' });
    }
    req.user = payload;
    next();
  };
}

module.exports = {
  JWT_SECRET,
  ROLES,
  ROLE_LABELS,
  signToken,
  verifyToken,
  extractToken,
  authRequired,
  requireRole,
};
