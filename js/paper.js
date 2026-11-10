// Paper trades: buy UP or DOWN of the running round at the live book (best ask, deeper levels for bigger orders,
// taker fee included), without money. Each trade keeps what the market (mid) and the model said at that moment;
// once the official result is in it is settled, so your own calls sit next to the market's and the model's.
// Stored in this browser (localStorage), all coins and markets in one list. The paper bot (bot.js) keeps its
// trades in a list of its own in the same format, with sales on top; both lists are settled here, together.
import { KS_FEE, PM_FEE } from './arb.js';
import { assetById, parseSeries, seriesId } from './assets.js';
import { KALSHI_PROXY } from './kalshi.js';
import { bookLevels, fillOrder, sellOrder } from './math.js';
import { computeModelProb } from './model.js';
import { clobResult } from './polymarket.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtHM, getJSON } from './util.js';
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

// a trade filled now: what it cost, and what the market (mid) and the model said about its side at that moment
export function newTrade(V, side, q, now, extra = {}) {
  const f = V.cur, model = computeModelProb(), up = V.up;
  return {
    id: now.toString(36) + Math.random().toString(36).slice(2, 5), t: now, asset: S.asset, series: seriesId(S.asset, V.key, lenOf(V)), start: f.wts,
    side, qty: q.qty, avg: +q.avg.toFixed(4), fees: +q.fees.toFixed(4), total: +q.total.toFixed(4), left: Math.round((currentRound(now).end - now) / 1000),
    mkt: up !== null ? +((side === 'up' ? up : 100 - up) / 100).toFixed(4) : null,
    model: model !== null ? +((side === 'up' ? model : 100 - model) / 100).toFixed(4) : null,
    // the market's id, for the result lookup
    ...(V === KS ? { ticker: f.ticker } : { cid: f.cid }),
    result: null, ...extra,
  };
}

// the venue the buttons trade on: the one in view; with both venues, the one picked in the order book card
const tradeVenue = () => both() ? (S.bookVenue === 'kalshi' ? KS : PM) : mainVenue();
const qty = () => Math.max(1, Math.min(100000, Math.round(+$('paper-qty').value || 10)));

function buy(side) {
  const V = tradeVenue(), q = quoteBuy(V, side, qty()), now = Date.now();
  if (!q || currentRound(now).end - now < 3000) return;
  M.trades.push(newTrade(V, side, q, now));
  saveLedger(M);
  render();
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
  $('paper-up').addEventListener('click', () => buy('up'));
  $('paper-down').addEventListener('click', () => buy('down'));
  $('paper').addEventListener('click', e => {
    if (e.target.id === 'paper-reset' && confirm('Delete all paper trades in this browser?')) { M.trades = []; saveLedger(M); render(); }
    if (e.target.id === 'paper-csv') exportCsv(M.trades, 'paper-trades.csv');
  });
  render();
}

// the buttons' prices and the open trades' status, every second
export function updatePaper() {
  const V = tradeVenue();
  for (const side of ['up', 'down']) {
    const b = $('paper-' + side), q = quoteBuy(V, side, qty()), left = currentRound().end - Date.now();
    b.disabled = !q || left < 3000;
    b.querySelector('b').textContent = q ? fmtC(q.avg) : '—';
    b.title = q ? `${q.qty} shares at ${fmtC(q.avg, 2)} on average + ${fmtC(q.fees / q.qty, 2)} fee each = $${q.total.toFixed(2)}; pays $${q.qty} if ${side.toUpperCase()} wins` +
      (q.qty < qty() ? ` (the book only has ${q.qty} on that side)` : '') : 'Needs the running round’s order book';
  }
  $('paper-venue').textContent = `${S.A.sym} ${V.name} ${lenOf(V)}m`;
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
  const s = parseSeries(t.series), A = assetById(t.asset), st = status(t, now), open = !t.result && !t.sold;
  const market = `${esc(A.sym)} ${s.venue === 'kalshi' ? 'Kalshi' : 'Poly'} ${s.len / 60}m`;
  const mm = `<span class="pt-l">mkt </span>${pct(t.mkt)} · <span class="pt-l">model </span>${pct(t.model)}`;
  return `<div class="ptrade${open ? ' open' : ''}" data-id="${esc(t.id)}">` +
    `<span class="pt-when" title="${esc(new Date(t.t).toLocaleString())}">${fmtHM(t.t)}</span>` +
    `<span class="pt-side" title="${t.qty} shares at ${fmtC(t.avg, 2)} on average + $${t.fees.toFixed(2)} fees"><b class="${t.side === 'up' ? 'up-t' : 'down-t'}">${t.side === 'up' ? '▲ UP' : '▼ DOWN'}</b> ${t.qty} @ ${fmtC(t.avg)}</span>` +
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
    statsEl.innerHTML = '<div class="sig-sub">Try your own calls without money: tap UP or DOWN, and each trade is settled with the official result. ' +
      'Next to your result: what the market and the model expected at the moment you bought.</div>';
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
