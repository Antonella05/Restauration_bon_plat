'use strict';

const express = require('express');
const db = require('../db');
const asyncHandler = require('../async-handler');
const { requireRole } = require('../auth');

const router = express.Router();
const manage = requireRole('developer', 'admin');

router.get('/', manage, asyncHandler(async (req, res) => {
  const categories = await db.all('SELECT * FROM categories ORDER BY sort_order, name');
  const products = await db.all('SELECT * FROM products ORDER BY category_id, name');
  res.json({ categories, products });
}));

router.post('/categories', manage, asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom de catégorie requis.' });
  const order = parseInt(req.body.sort_order, 10) || 0;
  const category = await db.one(
    'INSERT INTO categories (name, sort_order) VALUES (?, ?) RETURNING *',
    name,
    order
  );
  res.status(201).json({ category });
}));

router.delete('/categories/:id', manage, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM categories WHERE id = ?', parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

router.post('/', manage, asyncHandler(async (req, res) => {
  const categoryId = parseInt(req.body.category_id, 10);
  const name = (req.body.name || '').trim();
  const price = Math.max(0, parseInt(req.body.price, 10) || 0);
  const description = (req.body.description || '').trim();
  const imageUrl = (req.body.image_url || '').trim();
  const available = req.body.available === false || req.body.available === 0 ? 0 : 1;
  const featured = req.body.featured ? 1 : 0;

  if (!categoryId || !name) {
    return res.status(400).json({ error: 'Catégorie et nom requis.' });
  }
  const category = await db.one('SELECT id FROM categories WHERE id = ?', categoryId);
  if (!category) return res.status(400).json({ error: 'Catégorie introuvable.' });

  const product = await db.one(`
    INSERT INTO products (category_id, name, description, price, image_url, available, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `, categoryId, name, description || null, price, imageUrl || null, available, featured);
  res.status(201).json({ product });
}));

router.put('/:id', manage, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.one('SELECT * FROM products WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Produit introuvable.' });

  const categoryId = req.body.category_id != null ? parseInt(req.body.category_id, 10) : existing.category_id;
  const name = req.body.name != null ? String(req.body.name).trim() : existing.name;
  const price = req.body.price != null ? Math.max(0, parseInt(req.body.price, 10) || 0) : existing.price;
  const description = req.body.description != null ? String(req.body.description).trim() : existing.description;
  const imageUrl = req.body.image_url != null ? String(req.body.image_url).trim() : existing.image_url;
  const available = req.body.available != null ? (req.body.available ? 1 : 0) : existing.available;
  const featured = req.body.featured != null ? (req.body.featured ? 1 : 0) : existing.featured;

  const product = await db.one(`
    UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, image_url = ?, available = ?, featured = ?
    WHERE id = ? RETURNING *
  `, categoryId, name, description || null, price, imageUrl || null, available, featured, id);
  res.json({ product });
}));

router.delete('/:id', manage, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM products WHERE id = ?', parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

module.exports = router;
