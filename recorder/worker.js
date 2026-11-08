// Recorder for the Up/Down dashboard (Cloudflare Worker: Cron Trigger every minute + D1).
//
// Every minute, for every coin (js/assets.js) and market (Polymarket 5 and 15 minutes, Kalshi 15 minutes), it takes
// a snapshot of the running round: best bid and ask and the size there, the price, the volatilities and the model
// (table snaps). The snapshot about 60s before the end also goes into the round's own row (rounds), together with
// the 60s averages at start and end, the official result and Kalshi's published index averages. GET /rounds and
// GET /snaps hand that to the dashboard. Read-only public market data, no keys.
//
// Free-plan budget per run: 10 ms CPU, 50 subrequests (D1 included). So: all Polymarket books in one call, the
// market ids kept in D1 (looked up once per round), Kalshi books at depth 1, small trade pages, one D1 batch for
// all writes, and the history backfill one small step every other run.
//
// Prices: Bitcoin from Kraken BTC/USD trades (Binance answers Cloudflare's network with 403). The other coins trade
// too rarely on Kraken alone (Dogecoin: a trade every 30s, gaps of two minutes), so their trades from Kraken and
// Coinbase are merged. Volatility from Coinbase 1-minute candles, as in the dashboard.
import { ASSETS } from '../js/assets.js';
import { twap } from '../js/math.js';
import { volsFromCloses } from '../js/models.js';
import {
  SERIES, seriesById, runningRound, isFinalSnapshot, endedRounds, polyTouch, kalshiTouch, polyResult, polyToken, slugStart,
  kalshiRound, krakenTrades, lastPrice, tradeVelocity, modelAt, upsertMany, snapsInsert, sig, COLUMNS, MODEL_INPUTS, BOOK_EXTRA,
  SNAP_COLUMNS, SQL,
} from './lib.js';

const HEADERS = { 'Accept': 'application/json', 'User-Agent': 'btc-recorder/1.0 (+https://github.com/MariusRapp/btc-poly-dashboard)' };
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const RECENT_S = 2 * 3600;      // results and settlements are looked for over the last two hours
const BACKFILL_S = 14 * 86400;  // official 15-minute results are backfilled two weeks back
// trades per coin: Kraken from `kw` seconds back, plus Coinbase's latest `cb` trades (0 = none); sized to cover the
// last minute and a half with room, at a few kB each
const TAPE = { btc: { kw: 90, cb: 0 }, eth: { kw: 300, cb: 300 }, sol: { kw: 300, cb: 150 }, xrp: { kw: 300, cb: 150 }, doge: { kw: 900, cb: 100 } };

// browser origins that may read the data (requests without Origin, e.g. curl, are fine too)
const ORIGINS = [/^https:\/\/mariusrapp\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const log = (level, message, extra = {}) => console[level](JSON.stringify({ message, ...extra }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ── Trades ───────────────────────────────────────────────────────────────────
// Kraken from `sinceS` on (oldest first), a second page when a busy minute fills the first
async function kraken(pair, sinceS) {
  const url = s => `https://api.kraken.com/0/public/Trades?pair=${pair}&count=1000&since=${s}`;
  const d = await getJSON(url(sinceS));
  let out = krakenTrades(d);
  if (out.length >= 1000 && d.result?.last) out = out.concat(krakenTrades(await getJSON(url(d.result.last))));
  return out;
}
// Coinbase's latest `n` trades (oldest first)
async function coinbase(product, n) {
  const d = await getJSON(`https://api.exchange.coinbase.com/products/${product}/trades?limit=${n}`);
  return d.map(x => ({ t: Date.parse(x.time), p: +x.price })).reverse();
}
// A coin's tape: its trades, oldest first, complete from `from` (ms) up to the time it was fetched
async function tape(a, nowMs) {
  const { kw, cb } = TAPE[a.id], sinceS = Math.floor(nowMs / 1000) - kw;
  const [k, c] = await Promise.allSettled([kraken(a.kraken, sinceS), cb ? coinbase(a.coinbase, cb) : Promise.resolve(null)]);
  const parts = [];
  if (k.status === 'fulfilled') parts.push({ trades: k.value, from: sinceS * 1000 });
  else log('error', 'kraken trades failed', { asset: a.id, error: k.reason?.message });
  if (c.status === 'fulfilled' && c.value?.length) parts.push({ trades: c.value, from: c.value[0].t });
  else if (c.status === 'rejected') log('error', 'coinbase trades failed', { asset: a.id, error: c.reason?.message });
  if (!parts.length) return null;
  return { trades: parts.flatMap(x => x.trades).sort((x, y) => x.t - y.t), from: Math.max(...parts.map(x => x.from)) };
}
// 60s average over [a, b] ms from a tape, when the tape covers it
const tapeAvg = (tp, a, b) => tp && tp.from <= a ? twap(tp.trades, a, b) : null;

// ── Markets ──────────────────────────────────────────────────────────────────
const gammaEvents = slugs => slugs.length ? getJSON(`${GAMMA}/events?${slugs.map(s => 'slug=' + s).join('&')}`) : Promise.resolve([]);
// Kalshi markets of a coin's series that closed in [fromS, toS]: results, published averages, tickers
// Kalshi answers about 5–10 requests a second per IP, and Cloudflare's outgoing IPs are shared with other Workers.
// So its requests go out one at a time, 150 ms apart, and once more after a second when it answers 429.
let ksSlot = 0;
async function kalshiGet(url) {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now(), slot = Math.max(now, ksSlot + 150);
    ksSlot = slot;
    if (slot > now) await sleep(slot - now);
    try { return await getJSON(url); }
    catch (e) { if (attempt || !/^429 /.test(e.message)) throw e; await sleep(1000); }
  }
}
const kalshiMarkets = (series, fromS, toS, limit = 20) =>
  kalshiGet(`${KALSHI}/markets?series_ticker=${series}&min_close_ts=${fromS}&max_close_ts=${toS}&limit=${limit}`).then(d => d.markets || []);

export async function record(env, nowMs0) {
  // the cron fires on the minute, give or take a second: snapshot on the minute
  const mark = Math.round(nowMs0 / 60_000) * 60_000, wait = mark - Date.now();
  if (wait > 0 && wait < 20_000) await sleep(wait);
  // (a few ms short of the mark must not count as the last second of the previous minute)
  const snapMs = Date.now(), nowS = Math.abs(snapMs - mark) < 5000 ? mark / 1000 : Math.floor(snapMs / 1000);
  const writes = [], stats = { snaps: 0, final: 0, settled: 0, results: 0, backfilled: 0 };
  const put = (series, start, fields) => writes.push({ series, start, fields });

  // what D1 has for the last two hours: strike, settlement, result, market id
  const { results: rows } = await env.DB.prepare(SQL.recent).bind(nowS - RECENT_S - 900).all();   // ~225 rows, by the primary key
  const have = new Map(rows.map(r => [`${r.series}|${r.start}`, r]));
  const row = (s, start) => have.get(`${s.id}|${start}`);

  // 1. per coin: its trades of the last minutes and the volatilities from 1-minute candles
  const coins = new Map(await Promise.all(ASSETS.map(async a => {
    const [tp, cd] = await Promise.allSettled([tape(a, snapMs),
      getJSON(`https://api.exchange.coinbase.com/products/${a.coinbase}/candles?granularity=60`)]);
    if (cd.status === 'rejected') log('error', 'candles failed', { asset: a.id, error: cd.reason?.message });
    return [a.id, { tape: tp.status === 'fulfilled' ? tp.value : null,
                    vols: cd.status === 'fulfilled' ? volsFromCloses(cd.value.slice(1).map(c => c[4]).reverse()) : null }];
  })));

  // 2. the running round of every market, and its id: Polymarket's UP token (one Gamma call for all that lack it),
  //    Kalshi's ticker (with the coin's recent markets, which also bring results)
  const runs = SERIES.map(s => ({ s, ...runningRound(s.len, nowS) })).filter(r => r.left >= 30);
  for (const r of runs) r.token = row(r.s, r.start)?.token ?? null;
  const needToken = runs.filter(r => r.s.venue === 'poly' && !r.token);
  try {
    const bySlug = new Map((await gammaEvents(needToken.map(r => r.s.slug + r.start))).map(e => [e.slug, e]));
    for (const r of needToken) { r.token = polyToken(bySlug.get(r.s.slug + r.start)?.markets?.[0]); r.newToken = !!r.token; }
  } catch (e) {
    log('error', 'gamma tokens failed', { error: e.message });
  }
  // Kalshi: a coin's markets of the last two hours when its running ticker is unknown or a result is missing
  const ksRuns = runs.filter(r => r.s.venue === 'kalshi');
  await Promise.all(ksRuns.map(async r => {
    const s = r.s, missing = endedRounds(900, nowS - RECENT_S, nowS - 5).some(st => !row(s, st)?.result);
    if (r.token && !missing) return;
    try {
      for (const m of await kalshiMarkets(s.ticker, nowS - RECENT_S, r.start + 900)) {
        const k = kalshiRound(m);
        if (k.start === r.start) { if (!r.token) { r.token = m.ticker; r.newToken = true; } continue; }
        if (k.result && !row(s, k.start)?.result) { put(s.id, k.start, k); stats.results++; }
      }
    } catch (e) {
      log('error', 'kalshi markets failed', { series: s.id, error: e.message });
    }
  }));

  // 3. books: all Polymarket tokens in one call, Kalshi at depth 1
  const touches = new Map();
  const polyRuns = runs.filter(r => r.s.venue === 'poly' && r.token);
  await Promise.all([
    (async () => {
      if (!polyRuns.length) return;
      try {
        const books = await getJSON(`${CLOB}/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(polyRuns.map(r => ({ token_id: r.token }))) });
        const byToken = new Map(books.map(b => [b.asset_id, b]));   // not in the order asked
        for (const r of polyRuns) if (byToken.has(r.token)) touches.set(r, polyTouch(byToken.get(r.token)));
      } catch (e) {
        log('error', 'poly books failed', { error: e.message });
      }
    })(),
    ...ksRuns.filter(r => r.token).map(async r => {
      try { touches.set(r, kalshiTouch((await kalshiGet(`${KALSHI}/markets/${r.token}/orderbook?depth=1`)).orderbook_fp)); }
      catch (e) { log('error', 'kalshi book failed', { series: r.s.id, error: e.message }); }
    }),
  ]);

  // 4. per running round: the strike (once, from the minute the round started), the model and the snapshot
  const strikeFetches = new Map();   // asset|start → promise, for a round whose first minute was missed (at most 5)
  for (const r of runs) {
    const { s } = r, c = coins.get(s.asset.id), have0 = row(s, r.start);
    let strike = have0?.strike ?? tapeAvg(c.tape, (r.start - 60) * 1000, r.start * 1000);
    if (strike == null && strikeFetches.size < 5) {
      const key = s.asset.id + '|' + r.start;
      if (!strikeFetches.has(key)) strikeFetches.set(key, kraken(s.asset.kraken, r.start - Math.max(90, TAPE[s.asset.id].kw))
        .then(tr => twap(tr, (r.start - 60) * 1000, r.start * 1000)).catch(() => null));
      strike = await strikeFetches.get(key);
    }
    r.strike = strike;
    const newStrike = strike != null && have0?.strike == null;
    if (newStrike || r.newToken) put(s.id, r.start, { strike: newStrike ? sig(strike, 8) : null, token: r.newToken ? r.token : null });

    const touch = touches.get(r);
    if (!touch) continue;
    const tp = c.tape, price = tp ? lastPrice(tp.trades) : null, v = c.vols;
    const sigma = price !== null && v?.h60 != null ? v.h60 * price : null, endMs = (r.start + s.len) * 1000;
    const model = strike != null && sigma !== null ? modelAt({ price, strike, sigma, nowMs: snapMs, endMs }) : null;
    const f = {
      bid: touch.bid, ask: touch.ask, bid_sz: sig(touch.bid_sz, 5), ask_sz: sig(touch.ask_sz, 5),
      price: sig(price, 8), sigma: sig(sigma, 5), vol15: sig(v?.h15, 4), vol240: sig(v?.h240, 4), ewma: sig(v?.ewma, 4),
      vel: tp ? sig(tradeVelocity(tp.trades, snapMs), 4) : null, model: sig(model, 5),
    };
    writes.push({ snap: true, series: s.id, start: r.start, t: nowS, fields: f });
    stats.snaps++;
    if (isFinalSnapshot(r.left)) {
      put(s.id, r.start, { snap_t: nowS, ...f, strike: strike != null ? sig(strike, 8) : null });
      stats.final++;
    }
  }

  // 5. settlement average of rounds that have ended: from the same trades right after the end, else fetched (at most 3)
  const ends = new Map();   // asset|end → rows
  for (const rr of rows) {
    const s = seriesById(rr.series);
    if (!s || rr.settle !== null || rr.strike === null) continue;
    const end = rr.start + s.len;
    if (end > nowS - 2) continue;
    const key = s.asset.id + '|' + end;
    (ends.get(key) || ends.set(key, { a: s.asset, end, rows: [] }).get(key)).rows.push(rr);
  }
  let fetched = 0;
  for (const { a, end, rows: rs } of ends.values()) {
    let settle = tapeAvg(coins.get(a.id).tape, (end - 60) * 1000, end * 1000);
    if (settle == null && fetched < 3) {
      fetched++;
      try { settle = twap(await kraken(a.kraken, end - Math.max(90, TAPE[a.id].kw)), (end - 60) * 1000, end * 1000); }
      catch (e) { log('error', 'settle failed', { asset: a.id, end, error: e.message }); }
    }
    if (settle != null) for (const rr of rs) { put(rr.series, rr.start, { settle: sig(settle, 8) }); stats.settled++; }
  }

  // 6. official Polymarket results of the last two hours: the missing ones in one call (newest first, at most 20)
  const missing = SERIES.filter(s => s.venue === 'poly').flatMap(s =>
    endedRounds(s.len, nowS - RECENT_S, nowS - 30).filter(st => !row(s, st)?.result).map(st => ({ s, st })))
    .sort((x, y) => y.st - x.st).slice(0, 20);
  if (missing.length) {
    try {
      const bySlug = new Map(missing.map(x => [x.s.slug + x.st, x.s]));
      for (const ev of await gammaEvents([...bySlug.keys()])) {
        const res = polyResult(ev), s = bySlug.get(ev.slug);
        if (res && s) { put(s.id, slugStart(ev.slug), { result: res }); stats.results++; }
      }
    } catch (e) {
      log('error', 'poly results failed', { error: e.message });
    }
  }

  // 7. backfill of older official 15-minute results, one step every other run, coin after coin
  if (Math.floor(nowS / 60) % 2 === 1) await backfillStep(env, nowS, writes, stats);

  await flush(env, writes, nowS);
  log('log', 'recorded', { ...stats, writes: writes.length });
  return stats;
}

// Kalshi: settled markets newest first, 50 a page; Polymarket 15m: 10 rounds a step walking back. Bitcoin's progress
// keys keep their old names (kalshi_cursor, kalshi_done, poly15_before), the other coins' are prefixed (eth_…).
async function backfillStep(env, nowS, writes, stats) {
  const meta = Object.fromEntries((await env.DB.prepare('SELECT key, value FROM meta').all()).results.map(r => [r.key, r.value]));
  const setMeta = (key, value) => writes.push({ sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', params: [key, String(value)] });
  const put = (series, start, fields) => writes.push({ series, start, fields });
  const tasks = [];
  for (const a of ASSETS) {
    const pre = a.id === 'btc' ? '' : a.id + '_';
    const ks = SERIES.find(s => s.asset === a && s.venue === 'kalshi'), p15 = SERIES.find(s => s.asset === a && s.venue === 'poly' && s.len === 900);
    if (meta[pre + 'kalshi_done'] !== '1') tasks.push(async () => {
      const cur = meta[pre + 'kalshi_cursor'];
      const d = await kalshiGet(`${KALSHI}/markets?series_ticker=${a.kalshi}&status=settled&limit=50${cur ? '&cursor=' + encodeURIComponent(cur) : ''}`);
      let oldest = Infinity;
      for (const m of d.markets || []) { const k = kalshiRound(m); oldest = Math.min(oldest, k.start); if (k.result) { put(ks.id, k.start, k); stats.backfilled++; } }
      if (!d.cursor || oldest < nowS - BACKFILL_S) setMeta(pre + 'kalshi_done', 1);
      else setMeta(pre + 'kalshi_cursor', d.cursor);
    });
    const before = +meta[pre + 'poly15_before'] || Math.floor(nowS / 900) * 900 - 900 * 8;
    if (before > nowS - BACKFILL_S) tasks.push(async () => {
      const starts = Array.from({ length: 10 }, (_, i) => before - 900 * (i + 1));
      for (const ev of await gammaEvents(starts.map(t => p15.slug + t))) {
        const res = polyResult(ev);
        if (res) { put(p15.id, slugStart(ev.slug), { result: res }); stats.backfilled++; }
      }
      setMeta(pre + 'poly15_before', starts[starts.length - 1]);
    });
  }
  if (!tasks.length) return;
  try { await tasks[Math.floor(nowS / 120) % tasks.length](); }
  catch (e) { log('error', 'backfill failed', { error: e.message }); }
}

// One batch for every write: all rounds in one statement, all snapshots in another, plus the backfill progress.
// Without migrations/0003 the snapshots and the book columns are left out, without migrations/0002 also the model
// inputs (each with a reminder in the log).
async function flush(env, writes, nowS) {
  const rounds = writes.filter(w => !w.snap && !w.sql), snaps = writes.filter(w => w.snap), other = writes.filter(w => w.sql);
  const attempt = (cols, withSnaps) => {
    const list = [upsertMany(rounds, nowS, cols), withSnaps ? snapsInsert(snaps) : null, ...other].filter(Boolean);
    return list.length ? env.DB.batch(list.map(x => x.params ? env.DB.prepare(x.sql).bind(...x.params) : env.DB.prepare(x.sql))) : null;
  };
  const schemaErr = e => /no such table|no column|has no column/i.test(e.message);
  try { return await attempt(COLUMNS, true); }
  catch (e) { if (!schemaErr(e)) throw e; log('error', 'recorder v3 tables missing: run npm run migrate:3 in recorder/', { error: e.message }); }
  try { return await attempt(COLUMNS.filter(c => !BOOK_EXTRA.includes(c)), false); }
  catch (e) { if (!schemaErr(e)) throw e; log('error', 'model-input columns missing: run npm run migrate in recorder/', { error: e.message }); }
  return attempt(COLUMNS.filter(c => !BOOK_EXTRA.includes(c) && !MODEL_INPUTS.includes(c)), false);
}

function reply(body, origin, { status = 200, cache = 'no-store' } = {}) {
  const headers = { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'Cache-Control': cache };
  if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

// columns of /rounds, newest schema first (the market id stays in D1)
const ROUND_COLS = [COLUMNS.filter(c => c !== 'token'), COLUMNS.filter(c => !BOOK_EXTRA.includes(c)),
                    COLUMNS.filter(c => !BOOK_EXTRA.includes(c) && !MODEL_INPUTS.includes(c))];
const SNAP_COLS = ['start', 't', ...SNAP_COLUMNS];

// how far back a request reaches: ?hours=3 (the dashboard's refresh between full loads) or ?days=7
function since(url, nowS, defDays, maxDays) {
  const h = +url.searchParams.get('hours');
  if (h > 0) return nowS - Math.min(h, 48) * 3600;
  return nowS - Math.max(1, Math.min(maxDays, +url.searchParams.get('days') || defDays)) * 86400;
}

export default {
  async scheduled(event, env, ctx) {
    // the actual time, not event.scheduledTime: the run starts some seconds after it
    ctx.waitUntil(record(env, Date.now()).catch(e => log('error', 'run failed', { error: e.message })));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin !== null && !ORIGINS.some(r => r.test(origin))) return new Response('origin not allowed', { status: 403 });
    if (request.method !== 'GET') return reply('method not allowed', origin, { status: 405 });
    const url = new URL(request.url), nowS = Math.floor(Date.now() / 1000);
    const s = seriesById(url.searchParams.get('series'));

    // GET /rounds?series=poly5&days=7 (or &hours=3) → { cols, rows } (rows as arrays, oldest first)
    if (url.pathname === '/rounds') {
      if (!s) return reply('unknown series', origin, { status: 400 });
      const from = since(url, nowS, 7, 30);
      for (const c of ROUND_COLS) {
        const cols = ['start', ...c];
        try {
          const rows = await env.DB.prepare(SQL.rounds(cols)).bind(s.id, from).raw();
          return reply({ series: s.id, cols, rows }, origin, { cache: 'public, max-age=60' });
        } catch {}
      }
      return reply('database error', origin, { status: 500 });
    }

    // GET /snaps?series=poly5&days=3 (or &hours=1) → { cols, rows }: every minute's snapshot with its round's strike and
    // result. Two lookups by the primary key, joined here: a JOIN in SQL would read a rounds row again for every snapshot.
    if (url.pathname === '/snaps') {
      if (!s) return reply('unknown series', origin, { status: 400 });
      const from = since(url, nowS, 3, 14);
      try {
        const [snaps, outcomes] = await Promise.all([env.DB.prepare(SQL.snaps(SNAP_COLS)).bind(s.id, from).raw(),
                                                     env.DB.prepare(SQL.outcomes).bind(s.id, from).raw()]);
        const by = new Map(outcomes.map(r => [r[0], r]));
        const rows = snaps.map(r => { const o = by.get(r[0]); return [...r, o ? o[1] : null, o ? o[2] : null]; });
        return reply({ series: s.id, len: s.len, cols: [...SNAP_COLS, 'strike', 'result'], rows }, origin, { cache: 'public, max-age=60' });
      } catch {
        return reply('no snapshots yet (recorder v3: npm run migrate:3)', origin, { status: 503 });
      }
    }

    // GET /status → rows per series over the last 24 hours, snapshots of the last hour, backfill state
    if (url.pathname === '/status') {
      const { results } = await env.DB.prepare(SQL.statusRounds).bind(nowS - 86400).all();
      let snaps = null;
      try { snaps = (await env.DB.prepare(SQL.statusSnaps).bind(nowS - 3600).all()).results; } catch {}
      const meta = (await env.DB.prepare('SELECT key, value FROM meta').all()).results;
      return reply({ now: nowS, window: { rounds: '24 h', snaps: '1 h' }, series: results, snaps, meta }, origin);
    }

    return reply('not found', origin, { status: 404 });
  },
};
