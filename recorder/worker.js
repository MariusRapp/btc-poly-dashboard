// Recorder for the BTC Up/Down dashboard (Cloudflare Worker: Cron Trigger every minute + D1).
//
// Per market and round it stores what the dashboard otherwise only sees while a tab is open: the best bid/ask
// and the model probability 60s before the end, BTC's 60s averages at start and end, the official result and
// Kalshi's published BRTI averages. GET /rounds hands that to the dashboard for calibration, a backtest of the
// model edge and the measured settle-apart risk between the two venues. Read-only public market data, no keys.
//
// Free-plan budget per run: 10 ms CPU, 50 subrequests (D1 included). So: small responses, one D1 batch for all
// writes, and the history backfill in small steps on minutes without a snapshot.
//
// BTC comes from Kraken (BTC/USD trades; Binance answers Cloudflare's network with 403), volatility from
// Coinbase 1-minute candles, as in the dashboard.
import { twap, volFromCloses } from '../js/math.js';
import {
  SERIES, seriesById, snapshotRound, endedRounds, polyTouch, kalshiTouch, polyResult, slugStart, kalshiRound,
  krakenTrades, lastPrice, modelAt, upsert,
} from './lib.js';

const HEADERS = { 'Accept': 'application/json', 'User-Agent': 'btc-recorder/1.0 (+https://github.com/MariusRapp/btc-poly-dashboard)' };
const KRAKEN = 'https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=1000&since=';   // up to 1,000 trades from a time on
const CANDLES = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60';
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2', KS_SERIES = 'KXBTC15M';
const RECENT_S = 2 * 3600;      // results and settlements are looked for over the last two hours
const BACKFILL_S = 14 * 86400;  // official results are backfilled two weeks back (poly15, kalshi15)

// browser origins that may read /rounds (requests without Origin, e.g. curl, are fine too)
const ORIGINS = [/^https:\/\/mariusrapp\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const log = (level, message, extra = {}) => console[level](JSON.stringify({ message, ...extra }));

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
// BTC trades from `sinceS` on (oldest first); starting 30s early gives the price in force when a window opens
const trades = async sinceS => krakenTrades(await getJSON(KRAKEN + sinceS));
const gammaEvents = slugs => getJSON(`${GAMMA}/events?${slugs.map(s => 'slug=' + s).join('&')}`);

// best bid/ask of one round's market
async function polyBook(s, start) {
  const [ev] = await gammaEvents([s.slug + start]);
  const token = ev && JSON.parse(ev.markets?.[0]?.clobTokenIds || '[]')[0];
  if (!token) throw new Error('market not listed');
  return polyTouch(await getJSON(`${CLOB}/book?token_id=${token}`));
}
async function kalshiBook(start) {
  const end = start + 900;
  const d = await getJSON(`${KALSHI}/markets?series_ticker=${KS_SERIES}&min_close_ts=${end}&max_close_ts=${end}`);
  const m = (d.markets || []).find(x => Date.parse(x.close_time) / 1000 === end);
  if (!m) throw new Error('market not listed');
  const ob = await getJSON(`${KALSHI}/markets/${m.ticker}/orderbook`);
  return kalshiTouch(ob.orderbook_fp);
}

export async function record(env, nowMs) {
  const nowS = Math.floor(nowMs / 1000), writes = [], stats = { snapshots: 0, settled: 0, results: 0, backfilled: 0 };
  const put = (series, start, fields) => { const u = upsert(series, start, fields, nowS); if (u) writes.push(u); };

  // 1. Snapshot: market and model about 60s before a round ends
  const due = SERIES.map(s => ({ s, start: snapshotRound(s.len, nowS) })).filter(x => x.start !== null);
  if (due.length) {
    try {
      // the cron fires some seconds into the minute: wait for exactly 60s before the end, the dashboard's moment
      // (all rounds due in one run end together: a 15-minute boundary is also a 5-minute one)
      const endMs = (due[0].start + due[0].s.len) * 1000, wait = endMs - 60_000 - Date.now();
      if (wait > 0 && wait < 30_000) await new Promise(r => setTimeout(r, wait));
      const snapMs = Date.now(), starts = [...new Set(due.map(x => x.start))];
      const [candles, recent, ...atStart] = await Promise.all([
        getJSON(CANDLES), trades(Math.floor(snapMs / 1000) - 90), ...starts.map(st => trades(st - 90)),
      ]);
      const price = lastPrice(recent), vol = volFromCloses(candles.slice(1, 62).map(c => c[4]).reverse());   // newest first; skip the open minute
      const sigma = price !== null && vol !== null ? vol * price : null;
      await Promise.all(due.map(async ({ s, start }) => {
        try {
          const touch = s.venue === 'poly' ? await polyBook(s, start) : await kalshiBook(start);
          const strike = twap(atStart[starts.indexOf(start)], (start - 60) * 1000, start * 1000);
          const observed = snapMs > endMs - 60_000 ? twap(recent, endMs - 60_000, snapMs) : null;
          const model = strike !== null && sigma !== null ? modelAt({ price, strike, sigma, nowMs: snapMs, endMs, observed }) : null;
          put(s.id, start, { snap_t: Math.floor(snapMs / 1000), bid: touch.bid, ask: touch.ask, model, price, sigma, strike });
          stats.snapshots++;
        } catch (e) {
          log('error', 'snapshot failed', { series: s.id, start, error: e.message });
        }
      }));
    } catch (e) {
      log('error', 'snapshot data failed', { error: e.message });   // the rest of the run still goes ahead
    }
  }

  // what the last two hours already have
  // (from one round further back: a round that started before the span but ended inside it belongs to it)
  const { results: recent } = await env.DB.prepare('SELECT series, start, strike, settle, result FROM rounds WHERE start >= ?')
    .bind(nowS - RECENT_S - 900).all();
  const have = new Map(recent.map(r => [`${r.series}|${r.start}`, r]));

  // 2. Settlement average for snapshotted rounds that have ended (poly15 and kalshi15 share their end times)
  const ends = new Map();   // end → rows
  for (const r of recent) {
    const end = r.start + seriesById(r.series).len;
    if (r.settle === null && r.strike !== null && end <= nowS - 2) (ends.get(end) || ends.set(end, []).get(end)).push(r);
  }
  for (const [end, rows] of [...ends].slice(-3)) {
    try {
      const settle = twap(await trades(end - 90), (end - 60) * 1000, end * 1000);
      if (settle !== null) for (const r of rows) { put(r.series, r.start, { settle }); stats.settled++; }
    } catch (e) {
      log('error', 'settle failed', { end, error: e.message });
    }
  }

  // 3. Official results of the last two hours
  for (const s of SERIES.filter(s => s.venue === 'poly')) {
    const missing = endedRounds(s.len, nowS - RECENT_S, nowS - 30).filter(start => !have.get(`${s.id}|${start}`)?.result);
    if (!missing.length) continue;
    try {
      for (const ev of await gammaEvents(missing.slice(0, 20).map(t => s.slug + t))) {
        const res = polyResult(ev);
        if (res) { put(s.id, slugStart(ev.slug), { result: res }); stats.results++; }
      }
    } catch (e) {
      log('error', 'poly results failed', { series: s.id, error: e.message });
    }
  }
  if (endedRounds(900, nowS - RECENT_S, nowS - 5).some(start => !have.get(`kalshi15|${start}`)?.result)) {
    try {
      const d = await getJSON(`${KALSHI}/markets?series_ticker=${KS_SERIES}&status=settled&min_close_ts=${nowS - RECENT_S}&limit=20`);
      for (const m of d.markets || []) {
        const k = kalshiRound(m);
        if (k.result) { put('kalshi15', k.start, k); stats.results++; }
      }
    } catch (e) {
      log('error', 'kalshi results failed', { error: e.message });
    }
  }

  // 4. Backfill of older official results, a small step per run, only on minutes without a snapshot
  if (!due.length) {
    const meta = Object.fromEntries((await env.DB.prepare('SELECT key, value FROM meta').all()).results.map(r => [r.key, r.value]));
    const setMeta = (key, value) => writes.push({ sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', params: [key, String(value)] });
    // Kalshi: settled markets, newest first, 50 a page
    if (meta.kalshi_done !== '1') {
      try {
        const d = await getJSON(`${KALSHI}/markets?series_ticker=${KS_SERIES}&status=settled&limit=50${meta.kalshi_cursor ? '&cursor=' + encodeURIComponent(meta.kalshi_cursor) : ''}`);
        let oldest = Infinity;
        for (const m of d.markets || []) { const k = kalshiRound(m); oldest = Math.min(oldest, k.start); if (k.result) { put('kalshi15', k.start, k); stats.backfilled++; } }
        if (!d.cursor || oldest < nowS - BACKFILL_S) setMeta('kalshi_done', 1);
        else setMeta('kalshi_cursor', d.cursor);
      } catch (e) {
        log('error', 'kalshi backfill failed', { error: e.message });
      }
    }
    // Polymarket 15m: 10 rounds a step (their events are large), walking back from where the last step stopped
    const before = +meta.poly15_before || Math.floor(nowS / 900) * 900 - 900 * 8;
    if (before > nowS - BACKFILL_S) {
      const starts = Array.from({ length: 10 }, (_, i) => before - 900 * (i + 1));
      try {
        for (const ev of await gammaEvents(starts.map(t => 'btc-updown-15m-' + t))) {
          const res = polyResult(ev);
          if (res) { put('poly15', slugStart(ev.slug), { result: res }); stats.backfilled++; }
        }
        setMeta('poly15_before', starts[starts.length - 1]);
      } catch (e) {
        log('error', 'poly backfill failed', { error: e.message });
      }
    }
  }

  if (writes.length) await env.DB.batch(writes.map(w => env.DB.prepare(w.sql).bind(...w.params)));
  log('log', 'recorded', { ...stats, writes: writes.length });
  return stats;
}

function json(body, origin, cache = 'no-store') {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': cache };
  if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' });
  return new Response(JSON.stringify(body), { headers });
}

export default {
  async scheduled(event, env, ctx) {
    // the actual time, not event.scheduledTime: the run starts some seconds after it
    ctx.waitUntil(record(env, Date.now()).catch(e => log('error', 'run failed', { error: e.message })));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin !== null && !ORIGINS.some(r => r.test(origin))) return new Response('origin not allowed', { status: 403 });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    const url = new URL(request.url), nowS = Math.floor(Date.now() / 1000);

    // GET /rounds?series=poly5&days=7 → { cols, rows } (rows as arrays, oldest first)
    if (url.pathname === '/rounds') {
      const s = seriesById(url.searchParams.get('series'));
      if (!s) return new Response('unknown series', { status: 400 });
      const days = Math.max(1, Math.min(30, +url.searchParams.get('days') || 7));
      const cols = ['start', 'snap_t', 'bid', 'ask', 'model', 'price', 'sigma', 'strike', 'settle', 'result', 'k_strike', 'k_settle'];
      const rows = await env.DB.prepare(`SELECT ${cols.join(', ')} FROM rounds WHERE series = ? AND start >= ? ORDER BY start`)
        .bind(s.id, nowS - days * 86400).raw();
      return json({ series: s.id, cols, rows }, origin, 'public, max-age=60');
    }

    // GET /status → rows per series, last snapshot, backfill state
    if (url.pathname === '/status') {
      const { results } = await env.DB.prepare(`SELECT series, COUNT(*) AS rounds, COUNT(snap_t) AS snapshots,
        COUNT(result) AS results, MAX(snap_t) AS last_snapshot, MIN(start) AS first_round FROM rounds GROUP BY series`).all();
      const meta = (await env.DB.prepare('SELECT key, value FROM meta').all()).results;
      return json({ now: nowS, series: results, meta }, origin);
    }

    return new Response('not found', { status: 404 });
  },
};
