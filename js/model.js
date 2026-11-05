// Strike, expected settlement and the model probability (normal approximation of the 60s settlement average).

import { fetchStrike } from './chainlink.js';
import { yRange } from './charts.js';
import { firstIdx, probAbove, probWithin, settlementDist, twap, volFromCloses } from './math.js';
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

// σ in $ per √s: last hour of 1-minute returns; until that loads, the 60s range as a rough proxy
export function sigmaUsd() {
  if (S.volPerSqrtS !== null && S.lastMedianP !== null) return S.lastMedianP * S.volPerSqrtS;
  const cut60 = Date.now() - 60_000;
  let lo60 = Infinity, hi60 = -Infinity;
  for (let i = medianHistory.length - 1; i >= 0 && medianHistory[i].t >= cut60; i--) {
    lo60 = Math.min(lo60, medianHistory[i].p); hi60 = Math.max(hi60, medianHistory[i].p);
  }
  return (isFinite(lo60) ? Math.max(25, (hi60 - lo60) / 3) : 80) / Math.sqrt(60);
}

export async function fetchVol() {
  try {
    const d = await getJSON('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60');
    const v = volFromCloses(d.slice(1, 62).map(c => c[4]).reverse());   // newest first; skip the unfinished minute
    if (v !== null) S.volPerSqrtS = v;
  } catch (e) { console.warn('vol:', e.message); }
}

// distribution of the running round's settlement average (see settlementDist in math.js)
export function modelDist() {
  if (S.strike === null || S.lastMedianP === null) return null;
  const now = Date.now(), end = currentRound(now).end, T = (end - now) / 1000;
  if (T <= 0) return null;
  return settlementDist(S.lastMedianP, sigmaUsd(), T, T < 60 ? twap(medianHistory, end - TWAP_MS, now) : null);
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

export function velocity(now) {
  const old = medianHistory[Math.max(0, firstIdx(medianHistory, now - 30_000) - 1)];
  if (!old || S.lastMedianP === null || now - old.t < 1000) return null;
  return (S.lastMedianP - old.p) / ((now - old.t) / 1000);   // $/s
}
