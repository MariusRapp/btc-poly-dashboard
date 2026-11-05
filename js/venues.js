// Polymarket and Kalshi as two venue objects, their order-book feeds and probability histories.

import { ROUND_MS, S } from './state.js';

// One object per venue. Feeds hold a book each: `cur` = running round, `nxt` = next round (Polymarket preloads
// it and it already trades; Kalshi's next market only opens at the round start, `upcoming` is just its ticker).
// `up` = implied UP probability = book mid, in %; `prob` = its history, trimmed by age, never by count.
function makeVenue(key, name, short) {
  return { key, name, short, on: false, cur: null, nxt: null, upcoming: null,
           up: null, lastProb: null, prob: [], lastPushT: 0,
           archive: new Map(),   // round start (s) → live probability history recorded while it ran
           results: new Map(),   // round start (s) → 'up' | 'down' | 'pending' (official)
           meta: new Map(),      // round start (s) → parsed market
           loading: false, retryT: 0, preloading: false, preloadRetryT: 0 };
}
export const PM = makeVenue('poly', 'Polymarket', 'Poly');
export const KS = makeVenue('kalshi', 'Kalshi', 'Kalshi');
export const VENUES = [PM, KS];
export const activeVenues = () => VENUES.filter(V => V.on);
export const mainVenue = () => S.venueMode === 'kalshi' ? KS : PM;   // the venue the single-venue panels show
export const both = () => S.venueMode === 'both';

export function pushProbPoint(V, pct) {
  const now = Date.now(), h = V.prob;
  if (!Number.isFinite(pct)) return;
  V.lastProb = pct;
  const last = h[h.length - 1];
  const changed = !last || Math.abs(last.p - pct) >= 0.05;
  const enoughTimePassed = now - V.lastPushT >= 100;
  if (!changed && !enoughTimePassed) return;
  if (!enoughTimePassed && last && Math.abs(last.p - pct) < 0.25) return;
  h.push({ t: now, p: pct });
  V.lastPushT = now;
  const cutoff = now - ROUND_MS - 100_000;   // whole round incl. the minute before it
  while (h.length && h[0].t < cutoff) h.shift();
}

// ── Market feeds: one book per round (Polymarket: own socket each; Kalshi: polled) ──
export function makeFeed(m) {
  return { ...m, bids: {}, asks: {}, last: m.last ?? null, fine: m.tick < 0.01, mid: null, ver: 0, hist: [],
           ws: null, state: 'wait', stamp: 'Connecting…', lastMsgT: 0, closed: false };
}

export function closeFeed(f) {
  if (!f) return;
  f.closed = true;
  try { f.ws?.close(); } catch {}
}

// levels keyed by price in 0.1¢ units (an integer), so "0.5" and "0.50" are the same level
export function setLevel(f, side, price, size) {
  const k = Math.round(parseFloat(price) * 1000), sz = parseFloat(size);
  if (!(k > 0 && k < 1000)) return;
  if (k % 10) f.fine = true;             // the market quotes in 0.1¢ ticks (it does near 0¢ and 100¢)
  if (sz > 0) side[k] = sz; else delete side[k];
}

// mid = implied probability: the running round drives the KPI and chart, the next one records its own history
export function onBookChange(V, f) {
  let bb = 0, ba = 1000;
  for (const k in f.bids) if (+k > bb) bb = +k;
  for (const k in f.asks) if (+k < ba) ba = +k;
  f.mid = bb > 0 && ba < 1000 ? (bb + ba) / 2000 : null;
  f.ver++;
  if (f.mid === null) return;
  if (f === V.cur) { V.up = f.mid * 100; pushProbPoint(V, V.up); return; }
  const now = Date.now(), p = f.mid * 100, last = f.hist[f.hist.length - 1];
  if (last && Math.abs(last.p - p) < 0.05 && now - last.t < 1000) return;
  f.hist.push({ t: now, p });
  while (f.hist[0].t < now - 2 * ROUND_MS) f.hist.shift();
}

// the round is over and nothing is ready to take over (load failed, or back from the background):
// stop its feed and drop its book. Polymarket keeps an ended round trading until it resolves,
// and that after-hours book must not pass for the running round's.
export function retireFeed(V, f) {
  if (!f || f.closed) return;
  closeFeed(f);
  f.bids = {}; f.asks = {}; f.mid = null; f.last = null; f.ver++;
  f.stamp = 'Round ended · loading the next market…';
  if (f === V.cur) V.up = V.lastProb = null;
}

// keep a finished round's live probability path for the round menu
export function archiveRound(V) {
  if (!V.cur || !V.prob.length) return;
  V.archive.set(V.cur.wts, V.prob.slice());
  if (V.archive.size > 12) V.archive.delete(V.archive.keys().next().value);
}
