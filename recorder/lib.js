// Pure helpers of the recorder Worker: which rounds to snapshot, parsing books and results, 60s averages,
// the model at the snapshot, upsert SQL. No I/O; covered by recorder/lib.test.js.
import { ASSETS, seriesId } from '../js/assets.js';
import { firstIdx, probAbove, settlementDist, twap } from '../js/math.js';

// Every market the dashboard shows, per coin: Polymarket 5 and 15 minutes, Kalshi 15 minutes. The ids match the
// dashboard's track stores (Bitcoin: poly5, poly15, kalshi15; the others prefixed: eth-poly5, …).
export const SERIES = ASSETS.flatMap(a => [
  { id: seriesId(a.id, 'poly', 5),    asset: a, venue: 'poly',   len: 300, slug: `${a.poly}-updown-5m-` },
  { id: seriesId(a.id, 'poly', 15),   asset: a, venue: 'poly',   len: 900, slug: `${a.poly}-updown-15m-` },
  { id: seriesId(a.id, 'kalshi', 15), asset: a, venue: 'kalshi', len: 900, ticker: a.kalshi },
]);
export const seriesById = id => SERIES.find(s => s.id === id);

// The round running at `nowS` and the seconds left in it. Every run snapshots each running round once (the cron
// fires once a minute, on the minute), so a 5-minute round gets 5 snapshots (300, 240, … 60s left), a 15-minute one 15.
export function runningRound(len, nowS) {
  const start = Math.floor(nowS / len) * len;
  return { start, left: start + len - nowS };
}

// The snapshot that also goes into the round's own row (the track record, scored by the dashboard): the one
// about 60s before the end, 30–90s left.
export const isFinalSnapshot = left => left > 30 && left <= 90;

// start times of the rounds that ended after `fromS` (and by `nowS`), newest first
export function endedRounds(len, fromS, nowS) {
  const out = [];
  for (let start = Math.floor(nowS / len) * len - len; start + len > fromS; start -= len) out.push(start);
  return out;
}

// Polymarket CLOB book: bids and asks as [{ price, size }] strings → best UP bid and ask (0..1) and the size there
export function polyTouch(book) {
  const levels = side => (side || []).map(x => [+x.price, +x.size]).filter(([p, s]) => s > 0 && p > 0 && p < 1);
  const bids = levels(book?.bids), asks = levels(book?.asks);
  const best = (l, better) => l.reduce((a, x) => !a || better(x[0], a[0]) ? x : a, null);
  const b = best(bids, (x, y) => x > y), a = best(asks, (x, y) => x < y);
  return { bid: b?.[0] ?? null, ask: a?.[0] ?? null, bid_sz: b?.[1] ?? null, ask_sz: a?.[1] ?? null };
}

// Kalshi orderbook_fp: yes_dollars / no_dollars as [price, size]; the YES (UP) ask is 1 − the best NO bid
export function kalshiTouch(ob) {
  const best = side => { let m = null; for (const [p, s] of side || []) if (+s > 0 && (!m || +p > m[0])) m = [+p, +s]; return m; };
  const yes = best(ob?.yes_dollars), no = best(ob?.no_dollars);
  return { bid: yes?.[0] ?? null, ask: no ? Math.round((1 - no[0]) * 10000) / 10000 : null, bid_sz: yes?.[1] ?? null, ask_sz: no?.[1] ?? null };
}

// Polymarket Gamma market (from /markets) → official result once it is closed ('up' | 'down'), else null
export function polyMarketResult(m) {
  if (!m?.closed) return null;
  const outcomes = JSON.parse(m.outcomes || '[]'), prices = JSON.parse(m.outcomePrices || '[]').map(Number);
  const win = outcomes[prices.indexOf(1)];
  return win === 'Up' ? 'up' : win === 'Down' ? 'down' : null;
}
// … from a Gamma event (/events): its first market
export const polyResult = event => polyMarketResult(event?.markets?.[0]);
export const slugStart = slug => +slug.slice(slug.lastIndexOf('-') + 1);
// the UP token of a Gamma market
export const polyToken = m => { try { return JSON.parse(m?.clobTokenIds || '[]')[0] ?? null; } catch { return null; } };

// Kalshi market → round start, official result and the two published index averages (BRTI for Bitcoin)
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
// 60s average over [a, b) ms: time-weighted average of the trade prices, as the dashboard computes it;
// null when the trades start more than 10s into the window
export const windowAvg = (trades, a, b) => twap(trades, a, b);
// whether trades fetched from `fromMs` on cover [a, b]: they start early enough and run up to b
export const covers = (trades, fromMs, a, b) => fromMs <= a && trades.length > 0 && trades[trades.length - 1].t >= b - 15_000;
export const lastPrice = trades => trades.length ? trades[trades.length - 1].p : null;

// the price's speed in $/s over the last `span` ms: the latest price against the one in force `span` earlier
export function tradeVelocity(trades, nowMs, span = 60_000) {
  const i = firstIdx(trades, nowMs - span + 1) - 1;
  return i < 0 || !trades.length ? null : (trades[trades.length - 1].p - trades[i].p) / (span / 1000);
}

// model P(up) at the snapshot: the dashboard's Standard model (strike and price share the Kraken basis)
export function modelAt({ price, strike, sigma, nowMs, endMs, observed = null }) {
  const T = (endMs - nowMs) / 1000;
  if (!(T > 0) || !(sigma > 0)) return null;
  return probAbove(settlementDist(price, sigma, T, T < 60 ? observed : null), strike);
}

// round to `n` significant digits (keeps the stored rows and the /snaps answer small)
export const sig = (x, n = 6) => x == null || !Number.isFinite(x) ? null : x === 0 ? 0 : +x.toPrecision(n);

// ── Writes ───────────────────────────────────────────────────────────────────
// All of a run's writes go out as a few multi-row statements: D1 allows about 50 queries per invocation on the
// free plan and 100 bound parameters per query, and a run now touches up to ~80 rows. The values are written into
// the SQL as literals, so only numbers and short plain strings (series ids, results, market ids) are accepted.
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(v)) return `'${v}'`;
  throw new Error('value not allowed in SQL: ' + String(v).slice(0, 40));
}

// MODEL_INPUTS came with migrations/0002, BOOK_EXTRA with 0003; each is left out again while its migration is missing.
export const MODEL_INPUTS = ['vol15', 'vol240', 'ewma', 'vel'];
export const BOOK_EXTRA = ['bid_sz', 'ask_sz', 'token'];
export const COLUMNS = ['snap_t', 'bid', 'ask', 'model', 'price', 'sigma', 'strike', 'settle', 'result', 'k_strike', 'k_settle',
                        ...MODEL_INPUTS, ...BOOK_EXTRA];

// One INSERT … ON CONFLICT DO UPDATE for many rounds ([{ series, start, fields }]; the same round twice is merged,
// later values winning). A null leaves the stored value as it is (COALESCE), so a partial update never wipes what
// an earlier run stored. Only `columns` are written; null when there is nothing to write.
export function upsertMany(items, nowS, columns = COLUMNS) {
  const merged = new Map();
  for (const { series, start, fields } of items) {
    const k = series + '|' + start, m = merged.get(k) || merged.set(k, { series, start, fields: {} }).get(k);
    for (const [c, v] of Object.entries(fields)) if (v !== null && v !== undefined) m.fields[c] = v;
  }
  const rows = [...merged.values()], cols = columns.filter(c => rows.some(r => r.fields[c] !== undefined));
  if (!cols.length) return null;
  const all = ['series', 'start', ...cols, 'updated'];
  return {
    sql: `INSERT INTO rounds (${all.join(', ')}) VALUES ` +
         rows.filter(r => cols.some(c => r.fields[c] !== undefined))
           .map(r => `(${[r.series, r.start, ...cols.map(c => r.fields[c]), nowS].map(lit).join(', ')})`).join(', ') +
         ` ON CONFLICT (series, start) DO UPDATE SET ${cols.map(c => `${c} = COALESCE(excluded.${c}, rounds.${c})`).join(', ')}, updated = excluded.updated`,
  };
}

// one minute's snapshots of the running rounds (migrations/0003, table snaps): [{ series, start, t, fields }]
export const SNAP_COLUMNS = ['bid', 'ask', 'bid_sz', 'ask_sz', 'price', 'sigma', 'vol15', 'vol240', 'ewma', 'vel', 'model'];
export function snapsInsert(snaps) {
  if (!snaps.length) return null;
  return {
    sql: `INSERT OR REPLACE INTO snaps (series, start, t, ${SNAP_COLUMNS.join(', ')}) VALUES ` +
         snaps.map(s => `(${[s.series, s.start, s.t, ...SNAP_COLUMNS.map(c => s.fields[c])].map(lit).join(', ')})`).join(', '),
  };
}
