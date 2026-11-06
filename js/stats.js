// Statistics over the rounds the recorder Worker stored (recorder/): Brier score, calibration, a backtest of the
// model edge, and how often Polymarket and Kalshi settled the same round apart. Pure; covered by test/stats.test.js.
import { buyEdge, takerFee } from './math.js';

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

// Same 15-minute rounds on both venues: how many both settled, how many they settled apart, and for those how far
// Kalshi's BRTI settlement average ended from its start average (how close to the strike a round has to end to split)
export function settleApart(poly, kalshi) {
  const k = new Map(kalshi.filter(r => r.result === 'up' || r.result === 'down').map(r => [r.start, r]));
  let n = 0;
  const splits = [];
  for (const r of poly) {
    const x = k.get(r.start);
    if (!x || (r.result !== 'up' && r.result !== 'down')) continue;
    n++;
    if (r.result !== x.result) splits.push(x.k_settle != null && x.k_strike != null ? Math.abs(x.k_settle - x.k_strike) : null);
  }
  const d = splits.filter(v => v !== null);
  return { n, splits: splits.length, maxDist: d.length ? Math.max(...d) : null };
}
