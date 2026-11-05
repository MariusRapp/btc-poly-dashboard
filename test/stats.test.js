import test from 'node:test';
import assert from 'node:assert/strict';
import { toRecords, marketProb, scored, summary, calibration, backtest, settleApart } from '../js/stats.js';
import { takerFee } from '../js/math.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const rec = (o) => ({ start: 0, bid: null, ask: null, model: null, strike: null, settle: null, result: null, k_strike: null, k_settle: null, ...o });

test('toRecords / marketProb / scored', () => {
  const recs = toRecords({ cols: ['start', 'bid', 'ask'], rows: [[1, 0.4, 0.42], [2, null, 0.5]] });
  assert.deepEqual(recs, [{ start: 1, bid: 0.4, ask: 0.42 }, { start: 2, bid: null, ask: 0.5 }]);
  near(marketProb(recs[0]), 0.41);
  assert.equal(marketProb(recs[1]), null);
  assert.equal(scored([rec({ bid: 0.4, ask: 0.42, model: 0.5, result: 'up' }), rec({ bid: 0.4, ask: 0.42, model: 0.5 })]).length, 1);
});

test('summary: favourite, Brier, own basis', () => {
  const recs = [
    rec({ start: 10, bid: 0.7, ask: 0.72, model: 0.8, result: 'up', strike: 100, settle: 101 }),    // favourite UP won
    rec({ start: 20, bid: 0.6, ask: 0.62, model: 0.3, result: 'down', strike: 100, settle: 99 }),   // favourite UP lost
    rec({ start: 30, result: 'up', strike: 100, settle: 99 }),                                       // no snapshot
  ];
  const s = summary(recs);
  assert.equal(s.n, 2);
  assert.equal(s.since, 10);
  assert.equal(s.fav, 0.5);
  near(s.brierMkt, ((0.71 - 1) ** 2 + 0.61 ** 2) / 2);
  near(s.brierModel, ((0.8 - 1) ** 2 + 0.3 ** 2) / 2);
  assert.deepEqual([s.ownN, s.ownMatch], [3, 2]);
  assert.equal(summary([]).n, 0);
});

test('calibration: bins with their observed UP share', () => {
  const recs = [0.12, 0.15, 0.18, 0.95].map((m, i) => rec({ bid: 0.5, ask: 0.5, model: m, result: i === 0 || i === 3 ? 'up' : 'down' }));
  const c = calibration(recs, r => r.model);
  assert.equal(c.length, 2);
  assert.deepEqual([c[0].lo, c[0].n], [0.1, 3]);
  near(c[0].p, 0.15);
  near(c[0].freq, 1 / 3);
  assert.deepEqual([c[1].lo, c[1].n, c[1].freq], [0.9, 1, 1]);
  assert.equal(calibration([rec({ bid: 1, ask: 1, model: 1, result: 'up' })], r => r.model)[0].lo, 0.9, 'p = 1 goes into the top bin');
});

test('backtest: buys the side with enough edge at the ask, after the fee', () => {
  const fee = 0.07;
  const recs = [
    rec({ start: 1, bid: 0.30, ask: 0.32, model: 0.60, result: 'up' }),     // UP edge ≈ 0.26 → buy UP at 32¢, wins
    rec({ start: 2, bid: 0.70, ask: 0.72, model: 0.40, result: 'up' }),     // DOWN at 30¢ (edge ≈ 0.28) → loses
    rec({ start: 3, bid: 0.49, ask: 0.51, model: 0.50, result: 'down' }),   // no edge → no trade
  ];
  const b = backtest(recs, 0.03, fee);
  assert.deepEqual([b.trades, b.wins], [2, 1]);
  near(b.pnl, (1 - 0.32 - takerFee(0.32, fee)) + (0 - 0.30 - takerFee(0.30, fee)));
  near(b.perTrade, b.pnl / 2);
  assert.deepEqual(b.curve.map(c => c.t), [1, 2]);
  assert.equal(backtest([], 0.03, fee).perTrade, null);
});

test('settleApart: rounds both venues settled, splits and their BRTI distance', () => {
  const poly = [rec({ start: 1, result: 'up' }), rec({ start: 2, result: 'down' }), rec({ start: 3, result: 'up' }), rec({ start: 4, result: 'up' })];
  const kalshi = [
    rec({ start: 1, result: 'up', k_strike: 100, k_settle: 140 }),
    rec({ start: 2, result: 'up', k_strike: 100, k_settle: 103.5 }),    // split, BRTI ended $3.50 above
    rec({ start: 3, result: 'down', k_strike: 100, k_settle: 98 }),     // split, $2 below
  ];
  assert.deepEqual(settleApart(poly, kalshi), { n: 3, splits: 2, maxDist: 3.5 });
  assert.deepEqual(settleApart([], kalshi), { n: 0, splits: 0, maxDist: null });
});
