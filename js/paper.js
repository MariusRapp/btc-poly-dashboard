// Paper trades: buy UP or DOWN of the running round at the live book (best ask, deeper levels for bigger orders,
// taker fee included), without money, or with a limit order that waits at your price. Each trade keeps what the
// market (mid) and the model said at that moment; once the official result is in it is settled, so your own calls
// sit next to the market's and the model's. Stored in this browser (localStorage), all coins and markets in one
// list. The paper bot (bot.js) keeps its trades in a list of its own in the same format, with sales on top; both
// lists are settled here, together.
import { KS_FEE, PM_FEE } from './arb.js';
import { assetById, parseSeries, seriesId } from './assets.js';
import { KALSHI_PROXY } from './kalshi.js';
import { bookLevels, fillOrder, matchLimit, sellOrder } from './math.js';
import { computeModelProb } from './model.js';
import { clobResult } from './polymarket.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtClock, fmtHM, getJSON } from './util.js';
import { KS, PM, activeVenues, both, mainVenue } from './venues.js';

const QTY_KEY = 'paper-qty';
export const usd = x => (x < 0 ? '−⁠$' : '+⁠$') + Math.abs(x).toFixed(2);   // word joiner: the sign stays with the amount
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = x => x != null ? Math.round(x * 100) + '%' : '—';
const endOf = t => (t.start + parseSeries(t.series).len) * 1000;
export const pnlOf = (t, win) => +((win === t.side ? t.qty : 0) - t.total).toFixed(4);

// ── Lists of trades: the manual ones (this card) and the bot's, each stored in this browser ──
const ledgers = [];
export function makeLedger(key, max, onChange) {
  let trades = [];
  try { const t = JSON.parse(localStorage.getItem(key)); if (Array.isArray(t)) trades = t; } catch {}
  const L = { key, max, trades, onChange, open: [] };   // open: [trade, result cell] of the rows still changing
  ledgers.push(L);
  return L;
}
export function saveLedger(L) {
  if (L.trades.length > L.max) L.trades = L.trades.slice(-L.max);
  try { localStorage.setItem(L.key, JSON.stringify(L.trades)); } catch {}
}
const M = makeLedger('paper-v1', 500, () => render());

// ── The running round's books ────────────────────────────────────────────────
export const feeOf = V => V === KS ? KS_FEE : PM_FEE;
const lenOf = V => V === KS ? 15 : ROUND_S / 60;
export const liveFeed = V => { const f = V.cur; return f && !f.closed && f.wts * 1000 === currentRound().start ? f : null; };

// buy `n` shares at the asks (DOWN: the UP bids mirrored), level by level, none above `limit`
export function quoteBuy(V, side, n, limit = 1) {
  const f = liveFeed(V);
  if (!f) return null;
  const levels = side === 'up' ? bookLevels(f.asks, false) : bookLevels(f.bids, true, true);
  return fillOrder(levels.filter(l => l[0] <= limit + 1e-9), n, feeOf(V));
}
// sell `n` shares into the bids (DOWN: the UP asks mirrored)
export function quoteSell(V, side, n) {
  const f = liveFeed(V);
  return f && sellOrder(side === 'up' ? bookLevels(f.bids, true) : bookLevels(f.asks, false, true), n, feeOf(V));
}
// the venue in view whose running round a trade belongs to (null once the round is over, or for another market)
export function liveVenue(t) {
  for (const V of activeVenues()) if (seriesId(S.asset, V.key, lenOf(V)) === t.series && liveFeed(V)?.wts === t.start) return V;
  return null;
}

// what the market (mid) and the model say about a side right now, as a chance 0..1
function entryProbs(V, side) {
  const model = computeModelProb(), up = V.up;
  return { mkt: up !== null ? +((side === 'up' ? up : 100 - up) / 100).toFixed(4) : null,
           model: model !== null ? +((side === 'up' ? model : 100 - model) / 100).toFixed(4) : null };
}

// a trade filled now: what it cost, and what the market (mid) and the model said about its side at that moment
export function newTrade(V, side, q, now, extra = {}) {
  const f = V.cur;
  return {
    id: now.toString(36) + Math.random().toString(36).slice(2, 5), t: now, asset: S.asset, series: seriesId(S.asset, V.key, lenOf(V)), start: f.wts,
    side, qty: q.qty, avg: +q.avg.toFixed(4), fees: +q.fees.toFixed(4), total: +q.total.toFixed(4), left: Math.round((currentRound(now).end - now) / 1000),
    ...entryProbs(V, side),
    // the market's id, for the result lookup
    ...(V === KS ? { ticker: f.ticker } : { cid: f.cid }),
    result: null, ...extra,
  };
}

// the venue the buttons trade on: the one in view; with both venues, the one picked in the order book card
const tradeVenue = () => both() ? (S.bookVenue === 'kalshi' ? KS : PM) : mainVenue();
const qty = () => Math.max(1, Math.min(100000, Math.round(+$('paper-qty').value || 10)));
const marketOf = o => { const s = parseSeries(o.series); return `${assetById(o.asset).sym} ${s.venue === 'kalshi' ? 'Kalshi' : 'Poly'} ${s.len / 60}m`; };

function buy(side) {
  const V = tradeVenue(), q = quoteBuy(V, side, qty()), now = Date.now();
  if (!q || currentRound(now).end - now < 3000) return;
  M.trades.push(newTrade(V, side, q, now));
  saveLedger(M);
  render();
}

// ── Limit orders ─────────────────────────────────────────────────────────────
// A limit order buys at its price or less. What the asks already offer at or below it fills at once, like a market
// buy (taker fee); the rest waits until a seller comes down to the limit. A sell offer at the limit means no bid at
// that price is left ahead of the order, so it fills there, as a maker without fee, as many shares as are offered.
// The order isn't in the real book: sellers who would have hit it while it was the best bid go unseen, so paper
// fills come later and more rarely than real ones, if anything. It is checked 5× a second while its market is in
// view (main.js) and ends with its round.
const ORD_KEY = 'paper-orders-v1', TYPE_KEY = 'paper-type', SHOW_DONE = 180_000;   // ended orders stay listed 3 min
let orders = [], type = 'market';
try { const o = JSON.parse(localStorage.getItem(ORD_KEY)); if (Array.isArray(o)) orders = o; } catch {}
try { if (localStorage.getItem(TYPE_KEY) === 'limit') type = 'limit'; } catch {}
function saveOrders() {
  if (orders.length > 100) orders = orders.slice(-100);
  try { localStorage.setItem(ORD_KEY, JSON.stringify(orders)); } catch {}
}
const orderById = id => orders.find(o => o.id === id);
const sideAsks = (f, side) => side === 'up' ? bookLevels(f.asks, false) : bookLevels(f.bids, true, true);

// best bid and ask of a side, 0..1 (DOWN: the UP book mirrored)
function touch(f, side) {
  let bb = null, ba = null;
  for (const k in f.bids) if (bb === null || +k > bb) bb = +k;
  for (const k in f.asks) if (ba === null || +k < ba) ba = +k;
  return side === 'up' ? { bid: bb !== null ? bb / 1000 : null, ask: ba !== null ? ba / 1000 : null }
                       : { bid: ba !== null ? 1 - ba / 1000 : null, ask: bb !== null ? 1 - bb / 1000 : null };
}

// limit prices like the venues' ticks: whole cents between 10¢ and 90¢, tenths of a cent beyond (in cents)
const tickC = c => c < 10 || c > 90 ? Math.round(c * 10) / 10 : Math.round(c);
function limitOf(side) {
  const v = parseFloat($('paper-lim-' + side).value);
  return Number.isFinite(v) && v >= 0.1 && v <= 99.9 ? tickC(v) / 100 : null;
}

// each side's limit field follows its best bid (rounded down to a tick, so it never crosses the book) until you
// type a price in; that one holds for the round and market it was typed for
const limFor = { up: null, down: null };
const limKey = (V, f) => `${S.asset}|${V.key}|${f.wts}`;
const floorTick = c => c < 10 || c > 90 ? Math.floor(c * 10 + 1e-6) / 10 : Math.floor(c + 1e-6);
function prefill(V, f) {
  for (const side of ['up', 'down']) {
    const el = $('paper-lim-' + side);
    if (limFor[side] === limKey(V, f) || document.activeElement === el) continue;
    const { bid, ask } = touch(f, side), c = bid !== null ? bid * 100 : ask !== null ? ask * 100 - 1 : null;
    if (c !== null) el.value = String(Math.max(0.1, Math.min(99.9, floorTick(c))));
  }
}

function place(side) {
  const V = tradeVenue(), f = liveFeed(V), limit = limitOf(side), now = Date.now();
  if (!f || limit === null || currentRound(now).end - now < 3000) return;
  const o = { id: 'o' + now.toString(36) + Math.random().toString(36).slice(2, 5), t: now, asset: S.asset,
              series: seriesId(S.asset, V.key, lenOf(V)), start: f.wts, side, qty: qty(), limit,
              filled: 0, mk: 0, cost: 0, fees: 0, used: {}, status: 'open', tid: null };
  orders.push(o);
  const x = matchLimit(sideAsks(f, side), limit, o.qty, o.used, true, feeOf(V));
  if (x) addFill(o, V, x, now, true);
  saveOrders();
  renderOrders();
}

// a fill of an order: one trade per order, its shares, price and entry chances growing with each fill
function addFill(o, V, x, now, taker) {
  const prev = o.filled;
  o.filled = Math.round((o.filled + x.qty) * 100) / 100;
  o.cost += x.cost; o.fees += x.fees;
  if (!taker) o.mk = Math.round((o.mk + x.qty) * 100) / 100;
  const sum = { qty: o.filled, avg: o.cost / o.filled, fees: o.fees, total: o.cost + o.fees };
  const t = o.tid && M.trades.find(t => t.id === o.tid);
  if (!t) {
    const nt = newTrade(V, o.side, sum, now, { lim: o.limit, ord: o.id, mk: o.mk });
    o.tid = nt.id;
    M.trades.push(nt);
  } else {
    const p = entryProbs(V, o.side), w = (a, b) => a == null ? b : b == null ? a : +((a * prev + b * x.qty) / o.filled).toFixed(4);
    Object.assign(t, { qty: sum.qty, avg: +sum.avg.toFixed(4), fees: +sum.fees.toFixed(4), total: +sum.total.toFixed(4),
                       mk: o.mk, mkt: w(t.mkt, p.mkt), model: w(t.model, p.model) });
  }
  if (o.filled >= o.qty - 0.005) { o.status = 'filled'; o.done = now; delete o.used; }
  saveLedger(M);
  render();
}

function endOrder(o, status, now) {
  o.status = status; o.done = now;
  delete o.used;
}

// every 200ms (main.js): open orders against their book; an order whose round is over ends
export function paperTick(now) {
  let changed = false;
  for (const o of orders) {
    if (o.status !== 'open') continue;
    if (now >= endOf(o)) { endOrder(o, 'expired', endOf(o)); changed = true; continue; }
    const V = liveVenue(o), f = V && liveFeed(V);
    if (!f) continue;
    const x = matchLimit(sideAsks(f, o.side), o.limit, o.qty - o.filled, o.used, false, feeOf(V));
    if (x) { addFill(o, V, x, now, false); changed = true; }
  }
  if (changed) { saveOrders(); renderOrders(); }
}

function cancelOrder(id) {
  const o = orderById(id);
  if (o?.status !== 'open') return;
  endOrder(o, 'cancelled', Date.now());
  saveOrders();
  renderOrders();
  tickOpen();
}

// the order list: the open ones and those that ended in the last minutes, newest first
let ordRows = [], ordShown = '';
const shownOrders = now => orders.filter(o => o.status === 'open' || now - o.done < SHOW_DONE).slice(-8).reverse();

function orderStatus(o) {
  const part = o.filled > 0 ? `${o.filled} of ${o.qty} filled` : null;
  if (o.status === 'filled') return { cls: 'done', text: `filled · avg ${fmtC(o.cost / o.filled)}`, tip: '' };
  if (o.status === 'expired') return { cls: 'done', text: `round over · ${part ?? 'nothing filled'}`, tip: '' };
  if (o.status === 'cancelled') return { cls: 'done', text: `cancelled · ${part ?? 'nothing filled'}`, tip: '' };
  const V = liveVenue(o), f = V && liveFeed(V);
  if (!f) return { cls: 'idle', text: `not watched · ${marketOf(o)} isn’t in view`,
                   tip: 'An order is only checked against the order book this page shows; switch back to its market' };
  const { ask } = touch(f, o.side);
  return { cls: 'open', text: `${part ?? 'waiting'} · ask ${ask !== null ? fmtC(ask) : '—'}`,
           tip: `Fills once sellers offer at ${fmtC(o.limit)} or less (no fee); ends with the round` };
}

function orderRow(o) {
  const open = o.status === 'open';
  return `<div class="pord${open ? ' open' : ''}" data-id="${esc(o.id)}">` +
    `<span class="po-side"><b class="${o.side === 'up' ? 'up-t' : 'down-t'}">${o.side === 'up' ? '▲ UP' : '▼ DOWN'}</b> ${o.qty} @ ${fmtC(o.limit)}</span>` +
    `<span class="po-meta">${esc(marketOf(o))} · ${fmtClock(o.t)}</span>` +
    '<span class="po-st"></span>' +
    (open ? `<button type="button" class="link-btn po-x" data-cancel="${esc(o.id)}">Cancel</button>` : '') + '</div>';
}

function renderOrders() {
  const now = Date.now(), el = $('paper-orders'), list = shownOrders(now);
  ordShown = list.map(o => o.id + o.status).join();
  ordRows = [];
  el.hidden = !list.length;
  if (!list.length) { el.innerHTML = ''; return; }
  const open = list.filter(o => o.status === 'open').length;
  el.innerHTML = `<div class="po-head"><h3 class="sub">Limit orders</h3><span>${open ? `${open} open` : 'none open'}</span></div>` + list.map(orderRow).join('');
  for (const r of el.querySelectorAll('.pord')) ordRows.push([orderById(r.dataset.id), r.querySelector('.po-st')]);
  tickOrders();
}

function tickOrders() {
  if (shownOrders(Date.now()).map(o => o.id + o.status).join() !== ordShown) return renderOrders();
  for (const [o, el] of ordRows) {
    const st = orderStatus(o);
    if (el.textContent === st.text) continue;
    el.textContent = st.text;
    el.className = 'po-st ' + st.cls;
    el.title = st.tip;
  }
}

const TYPE_NOTE = {
  market: 'Fills at once at the asks, taker fee included',
  limit: 'Waits at your price until a seller comes down to it, no fee · ends with the round',
};
function setType(t) {
  type = t;
  try { localStorage.setItem(TYPE_KEY, t); } catch {}
  for (const b of document.querySelectorAll('[data-ptype]')) b.setAttribute('aria-pressed', String(b.dataset.ptype === t));
  $('paper-ctl').classList.toggle('limit', t === 'limit');
  for (const side of ['up', 'down']) $('paper-lim-' + side).closest('label').hidden = t !== 'limit';
  $('paper-type-note').textContent = TYPE_NOTE[t];
  updatePaper();
}

// ── Settlement ───────────────────────────────────────────────────────────────
// Polymarket closes a round 1–3 minutes after its end and the CLOB API shows the winner at once (Gamma's event
// list, which the old lookup used, lagged another 2–4 minutes). Until then the market keeps trading, near 100¢ / 0¢
// once the result is clear: that shows as "likely", the totals wait for the official result. Kalshi settles
// within seconds of the end. All trades of a round are settled by one lookup; a round that keeps failing is asked
// less and less often and never holds up the others. A trade the bot sold early keeps its result from the sale;
// the official result still comes in, to show what holding it would have made.
const look = new Map();   // round key → { nextT, up }: next lookup, UP's price meanwhile (this page only)
const roundKey = t => `${t.series}@${t.start}`;
const retryIn = sinceEnd => sinceEnd < 10 * 60_000 ? 4000 : sinceEnd < 60 * 60_000 ? 30_000 : 5 * 60_000;

// the result the dashboard already has for a round of the market in view
function knownResult(t) {
  const s = parseSeries(t.series), V = s.venue === 'kalshi' ? KS : PM;
  if (s.asset !== S.asset || !V.on || (V === PM && s.len !== ROUND_S)) return null;
  const r = V.results.get(t.start);
  return r === 'up' || r === 'down' ? r : null;
}

// → { win: 'up' | 'down' } once official, else { up: UP's price meanwhile } (or null)
async function lookup(ts) {
  const t = ts[0], s = parseSeries(t.series), A = assetById(s.asset);
  if (s.venue === 'kalshi') {
    const d = await getJSON(t.ticker ? `${KALSHI_PROXY}/trade-api/v2/markets/${t.ticker}`
      : `${KALSHI_PROXY}/trade-api/v2/markets?series_ticker=${A.kalshi}&min_close_ts=${t.start + 900}&max_close_ts=${t.start + 900}`);
    const m = d.market ?? (d.markets || [])[0];
    if (!m) return null;
    if (m.result === 'yes' || m.result === 'no') return { win: m.result === 'yes' ? 'up' : 'down' };
    const last = +m.last_price_dollars;
    return { up: last > 0 ? last : null };
  }
  let cid = ts.find(x => x.cid)?.cid;
  if (!cid) {   // a trade from before the CLOB lookup: the market's id from Gamma (lagging there doesn't matter)
    const d = await getJSON(`https://gamma-api.polymarket.com/events?slug=${A.poly}-updown-${s.len / 60}m-${t.start}`);
    cid = d[0]?.markets?.[0]?.conditionId;
    if (!cid) return null;
    for (const x of ts) x.cid = cid;
  }
  const r = await clobResult(cid);
  return r && (r.win ? { win: r.win } : { up: r.up });
}

let settling = false;
export async function settlePaper() {
  if (settling) return;
  settling = true;
  try {
    const now = Date.now(), rounds = new Map(), owner = new Map(), changed = new Set();
    for (const L of ledgers) for (const t of L.trades) {
      if (t.result || endOf(t) > now) continue;
      const k = roundKey(t);
      if (!rounds.has(k)) rounds.set(k, []);
      rounds.get(k).push(t);
      owner.set(t, L);
    }
    const settle = (ts, win) => { for (const t of ts) { t.result = win; if (!t.sold) t.pnl = pnlOf(t, win); changed.add(owner.get(t)); } };
    for (const k of look.keys()) if (!rounds.has(k)) look.delete(k);
    let kalshi = 0, poly = 0;
    const jobs = [];
    for (const [k, ts] of rounds) {
      const known = knownResult(ts[0]);
      if (known) { settle(ts, known); continue; }
      if (!look.has(k)) look.set(k, { nextT: 0, up: null });
      const L = look.get(k), isKs = parseSeries(ts[0].series).venue === 'kalshi';
      // a few lookups at a time (Kalshi's API allows ~5–10 requests a second, shared with the live book)
      if (now < L.nextT || (isKs ? !KALSHI_PROXY || kalshi++ >= 3 : poly++ >= 8)) continue;
      L.nextT = now + retryIn(now - endOf(ts[0]));
      jobs.push(lookup(ts).then(r => {
        if (r?.win) settle(ts, r.win);
        else if (r) L.up = r.up;
      }).catch(e => console.warn('paper result:', e.message)));
    }
    await Promise.all(jobs);
    for (const L of changed) { saveLedger(L); L.onChange(); }
    tickOpen();
  } finally {
    settling = false;
  }
}

// ── Card ─────────────────────────────────────────────────────────────────────
export function initPaper() {
  try { const q = +localStorage.getItem(QTY_KEY); if (q > 0) $('paper-qty').value = q; } catch {}
  $('paper-qty').addEventListener('change', () => { try { localStorage.setItem(QTY_KEY, String(qty())); } catch {} updatePaper(); });
  for (const side of ['up', 'down']) {
    $('paper-' + side).addEventListener('click', () => type === 'limit' ? place(side) : buy(side));
    const el = $('paper-lim-' + side);
    el.addEventListener('input', () => { const V = tradeVenue(), f = liveFeed(V); if (f) limFor[side] = limKey(V, f); updatePaper(); });
    el.addEventListener('change', () => { const L = limitOf(side); if (L !== null) el.value = String(Math.round(L * 1000) / 10); });
  }
  for (const b of document.querySelectorAll('[data-ptype]')) b.addEventListener('click', () => setType(b.dataset.ptype));
  $('paper-orders').addEventListener('click', e => { const id = e.target.closest('[data-cancel]')?.dataset.cancel; if (id) cancelOrder(id); });
  $('paper').addEventListener('click', e => {
    if (e.target.id === 'paper-reset' && confirm('Delete all paper trades and limit orders in this browser?')) {
      M.trades = []; orders = [];
      saveLedger(M); saveOrders(); render(); renderOrders();
    }
    if (e.target.id === 'paper-csv') exportCsv(M.trades, 'paper-trades.csv', ['lim', 'mk']);
  });
  // orders of rounds that ended while the page was closed
  paperTick(Date.now());
  setType(type);
  render();
  renderOrders();
}

// the buttons' prices, the orders' and the open trades' status, every second
export function updatePaper() {
  const V = tradeVenue(), f = liveFeed(V), n = qty(), left = currentRound().end - Date.now();
  if (type === 'limit' && f) prefill(V, f);
  for (const side of ['up', 'down']) {
    const b = $('paper-' + side), dir = side === 'up' ? '▲ UP' : '▼ DOWN';
    let label, price, note, tip;
    if (type === 'market') {
      const q = quoteBuy(V, side, n);
      b.disabled = !q || left < 3000;
      label = 'Buy ' + dir; price = q ? fmtC(q.avg) : '—'; note = '';
      tip = q ? `${q.qty} shares at ${fmtC(q.avg, 2)} on average + ${fmtC(q.fees / q.qty, 2)} fee each = $${q.total.toFixed(2)}; pays $${q.qty} if ${side.toUpperCase()} wins` +
        (q.qty < n ? ` (the book only has ${q.qty} on that side)` : '') : 'Needs the running round’s order book';
    } else {
      const L = limitOf(side), q = f && L !== null ? quoteBuy(V, side, n, L) : null, ask = f ? touch(f, side).ask : null;
      b.disabled = !f || L === null || left < 3000;
      label = 'Limit ' + dir; price = L !== null ? fmtC(L) : '—';
      note = !f || L === null ? '' : q && q.qty >= n - 0.005 ? 'fills at once' : q ? `${q.qty} at once, rest waits` : `waits · ask ${ask !== null ? fmtC(ask) : '—'}`;
      tip = !f ? 'Needs the running round’s order book' : L === null ? 'Enter a limit price in cents above the button'
        : `Buy up to ${n} ${side.toUpperCase()} at ${fmtC(L)} or less` + (q ? `: ${q.qty} at once at the asks (taker fee)` : '') +
          (!q || q.qty < n ? `; ${q ? 'the rest waits' : 'it waits'} for sellers at ${fmtC(L)} (no fee), until the round ends` : '');
    }
    b.querySelector('.pb-l').textContent = label;
    b.querySelector('b').textContent = price;
    b.querySelector('small').textContent = note;
    b.title = tip;
  }
  $('paper-venue').textContent = `${S.A.sym} ${V.name} ${lenOf(V)}m`;
  tickOrders();
  tickOpen();
}

// result cell of a trade: sold, settled, running (time left; a bot position it will sell: what selling now makes),
// or ended and waiting for the official result
function status(t, now) {
  if (t.sold) {
    const s = t.sold, held = t.result ? `; held to the end it would have made ${usd(pnlOf(t, t.result))}` : '';
    return { cls: t.pnl > 0 ? 'won' : 'lost', html: `${usd(t.pnl)}<small>sold ${fmtC(s.avg)}</small>`,
             tip: `Sold ${t.qty} at ${fmtC(s.avg, 2)} on average − $${s.fees.toFixed(2)} fees = $${s.net.toFixed(2)} (${EXIT_TEXT[s.why] ?? s.why})${held}` };
  }
  if (t.result) {
    const won = t.result === t.side;
    return { cls: won ? 'won' : 'lost', html: `${usd(t.pnl)}<small>${won ? 'won' : 'lost'}</small>`, tip: '' };
  }
  const end = endOf(t), venue = parseSeries(t.series).venue === 'kalshi' ? 'Kalshi' : 'Polymarket';
  if (now < end) {
    const V = t.exit ? liveVenue(t) : null, q = V && quoteSell(V, t.side, t.qty);
    if (q && q.qty === t.qty)
      return { cls: 'open', html: `≈ ${usd(q.net - t.total)}<small>${mmss((end - now) / 1000)} left · bid ${fmtC(q.avg)}</small>`,
               tip: 'Open: what selling now at the bids would make after the fee. The bot sells by the rule’s exits.' };
    const o = t.ord && orderById(t.ord);
    if (o?.status === 'open')
      return { cls: 'open', html: `${mmss((end - now) / 1000)}<small>left · order ${o.filled} of ${o.qty}</small>`,
               tip: `Round still running; the limit order at ${fmtC(o.limit)} is still open and may buy more` };
    return { cls: 'open', html: `${mmss((end - now) / 1000)}<small>left</small>`, tip: 'Round still running' };
  }
  const up = look.get(roundKey(t))?.up, p = up == null ? null : t.side === 'up' ? up : 1 - up;
  const tip = `Waiting for ${venue}’s official result (Polymarket closes a round 1–3 minutes after its end, Kalshi within seconds)`;
  if (p !== null && (p >= 0.9 || p <= 0.1)) {
    const won = p >= 0.9;
    return { cls: won ? 'likely-won' : 'likely-lost', html: `≈ ${usd(pnlOf(t, won ? t.side : 'other'))}<small>likely ${won ? 'won' : 'lost'}</small>`,
             tip: `${tip}. Meanwhile the market prices your side at ${fmtC(p)}.` };
  }
  return { cls: 'wait', html: `pending<small>${mmss((now - end) / 1000)} since end</small>`, tip };
}
export const EXIT_TEXT = { target: 'take profit', stop: 'stop loss', time: 'time limit', end: 'before the end', unwind: 'unwound: the other leg missed' };

function tickOpen() {
  const now = Date.now();
  for (const L of ledgers) for (const [t, el] of L.open) {
    const st = status(t, now);
    if (el.dataset.html === st.html) continue;
    el.dataset.html = st.html;
    el.className = 'pt-res ' + st.cls;
    el.innerHTML = st.html;
    el.title = st.tip;
  }
}

const dayName = d => {
  const day = new Date(d).setHours(0, 0, 0, 0), today = new Date().setHours(0, 0, 0, 0);
  return day === today ? 'Today' : today - day < 36 * 3600_000 ? 'Yesterday'
    : new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

// one trade; `ruleName` (bot trades) puts the rule where the manual list shows market and model
function row(t, now, ruleName) {
  const st = status(t, now), open = !t.result && !t.sold, market = esc(marketOf(t));
  const mm = `<span class="pt-l">mkt </span>${pct(t.mkt)} · <span class="pt-l">model </span>${pct(t.model)}`;
  const lim = t.lim == null ? '' : ` <span class="pt-lim" title="${esc(`Limit order at ${fmtC(t.lim)}: ${t.mk ? `${t.mk} of ${t.qty} filled waiting, as a maker without fee` : 'filled at once at the asks'}${t.mk && t.mk < t.qty ? ', the rest at once at the asks' : ''}`)}">limit</span>`;
  return `<div class="ptrade${open ? ' open' : ''}" data-id="${esc(t.id)}">` +
    `<span class="pt-when" title="${esc(new Date(t.t).toLocaleString())}">${fmtHM(t.t)}</span>` +
    `<span class="pt-side" title="${t.qty} shares at ${fmtC(t.avg, 2)} on average + $${t.fees.toFixed(2)} fees"><b class="${t.side === 'up' ? 'up-t' : 'down-t'}">${t.side === 'up' ? '▲ UP' : '▼ DOWN'}</b> ${t.qty} @ ${fmtC(t.avg)}${lim}</span>` +
    `<span class="pt-meta"><span>${market}</span>` +
    `<span title="Time left in the round when bought">${mmss(t.left)} left</span>` +
    `<span title="Paid incl. fees; pays $${t.qty} if it wins"><span class="pt-l">cost </span>$${t.total.toFixed(2)}</span>` +
    (ruleName ? `<span class="pt-rule" title="${esc(`${t.why ?? ''} · when bought: market ${pct(t.mkt)}, model ${pct(t.model)}`)}">${esc(ruleName(t))}</span>`
      : `<span title="Chance of your side when bought: by the market (mid) and by the model">${mm}</span>`) + '</span>' +
    `<span class="pt-res ${st.cls}" title="${esc(st.tip)}" data-html="${esc(st.html)}">${st.html}</span></div>`;
}

// the trades of a list, newest first, with a line where the day changes (keeps the scroll position)
export function renderList(L, el, list, ruleName) {
  const now = Date.now();
  L.open = [];
  if (!list.length) { el.innerHTML = ''; return; }
  const rows = [`<div class="phead" aria-hidden="true"><span>Time</span><span>Trade</span><span>Market</span><span>Bought</span><span>Cost</span><span>${ruleName ? 'Rule' : 'Mkt · model'}</span><span>Result</span></div>`];
  let day = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i], d = dayName(t.t);
    if (d !== day) { day = d; rows.push(`<div class="pday">${d}</div>`); }
    rows.push(row(t, now, ruleName));
  }
  const top = el.scrollTop;
  el.innerHTML = rows.join('');
  el.scrollTop = top;   // a settled trade must not throw you back to the top while you scroll
  const byId = new Map(list.filter(t => !t.result && !t.sold).map(t => [t.id, t]));
  for (const r of el.querySelectorAll('.ptrade.open')) { const t = byId.get(r.dataset.id); if (t) L.open.push([t, r.querySelector('.pt-res')]); }
}

// totals of a list: result, how often it won, how many, and what the trades were worth when bought
export function summaryTiles(trades) {
  const done = trades.filter(t => t.pnl != null), open = trades.length - done.length;
  const tile = (label, value, sub, cls = '', tip = '') =>
    `<div class="pstat"${tip ? ` title="${tip}"` : ''}><span class="pstat-l">${label}</span><b class="pstat-v ${cls}">${value}</b><span class="pstat-s">${sub}</span></div>`;
  if (!done.length) return tile('Trades', '0', `settled · ${open} open`) + '<div class="sig-sub">Totals appear once the first trade is settled.</div>';
  const sum = (xs, f) => xs.reduce((a, t) => a + f(t), 0);
  const pnl = sum(done, t => t.pnl), wins = done.filter(t => t.pnl > 0).length;
  const staked = sum(done, t => t.total), shares = sum(done, t => t.qty);
  // expected at entry: (chance it wins × shares) − what it cost, by the market's mid and by the model
  const exp = k => { const xs = done.filter(t => t[k] != null); return xs.length ? sum(xs, t => t[k] * t.qty - t.total) : null; };
  const em = exp('mkt'), ed = exp('model');
  const exLine = (v, who) => `<span>${v !== null ? usd(v) : '—'} <small>${who}</small></span>`;
  return [
    tile('Result <span class="muted">· after fees</span>', usd(pnl), `${usd(pnl / done.length)} a trade`, pnl >= 0 ? 'up-t' : 'down-t',
      `$${staked.toFixed(2)} paid in total incl. fees → ${pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(pnl / staked * 100))}% return`),
    tile('Won', `${Math.round(wins / done.length * 100)}% <small>${wins} of ${done.length}</small>`, `break-even ${Math.round(staked / shares * 100)}%`, '',
      'Break-even: what was paid per share incl. fees; a trade held to the end has to win more often than that to come out ahead'),
    tile('Trades', `${done.length}`, open ? `settled · ${open} open` : 'settled'),
    tile('Expected at entry', exLine(em, 'market') + exLine(ed, 'model'), '', 'two',
      'What the trades were worth when bought: chance of the side × shares − cost, by the market’s mid and by the model'),
  ].join('');
}

function render() {
  const statsEl = $('paper-stats'), listEl = $('paper-list'), foot = $('paper-foot'), trades = M.trades;
  if (!trades.length) {
    statsEl.innerHTML = '<div class="sig-sub">Try your own calls without money: tap UP or DOWN to buy at once, or pick Limit to wait at your price. ' +
      'Each trade is settled with the official result; next to your result: what the market and the model expected at the moment you bought.</div>';
    renderList(M, listEl, []);
    foot.hidden = true;
    return;
  }
  statsEl.innerHTML = summaryTiles(trades);
  renderList(M, listEl, trades);
  foot.hidden = false;
  foot.innerHTML = `<span>${trades.length} trade${trades.length === 1 ? '' : 's'} · stored in this browser${trades.length >= M.max ? ` (last ${M.max})` : ''}</span>` +
    '<span><button class="link-btn" type="button" id="paper-csv">CSV</button> · <button class="link-btn" type="button" id="paper-reset">Reset</button></span>';
}

export function exportCsv(trades, name, extra = []) {
  const cols = ['t', 'asset', 'series', 'start', 'side', 'qty', 'avg', 'fees', 'total', 'left', 'mkt', 'model', 'result', 'pnl', ...extra];
  const val = (t, c) => {
    const v = c === 't' ? new Date(t.t).toISOString() : c.startsWith('sold_') ? t.sold?.[c.slice(5)] : t[c];
    const s = c === 'sold_t' && v ? new Date(v).toISOString() : String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([[cols.join(','), ...trades.map(t => cols.map(c => val(t, c)).join(','))].join('\n')], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
