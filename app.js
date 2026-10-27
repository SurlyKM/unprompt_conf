/* [un]prompted II companion, version 2.
 *
 * Layout and behaviour follow the BSides Canberra schedule app. Sections:
 *   1. config, time helpers, storage
 *   2. session model (agenda.json -> sessions)
 *   3. clash detection and search
 *   4. rendering (cards, Now, Schedule, My plan, header)
 *   5. collapsing header and scrolling
 *   6. details sheet (notes, rating, takeaway)
 *   7. events and start-up
 *
 * Stars, notes, ratings and flags live in this browser's localStorage and never leave the phone.
 * Each session has a stable id (day + stage + start time) from agenda.json.
 */
(() => {
'use strict';

/* =====================================================================
   1. CONFIG, TIME HELPERS, STORAGE
   Everything displays in San Francisco time, whatever time zone the phone is in.
   Add ?now=2026-10-27T10:05 to the URL to test as if it is that San Francisco moment.
   ===================================================================== */
const TZ = 'America/Los_Angeles';
const SF_OFFSET = '-07:00';          // PDT. Daylight saving ends on 1 Nov, after the conference.
const DATA_URL = 'data/agenda.json';

const fHM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fLong = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const fShort = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fTab = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' });
const hm = (ms) => fHM.format(ms);
const shortDay = (ms) => fShort.format(ms).replace(/,/g, '');   // "Tue 27 Oct" without the comma
const dayOf = (ms) => fDay.format(ms);
const noon = (d) => Date.parse(`${d}T12:00:00${SF_OFFSET}`);

const override = (() => {
  const v = new URLSearchParams(location.search).get('now');
  const t = v ? Date.parse(`${v}${v.length === 16 ? ':00' : ''}${SF_OFFSET}`) : NaN;
  return Number.isFinite(t) ? { at: t, loaded: Date.now() } : null;
})();
const now = () => (override ? override.at + (Date.now() - override.loaded) : Date.now());

const $ = (s) => document.querySelector(s);
// Everything from the agenda goes through esc() before it is placed in HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (t, n = 40) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

// localStorage can throw (private tabs, blocked storage), so keep an in-memory copy as a fallback.
const mem = {};
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('upsf26-' + k); return v == null ? (k in mem ? mem[k] : d) : JSON.parse(v); }
    catch { return k in mem ? mem[k] : d; }
  },
  set(k, v) { mem[k] = v; try { localStorage.setItem('upsf26-' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" ${extra} aria-hidden="true">${body}</svg>`;
const STAR_PATH = '<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/>';
const STAR = svg(STAR_PATH, 'fill="currentColor"');
const STAR_O = svg(STAR_PATH, 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"');
const CHEV = svg('<path d="M6 9l6 6 6-6"/>', 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"');
const CHAT = svg('<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.38 8.5 8.5 0 0 1-4-1L3 20l1.12-5.5a8.38 8.38 0 0 1-1-4A8.38 8.38 0 0 1 11.5 3a8.5 8.5 0 0 1 9.5 8.5Z"/>', 'fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"');
const PENCIL = svg('<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 'fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"');

// Saved data, keyed by session id. The same keys as version 1, so earlier stars carry over.
let mine = store.get('bm', {});        // starred:            { id: true }
let wtt = store.get('wtt', {});        // want to talk to:    { id: true }
let notes = store.get('n', {});        // notes:              { id: "text" }
let ratings = store.get('r', {});      // star rating:        { id: 1..5 }
let takes = store.get('tk', {});       // one-line takeaway:  { id: "text" }

/* =====================================================================
   2. SESSION MODEL
   ===================================================================== */
let sessions = [], byKey = new Map(), DAYS = [], presentRooms = [], ROOMS = new Map(), DATA = null;

function mk(it, order) {
  const start = Date.parse(`${it.date}T${it.start}:00${SF_OFFSET}`);
  let end = Date.parse(`${it.date}T${it.end}:00${SF_OFFSET}`);
  const noEnd = !(end > start);                     // a few published end times are typos
  if (noEnd) end = start;
  const speakers = it.speakers || [];
  const s = {
    key: it.id, day: it.date, start, end, noEnd, track: it.track, room: ROOMS.get(it.track) || it.track,
    tr: order.indexOf(it.track), title: it.title, kind: it.kind,
    isBreak: it.kind === 'break',
    long: it.kind === 'village',                    // villages run for hours, so they live in a strip
    speakers, names: speakers.map((p) => p.name), abstract: it.abstract || [],
    venue: it.venue || '', address: it.address || '', maps: it.maps || '',
  };
  s.hay = norm([s.title, s.room, s.venue, ...speakers.map((p) => `${p.name} ${p.role}`), ...s.abstract].join(' '));
  return s;
}

function setSessions(data) {
  DATA = data;
  ROOMS = new Map(data.tracks.map((t) => [t.id, t.name]));
  const order = data.tracks.map((t) => t.id);
  sessions = data.items.map((it) => mk(it, order)).sort((a, b) => a.start - b.start || a.tr - b.tr);
  byKey = new Map(sessions.map((s) => [s.key, s]));
  DAYS = [...new Set(sessions.map((s) => s.day))].sort();
  presentRooms = order.filter((id) => sessions.some((s) => s.track === id && !s.isBreak));
  rooms = rooms.filter((r) => presentRooms.includes(r));
}

/* =====================================================================
   STATE
   ===================================================================== */
let view = store.get('view', 'now');             // now | schedule | plan
if (!['now', 'schedule', 'plan'].includes(view)) view = 'now';
let mode = store.get('mode', 'all');             // all | mine
let rooms = store.get('rooms', []);              // stage ids to show. [] means all
let query = '';
let allDayOpen = store.get('allday', false);
let day = null;

/* =====================================================================
   3. CLASH DETECTION AND SEARCH
   ===================================================================== */
// Breaks do not clash. Villages (CTF etc.) are drop-in, so they never count either.
const clashable = (s) => !s.isBreak && !s.long;
const overlap = (a, b) => a.start < b.end && b.start < a.end;

function context() {
  const t = now(), ms = new Set();
  for (const k of Object.keys(mine)) if (mine[k] && byKey.has(k)) ms.add(k);
  const list = [...ms].map((k) => byKey.get(k)).filter(clashable);
  const map = new Map(), pairs = [];
  for (let x = 0; x < list.length; x++) {
    for (let y = x + 1; y < list.length; y++) {
      if (overlap(list[x], list[y])) {
        pairs.push([list[x], list[y]]);
        if (!map.has(list[x].key)) map.set(list[x].key, []);
        if (!map.has(list[y].key)) map.set(list[y].key, []);
        map.get(list[x].key).push(list[y]);
        map.get(list[y].key).push(list[x]);
      }
    }
  }
  return { t, ms, cl: { map, pairs, upcoming: pairs.filter(([a, b]) => Math.max(a.end, b.end) > t).length } };
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = () => norm(query).split(/\s+/).filter(Boolean);
const mineText = (s) => norm(`${notes[s.key] || ''} ${takes[s.key] || ''}`);
const matches = (s, toks) => { const h = s.hay + ' ' + mineText(s); return toks.every((t) => h.includes(t)); };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function hl(text, toks) {
  if (!toks.length) return esc(text);
  const re = new RegExp(`(${toks.map(reEsc).join('|')})`, 'ig');
  return String(text).split(re).map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
}

/* =====================================================================
   4. RENDERING
   ===================================================================== */
const roomOn = (id) => !rooms.length || rooms.includes(id);

function visible(s, c, ignoreRooms) {
  if (s.isBreak) return mode === 'all';
  if (!ignoreRooms && !roomOn(s.track)) return false;
  if (mode === 'mine') return c.ms.has(s.key);
  return true;
}

function span(mins) {
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}
function whenText(start, t) {
  const mins = Math.round((start - t) / 60000);
  if (dayOf(start) === dayOf(t) && mins >= 0 && mins < 60) return `in ${mins} min`;
  return dayOf(start) === dayOf(t) ? `at ${hm(start)}` : `${shortDay(start)} at ${hm(start)}`;
}
const timeRange = (s) => (s.noEnd ? hm(s.start) : `${hm(s.start)} to ${hm(s.end)}`);

const starBtn = (s, on) =>
  `<button class="star" type="button" data-star="${esc(s.key)}" aria-pressed="${on}" aria-label="${on ? 'Remove star' : 'Star'}: ${esc(s.title)}">${on ? STAR : STAR_O}</button>`;

function clashLine(s, c) {
  const others = c.cl.map.get(s.key);
  if (others) return `<p class="cl">Clashes with ${others.map((o) => `${esc(short(o.title))} (${esc(o.room)})`).join(', ')}</p>`;
  if (!c.ms.has(s.key) && clashable(s)) {
    const over = [...c.ms].map((k) => byKey.get(k)).filter((p) => clashable(p) && overlap(s, p));
    if (over.length) return `<p class="cl soft">Overlaps your pick: ${over.map((o) => esc(short(o.title))).join(', ')}</p>`;
  }
  return '';
}

function marks(s) {
  const out = [];
  if (wtt[s.key]) out.push(`<span class="talk">${CHAT}Want to talk to</span>`);
  if (notes[s.key]) out.push(`<span>${PENCIL}Note</span>`);
  if (ratings[s.key]) out.push(`<span>${STAR.replace('<svg', '<svg width="15" height="15"')}${ratings[s.key]} of 5</span>`);
  const take = takes[s.key] ? `<p class="inabs">${esc(takes[s.key])}</p>` : '';
  return take + (out.length ? `<div class="marks">${out.join('')}</div>` : '');
}

function card(s, c, opts = {}) {
  const { t, ms } = c;
  const live = s.start <= t && t < s.end, past = s.end > s.start ? t >= s.end : t >= s.start + 60000;
  const on = ms.has(s.key), toks = opts.toks || [];
  const pct = live ? Math.min(100, Math.round(((t - s.start) / (s.end - s.start)) * 100)) : 0;
  const timing = opts.soon ? `<span class="soon">${esc(whenText(s.start, t))}</span>`
    : live ? `<span>ends ${hm(s.end)}</span>` : `<span>${timeRange(s)}</span>`;
  // If a search hit only the description, say so, otherwise the result looks random.
  const seen = norm([s.title, s.names.join(' '), s.room, s.venue].join(' ') + ' ' + mineText(s));
  const inAbs = toks.length && !toks.every((k) => seen.includes(k)) ? '<p class="inabs">Matches the talk description</p>' : '';
  const who = s.kind === 'event' ? s.venue : s.names.join(', ');
  const clash = c.cl.map.has(s.key);
  return `<article class="card${live ? ' live' : ''}${past ? ' past' : ''}${clash ? ' clash' : ''}">
    <div class="card-main" role="button" tabindex="0" data-open="${esc(s.key)}">
      <div class="meta"><span class="room">${hl(s.room, toks)}</span>${timing}</div>
      <h3>${hl(s.title, toks)}</h3>
      ${who ? `<p class="who">${hl(who, toks)}</p>` : ''}
      ${inAbs}${clashLine(s, c)}${marks(s)}
      ${live && opts.progress ? `<div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}
    </div>${starBtn(s, on)}</article>`;
}

// Villages are long drop-in blocks, so they tuck into a strip instead of filling the timeline.
function allDay(list, c) {
  if (!list.length) return '';
  const { t, ms } = c;
  const liveCount = list.filter((s) => s.start <= t && t < s.end).length;
  const rows = list.map((s) => {
    const live = s.start <= t && t < s.end;
    return `<div class="row${live ? ' live' : ''}">
      <div class="card-main" role="button" tabindex="0" data-open="${esc(s.key)}">
        <div class="meta"><span class="room">${esc(s.room)}</span><span>${timeRange(s)}</span></div>
        <h3>${esc(s.title)}</h3>${marks(s)}
      </div>${starBtn(s, ms.has(s.key))}</div>`;
  }).join('');
  const count = liveCount ? `${liveCount} on now` : `${list.length} today`;
  return `<details class="allday"${allDayOpen ? ' open' : ''}><summary>Villages<span class="count">${count}</span>${CHEV}</summary>${rows}</details>`;
}

// Empty states say why it is empty and offer the one action that fixes it.
function emptyState(c) {
  if (mode === 'mine' && !c.ms.size) {
    return '<div class="empty"><h2>No stars yet</h2><p>Tap the star on any talk to build your own day.</p><button class="btn ghost" type="button" data-mode="all">Show everyone</button></div>';
  }
  const fixes = [];
  if (rooms.length) fixes.push('<button class="btn ghost" type="button" data-act="clearrooms">Show all stages</button>');
  if (mode !== 'all') fixes.push('<button class="btn ghost" type="button" data-mode="all">Show everyone</button>');
  const why = rooms.length && mode !== 'all' ? 'your stage filter and view' : rooms.length ? 'your stage filter' : mode === 'mine' ? 'your stars' : '';
  const when = view === 'now' ? 'for the rest of today' : 'on this day';
  const msg = why ? `Nothing matches ${why} ${when}.` : `Nothing else is on ${when === 'on this day' ? 'this day' : 'today'}.`;
  return `<div class="empty"><h2>Nothing here</h2><p>${msg}</p>${fixes.join(' ')}</div>`;
}

const lastEnd = () => Math.max(0, ...sessions.filter((s) => !s.isBreak && s.kind !== 'event').map((s) => s.end));
const confDays = () => [...new Set(sessions.filter((s) => s.kind === 'talk').map((s) => s.day))].sort();

function clashBanner(c) {
  const n = c.cl.upcoming;
  if (!n) return '';
  return `<button class="banner warn" type="button" data-view="plan">${n} ${n === 1 ? 'clash' : 'clashes'} in your plan. Tap to review.</button>`;
}

function renderNow(c) {
  const { t } = c, dk = dayOf(t), cd = confDays(), di = cd.indexOf(dk);
  let h = `<p class="clock">${hm(t)}</p><p class="today">San Francisco, ${esc(fLong.format(t))}${di >= 0 ? `, day ${di + 1} of ${cd.length}` : ''}</p>`;

  const firstTalk = sessions.find((s) => s.kind === 'talk');
  if (firstTalk && t < firstTalk.start) {
    h += `<div class="banner">Day 1 starts in ${span(Math.round((firstTalk.start - t) / 60000))}</div>`;
  }
  h += clashBanner(c);
  const brk = sessions.find((s) => s.isBreak && s.start <= t && t < s.end);
  if (brk && mode === 'all') h += `<div class="banner">${esc(brk.title)} until ${hm(brk.end)}</div>`;

  const live = sessions.filter((s) => !s.isBreak && s.start <= t && t < s.end && visible(s, c));
  const longLive = live.filter((s) => s.long), talks = live.filter((s) => !s.long);
  h += allDay(longLive, c);
  if (talks.length) h += '<h2 class="sec">On now</h2>' + talks.map((s) => card(s, c, { progress: true })).join('');

  const later = sessions.filter((s) => !s.isBreak && !s.long && s.start > t && visible(s, c));
  const today = later.filter((s) => s.day === dk);
  if (today.length) {
    // Only look a short way ahead: the next hour, or 15 min past the earliest upcoming start if that is later.
    const horizon = Math.max(t + 60 * 60000, today[0].start + 15 * 60000);
    const seen = new Set(), next = [];
    for (const s of today) {
      if (s.start > horizon) break;                 // list is sorted by start time
      if (!seen.has(s.track)) { seen.add(s.track); next.push(s); }
    }
    h += '<h2 class="sec">Up next</h2>' + next.map((s) => card(s, c, { soon: true })).join('');
  } else if (!talks.length) {
    const first = later[0];
    if (first) {
      const slot = later.filter((s) => s.start - first.start < 5 * 60000);
      h += `<h2 class="sec">Next up, ${esc(shortDay(first.start))} at ${hm(first.start)}</h2>` + slot.map((s) => card(s, c)).join('');
    } else if (t >= lastEnd()) {
      h += '<div class="empty"><h2>That’s a wrap</h2><p>[un]prompted II is over. Your stars, notes and ratings are in My plan.</p></div>';
    } else if (!longLive.length) {
      h += emptyState(c);
    }
  }
  return h;
}

function renderSchedule(c) {
  const list = sessions.filter((s) => s.day === day);
  let h = clashBanner(c) + allDay(list.filter((s) => s.long && visible(s, c)), c);
  let rest = list.filter((s) => !s.long && visible(s, c));
  if (!rest.some((s) => !s.isBreak)) return h || emptyState(c);
  // The same break appears once per stage. Show it once, and only when there is a talk before and after it.
  const talks = rest.filter((s) => !s.isBreak), seenBrk = new Set();
  rest = rest.filter((s) => {
    if (!s.isBreak) return true;
    const k = `${s.title}|${s.start}|${s.end}`;
    if (seenBrk.has(k)) return false;
    seenBrk.add(k);
    return talks.some((x) => x.start < s.start) && talks.some((x) => x.start >= s.end);
  });
  let cur = null;
  for (const s of rest) {
    if (s.isBreak) { h += `<div class="brk">${hm(s.start)} ${esc(s.title)}</div>`; continue; }
    if (s.start !== cur) { cur = s.start; h += `<h2 class="slot" data-start="${s.start}">${hm(s.start)}</h2>`; }
    h += card(s, c);
  }
  return h;
}

function renderSearch(c) {
  const toks = tokens();
  const res = sessions.filter((s) => !s.isBreak && visible(s, c, true) && matches(s, toks));
  const scope = mode === 'mine' ? ' in your stars' : '';
  let h = !res.length ? '' : `<p class="note">${res.length} ${res.length === 1 ? 'result' : 'results'} across all days${scope}${rooms.length ? '. Stage filters are paused while you search' : ''}.</p>`;
  if (!res.length) {
    const widen = mode !== 'all' ? '<button class="btn ghost" type="button" data-mode="all">Search everyone</button> ' : '';
    return h + `<div class="empty"><h2>No matches</h2><p>Nothing matches “${esc(query)}”. Try one word from the title or a speaker’s first name.</p>${widen}<button class="btn ghost" type="button" data-act="clearsearch">Clear search</button></div>`;
  }
  let cur = null;
  for (const s of res) {
    if (s.day !== cur) { cur = s.day; h += `<h2 class="dayhead">${esc(fLong.format(s.start))}</h2>`; }
    h += card(s, c, { toks });
  }
  return h;
}

function renderPlan(c) {
  const starred = sessions.filter((s) => c.ms.has(s.key) && !s.isBreak);
  const flagged = sessions.filter((s) => wtt[s.key] && !s.isBreak);
  let h = '';
  if (!starred.length && !flagged.length) {
    h += '<div class="empty"><h2>No stars yet</h2><p>Tap the star on any talk to build your plan. Clashes, notes and ratings show up here.</p><button class="btn warm" type="button" data-view="schedule">Browse the schedule</button></div>';
  } else {
    const n = c.cl.pairs.length;
    if (n) h += `<div class="banner warn">${n} ${n === 1 ? 'clash' : 'clashes'} in your plan. The clashing talks are outlined below.</div>`;
    let cur = null;
    for (const s of starred) {
      if (s.day !== cur) { cur = s.day; h += `<h2 class="dayhead">${esc(fLong.format(s.start))}</h2>`; }
      h += card(s, c);
    }
    // Starred talks already show their "Want to talk to" mark, so list only the ones not starred.
    const flaggedOnly = flagged.filter((s) => !c.ms.has(s.key));
    if (flaggedOnly.length) h += '<h2 class="sec">Want to talk to</h2>' + flaggedOnly.map((s) => card(s, c)).join('');
  }
  const gen = DATA && DATA.generated ? new Date(DATA.generated) : null;
  const when = gen && !isNaN(gen) ? ` Snapshot taken ${esc(shortDay(gen))}.` : '';
  h += `<section class="panel" style="margin-top:22px"><h2>About this schedule</h2>
    <p class="muted">Agenda from <a href="${esc(DATA.conference.source)}" target="_blank" rel="noopener">unpromptedcon.org</a>.${when} All times are San Francisco time.</p>
    <p class="muted">Stars, notes and ratings stay on this phone. Clearing the site’s data in Chrome removes them.</p></section>`;
  return h;
}

/* ---------- Header: status, switch, chips, days ---------- */
function renderChrome() {
  const c = context(), t = c.t;
  const onNow = sessions.some((s) => !s.isBreak && s.kind !== 'event' && s.start <= t && t < s.end);
  $('#status').innerHTML = `<i class="dot ${onNow ? 'ok' : ''}"></i><span>SF ${hm(t)}</span>`;
  document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));

  $('#filters').hidden = view === 'plan';
  const segs = [['all', 'Everyone', null], ['mine', 'Mine', c.ms.size || null]];
  $('#seg').innerHTML = segs.map(([m, l, n]) =>
    `<button type="button" data-mode="${m}" aria-pressed="${mode === m}">${l}${n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('');
  $('#chips').innerHTML = presentRooms.map((id) =>
    `<button class="chip" type="button" data-room="${esc(id)}" aria-pressed="${rooms.includes(id)}">${esc(ROOMS.get(id))}</button>`).join('');

  const days = $('#days');
  days.hidden = view !== 'schedule';
  days.classList.toggle('dim', !!query);
  days.innerHTML = DAYS.map((d) =>
    `<button class="day" type="button" data-day="${d}" aria-pressed="${!query && d === day}">${esc(fTab.format(noon(d)))}</button>`).join('');
  measureChrome();
}

function renderView() {
  const c = context();
  $('#view').innerHTML = view !== 'plan' && query ? renderSearch(c) : view === 'now' ? renderNow(c) : view === 'schedule' ? renderSchedule(c) : renderPlan(c);
}
function render() { renderChrome(); renderView(); }

/* =====================================================================
   5. COLLAPSING HEADER AND SCROLLING
   Scrolling down slides the brand, search and filters away (the day tabs stay).
   Scrolling up brings them back, like Safari's toolbar.
   ===================================================================== */
const root = document.documentElement;
let collapsed = false, lastY = 0, acc = 0, quietUntil = 0;
function measureChrome() {
  const ch = $('#chrome'), days = $('#days');
  const h = ch.offsetHeight, keep = $('.notch').offsetHeight + (days.hidden ? 0 : days.offsetHeight);
  root.style.setProperty('--chrome-h', h + 'px');
  root.style.setProperty('--keep-h', keep + 'px');
  root.style.setProperty('--hide', Math.max(0, h - keep - 1) + 'px');
}
function setCollapsed(v) { if (v !== collapsed) { collapsed = v; $('#chrome').classList.toggle('collapsed', v); } }
function jumpTo(y) {
  quietUntil = Date.now() + 500; setCollapsed(false);
  window.scrollTo(0, Math.max(0, y)); lastY = Math.max(0, y); acc = 0;
}
addEventListener('scroll', () => {
  const y = Math.max(0, window.scrollY), dy = y - lastY; lastY = y;
  if (Date.now() < quietUntil) return;
  if (y < 24) { setCollapsed(false); acc = 0; return; }
  if (document.activeElement === $('#q') || document.querySelector('dialog[open]')) return;
  if (Math.sign(dy) !== Math.sign(acc)) acc = 0;
  acc += dy;
  if (acc > 28) setCollapsed(true); else if (acc < -28) setCollapsed(false);
}, { passive: true });
new ResizeObserver(measureChrome).observe($('#chrome'));

// Put the current time slot just under the header on today's schedule.
function scrollToNow() {
  if (view !== 'schedule' || query || day !== dayOf(now())) return jumpTo(0);
  const t = now(); let target = null;
  document.querySelectorAll('.slot').forEach((h) => { if (+h.dataset.start <= t) target = h; });
  if (!target) return jumpTo(0);
  jumpTo(target.getBoundingClientRect().top + window.scrollY - $('#chrome').offsetHeight - 8);
}

/* =====================================================================
   6. DETAILS SHEET
   ===================================================================== */
const paras = (list) => list.map((p) => `<p>${esc(p)}</p>`).join('');
let sheetPushed = false, dirty = false;

// One speaker in the details sheet: name, role as published, their other sessions, and a web search link.
// The agenda page publishes only name and role, so there are no bios or profile links to show.
function personCard(p, from) {
  const also = sessions
    .filter((x) => x.key !== from.key && x.kind !== 'break' && x.names.includes(p.name))
    .sort((a, b) => a.start - b.start);
  const list = also.length
    ? `<div class="also"><em>Also speaking</em>${also.map((x) => `<button type="button" data-open="${esc(x.key)}">${esc(shortDay(x.start))}, ${esc(timeRange(x))} <b>${esc(x.room)}</b><span>${esc(short(x.title, 60))}</span></button>`).join('')}</div>`
    : '';
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(`${p.name} ${p.role}`.trim());
  return `<div class="person"><strong>${esc(p.name)}</strong>${list}<a class="look" href="${esc(url)}" target="_blank" rel="noopener">Look up ${esc(p.name.split(' ')[0])} on the web</a></div>`;
}

function openDetail(key, toTop) {
  const s = byKey.get(key); if (!s) return;
  const c = context(), on = c.ms.has(key), w = !!wtt[key], r = ratings[key] || 0;
  const others = c.cl.map.get(key);
  const alert = others ? `<div class="alert">Clashes with ${others.map((o) => `${esc(o.title)} (${esc(o.room)}, ${esc(timeRange(o))})`).join('; ')}</div>` : '';
  const people = s.speakers.map((p) => personCard(p, s)).join('');
  const venue = s.kind === 'event' ? `<div class="venue"><p><strong>${esc(s.venue)}</strong></p><p class="muted">${esc(s.address)}</p>${s.maps ? `<p><a href="${esc(s.maps)}" target="_blank" rel="noopener">Open in Maps</a></p>` : ''}</div>` : '';
  const body = s.abstract.length ? paras(s.abstract) : (s.kind === 'event' || s.kind === 'village' ? '' : '<p class="muted">No description published yet.</p>');
  const stars = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="${n <= r ? 'lit' : ''}" data-rate="${n}" aria-label="Rate ${n} of 5">${STAR}</button>`).join('');
  const inner = $('#detailInner'), y = inner.scrollTop;
  inner.innerHTML = `<button class="x" type="button" data-close aria-label="Close">×</button>
    <div class="meta"><span>${esc(shortDay(s.start))}, ${esc(timeRange(s))}</span><span class="room">${esc(s.room)}</span></div>
    <h2>${esc(s.title)}</h2>
    ${s.speakers.length ? `<div class="who">${s.speakers.map((p) => `<p><strong>${esc(p.name)}</strong>${p.role ? esc(', ' + p.role) : ''}</p>`).join('')}</div>` : ''}
    <div class="actions">
      <button class="btn ${on ? 'ghost' : 'warm'}" type="button" data-star="${esc(key)}" aria-pressed="${on}">${on ? STAR : STAR_O}${on ? 'Starred' : 'Star this'}</button>
      <button class="btn ghost" type="button" data-wtt="${esc(key)}" aria-pressed="${w}" style="${w ? 'border-color:var(--live);color:var(--live)' : ''}">${CHAT}${w ? 'Want to talk to' : 'Want to talk to?'}</button>
    </div>
    ${alert}
    <div class="mynotes" data-k="${esc(key)}">
      <h3>Your notes</h3>
      <textarea id="note" rows="3" placeholder="Jot something down" aria-label="Your notes">${esc(notes[key] || '')}</textarea>
      <label>Rating</label><div class="rate" role="group" aria-label="Rating">${stars}</div>
      <label for="take">Key takeaway in one line</label>
      <input id="take" type="text" value="${esc(takes[key] || '')}" placeholder="What will you remember?" style="margin-bottom:8px">
    </div>
    <div class="body" style="margin-top:14px">${body}</div>
    ${s.speakers.length ? `<h3>${s.speakers.length > 1 ? 'Speakers' : 'Speaker'}</h3>${people}` : ''}
    ${venue}`;
  const d = $('#detail'); d.dataset.key = key;
  if (!d.open) {
    d.showModal();
    // Chrome's back button should close the sheet, not leave the app.
    history.pushState({ sheet: 1 }, ''); sheetPushed = true;
    inner.scrollTop = 0;
  } else inner.scrollTop = toTop ? 0 : y;
}

function toggleStar(key) {
  const s = byKey.get(key); if (!s) return;
  if (mine[key]) { delete mine[key]; } else {
    mine[key] = true;
    const c = context(), o = c.cl.map.get(key);
    if (o) toast(`Clashes with ${short(o[0].title, 34)}`);
  }
  store.set('bm', mine);
  if (navigator.vibrate) navigator.vibrate(8);
  render();
  if ($('#detail').open && $('#detail').dataset.key === key) { dirty = true; openDetail(key); }
}

function toggleWtt(key) {
  if (wtt[key]) delete wtt[key]; else wtt[key] = true;
  store.set('wtt', wtt);
  if (navigator.vibrate) navigator.vibrate(8);
  render();
  if ($('#detail').open && $('#detail').dataset.key === key) { dirty = true; openDetail(key); }
}

function setRooms(next) {
  rooms = next.length === presentRooms.length ? [] : next;
  store.set('rooms', rooms); render();
}
function toggleRoom(id) {
  const sel = new Set(rooms);
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  setRooms([...sel]);
}

/* =====================================================================
   7. EVENTS AND START-UP
   ===================================================================== */
const q = $('#q');
function clearSearch() {
  q.value = ''; query = ''; $('.qclear').hidden = true;
  render(); scrollToNow();
}
q.addEventListener('input', () => {
  query = q.value.trim(); $('.qclear').hidden = !q.value;
  renderChrome(); renderView(); jumpTo(0);
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); q.blur(); }      // dismiss the keyboard, keep results
  if (e.key === 'Escape') clearSearch();
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-star],[data-wtt],[data-open],[data-view],[data-day],[data-mode],[data-room],[data-act],[data-close],[data-rate],#status');
  if (!el) {
    if (e.target.matches('dialog.sheet')) e.target.close();      // tap on the backdrop
    return;
  }
  if (el.dataset.star) return toggleStar(el.dataset.star);
  if (el.dataset.wtt) return toggleWtt(el.dataset.wtt);
  if (el.dataset.open) return openDetail(el.dataset.open, !!el.closest('dialog'));
  if (el.dataset.rate) {
    const key = el.closest('.mynotes').dataset.k, n = +el.dataset.rate;
    if (ratings[key] === n) delete ratings[key]; else ratings[key] = n;     // tap the same star again to clear
    store.set('r', ratings); dirty = true;
    el.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('lit', +b.dataset.rate <= (ratings[key] || 0)));
    return;
  }
  if (el.dataset.view) {
    view = el.dataset.view; store.set('view', view);
    if (view === 'plan' && query) { q.value = ''; query = ''; $('.qclear').hidden = true; }
    render(); scrollToNow(); return;
  }
  if (el.dataset.day) {
    if (query) { q.value = ''; query = ''; $('.qclear').hidden = true; }
    day = el.dataset.day; render(); scrollToNow(); return;
  }
  if (el.dataset.mode) { mode = el.dataset.mode; store.set('mode', mode); render(); if (!query) scrollToNow(); return; }
  if (el.dataset.room) { toggleRoom(el.dataset.room); if (!query) scrollToNow(); return; }
  if (el.hasAttribute('data-close')) return el.closest('dialog').close();
  if (el.id === 'status') { view = 'now'; store.set('view', view); render(); jumpTo(0); return; }
  if (el.dataset.act === 'clearsearch') return clearSearch();
  if (el.dataset.act === 'clearrooms') { setRooms([]); if (!query) scrollToNow(); }
});

// Typing in notes or the takeaway saves straight away. The list behind the sheet refreshes when it closes.
document.addEventListener('input', (e) => {
  const box = e.target.closest && e.target.closest('.mynotes'); if (!box) return;
  const key = box.dataset.k;
  if (e.target.id === 'note') { notes[key] = e.target.value; if (!notes[key]) delete notes[key]; store.set('n', notes); dirty = true; }
  if (e.target.id === 'take') { takes[key] = e.target.value; if (!takes[key]) delete takes[key]; store.set('tk', takes); dirty = true; }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.open) { e.preventDefault(); openDetail(e.target.dataset.open); }
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details.allday')) { allDayOpen = e.target.open; store.set('allday', allDayOpen); }
}, true);

// Sheet and the browser's back button.
const sheet = $('#detail');
sheet.addEventListener('close', () => {
  if (sheetPushed) { sheetPushed = false; history.back(); }
  if (dirty) { dirty = false; render(); }
});
window.addEventListener('popstate', () => { if (sheet.open) { sheetPushed = false; sheet.close(); } });

// Touch: dismiss the keyboard when you start scrolling results, and swipe left or right to change day.
let sx = 0, sy = 0, st = 0;
$('#view').addEventListener('touchstart', (e) => {
  if (document.activeElement === q) q.blur();
  const p = e.touches[0]; sx = p.clientX; sy = p.clientY; st = Date.now();
}, { passive: true });
$('#view').addEventListener('touchend', (e) => {
  if (view !== 'schedule' || query) return;
  const p = e.changedTouches[0], dx = p.clientX - sx, dy = p.clientY - sy;
  if (Math.abs(dx) < 70 || Math.abs(dy) > 45 || Date.now() - st > 600) return;
  const i = DAYS.indexOf(day) + (dx < 0 ? 1 : -1);
  if (i < 0 || i >= DAYS.length) return;
  day = DAYS[i]; render(); scrollToNow();
}, { passive: true });

function tick() {
  if (document.visibilityState !== 'visible' || sheet.open) return;
  renderChrome(); renderView();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
window.addEventListener('resize', measureChrome);

(async function start() {
  let data = null;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch { /* handled below */ }
  if (!data) {
    $('#view').innerHTML = '<div class="empty"><h2>Couldn’t load the schedule</h2><p>Check your connection and reload. Once it has loaded once, it works offline.</p></div>';
    return;
  }
  setSessions(data);
  const today = dayOf(now());
  day = DAYS.includes(today) ? today : (confDays()[0] || DAYS[0]);
  render();
  scrollToNow();
  setInterval(tick, 30000);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    if (document.readyState === 'complete') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

})();
