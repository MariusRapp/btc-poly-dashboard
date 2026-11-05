// Taker fees, model edge per side, and Polymarket vs Kalshi: price gap, arbitrage pairs, settle-apart risk.

import { KALSHI_PROXY } from './kalshi.js';
import { bookLevels, buyEdge, walkPair } from './math.js';
import { ksTarget, nearStrikeProb } from './model.js';
import { EXCH, ROUNDS_SHOWN, ROUND_S, S, STALE_MS } from './state.js';
import { $, currentRound, fmtC, fmtP, fmtPts, fmtSz, signedUsd } from './util.js';
import { KS, PM, activeVenues } from './venues.js';

// Both venues charge takers rate × p × (1 − p) per share/contract: Polymarket crypto 0.07, Kalshi 0.07 × the
// series multiplier (1 for KXBTC15M), rounded up to the cent per order — that rounding only matters for tiny orders.
export const PM_FEE = 0.07, KS_FEE = 0.07;
// how far Chainlink's and CF Benchmarks' 60s averages may move apart over one round — an estimate, not measured
const SETTLE_BAND = 5;

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
  return {
    gap: (a.mid - b.mid) * 100,
    // UP on Polymarket (its asks) + NO on Kalshi (NO asks = YES bids mirrored)
    upPm:   walkPair(bookLevels(a.asks, false), PM_FEE, bookLevels(b.bids, true, true), KS_FEE),
    // DOWN on Polymarket (UP bids mirrored) + YES on Kalshi (its asks)
    downPm: walkPair(bookLevels(a.bids, true, true), PM_FEE, bookLevels(b.asks, false), KS_FEE),
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

function arbRow(id, r) {
  const val = $(id + '-val'), sub = $(id + '-sub');
  if (!r) { val.textContent = '—'; val.className = 'sig-value'; sub.textContent = 'One side of the books is empty'; return; }
  val.textContent = (r.edge > 0 ? '+' : r.edge < 0 ? '−' : '') + fmtC(Math.abs(r.edge)) + ' / pair';
  val.className = 'sig-value' + (r.edge > 0 ? ' good' : '');
  sub.textContent = `${fmtC(r.pa)} + ${fmtC(r.pb)} + fees ${fmtC(r.fees, 2)} = ${fmtC(r.pa + r.pb + r.fees)} for a $1 payout` +
    (r.pairs > 0 ? ` · up to ${fmtSz(r.pairs)} pairs, +$${r.profit.toFixed(2)}` : '');
}

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
  const near = nearStrikeProb(SETTLE_BAND), agree = venueAgreement();
  $('risk-val').textContent = near === null ? '—' : near < 0.1 ? '<0.1%' : near.toFixed(1) + '%';
  $('risk-val').className = 'sig-value' + (near !== null && near >= 5 ? ' warn' : '');
  $('risk-sub').textContent = `Model chance the settlement ends within ±$${SETTLE_BAND} of the strike, where the two indices can disagree` +
    (agree ? ` · same result in ${agree.same} of the last ${agree.n} rounds` : '');
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
