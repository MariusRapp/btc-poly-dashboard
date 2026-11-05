// Kalshi (KXBTC15M) through the proxy: book polled once a second, round switch, official results, past rounds.

import { updateTitle } from './mode.js';
import { fetchVol } from './model.js';
import { refreshRounds, setResult } from './rounds.js';
import { ROUNDS_SHOWN, S } from './state.js';
import { currentRound, fmtClock } from './util.js';
import { KS, PM, archiveRound, closeFeed, makeFeed, onBookChange, retireFeed } from './venues.js';

// ── Kalshi ───────────────────────────────────────────────────────────────────
// Series KXBTC15M, "BTC price up in next 15 mins?": Yes if the average of the 60 CF Benchmarks BRTI prints
// before the end is at least the same average before the start — Polymarket's rule on another index. Kalshi
// publishes that start average as the market's target price (floor_strike).
// Its REST API only answers browsers on kalshi.com (CORS) and its WebSocket needs an API key, so requests go
// through a small proxy (kalshi-proxy/, a Cloudflare Worker) and the book is polled once a second.
// ?kalshi=<proxy url> sets another proxy and is remembered in this browser (?kalshi= with nothing clears it).
const KALSHI_PROXY_DEFAULT = 'https://kalshi-proxy.mariusrapp-kit.workers.dev';
export const KALSHI_PROXY = (() => {
  let q = null;
  try { q = new URLSearchParams(location.search).get('kalshi'); } catch {}
  try {
    if (q !== null) q ? localStorage.setItem('kalshi-proxy', q) : localStorage.removeItem('kalshi-proxy');
    q = localStorage.getItem('kalshi-proxy') || q;
  } catch {}
  return (q || KALSHI_PROXY_DEFAULT).replace(/\/+$/, '');
})();
const KS_SERIES = 'KXBTC15M';
// with a timeout: a hung request must not stall the once-a-second poll
const kapi = async path => {
  const url = `${KALSHI_PROXY}/trade-api/v2${path}`, r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
};

function ksParse(m) {
  const last = +m.last_price_dollars;
  return { wts: Date.parse(m.close_time) / 1000 - 900, ticker: m.ticker, question: m.title || 'BTC price up in next 15 mins?',
           status: m.status, strike: m.floor_strike ?? null, settle: m.expiration_value ? +m.expiration_value : null,
           result: m.result === 'yes' ? 'up' : m.result === 'no' ? 'down' : 'pending', last: last > 0 ? last : null };
}

// the market that closes when the round starting at `wts` ends
async function ksMarket(wts) {
  const e = wts + 900;
  const d = await kapi(`/markets?series_ticker=${KS_SERIES}&min_close_ts=${e}&max_close_ts=${e}`);
  const m = (d.markets || []).find(x => Date.parse(x.close_time) / 1000 === e);
  return m ? ksParse(m) : null;
}

function ksNote(m) {
  KS.meta.set(m.wts, m);
  setResult(KS, m.wts, m.result);
}

// official results: one call lists the last rounds with result, target and settlement value
export async function ksRefreshResults() {
  if (!KALSHI_PROXY) return;
  try {
    const d = await kapi(`/markets?series_ticker=${KS_SERIES}&status=settled&limit=${ROUNDS_SHOWN + 4}`);
    for (const x of d.markets || []) ksNote(ksParse(x));
  } catch (e) { console.warn('kalshi results:', e.message); }
}

export async function ksFetchResult(ts) {
  if (!KALSHI_PROXY) return;
  try { const m = await ksMarket(ts); if (m) ksNote(m); } catch {}
}

// book: YES bids are UP bids; a NO bid at q is an UP ask at 1 − q. Prices in 0.1¢ units, like Polymarket's.
function ksSetBook(f, ob) {
  const bids = {}, asks = {};
  for (const [p, s] of ob.yes_dollars || []) { const k = Math.round(p * 1000); if (k > 0 && k < 1000 && +s > 0) bids[k] = +s; }
  for (const [p, s] of ob.no_dollars  || []) { const k = 1000 - Math.round(p * 1000); if (k > 0 && k < 1000 && +s > 0) asks[k] = +s; }
  f.bids = bids; f.asks = asks;
  // Kalshi quotes 0.1¢ steps below 10¢ and above 90¢: 0.1¢ rows only while the touch is out there
  let bb = 0, ba = 1000;
  for (const k in bids) if (+k > bb) bb = +k;
  for (const k in asks) if (+k < ba) ba = +k;
  f.fine = bb >= 900 || ba <= 100;
  onBookChange(KS, f);
}

export let ksTimer = null, ksPolls = 0, ksFails = 0;
export function ksSchedule(ms) { clearTimeout(ksTimer); ksTimer = setTimeout(ksPoll, ms); }

// book every second; the market itself (target price, last trade) every 5th time, more often until the target is out
async function ksPoll() {
  const f = KS.cur;
  if (!KS.on || !f || f.closed) return;
  const n = ksPolls++, withMarket = n % 5 === 0 || (f.strike == null && n % 2 === 0);
  try {
    const [ob, md] = await Promise.all([
      kapi(`/markets/${f.ticker}/orderbook`),
      withMarket ? kapi(`/markets/${f.ticker}`) : null,
    ]);
    if (f !== KS.cur || f.closed) return;
    if (md?.market) {
      const m = ksParse(md.market);
      if (m.strike != null) f.strike = m.strike;
      if (m.last !== null) f.last = m.last;
      f.status = m.status;
    }
    ksSetBook(f, ob.orderbook_fp || {});
    ksFails = 0;
    f.state = 'live'; f.lastMsgT = Date.now(); f.stamp = 'Live · polled ' + fmtClock(f.lastMsgT);
  } catch (e) {
    ksFails++;
    if (f === KS.cur) { f.state = 'err'; f.stamp = 'Proxy unreachable · retrying…'; }
    console.warn('kalshi poll:', e.message);
  } finally {
    if (f === KS.cur && !f.closed) ksSchedule(ksFails ? Math.min(15_000, 1000 * 2 ** ksFails) : document.hidden ? 5000 : 1000);
  }
}

function ksStart(m, backfill) {
  if (KS.cur && KS.cur.wts !== m.wts) archiveRound(KS);
  closeFeed(KS.cur);
  const f = KS.cur = makeFeed(m);
  KS.meta.set(m.wts, m);
  KS.prob.length = 0;
  KS.up = KS.lastProb = null;
  if (KS.upcoming && KS.upcoming.wts <= m.wts) KS.upcoming = null;
  if (backfill) ksBackfillProb(f);
  ksPolls = 0; ksFails = 0;
  ksSchedule(0);
  updateTitle();
}

export async function ksLoad() {
  if (KS.loading) return;
  if (!KALSHI_PROXY) { KS.retryT = Date.now() + 60_000; if (!PM.on) updateTitle('Kalshi needs its proxy — see README'); return; }
  KS.loading = true;
  const gen = S.modeGen, wts = currentRound().start / 1000;
  try {
    if (!PM.on) { fetchVol(); refreshRounds(); }
    const m = await ksMarket(wts);
    if (gen !== S.modeGen || !KS.on) return;
    if (!m) throw new Error('no market for this round yet');
    ksStart(m, true);
  } catch (e) {
    if (gen === S.modeGen) KS.retryT = Date.now() + 8000;
    console.warn('kalshi load:', e.message);
  } finally {
    if (gen === S.modeGen) KS.loading = false;
  }
}

// Kalshi's next market only opens when the round starts: fetch its ticker ahead, switch at the boundary
export function ksCheckSwitch(now) {
  const rs = currentRound(now).start / 1000;
  if (KS.cur && KS.cur.wts >= rs) {
    if (!KS.preloading && now >= KS.preloadRetryT && (!KS.upcoming || KS.upcoming.wts !== KS.cur.wts + 900)) ksPreload();
    return;
  }
  if (KS.loading) return;
  if (KS.upcoming && KS.upcoming.wts === rs) {
    ksStart(KS.upcoming, false);
    if (!PM.on) { fetchVol(); refreshRounds(); }
    return;
  }
  retireFeed(KS, KS.cur);
  if (now >= KS.retryT) ksLoad();
}

async function ksPreload() {
  const wts = KS.cur.wts + 900, gen = S.modeGen;
  KS.preloading = true;
  try {
    const m = await ksMarket(wts);
    if (gen !== S.modeGen) return;
    if (!m) throw new Error('next market not listed yet');
    KS.upcoming = m;
  } catch {
    if (gen === S.modeGen) KS.preloadRetryT = Date.now() + 15_000;
  } finally {
    if (gen === S.modeGen) KS.preloading = false;
  }
}

// one point per minute: mid of each minute's closing YES bid and ask (minutes with an empty side are skipped)
function ksCandlePoints(d) {
  const out = [];
  for (const c of d.candlesticks || []) {
    const b = +c.yes_bid?.close_dollars, a = +c.yes_ask?.close_dollars;
    if (b > 0 && a < 1 && a >= b) out.push({ t: c.end_period_ts * 1000, p: (a + b) / 2 * 100 });
  }
  return out;
}

const ksCandles = (ticker, ts) =>
  kapi(`/series/${KS_SERIES}/markets/${ticker}/candlesticks?start_ts=${ts}&end_ts=${ts + 900}&period_interval=1`);

// probability so far in the running round, from 1-minute candles, ahead of the live points
async function ksBackfillProb(f) {
  try {
    const d = await ksCandles(f.ticker, f.wts);
    if (KS.cur !== f) return;
    const first = KS.prob[0]?.t ?? Infinity, now = Date.now();
    KS.prob.unshift(...ksCandlePoints(d).filter(p => p.t < first && p.t < now));
  } catch {}
}

// a past round: the live mids recorded while it ran, else 1-minute candles. (Its trades would be finer, but a
// round has tens of thousands of them and Kalshi allows only ~5–10 requests a second, shared with the live book.)
export async function ksReviewProb(ts) {
  const arch = KS.archive.get(ts);
  if (arch?.length && arch[0].t <= ts * 1000 + 30_000) return Object.assign(arch.slice(), { src: 'live' });
  let m = KS.meta.get(ts);
  if (!m) { m = await ksMarket(ts); if (!m) return []; KS.meta.set(ts, m); }
  return Object.assign(ksCandlePoints(await ksCandles(m.ticker, ts)), { src: 'candles' });
}
