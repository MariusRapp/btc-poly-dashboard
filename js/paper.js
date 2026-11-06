// Paper trades: buy UP or DOWN of the running round at the live book (best ask, deeper levels for bigger orders,
// taker fee included), without money. Each trade keeps what the market (mid) and the model said at that moment;
// once the official result is in it is settled, so your own calls sit next to the market's and the model's.
// Stored in this browser (localStorage), all coins and markets in one list.
import { KS_FEE, PM_FEE } from './arb.js';
import { assetById, parseSeries, seriesId } from './assets.js';
import { KALSHI_PROXY } from './kalshi.js';
import { bookLevels, fillOrder } from './math.js';
import { computeModelProb } from './model.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtHM } from './util.js';
import { KS, PM, both, mainVenue } from './venues.js';

const KEY = 'paper-v1', QTY_KEY = 'paper-qty', MAX = 500;
let trades = (() => { try { const t = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(t) ? t : []; } catch { return []; } })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(trades.slice(-MAX))); } catch {} };
const usd = x => (x < 0 ? '−$' : '+$') + Math.abs(x).toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
    result: null,
  });
  save();
  render();
}

// ── Settlement: the official result, from the dashboard's own lists or fetched (a few a minute) ──
async function officialResult(tr) {
  const s = parseSeries(tr.series), A = assetById(s.asset);
  if (A.id === S.asset) {
    const r = (s.venue === 'kalshi' ? KS : PM).results.get(tr.start);
    if ((s.venue === 'kalshi' || s.len === ROUND_S) && (r === 'up' || r === 'down')) return r;
  }
  if (s.venue === 'poly') {
    const d = await (await fetch(`https://gamma-api.polymarket.com/events?slug=${A.poly}-updown-${s.len / 60}m-${tr.start}`)).json();
    const m = d[0]?.markets?.[0];
    if (!m?.closed) return null;
    const win = JSON.parse(m.outcomes || '[]')[JSON.parse(m.outcomePrices || '[]').map(Number).indexOf(1)];
    return win === 'Up' ? 'up' : win === 'Down' ? 'down' : null;
  }
  if (!KALSHI_PROXY) return null;
  const e = tr.start + 900;
  const d = await (await fetch(`${KALSHI_PROXY}/trade-api/v2/markets?series_ticker=${A.kalshi}&min_close_ts=${e}&max_close_ts=${e}`)).json();
  const m = (d.markets || [])[0];
  return m?.result === 'yes' ? 'up' : m?.result === 'no' ? 'down' : null;
}

let settling = false;
export async function settlePaper() {
  if (settling) return;
  settling = true;
  try {
    const now = Date.now() / 1000;
    const open = trades.filter(t => !t.result && t.start + parseSeries(t.series).len < now - 5).slice(0, 4);
    let changed = false;
    for (const t of open) {
      try {
        const r = await officialResult(t);
        if (r) { t.result = r; t.pnl = +((r === t.side ? t.qty : 0) - t.total).toFixed(4); changed = true; }
      } catch (e) { console.warn('paper result:', e.message); }
    }
    if (changed) { save(); render(); }
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
    if (e.target.id === 'paper-reset' && confirm('Delete all paper trades in this browser?')) { trades = []; save(); render(); }
    if (e.target.id === 'paper-csv') exportCsv();
  });
  render();
}

// the buttons' prices, every second
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
}

function render() {
  const done = trades.filter(t => t.result), open = trades.length - done.length, el = $('paper-stats');
  if (!trades.length) {
    el.innerHTML = '<div class="sig-sub">Try your own calls without money: tap UP or DOWN, and each trade is settled with the official result. ' +
      'Next to your result: what the market and the model expected at the moment you bought.</div>';
    $('paper-list').innerHTML = '';
    return;
  }
  const sum = f => done.reduce((a, t) => a + f(t), 0);
  const pnl = sum(t => t.pnl), wins = done.filter(t => t.result === t.side).length;
  // expected per trade at entry: (chance it wins × shares) − what it cost, by the market's mid and by the model
  const exp = k => { const xs = done.filter(t => t[k] != null); return xs.length ? xs.reduce((a, t) => a + t[k] * t.qty - t.total, 0) : null; };
  const em = exp('mkt'), ed = exp('model');
  el.innerHTML = [
    ['Trades', `${done.length} settled` + (open ? ` · ${open} open` : '')],
    ['Won', done.length ? `${wins} of ${done.length} (${Math.round(wins / done.length * 100)}%)` : '—'],
    ['Your result <span class="muted">· after fees</span>', done.length ? `<span class="${pnl >= 0 ? 'up-t' : 'down-t'}">${usd(pnl)}</span>` : '—'],
    ['Expected at entry <span class="muted">· by the market · by the model</span>', done.length ? `${em !== null ? usd(em) : '—'} · ${ed !== null ? usd(ed) : '—'}` : '—'],
  ].map(([k, v]) => `<div class="trow"><span>${k}</span><b>${v}</b></div>`).join('');
  $('paper-list').innerHTML = trades.slice(-8).reverse().map(t => {
    const s = parseSeries(t.series), A = assetById(t.asset), res = t.result ? (t.result === t.side ? 'won' : 'lost') : 'open';
    return `<div class="ptrade"><span class="pt-when">${fmtHM(t.t)}</span>` +
      `<span class="pt-what"><b class="${t.side === 'up' ? 'up-t' : 'down-t'}">${t.side === 'up' ? '▲ UP' : '▼ DOWN'}</b> ${t.qty} @ ${fmtC(t.avg)} · ${esc(A.sym)} ${s.venue === 'kalshi' ? 'Kalshi' : 'Poly'} ${s.len / 60}m · ${Math.floor(t.left / 60)}:${String(t.left % 60).padStart(2, '0')} left</span>` +
      `<span class="pt-res ${res}">${res === 'open' ? 'open' : usd(t.pnl)}</span></div>`;
  }).join('') + '<div class="track-foot"><span>Stored in this browser</span><span><button class="link-btn" type="button" id="paper-csv">CSV</button> · ' +
    '<button class="link-btn" type="button" id="paper-reset">Reset</button></span></div>';
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
