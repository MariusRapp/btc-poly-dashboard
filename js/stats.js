// Statistics over the rounds the recorder Worker stored (recorder/): Brier score, calibration, a backtest of the
// model edge, and how often Polymarket and Kalshi settled the same round apart. Pure; covered by test/stats.test.js.
import { buyEdge, probWithin, settlementDist, takerFee } from './math.js';

// { cols, rows } from GET /rounds → one object per round
export const toRecords = ({ cols, rows }) => rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

// market probability at the snapshot: mid of the best bid and ask. A round that is already decided often has one
// side empty (nobody sells UP below 100¢, or nobody bids above 0¢): the missing side then counts as 100¢ / 0¢,
// so those rounds are scored too instead of dropping out.
export const marketProb = r => r.bid == null && r.ask == null ? null : ((r.bid ?? 0) + (r.ask ?? 1)) / 2;
// rounds with a snapshot (market and model about 60s before the end) and an official result
export const scored = recs => recs.filter(r => (r.result === 'up' || r.result === 'down') && marketProb(r) !== null && r.model != null);

// "Open" rounds: the market still between 10% and 90% at the snapshot. Decided rounds score almost 0 for everyone
// and dilute the difference between market and model; this is where they part.
export const OPEN = [0.1, 0.9];
export const isOpen = r => { const p = marketProb(r); return p !== null && p >= OPEN[0] && p <= OPEN[1]; };

// Log loss: −ln of the probability given to what happened. It punishes confident misses much harder than the
// Brier score. Probabilities are clipped to 0.1% … 99.9% (a model that says 0.0001% and misses would count as ∞).
export const LOG_CLIP = 0.001;
export const logLoss = (p, up) => { const q = Math.min(1 - LOG_CLIP, Math.max(LOG_CLIP, p)); return -Math.log(up ? q : 1 - q); };

// Brier score and log loss of a forecast over scored rounds (null without any)
export function scores(rows, f) {
  if (!rows.length) return { brier: null, log: null };
  let b = 0, l = 0;
  for (const r of rows) { const p = f(r), up = r.result === 'up'; b += (p - (up ? 1 : 0)) ** 2; l += logLoss(p, up); }
  return { brier: b / rows.length, log: l / rows.length };
}

export function summary(recs) {
  const s = scored(recs), open = s.filter(isOpen);
  const own = recs.filter(r => r.result && r.strike != null && r.settle != null);
  const mkt = scores(s, marketProb), mod = scores(s, r => r.model);
  const oMkt = scores(open, marketProb), oMod = scores(open, r => r.model);
  return {
    n: s.length,
    since: s.length ? Math.min(...s.map(r => r.start)) : null,
    fav: s.length ? s.filter(r => (marketProb(r) >= 0.5) === (r.result === 'up')).length / s.length : null,
    brierMkt: mkt.brier, brierModel: mod.brier, logMkt: mkt.log, logModel: mod.log,
    open: { n: open.length, brierMkt: oMkt.brier, brierModel: oMod.brier, logMkt: oMkt.log, logModel: oMod.log },
    ownN: own.length,
    ownMatch: own.filter(r => (r.settle >= r.strike) === (r.result === 'up')).length,
  };
}

// reliability: rounds grouped by forecast probability (`bins` equal bins), and the share that went UP in each
export function calibration(recs, forecast, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, ups: 0 }));
  for (const r of scored(recs)) {
    const p = forecast(r), b = out[Math.min(bins - 1, Math.max(0, Math.floor(p * bins)))];
    b.n++; b.sumP += p; if (r.result === 'up') b.ups++;
  }
  return out.filter(b => b.n).map(({ lo, hi, n, sumP, ups }) => ({ lo, hi, n, p: sumP / n, freq: ups / n }));
}

// Backtest: at each snapshot buy one share of the side whose model edge after the taker fee is at least
// `minEdge`, at the best ask (DOWN at 1 − the UP bid). Gain per share: payout − price − fee.
export function backtest(recs, minEdge, fee) {
  let trades = 0, wins = 0, pnl = 0;
  const curve = [];
  for (const r of scored(recs)) {
    const sides = [];
    if (r.ask != null) sides.push({ side: 'up', price: r.ask, edge: buyEdge(r.ask, r.model, fee) });
    if (r.bid != null) sides.push({ side: 'down', price: 1 - r.bid, edge: buyEdge(1 - r.bid, 1 - r.model, fee) });
    const best = sides.reduce((a, x) => !a || x.edge > a.edge ? x : a, null);
    if (!best || best.edge < minEdge) continue;
    const won = best.side === r.result;
    trades++;
    if (won) wins++;
    pnl += (won ? 1 : 0) - best.price - takerFee(best.price, fee);
    curve.push({ t: r.start, pnl });
  }
  return { trades, wins, pnl, perTrade: trades ? pnl / trades : null, curve };
}

// ── Settle-apart risk between Polymarket (Chainlink) and Kalshi (CF Benchmarks) ──
// How often the two venues settle the same 15-minute round apart, by how far the settlement average ended from the
// strike, in basis points of the price (the indices differ by cents, so only near-ties split). Measured on Bitcoin,
// 1,403 rounds to 2026-11-06: 12 of 26 rounds within 0.25 bp ($2) split, 7 of 28 at 0.25–0.5, 5 of 56 at 0.5–1,
// none of 100 at 1–2 bp and 1 of 1,193 beyond. That is the default; each coin's own recorded rounds pull its curve
// towards what they show (shrinkage: `m` rounds' worth of weight for the default per bin).
export const SPLIT_EDGES = [0, 0.25, 0.5, 1, 2, Infinity];
export const SPLIT_DEFAULT = [0.46, 0.25, 0.09, 0.005, 0.001];
export function splitCurve(poly, kalshi, prior = SPLIT_DEFAULT, m = 10) {
  const p = new Map((poly || []).filter(r => r.result === 'up' || r.result === 'down').map(r => [r.start, r.result]));
  const bins = prior.map((_, i) => ({ lo: SPLIT_EDGES[i], hi: SPLIT_EDGES[i + 1], n: 0, s: 0 }));
  let n = 0, s = 0;
  for (const k of kalshi || []) {
    const pr = p.get(k.start);
    if (!pr || (k.result !== 'up' && k.result !== 'down') || k.k_strike == null || k.k_settle == null || !(k.k_strike > 0)) continue;
    const bp = Math.abs(k.k_settle - k.k_strike) / k.k_strike * 1e4, b = bins.find(x => bp >= x.lo && bp < x.hi);
    b.n++; n++;
    if (pr !== k.result) { b.s++; s++; }
  }
  for (const [i, b] of bins.entries()) b.rate = (b.s + m * prior[i]) / (b.n + m);
  return { bins, n, splits: s };
}
// chance the venues settle apart, for a settlement average distributed as `dist` around `strike`
export function splitProb(curve, dist, strike) {
  let p = 0;
  for (const b of curve.bins) {
    const lo = b.lo * strike / 1e4, hi = b.hi * strike / 1e4;
    const mass = (b.hi === Infinity ? 1 : probWithin(dist, strike, hi)) - (b.lo === 0 ? 0 : probWithin(dist, strike, lo));
    p += Math.max(0, mass) * b.rate;
  }
  return p;
}

// The pairs the recorded snapshots (60s before the end) offered: UP on one venue + DOWN on the other below $1 after
// fees. `raw`: every such pair. `aware`: only where the price advantage beats the chance of a split (both legs lose).
// P&L from what actually happened (a pair pays $1 when the venues agree, $0 or $2 when they split).
export function pairBacktest(poly, kalshi, curve, feeP, feeK, len = 900) {
  const k = new Map((kalshi || []).map(r => [r.start, r]));
  const out = { rounds: 0, raw: { n: 0, pnl: 0, splits: 0, lossSplits: 0 }, aware: { n: 0, pnl: 0, splits: 0 } };
  const done = r => r?.result === 'up' || r?.result === 'down';
  for (const a of poly || []) {
    const b = k.get(a.start);
    if (!done(a) || !done(b) || a.snap_t == null || a.snap_t !== b.snap_t) continue;
    out.rounds++;
    const legs = [];
    // Poly UP (its ask) + Kalshi NO (1 − its YES bid); Poly DOWN (1 − its UP bid) + Kalshi YES (its ask)
    if (a.ask != null && b.bid != null) legs.push({ pa: a.ask, pb: 1 - b.bid, pays: (a.result === 'up') + (b.result === 'down') });
    if (a.bid != null && b.ask != null) legs.push({ pa: 1 - a.bid, pb: b.ask, pays: (a.result === 'down') + (b.result === 'up') });
    const best = legs.map(l => ({ ...l, cost: l.pa + l.pb + takerFee(l.pa, feeP) + takerFee(l.pb, feeK) }))
      .reduce((x, l) => !x || l.cost < x.cost ? l : x, null);
    if (!best || best.cost >= 1) continue;
    const pnl = best.pays - best.cost, split = a.result !== b.result;
    out.raw.n++; out.raw.pnl += pnl;
    if (split) { out.raw.splits++; if (best.pays === 0) out.raw.lossSplits++; }
    if (a.price == null || a.sigma == null || a.strike == null) continue;
    const ps = splitProb(curve, settlementDist(a.price, a.sigma, a.start + len - a.snap_t), a.strike);
    if (1 - best.cost - ps > 0) { out.aware.n++; out.aware.pnl += pnl; if (split) out.aware.splits++; }
  }
  return out;
}
