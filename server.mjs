#!/usr/bin/env node
/* ============================================================================
 * server.mjs — HTTP server for MLB Live PBP with persistent feed logging.
 *
 * Serves static web assets and provides a shared persistence backend for
 * reviews, challenges, official-scorer pending rulings, and scoring changes.
 *
 * Persisted state lives in data/feed-log-<YYYY-MM-DD>.json so that any
 * client/browser visiting the website immediately receives all tracked
 * entries, scoring changes, and baselines across browsers and sessions.
 * ==========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = __dirname;
const DATA_DIR = path.join(REPO_DIR, 'data');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const HOST = '0.0.0.0';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

function getLogFilePath(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return path.join(DATA_DIR, `feed-log-${dateStr}.json`);
}

function readLogFromDisk(dateStr) {
  const filePath = getLogFilePath(dateStr);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[server] failed to read feed log for ${dateStr}:`, err);
    return null;
  }
}

/**
 * Merge an incoming feed log into an existing disk log idempotently.
 * Preserves all distinct rows, baselines, history chains, and irregularities.
 */
function mergeFeedLogPayloads(existing, incoming, dateStr) {
  const now = Date.now();
  if (!existing || typeof existing !== 'object' || existing.v !== 1) {
    return {
      v: 1,
      date: dateStr,
      savedAt: now,
      entries: Array.isArray(incoming.entries) ? incoming.entries : [],
      order: Array.isArray(incoming.order) ? incoming.order : [],
      snapshots: (incoming.snapshots && typeof incoming.snapshots === 'object') ? incoming.snapshots : {},
      irregularities: (incoming.irregularities && typeof incoming.irregularities === 'object') ? incoming.irregularities : {},
      grace: (incoming.grace && typeof incoming.grace === 'object') ? incoming.grace : {},
      settled: Array.isArray(incoming.settled) ? incoming.settled : [],
    };
  }

  // Merge entries by key: gamePk:review.id
  const entryMap = new Map();
  const orderList = [];

  function makeKey(entry) {
    if (!entry || !entry.review) return null;
    return `${entry.gamePk}:${entry.review.id || entry.review.atBatIndex || ''}`;
  }

  (Array.isArray(existing.entries) ? existing.entries : []).forEach((e) => {
    const k = makeKey(e);
    if (!k) return;
    entryMap.set(k, e);
    if (!orderList.includes(k)) orderList.push(k);
  });

  (Array.isArray(incoming.entries) ? incoming.entries : []).forEach((e) => {
    const k = makeKey(e);
    if (!k) return;
    const prev = entryMap.get(k);
    if (!prev) {
      entryMap.set(k, e);
      if (!orderList.includes(k)) orderList.push(k);
    } else {
      // Merge: prefer most complete / latest seen
      const mergedEntry = {
        gamePk: e.gamePk || prev.gamePk,
        review: { ...prev.review, ...e.review },
        firstSeen: Math.min(prev.firstSeen || e.firstSeen || now, e.firstSeen || prev.firstSeen || now),
        lastSeen: Math.max(prev.lastSeen || 0, e.lastSeen || 0, now),
        matchupLabel: e.matchupLabel || prev.matchupLabel || null,
      };
      // For scoring change: preserve longer history if present
      if (prev.review && prev.review.history && (!e.review.history || e.review.history.length < prev.review.history.length)) {
        mergedEntry.review.history = prev.review.history;
      }
      entryMap.set(k, mergedEntry);
    }
  });

  // Merge snapshots (per gamePk -> atBatIndex)
  const mergedSnapshots = { ...(existing.snapshots || {}) };
  if (incoming.snapshots && typeof incoming.snapshots === 'object') {
    Object.keys(incoming.snapshots).forEach((gamePk) => {
      mergedSnapshots[gamePk] = {
        ...(mergedSnapshots[gamePk] || {}),
        ...(incoming.snapshots[gamePk] || {}),
      };
    });
  }

  // Merge irregularities (per gamePk -> notes array)
  const mergedIrregularities = { ...(existing.irregularities || {}) };
  if (incoming.irregularities && typeof incoming.irregularities === 'object') {
    Object.keys(incoming.irregularities).forEach((gamePk) => {
      const prevNotes = mergedIrregularities[gamePk] || [];
      const newNotes = incoming.irregularities[gamePk] || [];
      const combined = [...prevNotes];
      newNotes.forEach((n) => {
        if (typeof n === 'string' && !combined.includes(n)) combined.push(n);
      });
      mergedIrregularities[gamePk] = combined.slice(-30);
    });
  }

  // Merge grace
  const mergedGrace = { ...(existing.grace || {}), ...(incoming.grace || {}) };

  // Merge settled
  const settledSet = new Set([
    ...(Array.isArray(existing.settled) ? existing.settled : []),
    ...(Array.isArray(incoming.settled) ? incoming.settled : []),
  ]);

  return {
    v: 1,
    date: dateStr,
    savedAt: now,
    entries: orderList.map((k) => entryMap.get(k)).filter(Boolean),
    order: orderList,
    snapshots: mergedSnapshots,
    irregularities: mergedIrregularities,
    grace: mergedGrace,
    settled: [...settledSet],
  };
}

function writeLogToDisk(dateStr, payload) {
  const filePath = getLogFilePath(dateStr);
  if (!filePath) return false;
  try {
    const existing = readLogFromDisk(dateStr);
    const merged = mergeFeedLogPayloads(existing, payload, dateStr);
    const serialized = JSON.stringify(merged, null, 2);
    // Write atomically via temporary file
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.renameSync(tempPath, filePath);

    // Update index
    const indexPath = path.join(DATA_DIR, 'feed-log-index.json');
    let index = {};
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) || {}; } catch (_) {}
    }
    index[dateStr] = merged.savedAt;
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error(`[server] failed to write feed log for ${dateStr}:`, err);
    return false;
  }
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // --- API Endpoints ---

  // Health check
  if (pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // GET /api/feed-log?date=YYYY-MM-DD or /api/log?date=YYYY-MM-DD
  if ((pathname === '/api/feed-log' || pathname === '/api/log') && req.method === 'GET') {
    const dateStr = reqUrl.searchParams.get('date');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required');
      return;
    }
    const log = readLogFromDisk(dateStr);
    if (log) {
      sendJSON(res, 200, log);
    } else {
      // Return empty valid structure if not yet created on disk
      sendJSON(res, 200, {
        v: 1,
        date: dateStr,
        savedAt: Date.now(),
        entries: [],
        order: [],
        snapshots: {},
        irregularities: {},
        grace: {},
        settled: [],
      });
    }
    return;
  }

  // POST /api/feed-log or /api/log
  if ((pathname === '/api/feed-log' || pathname === '/api/log') && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // 50MB protection
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || payload.v !== 1 || !payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
          sendError(res, 400, 'Invalid payload: must be object with v: 1 and valid date (YYYY-MM-DD)');
          return;
        }
        const saved = writeLogToDisk(payload.date, payload);
        if (saved) {
          sendJSON(res, 200, {
            ok: true,
            date: payload.date,
            savedAt: saved.savedAt,
            entriesCount: saved.entries.length,
          });
        } else {
          sendError(res, 500, 'Failed to save feed log to disk');
        }
      } catch (err) {
        sendError(res, 400, `JSON parse error: ${err.message}`);
      }
    });
    return;
  }

  // --- Static File Serving ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method not allowed');
    return;
  }

  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  if (safePath === '/reviews') safePath = '/reviews.html';
  if (safePath === '/game') safePath = '/game.html';

  const filePath = path.join(REPO_DIR, safePath);

  // Security check: ensure path is within REPO_DIR
  if (!filePath.startsWith(REPO_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 404 fallback: if asking for an html page, check 404.html
      const notFoundPath = path.join(REPO_DIR, '404.html');
      if (fs.existsSync(notFoundPath)) {
        res.writeHead(404, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(notFoundPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[MLB Live PBP Server] listening on http://${HOST}:${PORT}`);
  console.log(`[MLB Live PBP Server] Serving ${REPO_DIR}`);
  console.log(`[MLB Live PBP Server] Feed log persistence directory: ${DATA_DIR}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
