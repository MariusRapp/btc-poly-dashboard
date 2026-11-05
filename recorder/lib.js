// Pure helpers of the recorder Worker: which round to snapshot, parsing books and results, BTC averages,
// the model at the snapshot, upsert SQL. No I/O; covered by recorder/lib.test.js.
import { firstIdx, probAbove, settlementDist, twap } from '../js/math.js';

// the three markets the dashboard shows; ids match the dashboard's track stores
export const SERIES = [
  { id: 'poly5',    venue: 'poly',   len: 300, slug: 'btc-updown-5m-' },
  { id: 'poly15',   venue: 'poly',   len: 900, slug: 'btc-updown-15m-' },
  { id: 'kalshi15', venue: 'kalshi', len: 900 },
];
export const seriesById = id => SERIES.find(s => s.id === id);

// The round whose market is snapshotted on this run: the one ending 30–90s from now. The cron fires once a
// minute, shortly after :00, so this is the run about 60s before the end (the dashboard's track record moment).
export function snapshotRound(len, nowS) {
  const end = Math.ceil(nowS / len) * len, left = end - nowS;
  return left > 30 && left <= 90 ? end - len : null;
}

// start times of the rounds that ended after `fromS` (and by `nowS`), newest first
export function endedRounds(len, fromS, nowS) {
  const out = [];
  for (let start = Math.floor(nowS / len) * len - len; start + len > fromS; start -= len) out.push(start);
  return out;
}

// Polymarket CLOB /book: bids and asks as [{ price, size }] strings → best UP bid and ask (0..1)
export function polyTouch(book) {
  const prices = side => (side || []).filter(x => +x.size > 0).map(x => +x.price).filter(p => p > 0 && p < 1);
  const bids = prices(book?.bids), asks = prices(book?.asks);
  return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
}

// Kalshi orderbook_fp: yes_dollars / no_dollars as [price, size]; the YES (UP) ask is 1 − the best NO bid
export function kalshiTouch(ob) {
  const best = side => { let m = 0; for (const [p, s] of side || []) if (+s > 0 && +p > m) m = +p; return m || null; };
  const yes = best(ob?.yes_dollars), no = best(ob?.no_dollars);
  return { bid: yes, ask: no === null ? null : Math.round((1 - no) * 10000) / 10000 };
}

// Polymarket Gamma event → official result once the market is closed ('up' | 'down'), else null
export function polyResult(event) {
  const m = event?.markets?.[0];
  if (!m?.closed) return null;
  const outcomes = JSON.parse(m.outcomes || '[]'), prices = JSON.parse(m.outcomePrices || '[]').map(Number);
  const win = outcomes[prices.indexOf(1)];
  return win === 'Up' ? 'up' : win === 'Down' ? 'down' : null;
}
export const slugStart = slug => +slug.slice(slug.lastIndexOf('-') + 1);

// Kalshi market → round start, official result and the two published BRTI 60s averages
export function kalshiRound(m) {
  return {
    start: Date.parse(m.close_time) / 1000 - 900,
    result: m.result === 'yes' ? 'up' : m.result === 'no' ? 'down' : null,
    k_strike: m.floor_strike ?? null,
    k_settle: m.expiration_value ? +m.expiration_value : null,
  };
}

// Kraken /0/public/Trades → [{ t: ms, p }], oldest first ([price, volume, time s, side, type, misc, id] per trade)
export function krakenTrades(d) {
  const pair = Object.keys(d?.result || {}).find(k => k !== 'last');
  return (pair ? d.result[pair] : []).map(x => ({ t: Math.round(x[2] * 1000), p: +x[0] }));
}
// BTC 60s average over [a, b) ms: time-weighted average of the trade prices, as the dashboard computes it;
// null when the trades start more than 10s into the window
export const windowAvg = (trades, a, b) => twap(trades, a, b);
export const lastPrice = trades => trades.length ? trades[trades.length - 1].p : null;

// BTC's speed in $/s over the last `span` ms: the latest price against the one in force `span` earlier
export function tradeVelocity(trades, nowMs, span = 60_000) {
  const i = firstIdx(trades, nowMs - span + 1) - 1;
  return i < 0 || !trades.length ? null : (trades[trades.length - 1].p - trades[i].p) / (span / 1000);
}

// model P(up) at the snapshot: the dashboard's model, on Binance BTC/USDT (strike and price share the basis)
export function modelAt({ price, strike, sigma, nowMs, endMs, observed = null }) {
  const T = (endMs - nowMs) / 1000;
  if (!(T > 0) || !(sigma > 0)) return null;
  return probAbove(settlementDist(price, sigma, T, T < 60 ? observed : null), strike);
}

// INSERT … ON CONFLICT DO UPDATE for the given columns only; null/undefined values are left out, so a partial
// update never wipes what an earlier run stored
// added by migrations/0002; left out again when that migration has not run yet
export const MODEL_INPUTS = ['vol15', 'vol240', 'ewma', 'vel'];
export const COLUMNS = ['snap_t', 'bid', 'ask', 'model', 'price', 'sigma', 'strike', 'settle', 'result', 'k_strike', 'k_settle',
                        ...MODEL_INPUTS];
export function upsert(series, start, fields, nowS, columns = COLUMNS) {
  const cols = columns.filter(c => fields[c] !== null && fields[c] !== undefined);
  if (!cols.length) return null;
  const all = ['series', 'start', ...cols, 'updated'];
  return {
    sql: `INSERT INTO rounds (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
         `ON CONFLICT (series, start) DO UPDATE SET ${[...cols, 'updated'].map(c => `${c} = excluded.${c}`).join(', ')}`,
    params: [series, start, ...cols.map(c => fields[c]), nowS],
  };
}
