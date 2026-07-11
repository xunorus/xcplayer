#!/usr/bin/env node
/* XC Player server — descarga con yt-dlp y sirve los mp3 de ./music
   Sin dependencias. Uso: node server.js  (puerto 8977) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8977;
const ROOT = __dirname;
const MUSIC = path.join(ROOT, 'music');
if (!fs.existsSync(MUSIC)) fs.mkdirSync(MUSIC);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function listMp3s() {
  return fs.readdirSync(MUSIC)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .map(f => ({ name: f, size: fs.statSync(path.join(MUSIC, f)).size }));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}

function safeName(raw) {
  const name = path.basename(decodeURIComponent(raw));
  if (name.includes('..') || !name.toLowerCase().endsWith('.mp3')) return null;
  return name;
}

let downloading = false;

function handleDownload(req, res) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let url;
    try { url = JSON.parse(body).url; } catch { return json(res, 400, { error: 'JSON inválido' }); }
    if (!url || !/^https?:\/\//i.test(url)) return json(res, 400, { error: 'URL inválida' });
    if (downloading) return json(res, 409, { error: 'Ya hay una descarga en curso' });
    downloading = true;

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...CORS,
    });
    const send = obj => res.write(JSON.stringify(obj) + '\n');
    const before = new Set(listMp3s().map(t => t.name));

    const proc = spawn('yt-dlp', [
      '--extract-audio', '--audio-format', 'mp3',
      '-o', path.join(MUSIC, '%(title)s.%(ext)s'),
      '-c', '--newline', '--no-colors',
      // imprime la ruta del mp3 apenas termina cada ítem → evento 'file' por track
      '--print', 'after_move:filepath', '--no-quiet', '--no-simulate',
      url,
    ]);

    const onLine = chunk => {
      for (const line of chunk.toString().split('\n')) {
        const l = line.trim();
        if (!l) continue;
        if (l.startsWith(MUSIC + path.sep) && l.toLowerCase().endsWith('.mp3')) {
          send({ type: 'file', name: path.basename(l) });
        } else {
          send({ type: 'log', line: l });
        }
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('error', err => { send({ type: 'done', code: -1, error: String(err), files: [] }); res.end(); downloading = false; });
    proc.on('close', code => {
      const files = listMp3s().filter(t => !before.has(t.name));
      send({ type: 'done', code, files });
      res.end();
      downloading = false;
    });
    req.on('close', () => { if (!proc.killed) proc.kill(); });
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (req.method === 'POST' && u.pathname === '/api/download') return handleDownload(req, res);

  if (req.method === 'GET' && u.pathname === '/api/library') return json(res, 200, listMp3s());

  if (req.method === 'GET' && u.pathname === '/api/ping') return json(res, 200, { ok: true, app: 'xcplayer' });

  if (req.method === 'DELETE' && u.pathname.startsWith('/api/file/')) {
    const name = safeName(u.pathname.slice('/api/file/'.length));
    if (!name) return json(res, 400, { error: 'nombre inválido' });
    const fp = path.join(MUSIC, name);
    if (!fs.existsSync(fp)) return json(res, 404, { error: 'no existe' });
    fs.unlinkSync(fp);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && u.pathname.startsWith('/music/')) {
    const name = safeName(u.pathname.slice('/music/'.length));
    const fp = name && path.join(MUSIC, name);
    if (!fp || !fs.existsSync(fp)) return json(res, 404, { error: 'no existe' });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(fp).size, ...CORS });
    return fs.createReadStream(fp).pipe(res);
  }

  // estáticos
  let file = u.pathname === '/' ? '/index.html' : u.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const fp = path.join(ROOT, file);
  if (fp.startsWith(ROOT) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', ...CORS });
    return fs.createReadStream(fp).pipe(res);
  }
  res.writeHead(404, CORS);
  res.end('404');
});

server.listen(PORT, () => {
  console.log(`XC Player server → http://localhost:${PORT}  (música en ${MUSIC})`);
});
