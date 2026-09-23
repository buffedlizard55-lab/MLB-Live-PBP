/**
 * feed-log.js — Shared persistent feed logging for MLB Live PBP.
 *
 * Provides cross-browser, cross-session and cross-page persistence for:
 *   - Instant replay reviews (manager challenges, crew chief, umpire, ABS, boundary)
 *   - Official-scorer pending rulings & resolved ruling descriptions
 *   - Official scoring changes (hit ↔ error, single ↔ double, out ↔ hit, etc.)
 *   - Scoring snapshots (baselines for poll-diff detection)
 *   - Scoring irregularities
 *
 * Multi-tier storage architecture:
 *   1. Memory cache (instantaneous, 0ms latency)
 *   2. LocalStorage (client-local fast cache, survives refresh on same browser)
 *   3. Server persistence (POST /api/feed-log -> data/feed-log-<date>.json)
 *      Enables multi-browser sync so opening on another browser shows all logged
 *      scoring changes and review entries immediately.
 *   4. Static file fallback (data/feed-log-<date>.json for static deployments)
 */
(function(root) {
  'use strict';

  const FEED_LOG_VERSION = 1;
  const FEED_LOG_KEY_PREFIX = 'mlbReplayFeedLog.v1.';
  const FEED_LOG_INDEX_KEY = 'mlbReplayFeedLog.v1.index';
  const FEED_LOG_MAX_ENTRIES = 500;
  const FEED_LOG_MAX_DATES = 7;

  function feedLogStorageKey(dateStr) {
    return `${FEED_LOG_KEY_PREFIX}${dateStr || ''}`;
  }

  function isDateStr(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  }

  function localStore() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (_) {}
    return null;
  }

  /** Read from localStorage safely */
  function readLocal(dateStr) {
    const store = localStore();
    if (!store || !isDateStr(dateStr)) return null;
    try {
      const raw = store.getItem(feedLogStorageKey(dateStr));
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  /** Write to localStorage safely */
  function writeLocal(dateStr, payload) {
    const store = localStore();
    if (!store || !isDateStr(dateStr) || !payload) return false;
    try {
      store.setItem(feedLogStorageKey(dateStr), JSON.stringify(payload));
      let index = {};
      try {
        index = JSON.parse(store.getItem(FEED_LOG_INDEX_KEY)) || {};
      } catch (_) { index = {}; }
      if (!index || typeof index !== 'object') index = {};
      index[dateStr] = payload.savedAt || Date.now();
      // Bound index to FEED_LOG_MAX_DATES
      const keys = Object.keys(index).sort((a, b) => (index[b] || 0) - (index[a] || 0));
      if (keys.length > FEED_LOG_MAX_DATES) {
        keys.slice(FEED_LOG_MAX_DATES).forEach((k) => {
          if (k !== dateStr) {
            try { store.removeItem(feedLogStorageKey(k)); } catch (_) {}
            delete index[k];
          }
        });
      }
      store.setItem(FEED_LOG_INDEX_KEY, JSON.stringify(index));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Build stable event key */
  function buildEventKey(gamePk, review) {
    if (!review) return String(gamePk || '');
    return `${gamePk}:${review.id || review.atBatIndex || ''}`;
  }

  /**
   * Merge two raw log payloads (e.g. server payload and local payload).
   */
  function mergePayloads(a, b, dateStr) {
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    const now = Date.now();
    const entryMap = new Map();
    const order = [];

    const addEntry = (e) => {
      if (!e || typeof e !== 'object' || !e.review) return;
      const key = buildEventKey(e.gamePk, e.review);
      if (!entryMap.has(key)) {
        entryMap.set(key, e);
        order.push(key);
      } else {
        const prev = entryMap.get(key);
        entryMap.set(key, {
          gamePk: e.gamePk || prev.gamePk,
          review: { ...prev.review, ...e.review },
          firstSeen: Math.min(prev.firstSeen || e.firstSeen || now, e.firstSeen || prev.firstSeen || now),
          lastSeen: Math.max(prev.lastSeen || 0, e.lastSeen || 0, now),
          matchupLabel: e.matchupLabel || prev.matchupLabel || null,
        });
      }
    };

    (Array.isArray(a.entries) ? a.entries : []).forEach(addEntry);
    (Array.isArray(b.entries) ? b.entries : []).forEach(addEntry);

    const mergedSnapshots = {};
    [a.snapshots, b.snapshots].forEach((s) => {
      if (s && typeof s === 'object') {
        Object.keys(s).forEach((pk) => {
          mergedSnapshots[pk] = { ...(mergedSnapshots[pk] || {}), ...(s[pk] || {}) };
        });
      }
    });

    const mergedIrr = {};
    [a.irregularities, b.irregularities].forEach((irr) => {
      if (irr && typeof irr === 'object') {
        Object.keys(irr).forEach((pk) => {
          const list = [...(mergedIrr[pk] || [])];
          (irr[pk] || []).forEach((n) => { if (typeof n === 'string' && !list.includes(n)) list.push(n); });
          mergedIrr[pk] = list.slice(-30);
        });
      }
    });

    const mergedGrace = { ...(a.grace || {}), ...(b.grace || {}) };
    const mergedSettled = Array.from(new Set([
      ...(Array.isArray(a.settled) ? a.settled : []),
      ...(Array.isArray(b.settled) ? b.settled : []),
    ]));

    return {
      v: FEED_LOG_VERSION,
      date: dateStr,
      savedAt: Math.max(a.savedAt || 0, b.savedAt || 0, now),
      entries: order.map((k) => entryMap.get(k)).filter(Boolean),
      order,
      snapshots: mergedSnapshots,
      irregularities: mergedIrr,
      grace: mergedGrace,
      settled: mergedSettled,
    };
  }

  /**
   * Fetch log from server (POST/GET /api/feed-log or data/feed-log-<date>.json),
   * merged with localStorage.
   */
  async function fetchLog(dateStr) {
    if (!isDateStr(dateStr)) return null;
    const local = readLocal(dateStr);
    let remote = null;

    if (typeof fetch === 'function') {
      try {
        // 1. Try server API
        const res = await fetch(`/api/feed-log?date=${encodeURIComponent(dateStr)}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.ok) {
          remote = await res.json();
        }
      } catch (_) {}

      // 2. If API was unavailable, try static data file
      if (!remote) {
        try {
          const resStatic = await fetch(`data/feed-log-${encodeURIComponent(dateStr)}.json`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (resStatic.ok) {
            remote = await resStatic.json();
          }
        } catch (_) {}
      }
    }

    const merged = mergePayloads(remote, local, dateStr);
    if (merged) {
      writeLocal(dateStr, merged);
    }
    return merged;
  }

  /**
   * Save log payload: writes to localStorage and POSTs to server.
   */
  async function saveLog(dateStr, payload) {
    if (!isDateStr(dateStr) || !payload) return false;
    writeLocal(dateStr, payload);

    if (typeof fetch === 'function') {
      try {
        await fetch('/api/feed-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return true;
      } catch (err) {
        // Server unreachable or static hosting — localStorage remains saved
        return false;
      }
    }
    return true;
  }

  /**
   * Extract scoring changes for a specific gamePk from a log payload or for a date.
   */
  async function getScoringChangesForGame(dateStr, gamePk) {
    const log = await fetchLog(dateStr);
    if (!log || !Array.isArray(log.entries)) return [];
    const pkNum = Number(gamePk);
    return log.entries
      .filter((e) => Number(e.gamePk) === pkNum && e.review && e.review.typeKey === 'scoring_change')
      .map((e) => e.review);
  }

  /**
   * Extract all scoring changes by gamePk for a date.
   * Returns Map<gamePk, review[]>.
   */
  async function getScoringChangesByGame(dateStr) {
    const log = await fetchLog(dateStr);
    const map = new Map();
    if (!log || !Array.isArray(log.entries)) return map;
    log.entries.forEach((e) => {
      if (e.review && e.review.typeKey === 'scoring_change') {
        const pk = Number(e.gamePk);
        const list = map.get(pk) || [];
        list.push(e.review);
        map.set(pk, list);
      }
    });
    return map;
  }

  const MLBFeedLog = {
    FEED_LOG_VERSION,
    FEED_LOG_KEY_PREFIX,
    FEED_LOG_INDEX_KEY,
    feedLogStorageKey,
    readLocal,
    writeLocal,
    mergePayloads,
    fetchLog,
    saveLog,
    getScoringChangesForGame,
    getScoringChangesByGame,
  };

  root.MLBFeedLog = MLBFeedLog;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MLBFeedLog;
  }
})(typeof window !== 'undefined' ? window : globalThis);
