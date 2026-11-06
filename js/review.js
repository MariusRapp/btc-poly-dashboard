// Past rounds in the charts.

import { btcTip, yRange } from './charts.js';
import { ksFetchResult, ksReviewProb } from './kalshi.js';
import { firstIdx, twap } from './math.js';
import { pmFetchResult, pmReviewProb } from './polymarket.js';
import { resultName, roundResult } from './rounds.js';
import { ROUND_MS, S, TWAP_MS, medianHistory } from './state.js';
import { $, currentRound, fmtP, getJSON, roundSpan, signedUsd } from './util.js';
import { KS, PM, activeVenues } from './venues.js';

// ── Past rounds in the charts ────────────────────────────────────────────────
// Price: our own median while it is still in memory, else Binance 1s candles (USDT→USD).
// Probability: the live mids recorded while the round ran, else its trades (UP price; DOWN as 1 − price).
async function reviewBtc(start, end) {
  const a = start - TWAP_MS, h = medianHistory;
  if (h.length && h[0].t <= a + 5000 && h[h.length - 1].t >= end - 2000)
    return { pts: h.slice(Math.max(0, firstIdx(h, a) - 1), firstIdx(h, end + 1)), src: 'median of exchanges' };
  const q = `symbol=${S.A.binance}&interval=1s&startTime=${a}&endTime=${end - 1}&limit=1000`;
  const d = await getJSON(`https://api.binance.com/api/v3/klines?${q}`)
    .catch(() => getJSON(`https://data-api.binance.vision/api/v3/klines?${q}`));
  return { pts: d.map(k => ({ t: k[0], p: +k[4] * S.usdtUsd })), src: 'Binance 1s (USDT→USD)' };
}

export async function selectRound(ts) {
  ts = +ts || null;
  if (ts && ts >= currentRound().start / 1000) ts = null;     // the running round is the live view
  if ((S.review?.ts ?? null) === ts) return;
  const r = S.review = ts ? { ts, start: ts * 1000, end: ts * 1000 + ROUND_MS, btc: [], probs: {}, loading: true, src: '' } : null;
  delete yRange.btc; delete yRange.prob;
  S.hoverFrac = null;
  syncReview();
  if (!r) return;
  const done = res => res === 'up' || res === 'down';
  if (PM.on && !done(PM.results.get(ts))) pmFetchResult(ts).then(() => { if (S.review === r) syncReview(); });
  if (KS.on && !done(KS.results.get(ts))) ksFetchResult(ts).then(() => { if (S.review === r) syncReview(); });
  const vs = activeVenues();
  const [btc, ...probs] = await Promise.allSettled([reviewBtc(r.start, r.end), ...vs.map(V => V === PM ? pmReviewProb(ts) : ksReviewProb(ts))]);
  if (S.review !== r) return;
  if (btc.status === 'fulfilled') {
    r.btc = btc.value.pts; r.src = btc.value.src;
    r.strike = twap(r.btc, r.start - TWAP_MS, r.start);
    r.settle = twap(r.btc, r.end - TWAP_MS, r.end);
  } else console.warn('round btc:', btc.reason?.message);
  probs.forEach((p, i) => { if (p.status === 'fulfilled') r.probs[vs[i].key] = p.value; else console.warn('round prob', vs[i].key, p.reason?.message); });
  r.failed = btc.status === 'rejected' && probs.every(p => p.status === 'rejected');
  r.loading = false;
  delete yRange.btc; delete yRange.prob;
  syncReview();
}

export function syncBandLegend() {
  $('leg-band').hidden = !S.showBands || (!S.review && S.viewMode !== 'round');
}

export function syncReview() {
  const r = S.review;
  $('review').hidden = !r;
  $('win-seg').classList.toggle('dim', !!r);
  $('show-ex').disabled = !!r;
  $('legend-ex').hidden = !S.showExchanges || !!r;
  $('round-pick').value = r ? String(r.ts) : '';
  for (const c of $('rounds').children) c.setAttribute('aria-pressed', String(!!r && +c.dataset.ts === r.ts));
  const basis = !r || r.loading || r.src.startsWith('median') ? 'Median' : 'Binance';
  $('leg-med').textContent = basis;
  btcTip.refs.med.label.nodeValue = basis;
  syncBandLegend();
  if (!r) return;
  $('rv-title').textContent = roundSpan(r.ts);
  const res = roundResult(r.ts), el = $('rv-res');
  el.className = 'rv-res ' + (res === 'up' || res === 'down' ? res : '');
  el.textContent = res === 'up' || res === 'down' || res === 'split' ? resultName(r.ts, res) : 'result pending';
  el.title = `Official result (${activeVenues().map(V => V.name).join(', ')})`;
  // Kalshi publishes both averages of a round: its target (start) and the settlement value (end)
  const km = KS.on ? KS.meta.get(r.ts) : null;
  const kTxt = (km?.strike != null && km?.settle != null ? `Kalshi ${fmtP(km.strike)} → ${fmtP(km.settle)} (${signedUsd(km.settle - km.strike)}) · ` : '') +
               (r.probs.kalshi?.src === 'candles' ? 'Kalshi probability: 1-minute candles · ' : '');
  $('rv-sub').textContent = r.loading ? 'Loading round…' : r.failed ? 'Could not load this round' :
    (r.strike != null && r.settle != null
      ? `Strike ${fmtP(r.strike)} → settlement avg ${fmtP(r.settle)} (${signedUsd(r.settle - r.strike)}) · ` : '') +
    kTxt + `${S.A.sym}: ${r.src || 'no data'}`;
}
