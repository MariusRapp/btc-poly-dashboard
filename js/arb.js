// Taker fees, model edge per side, and Polymarket vs Kalshi: price gap, arbitrage pairs, settle-apart risk.

import { seriesId } from './assets.js';
import { KALSHI_PROXY } from './kalshi.js';
import { bookLevels, buyEdge, walkPair } from './math.js';
import { ksTarget, modelDist } from './model.js';
import { EXCH, ROUNDS_SHOWN, ROUND_S, S, STALE_MS } from './state.js';
import { $, currentRound, fmtC, fmtP, fmtPts, fmtSz, signedUsd } from './util.js';
import { KS, PM, activeVenues } from './venues.js';
import { recorded } from './recorder.js';
import { pairBacktest, splitCurve, splitProb } from './stats.js';

// Both venues charge takers rate × p × (1 − p) per share/contract: Polymarket crypto 0.07, Kalshi 0.07 × the
// series multiplier (1 for KXBTC15M), rounded up to the cent per order — that rounding only matters for tiny orders.
export const PM_FEE = 0.07, KS_FEE = 0.07;

// Settle-apart risk: the two venues settle on different indices (Chainlink, CF Benchmarks), so a round that ends
// within cents of the strike can go UP on one and DOWN on the other. A pair bought because one venue is cheaper
// then loses both legs: the price gap usually exists *because* the two indices sit on different sides. The chance
// comes from the recorded rounds of this coin (stats.js splitCurve: split rate by distance to the strike) and where
// the model expects the settlement average.
const recorded15 = () => [recorded(seriesId(S.asset, 'poly', 15)), recorded(seriesId(S.asset, 'kalshi', 15))];
let curveKey = '', curve = splitCurve([], []);
export function splitRisk() {
  const [p, k] = recorded15(), key = `${S.asset}|${p?.length}|${k?.length}`;
  if (key !== curveKey) { curveKey = key; curve = splitCurve(p, k); }
  const d = modelDist();
  return { curve, p: d && S.strike !== null ? splitProb(curve, d, S.strike) : null };
}

// ── Model edge ───────────────────────────────────────────────────────────────
// Buy one side of the running round at its best ask. If the model is right, the expected gain per $1 share
// after the taker fee is P(side) − ask − fee (UP at the UP ask; DOWN at 1 − the UP bid). In dollars.
export function modelEdges(V, modelP) {
  const f = V.cur;
  if (!f || f.closed || f.wts * 1000 !== currentRound().start || V.up === null) return null;
  let bb = 0, ba = 1000;
  for (const k in f.bids) if (+k > bb) bb = +k;
  for (const k in f.asks) if (+k < ba) ba = +k;
  const fee = V === KS ? KS_FEE : PM_FEE, p = modelP / 100;
  const buy = (side, price, win) => ({ V, side, price, edge: buyEdge(price, win, fee) });
  return [ba < 1000 ? buy('up', ba / 1000, p) : null, bb > 0 ? buy('down', 1 - bb / 1000, 1 - p) : null];
}
export const bestEdge = list => list.filter(Boolean).reduce((a, x) => !a || x.edge > a.edge ? x : a, null);
export const EDGE_ALERT = 0.05;   // alert from 5¢ per share

// ── Polymarket vs Kalshi: price gap and arbitrage ────────────────────────────

// both books of the running round: price gap, and the two ways to hold both sides of the same question
export function arbState() {
  const ok = f => f && !f.closed && f.wts * 1000 === currentRound().start && f.mid !== null;
  const a = PM.cur, b = KS.cur;
  if (!ok(a) || !ok(b)) return null;
  const split = splitRisk().p, ev = r => r && split !== null ? r.edge - split : null;
  const upPm = walkPair(bookLevels(a.asks, false), PM_FEE, bookLevels(b.bids, true, true), KS_FEE);
  const downPm = walkPair(bookLevels(a.bids, true, true), PM_FEE, bookLevels(b.asks, false), KS_FEE);
  return {
    gap: (a.mid - b.mid) * 100, split,
    // UP on Polymarket (its asks) + NO on Kalshi (NO asks = YES bids mirrored); `ev` = edge after the split risk
    upPm: upPm && { ...upPm, ev: ev(upPm) },
    // DOWN on Polymarket (UP bids mirrored) + YES on Kalshi (its asks)
    downPm: downPm && { ...downPm, ev: ev(downPm) },
  };
}

// rounds in the list where both official results are in, and how many of them agree
function venueAgreement() {
  const cur = currentRound().start / 1000;
  let n = 0, same = 0;
  for (let k = 1; k <= ROUNDS_SHOWN; k++) {
    const a = PM.results.get(cur - ROUND_S * k), b = KS.results.get(cur - ROUND_S * k);
    if ((a === 'up' || a === 'down') && (b === 'up' || b === 'down')) { n++; if (a === b) same++; }
  }
  return n ? { n, same } : null;
}

const signedCents = x => (x > 0.0005 ? '+' : x < -0.0005 ? '−' : '') + fmtC(Math.abs(x));
function arbRow(id, r) {
  const val = $(id + '-val'), sub = $(id + '-sub');
  if (!r) { val.textContent = '—'; val.className = 'sig-value'; sub.textContent = 'One side of the books is empty'; return; }
  const ev = r.ev ?? r.edge;
  val.textContent = signedCents(ev) + ' / pair';
  val.className = 'sig-value' + (ev > 0 ? ' good' : '');
  val.title = r.ev !== null ? 'Expected per pair after the split risk' : 'Per pair if both venues settle alike';
  sub.textContent = `${fmtC(r.pa)} + ${fmtC(r.pb)} + fees ${fmtC(r.fees, 2)} = ${fmtC(r.pa + r.pb + r.fees)} · ` +
    `${signedCents(r.edge)} if both settle alike` + (r.ev !== null ? `, ${signedCents(r.ev - r.edge)} split risk` : '') +
    (r.pairs > 0 ? ` · up to ${fmtSz(r.pairs)} pairs` : '');
}

// percentage with a sensible number of decimals for small risks
const pctSmall = p => p < 0.001 ? '<0.1%' : p < 0.1 ? (p * 100).toFixed(1) + '%' : Math.round(p * 100) + '%';

export function updateArb(arb) {
  if (!arb) {
    for (const id of ['gap', 'arb1', 'arb2']) { $(id + '-val').textContent = '—'; $(id + '-val').className = 'sig-value'; }
    $('gap-sub').textContent = 'Needs both order books of the running round';
    $('arb1-sub').textContent = $('arb2-sub').textContent = '—';
  } else {
    $('gap-val').textContent = Math.abs(arb.gap) < 0.05 ? '0.0 pts' : fmtPts(arb.gap);
    $('gap-sub').textContent = `UP mid: Poly ${(PM.cur.mid * 100).toFixed(1)}% vs Kalshi ${(KS.cur.mid * 100).toFixed(1)}% · ` +
      (Math.abs(arb.gap) < 1 ? 'in line' : `UP cheaper on ${arb.gap > 0 ? 'Kalshi' : 'Polymarket'}`);
    arbRow('arb1', arb.upPm);
    arbRow('arb2', arb.downPm);
  }
  // settle-apart risk now, and the curve it comes from
  const { curve: c, p } = splitRisk(), agree = venueAgreement(), near = c.bins[0];
  $('risk-val').textContent = p === null ? '—' : pctSmall(p);
  $('risk-val').className = 'sig-value' + (p !== null && p >= 0.02 ? ' warn' : '');
  const own = c.n >= 200;
  $('risk-sub').textContent = `Chance the venues settle this round apart: where the model expects the settlement × how often ` +
    `rounds that close to the strike split (${Math.round(near.rate * 100)}% within ${near.hi} bp` +
    (S.strike !== null ? ` ≈ $${(near.hi * S.strike / 1e4).toLocaleString('en-US', { maximumSignificantDigits: 2 })}` : '') + ')' +
    (own ? ` · recorded: ${c.splits} splits in ${c.n} rounds` : ` · curve measured on Bitcoin${c.n ? `, ${c.n} rounds of ${S.A.sym} so far` : ''}`) +
    (!c.n && agree ? ` · same result in ${agree.same} of the last ${agree.n} rounds` : '');
  updatePairs(c);
}

// what the recorded snapshots offered, and what it would have made
let pairsKey = '';
function updatePairs(c) {
  const [p, k] = recorded15(), key = `${S.asset}|${p?.length}|${k?.length}|${c.n}`;
  if (key === pairsKey) return;
  pairsKey = key;
  const val = $('pairs-val'), sub = $('pairs-sub');
  if (!p || !k) { val.textContent = '—'; sub.textContent = 'Needs the recorder’s rounds of both venues'; return; }
  const bt = pairBacktest(p, k, c, PM_FEE, KS_FEE), r = bt.raw, a = bt.aware, usd = x => (x < 0 ? '−$' : '+$') + Math.abs(x).toFixed(2);
  if (!r.n) { val.textContent = 'None'; val.className = 'sig-value'; sub.textContent = `No pair under $1 in ${bt.rounds} recorded rounds (60s before the end)`; return; }
  val.textContent = usd(r.pnl);
  val.className = 'sig-value ' + (r.pnl >= 0 ? 'up-t' : 'down-t');
  sub.textContent = `60s before the end, ${r.n} of ${bt.rounds} rounds had a pair under $1; ${r.splits} of them settled apart` +
    (r.lossSplits ? ` (${r.lossSplits} lost both legs)` : '') + ` · one pair each: ${usd(r.pnl)}. ` +
    `Only where the edge beats the split risk: ${a.n ? `${a.n} pairs, ${usd(a.pnl)}${a.splits ? `, ${a.splits} split` : ''}` : 'none'}.`;
}

export function updateSources() {
  const med = S.lastMedianP, now = Date.now();
  for (const ex of EXCH) {
    const fresh = ex.lastP !== null && now - ex.lastTT <= STALE_MS;
    $('sp-' + ex.key).textContent = ex.lastP !== null ? fmtP(ex.lastP) : '—';
    $('sd-' + ex.key).textContent = fresh && med !== null ? signedUsd(ex.lastP - med) : '—';
    $('sdot-' + ex.key).className = 'dot ' + (!ex.enabled ? '' : fresh ? 'live' : 'wait');
  }
  $('sp-cl').textContent = S.clPrice !== null ? fmtP(S.clPrice) : '—';
  $('sd-cl').textContent = S.clPrice !== null && med !== null ? signedUsd(S.clPrice - med) : '—';
  $('sdot-cl').className = 'dot ' + S.clState;
  $('sp-cls').textContent = S.clStrike !== null ? fmtP(S.clStrike) : '—';
  $('sd-cls').textContent = S.clStrike !== null && S.strike !== null && S.strikeSrc === 'twap' ? signedUsd(S.clStrike - S.strike) : '—';
  $('sdot-cls').className = 'dot ' + (S.clStrike !== null ? 'live' : 'wait');
  $('sp-pm').textContent = PM.cur ? PM.cur.stamp : 'Connecting…';
  $('sdot-pm').className = 'dot ' + (PM.cur ? PM.cur.state : 'wait');
  const kt = ksTarget();
  $('sp-kst').textContent = kt !== null ? fmtP(kt) : '—';
  $('sd-kst').textContent = kt !== null && S.strike !== null && S.strikeSrc === 'twap' ? signedUsd(kt - S.strike) : '—';
  $('sdot-kst').className = 'dot ' + (kt !== null ? 'live' : 'wait');
  $('sp-ks').textContent = !KALSHI_PROXY ? 'No proxy set (see README)' : KS.cur ? KS.cur.stamp : 'Connecting…';
  $('sdot-ks').className = 'dot ' + (!KALSHI_PROXY ? 'err' : KS.cur ? KS.cur.state : 'wait');

  // data quality 0–100 from exchange consensus and trade activity
  const live = EXCH.filter(e => e.enabled && e.lastP !== null && now - e.lastTT <= STALE_MS).map(e => e.lastP);
  const mean = live.reduce((a, v) => a + v, 0) / (live.length || 1);
  const stdDev = live.length > 1 ? Math.sqrt(live.reduce((a, v) => a + (v - mean) ** 2, 0) / live.length) : 999;
  const quality = Math.round(Math.max(0, 100 - stdDev * 5) * 0.6 + Math.min(100, S.tps * 10) * 0.4);
  $('src-meta').textContent = `${S.tps} trades/s · USDT ${S.usdtUsd.toFixed(4)} · quality ${quality}%`;
}

export function updateLive() {
  const now = Date.now();
  const live = EXCH.filter(e => e.enabled && e.lastP !== null && now - e.lastTT <= STALE_MS).length;
  let cls = 'wait', txt = 'Connecting';
  const states = activeVenues().map(V => V.cur ? V.cur.state : 'wait');
  if (KS.on && !KALSHI_PROXY) { cls = 'err'; txt = 'No Kalshi proxy'; }
  else if (states.every(s => s === 'live') && live >= 3) { cls = 'live'; txt = 'Live'; }
  else if (states.includes('err')) { cls = 'err'; txt = 'Reconnecting'; }
  $('live-dot').className = 'dot ' + cls;
  $('live-text').textContent = txt;
}
