// Price of the coin in view: trade feeds of six exchanges, their median, and REST backfill after loading or a gap.

import { firstIdx, median } from './math.js';
import { EX, EXCH, MAX_BUF, MED_BUF, S, STALE_MS, medianHistory } from './state.js';
import { getJSON } from './util.js';

// ── Median of exchanges ──────────────────────────────────────────────────────
// median of each enabled exchange's last trade; needs 3 fresh sources (one exchange alone can sit $100+ off)
function medianAt(t) {
  const prices = [];
  let enabled = 0;
  for (const ex of EXCH) {
    if (!ex.enabled) continue;
    enabled++;
    if (ex.lastP !== null && t - ex.lastTT <= STALE_MS) prices.push(ex.lastP);
  }
  return !prices.length || prices.length < Math.min(3, enabled) ? null : median(prices);
}
export const getMedian = () => medianAt(Date.now());

function onTrade(key, tr) {
  const ex = EX[key];
  const last = ex.trades[ex.trades.length - 1];
  tr.t = Math.min(Date.now(), Math.max(tr.t, last ? last.t : 0));
  ex.trades.push(tr);
  if (ex.trades.length > MAX_BUF) ex.trades.splice(0, 2000);
  ex.lastP = tr.p; ex.lastTT = tr.t;
  if (!ex.enabled) return;
  S.tpsCount++;
  const med = medianAt(tr.t);
  if (med === null) return;
  const lastM = medianHistory[medianHistory.length - 1];
  medianHistory.push({ t: Math.max(tr.t, lastM ? lastM.t : 0), p: med });
  if (medianHistory.length > MED_BUF) medianHistory.splice(0, 5000);
  S.lastMedianP = med;
}

// ── Backfill: recent trades over REST so charts, strike and model work right after loading ──
// (Coinbase, Kraken and Binance allow browser requests; Bitstamp answers browsers with 403, Gemini and Bitfinex send no CORS)
async function fetchCoinbaseTrades(since, A) {
  const out = [];
  let after = '';
  for (let page = 0; page < 14; page++) {   // a 15-minute round plus the minute before it
    const d = await getJSON(`https://api.exchange.coinbase.com/products/${A.coinbase}/trades?limit=1000${after}`);
    if (!d.length) break;
    // side is the maker side: maker 'buy' = taker sold
    for (const x of d) out.push({ id: x.trade_id, t: Date.parse(x.time), p: +x.price, q: +x.size, sell: x.side === 'buy' });
    const oldest = d[d.length - 1];
    if (Date.parse(oldest.time) < since) break;
    after = `&after=${oldest.trade_id}`;
  }
  return out.filter(x => x.t >= since).reverse();
}

async function fetchKrakenTrades(since, A) {
  const out = [];
  let cursor = Math.floor(since / 1000);
  for (let page = 0; page < 8; page++) {
    const d = await getJSON(`https://api.kraken.com/0/public/Trades?pair=${A.kraken}&since=${cursor}`);
    const pair = Object.keys(d.result || {}).find(k => k !== 'last');
    const rows = pair ? d.result[pair] : [];
    for (const x of rows) out.push({ t: Math.round(x[2] * 1000), p: +x[0], q: +x[1], sell: x[3] === 's' });
    if (rows.length < 1000) break;
    cursor = d.result.last;
  }
  return out;
}

async function fetchBinanceTrades(since, A) {
  const get = q => getJSON(`https://api.binance.com/api/v3/aggTrades?symbol=${A.binance}&limit=1000&${q}`)
    .catch(() => getJSON(`https://data-api.binance.vision/api/v3/aggTrades?symbol=${A.binance}&limit=1000&${q}`));
  const out = [];
  let q = `startTime=${since}`;
  for (let page = 0; page < 24; page++) {
    const d = await get(q);
    for (const x of d) out.push({ id: x.a, t: x.T, p: +x.p * S.usdtUsd, q: +x.q, sell: x.m });
    if (d.length < 1000) break;
    q = `fromId=${d[d.length - 1].a + 1}`;
  }
  return out;
}

export async function seedUsdt() {
  try {
    const p = +(await getJSON('https://api.exchange.coinbase.com/products/USDT-USD/ticker')).price;
    if (p > 0.9 && p < 1.1) S.usdtUsd = p;
  } catch {}
}

// merge fetched trades into an exchange's history (dedupe by trade id, or time|price|size)
function mergeTrades(ex, list) {
  const key = tr => tr.id ?? `${tr.t}|${tr.p}|${tr.q}`;
  const seen = new Set(ex.trades.map(key));
  let added = 0;
  for (const tr of list) if (!seen.has(key(tr))) { ex.trades.push(tr); seen.add(key(tr)); added++; }
  if (added) ex.trades.sort((a, b) => a.t - b.t);
  return added;
}

// replay all trades from `from` on through the median logic (after a backfill filled history or a gap)
function rebuildMedian(from) {
  const warm = from - STALE_MS, evs = [];
  for (const ex of EXCH) {
    const i0 = firstIdx(ex.trades, warm);
    const prev = ex.trades[i0 - 1];
    ex.lastP = prev ? prev.p : null; ex.lastTT = prev ? prev.t : 0;
    for (let i = i0; i < ex.trades.length; i++) evs.push([ex.trades[i], ex]);
  }
  evs.sort((a, b) => a[0].t - b[0].t);
  const keep = firstIdx(medianHistory, from);
  medianHistory.length = keep;
  let lastT = keep ? medianHistory[keep - 1].t : 0;
  for (const [tr, ex] of evs) {
    ex.lastP = tr.p; ex.lastTT = tr.t;
    if (!ex.enabled || tr.t < from) continue;
    const m = medianAt(tr.t);
    if (m === null) continue;
    lastT = Math.max(lastT, tr.t);
    medianHistory.push({ t: lastT, p: m });
  }
  S.lastMedianP = getMedian() ?? S.lastMedianP;
}

// one backfill at a time per coin; one for a coin no longer in view is dropped when it lands
let backfilling = null;
export async function backfill(since) {
  if (backfilling === S.assetGen) return;
  const gen = backfilling = S.assetGen, A = S.A;
  try {
    await seedUsdt();
    const jobs = [['coinbase', fetchCoinbaseTrades], ['kraken', fetchKrakenTrades], ['binance', fetchBinanceTrades]];
    const res = await Promise.allSettled(jobs.map(([, f]) => f(since, A)));
    if (gen !== S.assetGen) return;
    let added = 0;
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') added += mergeTrades(EX[jobs[i][0]], r.value);
      else console.warn('backfill', jobs[i][0], r.reason?.message);
    });
    if (added) rebuildMedian(since);
  } finally {
    if (backfilling === gen) backfilling = null;
  }
}

// ── Exchange WebSocket feeds ─────────────────────────────────────────────────
// one socket per exchange; reconnects on close, the watchdog below closes silent ones
function openFeed(key, url, subscribe, makeHandler) {
  const ex = EX[key], ws = new WebSocket(url), handle = makeHandler();
  ex.ws = ws;
  ws.onopen = () => { ex.lastMsgT = Date.now(); if (subscribe) ws.send(JSON.stringify(subscribe)); };
  ws.onmessage = e => {
    if (ex.ws !== ws) return;   // replaced (another coin): late messages are not this coin's trades
    ex.lastMsgT = Date.now();
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    handle(d);
  };
  ws.onclose = () => {
    if (ex.ws !== ws) return;
    ex.ws = null;
    const gen = S.assetGen;
    setTimeout(() => { if (gen === S.assetGen) openFeed(key, url, subscribe, makeHandler); }, 2500);   // unless another coin took over
  };
  ws.onerror = () => ws.close();
}

// another coin: close every feed, forget its trades and median, and connect the new coin's feeds
export function switchExchanges() {
  for (const ex of EXCH) {
    const ws = ex.ws;
    ex.ws = null;               // its onclose then does not reconnect
    try { ws?.close(); } catch {}
    ex.trades = []; ex.lastP = null; ex.lastTT = 0; ex.lastMsgT = 0;
  }
  medianHistory.length = 0;
  S.lastMedianP = null;
  connectExchanges();
}

export function connectExchanges() {
  const A = S.A;
  openFeed('coinbase', 'wss://ws-feed.exchange.coinbase.com',
    { type:'subscribe', channels:['matches'], product_ids:[A.coinbase, 'USDT-USD'] },
    () => d => {
      if (d.type !== 'match') return;   // skips last_match, a stale replay on subscribe
      if (d.product_id === 'USDT-USD') { const p = parseFloat(d.price); if (p > 0.9 && p < 1.1) S.usdtUsd = p; return; }
      // side is the maker side: maker 'buy' = taker sold
      onTrade('coinbase', { id: d.trade_id, t: Date.parse(d.time), p: parseFloat(d.price), q: parseFloat(d.size), sell: d.side === 'buy' });
    });

  openFeed('kraken', 'wss://ws.kraken.com',
    { event:'subscribe', pair:[A.krakenWs], subscription:{ name:'trade' } },
    () => d => {
      if (!Array.isArray(d) || d[2] !== 'trade') return;
      for (const t of d[1])
        onTrade('kraken', { t: Math.round(parseFloat(t[2]) * 1000), p: parseFloat(t[0]), q: parseFloat(t[1]), sell: t[3] === 's' });
    });

  openFeed('bitstamp', 'wss://ws.bitstamp.net',
    { event:'bts:subscribe', data:{ channel:'live_trades_' + A.bitstamp } },
    () => d => {
      if (d.event !== 'trade') return;
      const td = d.data;
      onTrade('bitstamp', { id: td.id, t: Math.round(+td.microtimestamp / 1000), p: +td.price, q: +td.amount, sell: td.type === 1 });
    });

  openFeed('gemini', 'wss://api.gemini.com/v1/marketdata/' + A.gemini, null,
    () => d => {
      if (d.type !== 'update') return;
      for (const ev of (d.events || [])) {
        if (ev.type !== 'trade') continue;
        onTrade('gemini', { id: ev.tid, t: d.timestampms || Date.now(), p: parseFloat(ev.price), q: parseFloat(ev.amount), sell: ev.makerSide === 'bid' });
      }
    });

  // <coin>/USDt, not <coin>/USD: dollars on Bitfinex are hard to withdraw and trade ~0.15% below bank dollars,
  // so its USD pair sits $100+ above everyone else. Via USDt and Coinbase's USDT-USD rate it is in line.
  openFeed('bitfinex', 'wss://api-pub.bitfinex.com/ws/2',
    { event:'subscribe', channel:'trades', symbol:A.bitfinex },
    () => {
      let chanId = null;
      return d => {
        if (d.event === 'subscribed' && d.channel === 'trades') { chanId = d.chanId; return; }
        if (!Array.isArray(d) || d[0] !== chanId || d[1] !== 'te') return;
        const t = d[2]; // [ID, timestamp_ms, amount, price]
        onTrade('bitfinex', { id: t[0], t: t[1], p: t[3] * S.usdtUsd, q: Math.abs(t[2]), sell: t[2] < 0 });
      };
    });

  openFeed('binance', `wss://stream.binance.com:9443/ws/${A.binance.toLowerCase()}@aggTrade`, null,
    () => d => {
      if (d.e !== 'aggTrade') return;
      onTrade('binance', { id: d.a, t: d.T, p: parseFloat(d.p) * S.usdtUsd, q: parseFloat(d.q), sell: d.m });
    });
}
