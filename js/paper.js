// Paper trades: buy UP or DOWN of the running round at the live book (best ask, deeper levels for bigger orders,
// taker fee included), without money. Each trade keeps what the market (mid) and the model said at that moment;
// once the official result is in it is settled, so your own calls sit next to the market's and the model's.
// Stored in this browser (localStorage), all coins and markets in one list.
import { KS_FEE, PM_FEE } from './arb.js';
import { assetById, parseSeries, seriesId } from './assets.js';
import { KALSHI_PROXY } from './kalshi.js';
import { bookLevels, fillOrder } from './math.js';
import { computeModelProb } from './model.js';
import { clobResult } from './polymarket.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtHM, getJSON } from './util.js';
import { KS, PM, both, mainVenue } from './venues.js';

const KEY = 'paper-v1', QTY_KEY = 'paper-qty', MAX = 500;
let trades = (() => { try { const t = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(t) ? t : []; } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(trades.slice(-MAX))); } catch {} };
const usd = x => (x < 0 ? '−$' : '+$') + Math.abs(x).toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = x => x != null ? Math.round(x * 100) + '%' : '—';
const endOf = t => (t.start + parseSeries(t.series).len) * 1000;
const pnlOf = (t, win) => +((win === t.side ? t.qty : 0) - t.total).toFixed(4);

// the venue the buttons trade on: the one in view; with both venues, the one picked in the order book card
const tradeVenue = () => both() ? (S.bookVenue === 'kalshi' ? KS : PM) : mainVenue();
const qty = () => Math.max(1, Math.min(100000, Math.round(+$('paper-qty').value || 10)));

// fill the shares at the running round's book: its asks (DOWN: the UP bids mirrored), walked level by level
function quote(V, side) {
  const f = V.cur;
  if (!f || f.closed || f.wts * 1000 !== currentRound().start) return null;
  const levels = side === 'up' ? bookLevels(f.asks, false) : bookLevels(f.bids, true, true);
  return fillOrder(levels, qty(), V === KS ? KS_FEE : PM_FEE);
}

function buy(side) {
  const V = tradeVenue(), q = quote(V, side), now = Date.now(), { start, end } = currentRound(now);
  if (!q || end - now < 3000) return;
  const model = computeModelProb(), up = V.up;
  trades.push({
    id: now.toString(36), t: now, asset: S.asset, series: seriesId(S.asset, V.key, V === KS ? 15 : ROUND_S / 60), start: start / 1000,
    side, qty: q.qty, avg: +q.avg.toFixed(4), fees: +q.fees.toFixed(4), total: +q.total.toFixed(4), left: Math.round((end - now) / 1000),
    mkt: up !== null ? +((side === 'up' ? up : 100 - up) / 100).toFixed(4) : null,
    model: model !== null ? +((side === 'up' ? model : 100 - model) / 100).toFixed(4) : null,
    // the market's id, for the result lookup
    ...(V === KS ? { ticker: V.cur.ticker } : { cid: V.cur.cid }),
    result: null,
  });
  if (trades.length > MAX) trades = trades.slice(-MAX);
  save();
  render();
}

// ── Settlement ───────────────────────────────────────────────────────────────
// Polymarket closes a round 1–3 minutes after its end and the CLOB API shows the winner at once (Gamma's event
// list, which the old lookup used, lagged another 2–4 minutes). Until then the market keeps trading, near 100¢ / 0¢
// once the result is clear: that shows as "likely", the totals wait for the official result. Kalshi settles
// within seconds of the end. All trades of a round are settled by one lookup; a round that keeps failing is asked
// less and less often and never holds up the others.
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
    const now = Date.now(), rounds = new Map();
    for (const t of trades) {
      if (t.result || endOf(t) > now) continue;
      const k = roundKey(t);
      if (!rounds.has(k)) rounds.set(k, []);
      rounds.get(k).push(t);
    }
    for (const k of look.keys()) if (!rounds.has(k)) look.delete(k);
    let changed = false, kalshi = 0, poly = 0;
    const jobs = [];
    for (const [k, ts] of rounds) {
      const known = knownResult(ts[0]);
      if (known) { for (const t of ts) { t.result = known; t.pnl = pnlOf(t, known); } changed = true; continue; }
      if (!look.has(k)) look.set(k, { nextT: 0, up: null });
      const L = look.get(k), isKs = parseSeries(ts[0].series).venue === 'kalshi';
      // a few lookups at a time (Kalshi's API allows ~5–10 requests a second, shared with the live book)
      if (now < L.nextT || (isKs ? !KALSHI_PROXY || kalshi++ >= 3 : poly++ >= 8)) continue;
      L.nextT = now + retryIn(now - endOf(ts[0]));
      jobs.push(lookup(ts).then(r => {
        if (r?.win) { for (const t of ts) { t.result = r.win; t.pnl = pnlOf(t, r.win); } changed = true; }
        else if (r) L.up = r.up;
      }).catch(e => console.warn('paper result:', e.message)));
    }
    await Promise.all(jobs);
    if (changed) { save(); render(); }
    else tickOpen();
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
    if (e.target.id === 'paper-reset' && confirm('Delete all paper trades in this browser?')) { trades = []; look.clear(); save(); render(); }
    if (e.target.id === 'paper-csv') exportCsv();
  });
  render();
}

// the buttons' prices and the open trades' status, every second
export function updatePaper() {
  const V = tradeVenue();
  for (const side of ['up', 'down']) {
    const b = $('paper-' + side), q = quote(V, side), left = currentRound().end - Date.now();
    b.disabled = !q || left < 3000;
    b.querySelector('b').textContent = q ? fmtC(q.avg) : '—';
    b.title = q ? `${q.qty} shares at ${fmtC(q.avg, 2)} on average + ${fmtC(q.fees / q.qty, 2)} fee each = $${q.total.toFixed(2)}; pays $${q.qty} if ${side.toUpperCase()} wins` +
      (q.qty < qty() ? ` (the book only has ${q.qty} on that side)` : '') : 'Needs the running round’s order book';
  }
  $('paper-venue').textContent = `${S.A.sym} ${V.name} ${V === KS ? 15 : ROUND_S / 60}m`;
  tickOpen();
}

// result cell of a trade: settled, running (time left), or ended and waiting for the official result
function status(t, now) {
  if (t.result) {
    const won = t.result === t.side;
    return { cls: won ? 'won' : 'lost', html: `${usd(t.pnl)}<small>${won ? 'won' : 'lost'}</small>`, tip: '' };
  }
  const end = endOf(t), venue = parseSeries(t.series).venue === 'kalshi' ? 'Kalshi' : 'Polymarket';
  if (now < end) return { cls: 'open', html: `${mmss((end - now) / 1000)}<small>left</small>`, tip: 'Round still running' };
  const up = look.get(roundKey(t))?.up, p = up == null ? null : t.side === 'up' ? up : 1 - up;
  const tip = `Waiting for ${venue}’s official result (Polymarket closes a round 1–3 minutes after its end, Kalshi within seconds)`;
  if (p !== null && (p >= 0.9 || p <= 0.1)) {
    const won = p >= 0.9;
    return { cls: won ? 'likely-won' : 'likely-lost', html: `≈ ${usd(pnlOf(t, won ? t.side : 'other'))}<small>likely ${won ? 'won' : 'lost'}</small>`,
             tip: `${tip}. Meanwhile the market prices your side at ${fmtC(p)}.` };
  }
  return { cls: 'wait', html: `pending<small>${mmss((now - end) / 1000)} since end</small>`, tip };
}

let openCells = [];   // [trade, result cell] of the trades not settled yet
function tickOpen() {
  const now = Date.now();
  for (const [t, el] of openCells) {
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

function row(t, now) {
  const s = parseSeries(t.series), A = assetById(t.asset), st = status(t, now);
  const market = `${esc(A.sym)} ${s.venue === 'kalshi' ? 'Kalshi' : 'Poly'} ${s.len / 60}m`;
  return `<div class="ptrade${t.result ? '' : ' open'}" data-id="${esc(t.id)}">` +
    `<span class="pt-when" title="${esc(new Date(t.t).toLocaleString())}">${fmtHM(t.t)}</span>` +
    `<span class="pt-side" title="${t.qty} shares at ${fmtC(t.avg, 2)} on average + $${t.fees.toFixed(2)} fees"><b class="${t.side === 'up' ? 'up-t' : 'down-t'}">${t.side === 'up' ? '▲ UP' : '▼ DOWN'}</b> ${t.qty} @ ${fmtC(t.avg)}</span>` +
    `<span class="pt-meta"><span>${market}</span>` +
    `<span title="Time left in the round when bought">${mmss(t.left)} left</span>` +
    `<span title="Paid incl. fees; pays $${t.qty} if it wins"><span class="pt-l">cost </span>$${t.total.toFixed(2)}</span>` +
    `<span title="Chance of your side when bought: by the market (mid) and by the model"><span class="pt-l">mkt </span>${pct(t.mkt)} · <span class="pt-l">model </span>${pct(t.model)}</span></span>` +
    `<span class="pt-res ${st.cls}" title="${esc(st.tip)}" data-html="${esc(st.html)}">${st.html}</span></div>`;
}

function render() {
  const statsEl = $('paper-stats'), listEl = $('paper-list'), foot = $('paper-foot'), now = Date.now();
  openCells = [];
  if (!trades.length) {
    statsEl.innerHTML = '<div class="sig-sub">Try your own calls without money: tap UP or DOWN, and each trade is settled with the official result. ' +
      'Next to your result: what the market and the model expected at the moment you bought.</div>';
    listEl.innerHTML = '';
    foot.hidden = true;
    return;
  }
  const done = trades.filter(t => t.result), open = trades.length - done.length;
  const sum = (xs, f) => xs.reduce((a, t) => a + f(t), 0);
  const pnl = sum(done, t => t.pnl), wins = done.filter(t => t.result === t.side).length;
  const staked = sum(done, t => t.total), shares = sum(done, t => t.qty);
  // expected at entry: (chance it wins × shares) − what it cost, by the market's mid and by the model
  const exp = k => { const xs = done.filter(t => t[k] != null); return xs.length ? sum(xs, t => t[k] * t.qty - t.total) : null; };
  const em = exp('mkt'), ed = exp('model');
  const tile = (label, value, sub, cls = '', tip = '') =>
    `<div class="pstat"${tip ? ` title="${tip}"` : ''}><span class="pstat-l">${label}</span><b class="pstat-v ${cls}">${value}</b><span class="pstat-s">${sub}</span></div>`;
  const exLine = (v, who) => `<span>${v !== null ? usd(v) : '—'} <small>${who}</small></span>`;
  statsEl.innerHTML = done.length ? [
    tile('Result <span class="muted">· after fees</span>', usd(pnl), `${usd(pnl / done.length)} a trade`, pnl >= 0 ? 'up-t' : 'down-t',
      `$${staked.toFixed(2)} paid in total incl. fees → ${pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(pnl / staked * 100))}% return`),
    tile('Won', `${Math.round(wins / done.length * 100)}% <small>${wins} of ${done.length}</small>`, `break-even ${Math.round(staked / shares * 100)}%`, '',
      'Break-even: what you paid per share incl. fees; win more often than that to come out ahead'),
    tile('Trades', `${done.length}`, open ? `settled · ${open} open` : 'settled'),
    tile('Expected at entry', exLine(em, 'market') + exLine(ed, 'model'), '', 'two',
      'What the trades were worth when you bought them: chance of your side × shares − cost, by the market’s mid and by the model'),
  ].join('') : tile('Trades', '0', `settled · ${open} open`) + '<div class="sig-sub">Totals appear once the first trade is settled.</div>';

  const rows = [`<div class="phead" aria-hidden="true"><span>Time</span><span>Trade</span><span>Market</span><span>Bought</span><span>Cost</span><span>Mkt · model</span><span>Result</span></div>`];
  let day = null;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i], d = dayName(t.t);
    if (d !== day) { day = d; rows.push(`<div class="pday">${d}</div>`); }
    rows.push(row(t, now));
  }
  const top = listEl.scrollTop;
  listEl.innerHTML = rows.join('');
  listEl.scrollTop = top;   // a settled trade must not throw you back to the top while you scroll
  const byId = new Map(trades.filter(t => !t.result).map(t => [t.id, t]));
  for (const el of listEl.querySelectorAll('.ptrade.open')) openCells.push([byId.get(el.dataset.id), el.querySelector('.pt-res')]);
  openCells = openCells.filter(([t]) => t);
  foot.hidden = false;
  foot.innerHTML = `<span>${trades.length} trade${trades.length === 1 ? '' : 's'} · stored in this browser${trades.length >= MAX ? ` (last ${MAX})` : ''}</span>` +
    '<span><button class="link-btn" type="button" id="paper-csv">CSV</button> · <button class="link-btn" type="button" id="paper-reset">Reset</button></span>';
}

function exportCsv() {
  const cols = ['t', 'asset', 'series', 'start', 'side', 'qty', 'avg', 'fees', 'total', 'left', 'mkt', 'model', 'result', 'pnl'];
  const rows = trades.map(t => cols.map(c => c === 't' ? new Date(t.t).toISOString() : t[c] ?? '').join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' }));
  a.download = 'paper-trades.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
