// Strike, expected settlement, and the model in use: its inputs, distribution and probability (models.js).

import { fetchStrike } from './chainlink.js';
import { yRange } from './charts.js';
import { firstIdx, probAbove, probWithin, twap } from './math.js';
import { modelById, modelDist as modelDistOf, paramsOf, volsFromCloses } from './models.js';
import { S, TWAP_MS, medianHistory } from './state.js';
import { currentRound, getJSON } from './util.js';
import { KS } from './venues.js';

// ── Strike, settlement, model ────────────────────────────────────────────────
// strike = 60s average of our median before the round starts. Strike and settlement come from the
// same price basis, so a constant offset to Chainlink's stream or CF Benchmarks' BRTI cancels out.
// Fallbacks: Kalshi's published target (exact for Kalshi), else on-chain Chainlink.
export function updateStrike(now) {
  const { start } = currentRound(now);
  if (S.strikeRound !== start) {
    S.strikeRound = start; S.strike = null; S.strikeSrc = null; S.clStrike = null;
    delete yRange.btc; delete yRange.prob;
    fetchStrike(start / 1000);
  }
  if (S.strikeSrc === 'twap') return;
  const v = now >= start ? twap(medianHistory, start - TWAP_MS, start) : null;
  if (v !== null) { S.strike = v; S.strikeSrc = 'twap'; return; }
  const kt = ksTarget();
  if (kt !== null) { S.strike = kt; S.strikeSrc = 'kalshi'; return; }
  if (S.clStrike !== null) { S.strike = S.clStrike; S.strikeSrc = 'chainlink'; }
}

// Kalshi's official start average for the running round (null until it is published)
export function ksTarget() {
  const f = KS.on ? KS.cur : null;
  return f && f.wts * 1000 === currentRound().start && f.strike != null ? f.strike : null;
}

export const strikeNote = () => S.strikeSrc === 'twap' ? '60s avg' : S.strikeSrc === 'kalshi' ? 'Kalshi target' : 'Chainlink';

// expected settlement average: the part of the final minute already observed + current price for the rest
export function expectedSettlement(now) {
  if (S.lastMedianP === null) return null;
  const ws = currentRound(now).end - TWAP_MS;
  if (now <= ws) return { value: S.lastMedianP, locked: 0 };
  const done = twap(medianHistory, ws, now);
  if (done === null) return { value: S.lastMedianP, locked: 0 };
  const e = Math.min(1, (now - ws) / TWAP_MS);
  return { value: done * e + S.lastMedianP * (1 - e), locked: e };
}

// rough σ in $ per √s from the last 60s range, while the 1-minute candles have not loaded yet
// (at least 0.033% of the price a minute, 0.1% when there is no range yet: $25 and $75 on BTC)
function rangeSigma() {
  const cut60 = Date.now() - 60_000, p = S.lastMedianP ?? 0;
  let lo60 = Infinity, hi60 = -Infinity;
  for (let i = medianHistory.length - 1; i >= 0 && medianHistory[i].t >= cut60; i--) {
    lo60 = Math.min(lo60, medianHistory[i].p); hi60 = Math.max(hi60, medianHistory[i].p);
  }
  return (isFinite(lo60) ? Math.max(3.3e-4 * p, (hi60 - lo60) / 3) : 1e-3 * p) / Math.sqrt(60);
}

// 1-minute closes of the last five hours (Coinbase; oldest first, the running minute left out) and the
// volatilities the models use from them, refreshed every round
export async function fetchVol() {
  const gen = S.assetGen;
  try {
    const d = await getJSON(`https://api.exchange.coinbase.com/products/${S.A.coinbase}/candles?granularity=60`);
    if (gen !== S.assetGen) return;   // another coin by now
    S.closes1m = d.slice(1).map(c => c[4]).reverse();
    S.vols = volsFromCloses(S.closes1m);
  } catch (e) { console.warn('vol:', e.message); }
}

// ── The model in use (models.js): picked and tuned in the Model card, remembered per browser ──
export const activeModel = () => modelById(S.modelId);
export const activeParams = (m = activeModel()) => paramsOf(m, S.modelParams?.[m.id]);

// what the models get: price, strike, time left, the window seen so far, volatilities, the last minute's speed
export function modelInputs(now = Date.now()) {
  if (S.strike === null || S.lastMedianP === null) return null;
  const end = currentRound(now).end, T = (end - now) / 1000;
  if (T <= 0) return null;
  return { price: S.lastMedianP, strike: S.strike, T, ws: T - 60, end,
           observed: T < 60 ? twap(medianHistory, end - TWAP_MS, now) : null,
           vol: k => S.vols?.[k] ?? null, velocity: velocity(now, 60_000), fallback: rangeSigma() };
}

// distribution of the running round's settlement average under the model in use
export function modelDist() {
  const inp = modelInputs();
  return inp && modelDistOf(activeModel(), inp, activeParams());
}

// P(settlement average >= strike), in %
export function computeModelProb() {
  const d = modelDist();
  return d && Math.max(0.5, Math.min(99.5, probAbove(d, S.strike) * 100));
}

// model chance that the settlement average lands within ±band of the strike, in %
export function nearStrikeProb(band) {
  const d = modelDist();
  return d && probWithin(d, S.strike, band) * 100;
}

// $/s over the last `span` ms (30s for the projected settlement, 60s for the momentum model)
export function velocity(now, span = 30_000) {
  const old = medianHistory[Math.max(0, firstIdx(medianHistory, now - span) - 1)];
  if (!old || S.lastMedianP === null || now - old.t < 1000) return null;
  return (S.lastMedianP - old.p) / ((now - old.t) / 1000);
}
