import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotRound, endedRounds, polyTouch, kalshiTouch, polyResult, slugStart, kalshiRound, klineAvg, lastClose, modelAt, upsert,
} from './lib.js';
import { settlementDist, probAbove } from '../js/math.js';

test('snapshotRound: the run about 60s before the end', () => {
  const t = 1793909700;                              // a multiple of 900 (and of 300)
  assert.equal(t % 900, 0);
  assert.equal(snapshotRound(300, t - 60), t - 300);  // cron at :00, round ends in 60s
  assert.equal(snapshotRound(300, t - 57), t - 300);  // fired a few seconds late
  assert.equal(snapshotRound(300, t - 120), null);    // two minutes before: not yet
  assert.equal(snapshotRound(300, t - 25), null);     // too late for "60s before"
  assert.equal(snapshotRound(900, t - 60), t - 900);
  assert.equal(snapshotRound(900, t - 300 - 60), null, 'a 5-minute boundary is not a 15-minute one');
});

test('endedRounds: newest first, ended within the span', () => {
  assert.deepEqual(endedRounds(300, 1000 * 300 - 900, 1000 * 300 + 10), [999 * 300, 998 * 300, 997 * 300]);
  assert.deepEqual(endedRounds(300, 1000 * 300 - 1, 1000 * 300 + 10), [999 * 300]);
  assert.deepEqual(endedRounds(300, 1000 * 300, 1000 * 300 + 10), [], 'ending exactly at the span start is not after it');
});

test('polyTouch / kalshiTouch: best bid and ask', () => {
  assert.deepEqual(polyTouch({ bids: [{ price: '0.41', size: '10' }, { price: '0.43', size: '5' }, { price: '0.44', size: '0' }],
                               asks: [{ price: '0.47', size: '3' }, { price: '0.46', size: '8' }] }), { bid: 0.43, ask: 0.46 });
  assert.deepEqual(polyTouch({ bids: [], asks: [] }), { bid: null, ask: null });
  // YES bids up to 42¢, NO bids up to 55¢ → YES ask 45¢
  assert.deepEqual(kalshiTouch({ yes_dollars: [['0.4000', '10'], ['0.4200', '3']], no_dollars: [['0.5000', '1'], ['0.5500', '7']] }), { bid: 0.42, ask: 0.45 });
  assert.deepEqual(kalshiTouch({}), { bid: null, ask: null });
});

test('polyResult / slugStart / kalshiRound', () => {
  const ev = (closed, prices) => ({ slug: 'btc-updown-5m-1793909400', markets: [{ closed, outcomes: '["Up", "Down"]', outcomePrices: prices }] });
  assert.equal(polyResult(ev(true, '["0", "1"]')), 'down');
  assert.equal(polyResult(ev(true, '["1", "0"]')), 'up');
  assert.equal(polyResult(ev(false, '["0.99", "0.01"]')), null, 'not closed yet');
  assert.equal(slugStart('btc-updown-15m-1793909700'), 1793909700);
  assert.deepEqual(kalshiRound({ close_time: '2026-11-05T20:15:00Z', result: 'no', floor_strike: 76237.53, expiration_value: '75971.55' }),
    { start: Date.parse('2026-11-05T20:15:00Z') / 1000 - 900, result: 'down', k_strike: 76237.53, k_settle: 75971.55 });
  assert.equal(kalshiRound({ close_time: '2026-11-05T20:15:00Z', result: '' }).result, null);
});

test('klineAvg: average close of the seconds in the window', () => {
  const k = Array.from({ length: 120 }, (_, i) => [i * 1000, '0', '0', '0', String(100 + i)]);
  assert.equal(klineAvg(k, 0, 60_000), 129.5);       // closes 100..159
  assert.equal(klineAvg(k, 100_000, 160_000), null, 'only 20 points');
  assert.equal(klineAvg(k, 100_000, 160_000, 1), 209.5);
  assert.equal(lastClose(k), 219);
  assert.equal(lastClose([]), null);
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

test('upsert: only the given columns, nulls left out', () => {
  const u = upsert('poly5', 1793909400, { bid: 0.4, ask: null, result: 'up', other: 1 }, 1793910000);
  assert.equal(u.sql, 'INSERT INTO rounds (series, start, bid, result, updated) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT (series, start) DO UPDATE SET bid = excluded.bid, result = excluded.result, updated = excluded.updated');
  assert.deepEqual(u.params, ['poly5', 1793909400, 0.4, 'up', 1793910000]);
  assert.equal(upsert('poly5', 1, { bid: null }, 2), null);
});
