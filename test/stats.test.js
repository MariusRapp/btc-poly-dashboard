import test from 'node:test';
import assert from 'node:assert/strict';
import { toRecords, marketProb, scored, summary, calibration, backtest, logLoss, scores, isOpen, LOG_CLIP, splitCurve, splitProb, pairBacktest, SPLIT_DEFAULT } from '../js/stats.js';
import { takerFee, probWithin } from '../js/math.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const rec = (o) => ({ start: 0, bid: null, ask: null, model: null, strike: null, settle: null, result: null, k_strike: null, k_settle: null, ...o });

test('toRecords / marketProb / scored', () => {
  const recs = toRecords({ cols: ['start', 'bid', 'ask'], rows: [[1, 0.4, 0.42], [2, null, 0.5]] });
  assert.deepEqual(recs, [{ start: 1, bid: 0.4, ask: 0.42 }, { start: 2, bid: null, ask: 0.5 }]);
  near(marketProb(recs[0]), 0.41);
  // one side empty (a decided round): the missing side counts as 0¢ / 100¢
  near(marketProb(recs[1]), 0.25);
  near(marketProb({ bid: 0.99, ask: null }), 0.995);
  assert.equal(marketProb({ bid: null, ask: null }), null);
  assert.equal(scored([rec({ bid: 0.4, ask: 0.42, model: 0.5, result: 'up' }), rec({ bid: 0.4, ask: 0.42, model: 0.5 }),
                       rec({ bid: null, ask: 0.01, model: 0.001, result: 'down' })]).length, 2);
});

test('logLoss / scores / isOpen', () => {
  near(logLoss(0.8, true), -Math.log(0.8));
  near(logLoss(0.8, false), -Math.log(0.2));
  near(logLoss(0, true), -Math.log(LOG_CLIP), 1e-12, 'clipped, not infinite');
  const rows = [rec({ model: 0.9, result: 'up' }), rec({ model: 0.4, result: 'down' })];
  const s = scores(rows, r => r.model);
  near(s.brier, (0.01 + 0.16) / 2);
  near(s.log, (-Math.log(0.9) - Math.log(0.6)) / 2);
  assert.deepEqual(scores([], r => r.model), { brier: null, log: null });
  assert.equal(isOpen({ bid: 0.5, ask: 0.52 }), true);
  assert.equal(isOpen({ bid: 0.95, ask: 0.96 }), false);
  assert.equal(isOpen({ bid: null, ask: null }), false);
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
  near(s.logModel, (-Math.log(0.8) - Math.log(0.7)) / 2);
  assert.equal(s.open.n, 2, 'both at 61–71%: still open');
  near(s.open.brierMkt, s.brierMkt);
  assert.deepEqual([s.ownN, s.ownMatch], [3, 2]);
  assert.equal(summary([]).n, 0);
  assert.equal(summary([]).open.brierMkt, null);
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

test('splitCurve: split rate by distance to the strike in bp, pulled towards the default', () => {
  const K = 100_000;   // 1 bp = $10
  const poly = [1, 2, 3, 4].map(s => rec({ start: s, result: 'up' }));
  const kalshi = [
    rec({ start: 1, result: 'down', k_strike: K, k_settle: K - 1 }),     // 0.1 bp, split
    rec({ start: 2, result: 'up', k_strike: K, k_settle: K + 2 }),       // 0.2 bp, same
    rec({ start: 3, result: 'up', k_strike: K, k_settle: K + 500 }),     // 50 bp, same
    rec({ start: 9, result: 'up', k_strike: K, k_settle: K + 1 }),       // no Polymarket round
  ];
  const c = splitCurve(poly, kalshi, SPLIT_DEFAULT, 10);
  assert.deepEqual([c.n, c.splits], [3, 1]);
  assert.deepEqual([c.bins[0].n, c.bins[0].s], [2, 1]);
  near(c.bins[0].rate, (1 + 10 * SPLIT_DEFAULT[0]) / 12);
  near(c.bins[4].rate, (0 + 10 * SPLIT_DEFAULT[4]) / 11);
  near(splitCurve([], []).bins[2].rate, SPLIT_DEFAULT[2], 1e-12, 'no data: the default');
});

test('splitProb: mass of the settlement distribution near the strike × the split rate there', () => {
  const c = { bins: [{ lo: 0, hi: 1, rate: 0.5 }, { lo: 1, hi: Infinity, rate: 0 }] }, K = 100_000;
  near(splitProb(c, { mean: K, sd: 1e-6 }, K), 0.5, 1e-9, 'certain to land on the strike');
  near(splitProb(c, { mean: K + 1000, sd: 1 }, K), 0, 1e-9, 'far away');
  const d = { mean: K, sd: 10 };   // ±1 bp = ±$10 = ±1 sd → 68% of the mass
  near(splitProb(c, d, K), 0.5 * probWithin(d, K, 10), 1e-12);
});

test('pairBacktest: pairs under $1 at the snapshot, P&L from the actual results', () => {
  const fee = 0.07, c = { bins: [{ lo: 0, hi: Infinity, rate: 0 }] };
  const snap = { snap_t: 840, price: 100_000, sigma: 1, strike: 100_000 };
  const poly = [
    rec({ start: 0, ...snap, bid: 0.44, ask: 0.45, result: 'up' }),      // Poly UP 45¢ + Kalshi NO 45¢: cheap pair, both agree → +
    rec({ start: 900, ...snap, snap_t: 1740, bid: 0.44, ask: 0.45, result: 'down' }),   // same prices, split: both legs lose
    rec({ start: 1800, ...snap, snap_t: 2640, bid: 0.49, ask: 0.51, result: 'up' }),    // no pair under $1
  ];
  const kalshi = [
    rec({ start: 0, snap_t: 840, bid: 0.55, ask: 0.56, result: 'up' }),
    rec({ start: 900, snap_t: 1740, bid: 0.55, ask: 0.56, result: 'up' }),
    rec({ start: 1800, snap_t: 2640, bid: 0.49, ask: 0.51, result: 'up' }),
  ];
  const cost = 0.45 + 0.45 + takerFee(0.45, fee) * 2;
  const bt = pairBacktest(poly, kalshi, c, fee, fee);
  assert.equal(bt.rounds, 3);
  assert.deepEqual([bt.raw.n, bt.raw.splits, bt.raw.lossSplits], [2, 1, 1]);
  near(bt.raw.pnl, (1 - cost) + (0 - cost));
  assert.equal(bt.aware.n, 2, 'no split risk in this curve: the same pairs');
  const risky = { bins: [{ lo: 0, hi: Infinity, rate: 0.5 }] };
  assert.equal(pairBacktest(poly, kalshi, risky, fee, fee).aware.n, 0, 'a 50% split risk eats the edge');
});
