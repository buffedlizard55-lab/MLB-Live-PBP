/* ============================================================================
 * ui.js — shared UI helpers for the scoreboard + game pages
 * (DOM builders, team colors, count dots, runners diamond, status chips)
 * ==========================================================================*/
'use strict';

const UI = (() => {
  /* Team primary colors (official-ish hexes), used for accents + fallback logos */
  const TEAM_COLORS = {
    108: '#BA0021', 109: '#A71930', 110: '#DF4601', 111: '#BD3039',
    112: '#0E3386', 113: '#C6011F', 114: '#E31937', 115: '#333366',
    116: '#0C2340', 117: '#004687', 118: '#EB6E1F', 119: '#005A9C',
    120: '#AB0003', 121: '#002D72', 133: '#003831', 134: '#FDB827',
    135: '#2F241D', 136: '#0C2C56', 137: '#FD5A1E', 138: '#C41E3A',
    139: '#092C5C', 140: '#003278', 141: '#134A8E', 142: '#002B5C',
    143: '#E81828', 144: '#CE1141', 145: '#27251F', 146: '#00A3E0',
    147: '#003087', 158: '#12284B',
  };

  function teamColor(teamId) { return TEAM_COLORS[teamId] || '#2f81f7'; }

  /* ------------------------------------------------------------- DOM utils */

  /** Create an element: el('div', 'class1 class2', 'text content', {attr: val}) */
  function el(tag, cls, text, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (attrs) {
      Object.entries(attrs).forEach(([k, v]) => {
        if (v != null) node.setAttribute(k, v);
      });
    }
    return node;
  }

  /** Safe innerHTML-free text escaping (we build nodes, but useful anyway). */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ------------------------------------------------------------- team bits */

  /** Logo <img> that falls back to a colored circle with the abbreviation. */
  function teamLogo(teamId, teamName, abbrev, cls) {
    const holder = (id, name) => {
      const h = el('span', `team-logo-fallback ${cls || ''}`);
      h.style.background = teamColor(id);
      h.textContent = abbrev || (name || '?').slice(0, 3).toUpperCase();
      return h;
    };
    if (!teamId) return holder(teamId, teamName);
    const img = el('img', `team-logo ${cls || ''}`);
    img.alt = teamName || 'team';
    img.loading = 'lazy';
    img.src = MLB.teamLogoUrl(teamId);
    img.onerror = () => {
      img.onerror = null;
      const fb = new Image();
      fb.src = MLB.teamLogoFallbackUrl(teamId);
      fb.onload = () => { img.src = fb.src; };
      fb.onerror = () => { img.replaceWith(holder(teamId, teamName)); };
    };
    return img;
  }

  /** Player headshot <img> with graceful hide on error. */
  function headshot(personId, name, cls) {
    if (!personId) {
      const placeholder = el('span', `headshot headshot-na ${cls || ''}`);
      placeholder.title = name || 'player';
      return placeholder;
    }
    const img = el('img', `headshot ${cls || ''}`);
    img.alt = name || 'player';
    img.loading = 'lazy';
    img.src = MLB.headshotUrl(personId);
    img.onerror = () => { img.remove(); };
    return img;
  }

  /* ------------------------------------------------------------ status chip */

  const STATUS_META = {
    Scheduled:   { cls: 'chip-sched',  label: 'Scheduled' },
    'Pre-Game':  { cls: 'chip-sched',  label: 'Pre-Game' },
    Warmup:      { cls: 'chip-live',   label: 'Warmup' },
    'In Progress': { cls: 'chip-live', label: 'LIVE' },
    Delayed:     { cls: 'chip-warn',   label: 'Delayed' },
    'Manager Challenge': { cls: 'chip-review', label: 'Challenge' },
    Review:      { cls: 'chip-review', label: 'Review' },
    'In Review': { cls: 'chip-review', label: 'In Review' },
    'Crew Chief Review': { cls: 'chip-review', label: 'Crew Review' },
    'ABS Challenge': { cls: 'chip-review', label: 'ABS Challenge' },
    'Umpire Review': { cls: 'chip-review', label: 'Umpire Review' },
    Final:       { cls: 'chip-final',  label: 'Final' },
    'Game Over': { cls: 'chip-final',  label: 'Final' },
    Postponed:   { cls: 'chip-muted',  label: 'Postponed' },
    Cancelled:   { cls: 'chip-muted',  label: 'Cancelled' },
    Suspended:   { cls: 'chip-muted',  label: 'Suspended' },
  };

  function statusChip(status, labelOverride) {
    const detailed = status && status.detailedState;
    const isReview = /challenge|review/i.test(detailed || '');
    const meta = STATUS_META[detailed] || (isReview ? { cls: 'chip-review', label: detailed } :
                 { cls: 'chip-muted', label: detailed || (status && status.abstractGameState) });
    const label = labelOverride || meta.label;
    const chip = el('span', `chip ${meta.cls}`, label);
    if (meta.cls === 'chip-live' || meta.cls === 'chip-review' || label === 'LIVE' || label === 'Warmup' || isReview) {
      const dot = el('span', 'chip-dot');
      chip.prepend(dot);
    }
    return chip;
  }

  /* ------------------------------------------------------------- count dots */

  /** Balls / Strikes / Outs dot clusters. max: 4 balls, 3 strikes, 2 outs. */
  function countDots(balls, strikes, outs, cls) {
    const wrap = el('div', `count-dots ${cls || ''}`);
    const group = (label, filled, total) => {
      const g = el('span', 'count-group');
      g.appendChild(el('span', 'count-label', label));
      for (let i = 0; i < total; i += 1) {
        g.appendChild(el('span', `dot ${i < filled ? 'dot-on' : ''}`));
      }
      return g;
    };
    wrap.appendChild(group('B', balls, 4));
    wrap.appendChild(group('S', strikes, 3));
    wrap.appendChild(group('O', outs, 2));
    return wrap;
  }

  /* -------------------------------------------------------- runners diamond */

  /**
   * Baseball diamond with occupied bases.
   * bases: {first, second, third} booleans.
   */
  function diamond(bases, cls) {
    const box = el('div', `diamond ${cls || ''}`);
    const base = (key, label) => {
      const b = el('span', `base base-${key} ${bases[key] ? 'base-on' : ''}`);
      b.title = label;
      return b;
    };
    box.appendChild(base('third', '3rd base'));
    box.appendChild(base('second', '2nd base'));
    box.appendChild(base('first', '1st base'));
    return box;
  }

  /** Map a StatsAPI runners array -> {first, second, third} booleans. */
  function basesFromRunners(runners) {
    const bases = { first: false, second: false, third: false };
    (runners || []).forEach((r) => {
      const end = r.movement && r.movement.end;
      if (end === '1B') bases.first = true;
      if (end === '2B') bases.second = true;
      if (end === '3B') bases.third = true;
    });
    return bases;
  }

  /* ---------------------------------------------------------------- misc */

  /** Friendly countdown text: 47 -> "47s", 90 -> "1m 30s". */
  function fmtCountdown(sec) {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  /** "5.1" innings pitched -> "5.1 IP". */
  function fmtInnings(ip) {
    return ip == null || ip === '' ? '—' : String(ip);
  }

  function pct(num) {
    return num == null ? '—' : String(num).padStart(3, '0');
  }

  return {
    teamColor, el, esc, clear,
    teamLogo, headshot, statusChip,
    countDots, diamond, basesFromRunners,
    fmtCountdown, fmtInnings, pct,
  };
})();
