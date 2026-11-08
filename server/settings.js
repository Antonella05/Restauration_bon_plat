'use strict';

const db = require('./db');

/**
 * Paramètres propres à chaque restaurant utilisant la plateforme :
 * identité visuelle, textes de la page d'accueil, informations pratiques
 * et règles de réception (livraison / retrait).
 * Les valeurs sont stockées en texte dans la table `settings`.
 */
const DEFAULTS = {
  // Identité
  name: 'Le Bon Plat',
  tagline: 'La cuisine que vous aimez, livrée avec le sourire.',
  logo_url: '',
  primary_color: '#b8431e',

  // Page d'accueil
  hero_eyebrow: 'Restaurant · Commande en ligne',
  hero_title: 'La cuisine que vous aimez,',
  hero_accent: 'servie à votre table ou chez vous.',
  hero_subtitle: "Une carte fraîche préparée à la commande, et le suivi de votre livraison en temps réel — de la cuisine jusqu'à votre porte.",
  hero_image_url: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=1400&q=75',

  // Informations pratiques
  phone: '90 00 00 00',
  address: 'Cotonou, Bénin',
  hours: 'Lun – Dim : 08h00 – 23h00',

  // Modes de réception
  delivery_enabled: '1',
  pickup_enabled: '1',
  pickup_instructions: 'Présentez-vous au comptoir avec votre numéro de commande.',
  pickup_hold_minutes: '60',
  no_show_policy: "Une commande prête non récupérée dans le délai indiqué pourra être annulée par le restaurant. Merci de nous prévenir en cas d'empêchement.",
};

const MAX_LEN = 600;
const MAX_IMAGE_LEN = 700000; // logo importé en data URL (~500 Ko)

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/** Une URL d'image acceptable : http(s) ou image encodée (data:image/...). */
function isImageUrl(v) {
  return /^https?:\/\//i.test(v) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(v);
}

function validate(key, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (key === 'logo_url' || key === 'hero_image_url') {
    if (v && !isImageUrl(v)) {
      throw validationError('Image invalide : utilisez une adresse http(s) ou importez un fichier image.');
    }
    if (v.length > MAX_IMAGE_LEN) throw validationError('Image trop lourde (500 Ko maximum).');
    return v;
  }
  if (key === 'primary_color') {
    if (!/^#[0-9a-f]{6}$/i.test(v)) throw validationError('Couleur invalide (format #RRGGBB).');
    return v.toLowerCase();
  }
  if (key === 'delivery_enabled' || key === 'pickup_enabled') {
    return v === '1' || v === 'true' ? '1' : '0';
  }
  if (key === 'pickup_hold_minutes') {
    const n = parseInt(v, 10);
    return String(Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 60) : 60);
  }
  if (key === 'name' && !v) throw validationError('Le nom du restaurant est requis.');
  return v.slice(0, MAX_LEN);
}

async function getSettings(executor = db) {
  const rows = await executor.all('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS && r.value != null) out[r.key] = r.value;
  return out;
}

async function updateSettings(patch, executor = db) {
  const clean = {};
  for (const key of Object.keys(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    clean[key] = validate(key, patch[key]);
  }
  const merged = { ...(await getSettings(executor)), ...clean };
  if (merged.delivery_enabled !== '1' && merged.pickup_enabled !== '1') {
    throw validationError('Au moins un mode de réception (livraison ou retrait) doit rester actif.');
  }
  for (const [key, value] of Object.entries(clean)) {
    await executor.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }
  return getSettings(executor);
}

module.exports = { DEFAULTS, getSettings, updateSettings };
