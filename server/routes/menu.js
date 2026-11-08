'use strict';

const express = require('express');
const db = require('../db');
const asyncHandler = require('../async-handler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const categories = await db.all('SELECT * FROM categories ORDER BY sort_order, name');
  const products = await db.all('SELECT * FROM products WHERE available = 1 ORDER BY name');
  const byCategory = categories.map((category) => ({
    ...category,
    products: products.filter((product) => product.category_id === category.id),
  }));
  res.json({ categories: byCategory });
}));

module.exports = router;
