// server.js — Servidor local que emula Netlify Functions en puerto 8888
// Uso: node server.js
'use strict';

// ── Cargar .env ────────────────────────────────────────────────────────────
try {
  require('fs').readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if(idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if(key && !process.env[key]) process.env[key] = val;
    }
  });
} catch(e) { console.warn('No se pudo leer .env:', e.message); }

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = 8888;

// ── Importar el handler de la Netlify Function ─────────────────────────────
const { handler } = require('./netlify/functions/gcal.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ── Servidor ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${parsed.pathname}`);

  // ── Ruta: Netlify Function ─────────────────────────────────────────────
  if(parsed.pathname === '/.netlify/functions/gcal') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const event = {
        httpMethod: req.method,
        queryStringParameters: parsed.query || {},
        headers: req.headers,
        body: body || null,
      };
      try {
        const result = await handler(event);
        const resHeaders = { 'Content-Type': 'application/json', ...(result.headers || {}) };
        res.writeHead(result.statusCode, resHeaders);
        res.end(result.body || '');
      } catch(e) {
        console.error('[function error]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Ruta: archivos estáticos ───────────────────────────────────────────
  let filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);

  // Si la ruta no tiene extensión, intenta index.html (SPA fallback)
  if(!path.extname(filePath)) filePath += '/index.html';

  fs.readFile(filePath, (err, data) => {
    if(err) {
      // SPA fallback → index.html
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if(err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\n──────────────────────────────────────────');
  console.log(`  KN Dental dev server → http://localhost:${PORT}`);
  console.log(`  Function  → http://localhost:${PORT}/.netlify/functions/gcal?action=status`);
  console.log('──────────────────────────────────────────\n');
});
