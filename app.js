/* [un]prompted II companion app.
 *
 * Reading guide:
 *   1. helpers and storage        (esc, store)
 *   2. time                       (sfNow: current San Francisco time)
 *   3. loading + preparing data   (agenda.json -> ITEMS, DAYS)
 *   4. clash detection
 *   5. rendering                  (strip, controls, session cards)
 *   6. events                     (taps, typing, timers)
 *
 * Everything you save (bookmarks, notes, ratings) lives in this browser's localStorage.
 * Nothing leaves the device. Items are keyed by their `id` from agenda.json, which is
 * built from day + stage + start time, so your saves survive a refreshed schedule.
 */
(() => {
'use strict';

/* ---------- 1. helpers and storage ---------- */

const TZ = 'America/Los_Angeles';
const $ = (s) => document.querySelector(s);

// Everything from the agenda goes through esc() before it touches innerHTML.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// localStorage can throw (private tabs, blocked storage), so keep an in-memory copy as a fallback.
const mem = {};
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('upsf26-' + k); return v ? JSON.parse(v) : (k in mem ? mem[k] : d); }
    catch { return k in mem ? mem[k] : d; }
  },
  set(k, v) { mem[k] = v; try { localStorage.setItem('upsf26-' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const bm = store.get('bm', {});        // bookmarks:       { id: true }
const wtt = store.get('wtt', {});      // "want to talk to": { id: true }
const notes = store.get('n', {});      // notes:           { id: "text" }
const ratings = store.get('r', {});    // star ratings:    { id: 1..5 }
const takes = store.get('tk', {});     // one-line takeaway: { id: "text" }
const ui = Object.assign({ day: null, filter: 'all', view: 'day' }, store.get('ui', {}));
// view: 'day' = one day, 'bm' = bookmarked across all days, 'wtt' = want-to-talk-to across all days

let q = '';                            // search text (lower case)
const open = new Set();                // ids of expanded cards, so re-renders keep them open

const ICO = {
  star: '<svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9-6.2-3.3-6.2 3.3 1.2-6.9-5-4.9 6.9-1z"/></svg>',
  chat: '<svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.38 8.5 8.5 0 0 1-4-1L3 20l1.12-5.5a8.38 8.38 0 0 1-1-4A8.38 8.38 0 0 1 11.5 3a8.5 8.5 0 0 1 9.5 8.5Z"/></svg>',
  chev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  pin: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  warn: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m10.3 3.9-8.2 14A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-3.1l-8.2-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  down: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
};

/* ---------- 2. time ---------- */

// "Minutes since midnight" for 'HH:MM'.
const toMin = (t) => { const [h, m] = t.split(':'); return +h * 60 + +m; };
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
// A date + minute-of-day as one number (minutes), handy for "how long until" sums.
const absMin = (date, min) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) / 60000 + min; };

// The current time in San Francisco, whatever time zone the phone is in.
// Add ?now=2026-10-27T10:05 to the URL to pretend it is that San Francisco time (for previewing).
function sfNow() {
  const o = new URLSearchParams(location.search).get('now');
  const m = o && o.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return { date: m[1], min: +m[2] * 60 + +m[3] };
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { wd: WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], d, mon: MO[m - 1] };
}
const dayShort = (iso) => { const p = dayParts(iso); return `${p.wd} ${p.d}`; };
const dayLong = (iso) => { const p = dayParts(iso); return `${p.wd} ${p.d} ${p.mon}`; };

function span(mins) {
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

/* ---------- 3. loading + preparing data ---------- */

let DATA = null, ITEMS = [], DAYS = [], TRACKS = {}, ORDER = [];

const TRACK_CLASS = { 'stage-1': 's1', 'stage-2': 's2', villages: 'vil', evening: 'eve' };
const trackName = (id) => (TRACKS[id] && TRACKS[id].name) || id;
const trackCls = (id) => TRACK_CLASS[id] || 's1';

async function load() {
  try {
    const res = await fetch('data/agenda.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch { return null; }
}

function prepare(data) {
  DATA = data;
  data.tracks.forEach((t) => { TRACKS[t.id] = t; ORDER.push(t.id); });
  ITEMS = data.items.map((it) => {
    const s = toMin(it.start), e = toMin(it.end);
    const ok = e > s;                                  // a few published end times are typos
    const text = [it.title, trackName(it.track), it.venue, it.address,
      ...it.speakers.map((p) => `${p.name} ${p.role}`), ...it.abstract].join(' ').toLowerCase();
    return Object.assign({}, it, { s, e: ok ? e : s, ok, tr: ORDER.indexOf(it.track), text });
  }).sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s || a.tr - b.tr);

  DAYS = [...new Set(ITEMS.map((i) => i.date))].sort().map((iso) => ({
    iso, n: ITEMS.filter((i) => i.date === iso && i.kind !== 'break').length,
  }));

  // Open on today if it is a conference day (San Francisco date), otherwise the first full day.
  const today = sfNow().date;
  if (DAYS.some((d) => d.iso === today)) ui.day = today;
  else if (!DAYS.some((d) => d.iso === ui.day)) {
    const first = DAYS.find((d) => ITEMS.some((i) => i.date === d.iso && i.kind === 'talk'));
    ui.day = (first || DAYS[0]).iso;
  }
}

const byId = (id) => ITEMS.find((i) => i.id === id);
const picks = () => ITEMS.filter((i) => bm[i.id]);
const count = (o) => ITEMS.filter((i) => o[i.id]).length;

/* ---------- 4. clash detection ---------- */

// Breaks do not clash. Villages (CTF etc.) are drop-in all day, so they never count either.
const clashable = (i) => i.kind !== 'break' && i.kind !== 'village';
const overlap = (a, b) => a.date === b.date && a.s < b.e && b.s < a.e;

// For each bookmarked, clashable item: the other bookmarked items it overlaps.
function clashes() {
  const list = picks().filter(clashable), map = {};
  let pairs = 0;
  for (let x = 0; x < list.length; x++) {
    for (let y = x + 1; y < list.length; y++) {
      if (overlap(list[x], list[y])) {
        (map[list[x].id] = map[list[x].id] || []).push(list[y]);
        (map[list[y].id] = map[list[y].id] || []).push(list[x]);
        pairs++;
      }
    }
  }
  return { map, pairs };
}

/* ---------- 5. rendering ---------- */

const short = (t, n = 38) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

const initials = (name) => {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w[0] || '')[0] || '') + (w.length > 1 ? w[w.length - 1][0] : '');
};

function matches(i) {
  if (!q) return true;
  const hay = `${i.text} ${notes[i.id] || ''} ${takes[i.id] || ''}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

// Which items to show for the current day / filter / view / search.
function visible() {
  let list = ITEMS;
  const searching = q.length > 0;
  if (ui.view === 'bm') list = list.filter((i) => bm[i.id]);
  else if (ui.view === 'wtt') list = list.filter((i) => wtt[i.id]);
  else if (!searching) list = list.filter((i) => i.date === ui.day);
  if (ui.view === 'day' && ui.filter !== 'all') list = list.filter((i) => i.track === ui.filter);
  if (searching) list = list.filter((i) => i.kind !== 'break' && matches(i));
  if (ui.view !== 'day') list = list.filter((i) => i.kind !== 'break');
  return list;
}

// Group a day's items into blocks that share a start time. The same break on both stages shows once.
function blocks(items) {
  const out = [], seen = new Set();
  items.forEach((i) => {
    if (i.kind === 'break') {
      const key = `${i.title}|${i.s}|${i.e}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    let b = out[out.length - 1];
    if (!b || b.s !== i.s) { b = { s: i.s, e: 0, items: [] }; out.push(b); }
    b.items.push(i);
  });
  // Label end = earliest end among real sessions. A 3 hour village should not stretch a 25 minute slot.
  out.forEach((b) => {
    const pool = b.items.filter((i) => i.ok && i.kind !== 'village');
    const ends = (pool.length ? pool : b.items.filter((i) => i.ok)).map((i) => i.e);
    b.e = ends.length ? Math.min(...ends) : 0;
  });
  return out;
}

const liveKind = (i) => i.kind === 'talk' || i.kind === 'tbd' || i.kind === 'event';

function card(i, ctx, blockEnd) {
  const k = i.id;
  if (i.kind === 'break') {
    return `<article class="sess brk" data-k="${esc(k)}"><div class="sh"><div class="sbody"><div class="si">
      <span class="st">${esc(i.title)}</span></div></div></div></article>`;
  }
  const isOpen = open.has(k), on = !!bm[k], w = !!wtt[k], r = ratings[k] || 0;
  const live = ctx.now.date === i.date && i.s <= ctx.now.min && ctx.now.min < i.e && liveKind(i);
  const clash = ctx.clash.map[k];
  const names = i.speakers.map((p) => p.name).join(', ');
  const av = i.speakers.length ? `<span class="av" aria-hidden="true">${esc(initials(i.speakers[0].name))}</span>` : '';
  const sub = i.kind === 'event' ? esc(i.venue) : esc(names);
  // Show "25m" normally, or the full time range when this item is longer than its slot (villages, events).
  const dur = !i.ok ? '' : (i.e !== blockEnd || i.kind === 'village' || i.kind === 'event')
    ? `<span class="sd">${hm(i.s)}–${hm(i.e)}</span>` : `<span class="sd">${i.e - i.s}m</span>`;

  let hint = '';
  if (clash) {
    hint = `<div class="cl">${ICO.warn}<span>Clashes with ${clash.map((c) => `${esc(short(c.title))} (${esc(trackName(c.track))})`).join(', ')}</span></div>`;
  } else if (!on && clashable(i)) {
    const over = picks().filter((p) => clashable(p) && overlap(i, p));
    if (over.length) hint = `<div class="cl soft"><span>Overlaps your pick: ${over.map((c) => esc(short(c.title))).join(', ')}</span></div>`;
  }

  const people = i.speakers.map((p) => `<div class="sc"><span class="av" aria-hidden="true">${esc(initials(p.name))}</span>
    <div><h4>${esc(p.name)}</h4>${p.role ? `<div class="org">${esc(p.role)}</div>` : ''}</div></div>`).join('');
  const venue = i.kind === 'event'
    ? `<div class="venue"><strong>${esc(i.venue)}</strong><div>${esc(i.address)}</div>${i.maps ? `<a href="${esc(i.maps)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}</div>` : '';
  const abs = i.abstract.length ? `<div class="abs">${i.abstract.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
    : (!i.speakers.length && i.kind !== 'event' ? '<div class="empty-det">No description published yet.</div>' : '');
  const stars = [1, 2, 3, 4, 5].map((n) => `<button class="star ${n <= r ? 'lit' : ''}" type="button" data-n="${n}" aria-label="Rate ${n} of 5">${ICO.star}</button>`).join('');

  return `<article class="sess ${isOpen ? 'exp' : ''} ${live ? 'is-now' : ''} ${clash ? 'clash' : ''}" data-k="${esc(k)}">
  <div class="sh">
    <button class="sbody" type="button" aria-expanded="${isOpen}">${av}<span class="si">
      <span class="st">${esc(i.title)}</span>
      <span class="sm">${sub ? `<span class="sp">${sub}</span>` : ''}<span class="stp ${trackCls(i.track)}">${esc(trackName(i.track))}</span>${dur}</span>
      ${hint}</span></button>
    <div class="sr">
      <button class="abtn wtt ${w ? 'on' : ''}" type="button" data-a="wtt" aria-pressed="${w}" aria-label="Want to talk to">${ICO.chat}</button>
      <button class="abtn bm ${on ? 'on' : ''}" type="button" data-a="bm" aria-pressed="${on}" aria-label="Bookmark">${ICO.star}</button>
      <span class="chv">${ICO.chev}</span>
    </div>
  </div>
  <div class="det"><div class="det-in" ${isOpen ? '' : 'inert'}>
    ${venue}${people}${abs}
    <div class="nts"><label for="n-${esc(k)}">Notes</label><textarea id="n-${esc(k)}" class="nta" rows="2" placeholder="Jot something down">${esc(notes[k] || '')}</textarea></div>
    <div class="rating"><label>Rating</label><div class="stars">${stars}</div>
      <input class="tki" type="text" placeholder="Key takeaway in one line" aria-label="Key takeaway" value="${esc(takes[k] || '')}"></div>
  </div></div>
</article>`;
}

function renderMain() {
  const main = $('#main');
  const list = visible();
  const searching = q.length > 0, multi = searching || ui.view !== 'day';
  if (!list.length) {
    const msg = searching ? `Nothing matches “${esc(q)}”.`
      : ui.view === 'bm' ? 'No bookmarks yet. Tap the star on a session to add it.'
        : ui.view === 'wtt' ? 'Nobody on your list yet. Tap the chat icon on a talk to flag someone you want to meet.'
          : 'No sessions to show.';
    main.innerHTML = `<div class="no-r">${msg}</div>`;
    setFab(null);
    return;
  }

  const now = sfNow(), cl = clashes(), ctx = { now, clash: cl };
  const today = list.filter((i) => i.date === now.date && liveKind(i));
  const nextStart = today.filter((i) => i.s > now.min).reduce((m, i) => Math.min(m, i.s), Infinity);
  let anchor = null;

  const dates = [...new Set(list.map((i) => i.date))].sort();
  main.innerHTML = dates.map((date) => {
    const dayItems = list.filter((i) => i.date === date);
    let html = multi ? `<h2 class="dhd">${esc(dayLong(date))}</h2>` : '';
    // Notes such as "Stage 2 opens at 9:25", only for what is on screen.
    const lines = [...new Set(dayItems.map((i) => i.track))].map((t) => {
      const n = (DATA.trackNotes || {})[`${date}|${t}`];
      return n ? (n.toLowerCase().startsWith(trackName(t).toLowerCase()) ? n : `${trackName(t)}: ${n.charAt(0).toLowerCase()}${n.slice(1)}`) : '';
    }).filter(Boolean);
    if (lines.length && !multi) html += `<p class="note-line">${esc(lines.join('  ·  '))}</p>`;

    html += blocks(dayItems).map((b) => {
      const talks = b.items.filter(liveKind);
      const isNow = date === now.date && talks.some((i) => i.s <= now.min && now.min < i.e);
      const isNext = date === now.date && talks.length && b.s === nextStart;
      const badge = (isNow ? '<span class="badge now">NOW</span>' : '') + (isNext ? '<span class="badge nxt">UP NEXT</span>' : '');
      const id = !anchor && (isNow || isNext) ? ' id="jump-blk"' : '';
      if (id) anchor = isNow ? 'now' : 'next';
      return `<section class="tblk"${id}><div class="tlbl">${hm(b.s)}${b.e ? '–' + hm(b.e) : ''} ${badge}</div>${b.items.map((i) => card(i, ctx, b.e)).join('')}</section>`;
    }).join('');
    return html;
  }).join('');
  setFab(anchor);
}

// The jump button hides itself while its target is already on screen, so it never covers a card's buttons.
let fabObs = null;
function setFab(kind) {
  const f = $('#fab');
  if (fabObs) { fabObs.disconnect(); fabObs = null; }
  f.hidden = true;
  const target = document.getElementById('jump-blk');
  if (!kind || !target) return;
  f.innerHTML = `${ICO.down} ${kind === 'now' ? 'Now' : 'Next'}`;
  if ('IntersectionObserver' in window) {
    fabObs = new IntersectionObserver(([en]) => { f.hidden = en.isIntersecting; });
    fabObs.observe(target);
  } else f.hidden = false;
}

function renderCtrl() {
  const searching = q.length > 0, dayMode = ui.view === 'day' && !searching;
  const bmC = count(bm), wtC = count(wtt);
  const tracks = DATA.tracks.filter((t) => t.id !== 'evening');
  $('#ctrl').innerHTML = `<div class="days" style="--n:${DAYS.length}" role="tablist" aria-label="Day">${DAYS.map((d) =>
    `<button class="dtab ${dayMode && d.iso === ui.day ? 'on' : ''}" type="button" role="tab" aria-selected="${dayMode && d.iso === ui.day}" data-day="${d.iso}">${esc(dayShort(d.iso))}<span class="ct">${d.n}</span></button>`).join('')}</div>
  <div class="filters">
    <button class="fbtn ${ui.view === 'day' && ui.filter === 'all' ? 'on' : ''}" type="button" data-f="all">All</button>
    ${tracks.map((t) => `<button class="fbtn ${ui.view === 'day' && ui.filter === t.id ? 'on' : ''}" type="button" data-f="${esc(t.id)}">${esc(t.name)}</button>`).join('')}
    <button class="fbtn bm ${ui.view === 'bm' ? 'on' : ''}" type="button" data-view="bm" aria-label="Bookmarked, ${bmC}">${ICO.star.replace('width="20" height="20"', 'width="15" height="15"')}<span>${bmC || ''}</span></button>
    <button class="fbtn wtt ${ui.view === 'wtt' ? 'on' : ''}" type="button" data-view="wtt" aria-label="Want to talk to, ${wtC}">${ICO.chat.replace('width="20" height="20"', 'width="15" height="15"')}<span>${wtC || ''}</span></button>
  </div>`;
}

function renderStrip() {
  const now = sfNow(), cl = clashes(), pills = [];
  if (cl.pairs) {
    pills.push(`<button class="pill warn" type="button" data-view="bm">${ICO.warn} ${cl.pairs} clash${cl.pairs > 1 ? 'es' : ''} in your picks</button>`);
  }
  pills.push(`<span class="pill">${ICO.pin} SF time <b>${hm(now.min)}</b></span>`);

  const firstTalk = ITEMS.find((i) => i.kind === 'talk');
  const last = ITEMS.filter((i) => i.kind !== 'event').slice(-1)[0];
  const nowAbs = absMin(now.date, now.min);
  if (firstTalk && nowAbs < absMin(firstTalk.date, firstTalk.s)) {
    pills.push(`<span class="pill">Opens in <b>${span(absMin(firstTalk.date, firstTalk.s) - nowAbs)}</b></span>`);
  } else if (last && nowAbs > absMin(last.date, last.e || last.s)) {
    pills.push('<span class="pill">That’s a wrap</span>');
  }
  const next = picks().filter(clashable).filter((i) => absMin(i.date, i.s) > nowAbs)
    .sort((a, b) => absMin(a.date, a.s) - absMin(b.date, b.s))[0];
  if (next) {
    pills.push(`<span class="pill">Next pick: ${esc(short(next.title, 26))} in <b>${span(absMin(next.date, next.s) - nowAbs)}</b></span>`);
  }
  $('#cdown').innerHTML = pills.join('');
}

function renderAll() { renderCtrl(); renderMain(); renderStrip(); setHdr(); }

function setHdr() {
  document.documentElement.style.setProperty('--hdr-h', $('#hdr').offsetHeight + 'px');
}

// Re-render but keep the page where it is and put keyboard focus back.
function rerender(focusSel) {
  const y = window.scrollY, main = $('#main');
  main.style.minHeight = main.offsetHeight + 'px';
  renderAll();
  main.style.minHeight = '';
  window.scrollTo(0, y);
  if (focusSel) { const el = document.querySelector(focusSel); if (el) el.focus({ preventScroll: true }); }
}

/* ---------- 6. events ---------- */

function bind() {
  const main = $('#main');

  // Taps inside the list: expand/collapse, bookmark, want-to-talk-to, star rating.
  main.addEventListener('click', (e) => {
    const cardEl = e.target.closest('.sess');
    if (!cardEl || cardEl.classList.contains('brk')) return;
    const k = cardEl.dataset.k;

    const act = e.target.closest('.abtn');
    if (act) {
      const store_ = act.dataset.a === 'bm' ? bm : wtt;
      store_[k] = !store_[k];
      if (!store_[k]) delete store_[k];
      store.set(act.dataset.a === 'bm' ? 'bm' : 'wtt', store_);
      if (navigator.vibrate) navigator.vibrate(8);
      rerender(`.sess[data-k="${CSS.escape(k)}"] .abtn[data-a="${act.dataset.a}"]`);
      return;
    }
    const star = e.target.closest('.star');
    if (star) {
      const n = +star.dataset.n;
      if (ratings[k] === n) delete ratings[k]; else ratings[k] = n;     // tap the same star again to clear
      store.set('r', ratings);
      cardEl.querySelectorAll('.star').forEach((s) => s.classList.toggle('lit', +s.dataset.n <= (ratings[k] || 0)));
      return;
    }
    if (e.target.closest('.sh')) {
      const isOpen = cardEl.classList.toggle('exp');
      if (isOpen) open.add(k); else open.delete(k);
      cardEl.querySelector('.sbody').setAttribute('aria-expanded', isOpen);
      cardEl.querySelector('.det-in').toggleAttribute('inert', !isOpen);
    }
  });

  // Typing in notes / takeaway saves straight away.
  main.addEventListener('input', (e) => {
    const k = e.target.closest('.sess') && e.target.closest('.sess').dataset.k;
    if (!k) return;
    if (e.target.classList.contains('nta')) { notes[k] = e.target.value; if (!notes[k]) delete notes[k]; store.set('n', notes); }
    if (e.target.classList.contains('tki')) { takes[k] = e.target.value; if (!takes[k]) delete takes[k]; store.set('tk', takes); }
  });

  // Day tabs and filter chips.
  $('#ctrl').addEventListener('click', (e) => {
    const d = e.target.closest('[data-day]'), f = e.target.closest('[data-f]'), v = e.target.closest('[data-view]');
    if (d) { ui.day = d.dataset.day; ui.view = 'day'; setQuery(''); }
    else if (f) { ui.filter = f.dataset.f; ui.view = 'day'; setQuery(''); }
    else if (v) { ui.view = ui.view === v.dataset.view ? 'day' : v.dataset.view; setQuery(''); }
    else return;
    store.set('ui', ui);
    renderAll();
    window.scrollTo(0, 0);
  });

  $('#cdown').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { ui.view = v.dataset.view; setQuery(''); store.set('ui', ui); renderAll(); window.scrollTo(0, 0); }
  });

  $('#q').addEventListener('input', (e) => {
    q = e.target.value.toLowerCase().trim();
    renderCtrl(); renderMain();
  });

  $('#fab').addEventListener('click', jump);
  window.addEventListener('resize', setHdr);
  window.addEventListener('orientationchange', () => setTimeout(setHdr, 150));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setInterval(tick, 30000);
}

function setQuery(v) { q = v; $('#q').value = v; }

function jump() {
  const el = document.getElementById('jump-blk');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Every 30 seconds: refresh the strip and the NOW / UP NEXT badges, unless you are typing.
function tick() {
  renderStrip();
  const a = document.activeElement;
  if (a && a.closest && a.closest('#main') && /^(TEXTAREA|INPUT)$/.test(a.tagName)) return;
  rerender();
}

/* ---------- start ---------- */

(async function init() {
  const data = await load();
  if (!data) {
    $('#main').innerHTML = '<div class="no-r">Couldn’t load the schedule.<br>Check your connection and reload.</div>';
    return;
  }
  prepare(data);
  bind();
  renderAll();
  const gen = DATA.generated ? new Date(DATA.generated) : null;
  const when = gen && !isNaN(gen) ? ` Snapshot taken ${gen.toISOString().slice(0, 10)}.` : '';
  $('#ftr').innerHTML = `Agenda from <a href="${esc(DATA.conference.source)}" target="_blank" rel="noopener">unpromptedcon.org</a>.${when}<br>Bookmarks, notes and ratings stay on this device. All times are San Francisco time.`;
  if (document.getElementById('jump-blk') && ui.view === 'day') setTimeout(jump, 400);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();

})();
