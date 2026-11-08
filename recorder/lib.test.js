import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERIES, seriesById, runningRound, isFinalSnapshot, endedRounds, polyTouch, kalshiTouch, polyResult, polyMarketResult, polyToken,
  slugStart, kalshiRound, krakenTrades, windowAvg, covers, lastPrice, modelAt, tradeVelocity, sig, lit, upsertMany, snapsInsert,
  COLUMNS, MODEL_INPUTS, BOOK_EXTRA, SNAP_COLUMNS, SQL,
} from './lib.js';
import { settlementDist, probAbove } from '../js/math.js';

test('SERIES: three markets per coin, Bitcoin under its old ids', () => {
  assert.equal(SERIES.length, 15);
  assert.deepEqual(SERIES.slice(0, 3).map(s => s.id), ['poly5', 'poly15', 'kalshi15']);
  assert.equal(seriesById('eth-poly15').slug, 'eth-updown-15m-');
  assert.equal(seriesById('doge-kalshi15').ticker, 'KXDOGE15M');
  assert.equal(seriesById('nope'), undefined);
});

test('runningRound / isFinalSnapshot: one snapshot a minute, the one 60s before the end also goes into the round', () => {
  const t = 1793909700;                                // a multiple of 900 (and of 300)
  assert.equal(t % 900, 0);
  assert.deepEqual(runningRound(300, t), { start: t, left: 300 }, 'on the boundary: the round that just started');
  assert.deepEqual(runningRound(300, t - 60), { start: t - 300, left: 60 });
  assert.deepEqual(runningRound(900, t + 120), { start: t, left: 780 });
  assert.equal(isFinalSnapshot(60), true);
  assert.equal(isFinalSnapshot(57), true, 'fired a few seconds late');
  assert.equal(isFinalSnapshot(120), false);
  assert.equal(isFinalSnapshot(25), false, 'too late for "60s before"');
});

test('endedRounds: newest first, ended within the span', () => {
  assert.deepEqual(endedRounds(300, 1000 * 300 - 900, 1000 * 300 + 10), [999 * 300, 998 * 300, 997 * 300]);
  assert.deepEqual(endedRounds(300, 1000 * 300 - 1, 1000 * 300 + 10), [999 * 300]);
  assert.deepEqual(endedRounds(300, 1000 * 300, 1000 * 300 + 10), [], 'ending exactly at the span start is not after it');
});

test('polyTouch / kalshiTouch: best bid and ask, and the size there', () => {
  assert.deepEqual(polyTouch({ bids: [{ price: '0.41', size: '10' }, { price: '0.43', size: '5' }, { price: '0.44', size: '0' }],
                               asks: [{ price: '0.47', size: '3' }, { price: '0.46', size: '8' }] }), { bid: 0.43, ask: 0.46, bid_sz: 5, ask_sz: 8 });
  assert.deepEqual(polyTouch({ bids: [], asks: [] }), { bid: null, ask: null, bid_sz: null, ask_sz: null });
  // YES bids up to 42¢, NO bids up to 55¢ → YES ask 45¢ (7 contracts: the NO bid's size)
  assert.deepEqual(kalshiTouch({ yes_dollars: [['0.4000', '10'], ['0.4200', '3']], no_dollars: [['0.5000', '1'], ['0.5500', '7']] }),
    { bid: 0.42, ask: 0.45, bid_sz: 3, ask_sz: 7 });
  assert.deepEqual(kalshiTouch({}), { bid: null, ask: null, bid_sz: null, ask_sz: null });
});

test('results, tokens, slugStart, kalshiRound', () => {
  const m = (closed, prices) => ({ slug: 'btc-updown-5m-1793909400', closed, outcomes: '["Up", "Down"]', outcomePrices: prices, clobTokenIds: '["111", "222"]' });
  assert.equal(polyMarketResult(m(true, '["0", "1"]')), 'down');
  assert.equal(polyResult({ markets: [m(true, '["1", "0"]')] }), 'up');
  assert.equal(polyMarketResult(m(false, '["0.99", "0.01"]')), null, 'not closed yet');
  assert.equal(polyToken(m(false, '[]')), '111');
  assert.equal(polyToken({ clobTokenIds: 'not json' }), null);
  assert.equal(slugStart('btc-updown-15m-1793909700'), 1793909700);
  assert.deepEqual(kalshiRound({ close_time: '2026-11-05T20:15:00Z', result: 'no', floor_strike: 76237.53, expiration_value: '75971.55' }),
    { start: Date.parse('2026-11-05T20:15:00Z') / 1000 - 900, result: 'down', k_strike: 76237.53, k_settle: 75971.55 });
  assert.equal(kalshiRound({ close_time: '2026-11-05T20:15:00Z', result: '' }).result, null);
});

test('krakenTrades / windowAvg / covers / lastPrice: trade-weighted 60s average', () => {
  const d = { error: [], result: { XXBTZUSD: [['100.0', '0.1', 1000.25, 'b', 'l', '', 1], ['110.0', '0.2', 1030.25, 's', 'm', '', 2]], last: 'x' } };
  const t = krakenTrades(d);
  assert.deepEqual(t, [{ t: 1000250, p: 100 }, { t: 1030250, p: 110 }]);
  assert.equal(windowAvg(t, 1000250, 1060250), 105, '30s at 100, 30s at 110');
  assert.equal(windowAvg(t, 980_000, 1_040_000), null, 'trades start 20s into the window');
  assert.equal(covers(t, 990_000, 1_000_000, 1_040_000), true);
  assert.equal(covers(t, 1_010_000, 1_000_000, 1_040_000), false, 'fetched from after the window opened');
  assert.equal(lastPrice(t), 110);
  assert.deepEqual(krakenTrades({ error: ['EGeneral'] }), []);
});

test('modelAt: the dashboard model', () => {
  const p = modelAt({ price: 100_010, strike: 100_000, sigma: 2, nowMs: 0, endMs: 60_000 });
  assert.equal(p, probAbove(settlementDist(100_010, 2, 60), 100_000));
  assert.ok(p > 0.5 && p < 1);
  // inside the window the observed part counts
  const q = modelAt({ price: 100_010, strike: 100_000, sigma: 2, nowMs: 30_000, endMs: 60_000, observed: 99_900 });
  assert.equal(q, probAbove(settlementDist(100_010, 2, 30, 99_900), 100_000));
  assert.ok(q < 0.01);
  assert.equal(modelAt({ price: 1, strike: 1, sigma: 2, nowMs: 60_000, endMs: 60_000 }), null, 'round over');
});

test('tradeVelocity: $/s over the last minute', () => {
  const t = [{ t: 0, p: 100 }, { t: 30_000, p: 103 }, { t: 70_000, p: 106 }];
  assert.equal(tradeVelocity(t, 70_000), (106 - 100) / 60, 'against the price in force 60s earlier (the trade at 0s)');
  assert.equal(tradeVelocity(t, 50_000), null, 'nothing that old');
  assert.equal(tradeVelocity([], 1), null);
});

test('sig / lit: rounding and the only values written into SQL', () => {
  assert.equal(sig(75615.4612345, 8), 75615.461);
  assert.equal(sig(0.0000012345678, 4), 0.000001235);
  assert.equal(sig(0), 0);
  assert.equal(sig(null), null);
  assert.equal(sig(NaN), null);
  assert.equal(lit(null), 'NULL');
  assert.equal(lit(Infinity), 'NULL');
  assert.equal(lit(0.25), '0.25');
  assert.equal(lit('eth-poly5'), "'eth-poly5'");
  assert.equal(lit('KXBTC15M-26NOV061415-15'), "'KXBTC15M-26NOV061415-15'");
  assert.throws(() => lit("x'); DROP TABLE rounds; --"));
  assert.throws(() => lit({}));
});

test('upsertMany: one statement, same round merged, nulls keep the stored value', () => {
  const u = upsertMany([
    { series: 'poly5', start: 1, fields: { bid: 0.4, ask: null, other: 1 } },
    { series: 'poly5', start: 1, fields: { result: 'up' } },
    { series: 'eth-poly5', start: 1, fields: { strike: 2227.5 } },
  ], 9);
  assert.equal(u.sql, 'INSERT INTO rounds (series, start, bid, strike, result, updated) VALUES ' +
    "('poly5', 1, 0.4, NULL, 'up', 9), ('eth-poly5', 1, NULL, 2227.5, NULL, 9) ON CONFLICT (series, start) DO UPDATE SET " +
    'bid = COALESCE(excluded.bid, rounds.bid), strike = COALESCE(excluded.strike, rounds.strike), result = COALESCE(excluded.result, rounds.result), updated = excluded.updated');
  assert.equal(upsertMany([{ series: 'poly5', start: 1, fields: { bid: null } }], 2), null);
  assert.equal(upsertMany([], 2), null);
});

test('upsertMany: columns of a missing migration are left out', () => {
  const f = { bid: 0.4, vol15: 1e-5, vel: 0.3, token: '123' };
  assert.match(upsertMany([{ series: 'poly5', start: 1, fields: f }], 2).sql, /vol15, vel, token/);
  const old = upsertMany([{ series: 'poly5', start: 1, fields: f }], 2, COLUMNS.filter(c => !MODEL_INPUTS.includes(c) && !BOOK_EXTRA.includes(c)));
  assert.doesNotMatch(old.sql, /vol15|vel|token/);
});

test('snapsInsert: all snapshots of a run in one statement', () => {
  const s = snapsInsert([{ series: 'poly5', start: 300, t: 360, fields: { bid: 0.5, ask: 0.51, model: 0.49 } },
                         { series: 'kalshi15', start: 0, t: 360, fields: {} }]);
  assert.equal(s.sql, `INSERT OR REPLACE INTO snaps (series, start, t, ${SNAP_COLUMNS.join(', ')}) VALUES ` +
    "('poly5', 300, 360, 0.5, 0.51, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0.49), " +
    "('kalshi15', 0, 360, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)");
  assert.equal(snapsInsert([]), null);
});

test('every read goes through the primary key: no query scans a whole table (D1 bills every row read)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const plan = sql => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(r => r.detail).join(' | ');
  const queries = [SQL.recent, SQL.rounds(['start', 'bid']), SQL.snaps(['start', 't', 'bid']), SQL.outcomes, SQL.statusRounds, SQL.statusSnaps];
  for (const q of queries) {
    const p = plan(q);
    assert.match(p, /SEARCH (rounds|snaps) USING (COVERING )?(INDEX|PRIMARY KEY)/, `${q.slice(0, 60)} → ${p}`);
    assert.doesNotMatch(p, /\bSCAN (rounds|snaps)\b/, `${q.slice(0, 60)} → ${p}`);
  }
  // the query that used up the daily limit, for contrast
  assert.match(plan('SELECT * FROM rounds WHERE start >= 1'), /SCAN rounds/);
});
