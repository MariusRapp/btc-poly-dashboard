// Order book card: a fixed price ladder, the mid line moves through it.

import { KALSHI_PROXY } from './kalshi.js';
import { mirrorBook } from './math.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtSz, roundSpan } from './util.js';
import { KS, PM, both, mainVenue } from './venues.js';

// ── Order book ladder: one row per price, the mid line moves through them ────
// The window only re-centres when the mid comes within LEDGE rows of an edge, and then scrolls there
// smoothly — a move shows as the line travelling, instead of every label changing under a fixed mid.
const LROWS = 16, LROW_H = 25, LEDGE = 3;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const lad = { feed: undefined, side: null, ver: -1, gen: 0, M: null, step: 0, T: null, target: null, drawn: '', pool: [] };

for (let k = 0; k <= LROWS; k++) {
  const el = document.createElement('div');
  el.className = 'lrow'; el.setAttribute('role', 'row'); el.hidden = true;
  el.innerHTML = '<i class="lbar"></i><span class="lp" role="cell"></span><span role="cell"></span><span class="lt" role="cell"></span>';
  $('lrows').appendChild(el);
  lad.pool.push({ el, bar: el.children[0], p: el.children[1], s: el.children[2], t: el.children[3], i: null, gen: -1 });
}

export function setBookView(v) {
  S.bookView = v;
  document.querySelectorAll('[data-book]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.book === v)));
}

// which venue's book the card shows: the one venue, or the one picked in the card with both on
const bookV = () => both() ? (S.bookVenue === 'kalshi' ? KS : PM) : mainVenue();
export function setBookVenue(v) {
  S.bookVenue = v;
  document.querySelectorAll('[data-bv]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.bv === v)));
}

export function setBookSide(s) {
  S.bookSide = s;
  document.querySelectorAll('[data-side]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.side === s)));
  $('ladder').setAttribute('aria-label', `Order book for ${s.toUpperCase()} shares`);
}

// rows indexed by price / tick (1¢, or 0.1¢ once the market uses 0.1¢ ticks); totals add up from the touch outwards
function ladderModel(f, down) {
  const unit = f.fine ? 1 : 10;
  // levels finer than the row (Kalshi's 0.1¢ steps far from the touch, on a 1¢ grid) add up into their row
  const side = (book, desc) => {
    const ks = Object.keys(book).map(Number).sort((a, b) => desc ? b - a : a - b), m = new Map();
    let cum = 0;
    for (const k of ks) { cum += book[k]; const i = Math.round(k / unit); m.set(i, { sz: (m.get(i)?.sz ?? 0) + book[k], cum }); }
    return { m, best: ks.length ? Math.round(ks[0] / unit) : null };
  };
  const b = side(down ? mirrorBook(f.asks) : f.bids, true), a = side(down ? mirrorBook(f.bids) : f.asks, false);
  const mid = b.best !== null && a.best !== null ? (b.best + a.best) / 2 : b.best ?? a.best;
  // bar scale and largest level from the levels around the mid, so they hold still while the window scrolls
  let maxSz = 1e-9, wallB = 0, wallA = 0;
  for (const [i, l] of b.m) if (Math.abs(i - mid) <= LROWS) { maxSz = Math.max(maxSz, l.sz); wallB = Math.max(wallB, l.sz); }
  for (const [i, l] of a.m) if (Math.abs(i - mid) <= LROWS) { maxSz = Math.max(maxSz, l.sz); wallA = Math.max(wallA, l.sz); }
  return { step: unit / 1000, maxI: 1000 / unit - 1, bids: b.m, asks: a.m, bb: b.best, ba: a.best, mid, maxSz, wallB, wallA };
}

function ladderMeta(f, M) {
  const both = M && M.bb !== null && M.ba !== null;
  $('lspread').textContent = both ? 'Spread ' + fmtC((M.ba - M.bb) * M.step) : 'Spread —';
  $('last-trade').textContent = f && f.last !== null ? 'Last ' + fmtC(S.bookSide === 'down' ? 1 - f.last : f.last) : 'Last —';
  $('lmid-tag').textContent = !M || M.mid === null ? '' :
    (both ? 'Mid ' : M.bb === null ? 'Ask ' : 'Bid ') + fmtC(M.mid * M.step, M.step < 0.01 ? 2 : 1);
}

// the line above the ladder: which round this book is, and a note while the charts show another round
S.lroundKey = '';
function ladderRound(V, f) {
  const ts = f ? f.wts : currentRound().start / 1000 + (S.bookView === 'next' ? ROUND_S : 0);
  const key = `${V.key}|${S.bookView}|${ts}|${f?.closed}|${S.review?.ts}|${ROUND_S}`;
  if (key === S.lroundKey) return;
  S.lroundKey = key;
  const el = $('lround'), span = roundSpan(ts), note = !!S.review && S.bookView === 'now' && !f?.closed;
  const pre = both() ? V.name + ' · ' : '';
  el.classList.toggle('note', note);
  if (note) el.innerHTML = `<b>${pre}Live round ${span}</b> — not the ${roundSpan(S.review.ts)} round in the charts. ` +
                           `${V.name} keeps no order book history, so past rounds have none.`;
  else el.textContent = pre + (f?.closed ? `Round ${span} ended`
                      : S.bookView !== 'next' ? `Live round · ${span}`
                      : V === KS ? `Next round · ${span} · not trading yet` : `Next round · ${span} · already trading`);
}

// runs every frame; touches the DOM only when the book changed or the window / mid line is moving.
// Returns whether it is still animating (the render loop keeps frames coming until it settles).
export function renderLadder(dt) {
  const V = bookV(), f = S.bookView === 'next' ? V.nxt : V.cur;
  ladderRound(V, f);
  if (f !== lad.feed || S.bookSide !== lad.side) {   // other book: jump to it instead of scrolling there
    lad.feed = f; lad.side = S.bookSide; lad.ver = -1; lad.M = null; lad.T = null; lad.target = null; ladderMeta(f, null);
  }
  if (f && f.ver !== lad.ver) { lad.ver = f.ver; lad.M = ladderModel(f, S.bookSide === 'down'); lad.gen++; ladderMeta(f, lad.M); }

  const M = lad.M, emptyEl = $('lempty');
  if (!M || M.mid === null) {
    const msg = V === KS && !KALSHI_PROXY ? 'Kalshi needs its proxy (see README)'
              : !f ? (S.bookView !== 'next' ? 'Waiting for market…' : V === KS ? 'Kalshi opens the next market when this round ends' : 'Next round not listed yet…')
              : f.closed ? 'Round over · loading the next market…' : 'Waiting for book…';
    if (lad.drawn !== msg) {
      lad.drawn = msg; emptyEl.textContent = msg; emptyEl.hidden = false; $('lmid').hidden = true;
      for (const r of lad.pool) r.el.hidden = true;
    }
    lad.T = null;
    return false;
  }

  if (lad.step !== M.step) { lad.step = M.step; lad.T = null; lad.target = null; }   // tick size changed: new grid
  const off = lad.target === null ? null : lad.target - M.mid;   // rows from the top edge down to the mid
  if (off === null || off < LEDGE || off > LROWS - LEDGE)
    lad.target = Math.max(LROWS + 0.5, Math.min(M.maxI + 0.5, Math.floor(M.mid + LROWS / 2) + 0.5));
  // The window scrolls here (rarely: only when the mid nears an edge). The mid line glides by a CSS transition,
  // so a busy book, whose mid moves many times a second, needs no animation frames.
  const jump = lad.T === null || reduceMotion.matches;
  if (jump) lad.T = lad.target;
  else {
    lad.T += (lad.target - lad.T) * (1 - Math.exp(-dt / 140));
    if (Math.abs(lad.target - lad.T) < 0.02) lad.T = lad.target;   // within half a pixel: done
  }
  const moving = lad.T !== lad.target;

  const key = `${lad.gen}|${lad.T}`;
  if (key === lad.drawn) return moving;
  lad.drawn = key;
  if (!emptyEl.hidden) emptyEl.hidden = true;

  // T = price index at the top edge; row i spans [i − ½, i + ½]
  const iTop = Math.ceil(lad.T + 0.5) - 1;
  for (let k = 0; k < lad.pool.length; k++) {
    const r = lad.pool[k], i = iTop - k, show = i >= 1 && i <= M.maxI;
    if (r.el.hidden === show) r.el.hidden = !show;
    if (!show) continue;
    r.el.style.transform = `translateY(${((lad.T - i - 0.5) * LROW_H).toFixed(1)}px)`;
    if (r.i === i && r.gen === lad.gen) continue;
    r.i = i; r.gen = lad.gen;
    const a = M.asks.get(i), b = a ? null : M.bids.get(i), l = a || b;
    const gap = !l && M.bb !== null && M.ba !== null && i > M.bb && i < M.ba;
    r.el.className = 'lrow' + (a ? ' ask' : b ? ' bid' : gap ? ' gap' : '');
    r.p.textContent = fmtC(i * M.step);
    if (l) {
      const wall = l.sz === (a ? M.wallA : M.wallB) && (a ? M.asks : M.bids).size > 1;
      r.bar.style.width = (l.sz / M.maxSz * 100).toFixed(1) + '%';
      r.s.textContent = fmtSz(l.sz); r.s.className = wall ? 'wall' : ''; r.s.title = wall ? 'Largest level' : '';
      r.t.textContent = fmtSz(l.cum);
    } else {
      r.bar.style.width = '0'; r.s.textContent = ''; r.s.className = ''; r.s.title = ''; r.t.textContent = '';
    }
  }
  const mk = $('lmid');
  mk.classList.toggle('instant', jump || mk.hidden);   // another book, or shown again: no glide from the old spot
  if (mk.hidden) mk.hidden = false;
  mk.style.transform = `translateY(${((lad.T - M.mid) * LROW_H).toFixed(1)}px)`;
  return moving;
}
