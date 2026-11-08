'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const outputDir = path.join(projectRoot, 'dist');

if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
  throw new Error('La page public/index.html est introuvable.');
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.cpSync(publicDir, outputDir, { recursive: true });

console.log('Build Vercel terminé : les fichiers de public/ sont dans dist/.');
