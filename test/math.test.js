// Pure functions behind the strike, the model, fees and the arbitrage card. Run: npm test (or node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  firstIdx, twap, median, normalCDF, volFromCloses, settlementDist, probAbove, probWithin,
  takerFee, buyEdge, bookLevels, walkPair, mirrorBook, niceStep, forecastAt, distPdf, distCdf, distQuantile, tCdf, tPdf, stdQuantile, ewmaVol, impliedSigma,
} from '../js/math.js';
import { decodeRound } from '../js/chainlink.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('firstIdx: first point at or after t', () => {
  const a = [{ t: 10 }, { t: 20 }, { t: 20 }, { t: 30 }];
  assert.equal(firstIdx(a, 5), 0);
  assert.equal(firstIdx(a, 20), 1);
  assert.equal(firstIdx(a, 21), 3);
  assert.equal(firstIdx(a, 99), 4);
  assert.equal(firstIdx([], 1), 0);
});

test('twap: time-weighted step average', () => {
  const s = [{ t: 0, p: 100 }, { t: 30, p: 200 }];
  assert.equal(twap(s, 0, 60), 150);              // 30s at 100, 30s at 200
  assert.equal(twap(s, 30, 60), 200);
  near(twap(s, 15, 45), 150, 1e-9);
  assert.equal(twap(s, 60, 60), null);            // empty window
  assert.equal(twap([], 0, 60), null);
  // up to 10s missing at the start are tolerated (the average starts at the first point), more is not
  assert.equal(twap([{ t: 5000, p: 100 }], 0, 60_000), 100);
  assert.equal(twap([{ t: 11_000, p: 100 }], 0, 60_000), null);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const v = [5, 1, 3];
  median(v);
  assert.deepEqual(v, [5, 1, 3], 'input left unsorted');
});

test('normalCDF', () => {
  near(normalCDF(0), 0.5, 1e-7);
  near(normalCDF(1.959964), 0.975, 1e-6);
  near(normalCDF(-1) + normalCDF(1), 1, 1e-9);
});

test('volFromCloses: log-return σ per √s', () => {
  assert.equal(volFromCloses([1, 2, 3]), null, 'needs 20 returns');
  // alternating ±r: the sample sd of the returns is r·√(n/(n−1))
  const r = 0.001, closes = [100];
  for (let i = 0; i < 40; i++) closes.push(closes[i] * Math.exp(i % 2 ? -r : r));
  near(volFromCloses(closes), r * Math.sqrt(40 / 39) / Math.sqrt(60), 1e-9);
});

test('settlementDist: closed form, continuous at the window start', () => {
  const sigma = 2;
  assert.deepEqual(settlementDist(100, sigma, 300), { mean: 100, sd: sigma * Math.sqrt(260) });
  const a = settlementDist(100, sigma, 60), b = settlementDist(100, sigma, 60 - 1e-9, 100);
  near(a.sd, b.sd, 1e-6, 'sd at T = 60 from both formulas');
  // 30s left with the first half of the window averaging 90: mean is half observed, half current price
  const c = settlementDist(100, sigma, 30, 90);
  assert.equal(c.mean, 95);
  near(c.sd, sigma * Math.sqrt(30 ** 3 / 3) / 60, 1e-12);
  assert.ok(settlementDist(100, sigma, 0, 90).sd > 0, 'never zero');
});

test('settlementDist matches a simulation of the 60s average', () => {
  // Brownian price, 0.25s steps: sd of the average over the last 60s, T = 120s and T = 30s before the end
  let seed = 7;   // mulberry32: small seeded PRNG in 32-bit integer math
  const rnd = () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sigma = 1.5, dt = 0.25, N = 3000;
  for (const T of [120, 30]) {
    const steps = Math.round(T / dt), inWindow = Math.round(Math.min(T, 60) / dt);
    const avgs = [];
    for (let n = 0; n < N; n++) {
      let p = 0, sum = 0;
      for (let k = 1; k <= steps; k++) { p += sigma * Math.sqrt(dt) * gauss(); if (k > steps - inWindow) sum += p; }
      // T < 60: the rest of the window (already observed) is 0 here, so the average is sum / 240 steps
      avgs.push(sum / (60 / dt));
    }
    const mean = avgs.reduce((a, v) => a + v, 0) / N;
    const sd = Math.sqrt(avgs.reduce((a, v) => a + (v - mean) ** 2, 0) / (N - 1));
    near(sd, settlementDist(0, sigma, T, 0).sd, settlementDist(0, sigma, T, 0).sd * 0.06, `T = ${T}s`);
  }
});

test('forecastAt: price before the window, running average in it, settlementDist at the end', () => {
  const sigma = 2, price = 100;
  // 300s left, window opens in 240s
  assert.deepEqual(forecastAt(price, sigma, 100, 240), { mean: 100, sd: sigma * 10 });
  const end = forecastAt(price, sigma, 300, 240), sd = settlementDist(price, sigma, 300);
  near(end.sd, sd.sd, 1e-9, 'end = settlement average');
  near(forecastAt(price, sigma, 240 + 1e-9, 240).sd, forecastAt(price, sigma, 240, 240).sd, 1e-4, 'continuous at the window start');
  // 30s left inside the window (opened 30s ago), first half averaged 90
  const inWin = forecastAt(price, sigma, 30, -30, 90), d = settlementDist(price, sigma, 30, 90);
  near(inWin.mean, d.mean, 1e-12);
  near(inWin.sd, d.sd, 1e-12);
  // narrows relative to the price inside the window: the average moves slower than the price
  assert.ok(forecastAt(price, sigma, 300, 240).sd < sigma * Math.sqrt(300));
  near(distPdf({ mean: 5, sd: 2 }, 5), 1 / (2 * Math.sqrt(2 * Math.PI)), 1e-9);
});

test('probAbove / probWithin', () => {
  const d = { mean: 100, sd: 10 };
  near(probAbove(d, 100), 0.5, 1e-7);
  near(probAbove(d, 80.4), 0.975, 1e-3);
  near(probWithin(d, 100, 19.6), 0.95, 1e-3);
  assert.ok(probWithin({ mean: 200, sd: 1 }, 100, 5) < 1e-9);
});

test('fees and edge', () => {
  near(takerFee(0.5, 0.07), 0.0175, 1e-12, 'max 1.75¢ at 50¢');
  near(takerFee(0.9, 0.07), 0.0063, 1e-12);
  // model 60% for a side asked at 55¢: 0.60 − 0.55 − 0.07·0.55·0.45
  near(buyEdge(0.55, 0.6, 0.07), 0.05 - 0.017325, 1e-12);
});

test('order books: levels, mirror, arbitrage walk', () => {
  // keys are prices in 0.1¢ units
  const asks = { 450: 10, 470: 5 }, bids = { 400: 7, 380: 3 };
  assert.deepEqual(bookLevels(asks, false), [[0.45, 10], [0.47, 5]]);
  assert.deepEqual(bookLevels(bids, true, true), [[0.6, 7], [0.62, 3]], 'UP bids → DOWN asks');
  assert.deepEqual(mirrorBook({ 400: 7 }), { 600: 7 });
  // UP at 45¢ (10) then 47¢ (5), other venue's DOWN at 50¢ (8) then 51¢ (20)
  const r = walkPair([[0.45, 10], [0.47, 5]], 0.07, [[0.5, 8], [0.51, 20]], 0.07);
  const e1 = 1 - 0.45 - 0.5 - takerFee(0.45, 0.07) - takerFee(0.5, 0.07);
  near(r.edge, e1, 1e-12, 'edge of the best pair');
  assert.ok(r.pairs >= 8 && r.profit > 0);
  // no pair under $1: only the top is reported
  const none = walkPair([[0.55, 10]], 0.07, [[0.5, 10]], 0.07);
  assert.ok(none.edge < 0);
  assert.equal(none.pairs, 0);
  assert.equal(walkPair([], 0.07, [[0.5, 1]], 0.07), null);
});

test('niceStep', () => {
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(7, 6), 1);
  assert.equal(niceStep(0.3, 3), 0.1);
});

test('decodeRound: Chainlink latestRoundData answer', () => {
  // live answer of the BTC/USD aggregator on Polygon (2026-11-05)
  const hex = '0x00000000000000000000000000000000000000000000000300000000003cd5b7000000000000000000000000000000000000000000000000000006e8d06d3fc0' +
    '000000000000000000000000000000000000000000000000000000006aecd25f000000000000000000000000000000000000000000000000000000006aecd263' +
    '00000000000000000000000000000000000000000000000300000000003cd5b7';
  const r = decodeRound(hex);
  assert.equal(r.price, 75969.99);
  assert.equal(r.ts, 1793905251);
  assert.equal(r.id, (3n << 64n) | 0x3cd5b7n, 'phase 3, round 0x3cd5b7');
  // int256: a negative answer comes back negative
  const neg = hex.slice(0, 66) + 'f'.repeat(63) + 'f' + hex.slice(130);
  assert.equal(decodeRound(neg).price, -1e-8);
});

test('Student-t: CDF against table values, density, quantiles', () => {
  near(tCdf(2.132, 4), 0.95, 2e-4);
  near(tCdf(1.812, 10), 0.95, 2e-4);
  near(tCdf(3.182, 3), 0.975, 2e-4);
  near(tCdf(1, 1), 0.75, 1e-9, 'Cauchy');
  near(tCdf(-1.5, 7) + tCdf(1.5, 7), 1, 1e-12);
  near(tPdf(0, 1), 1 / Math.PI, 1e-9);
  near(stdQuantile(0.975), 1.959964, 2e-5);
  near(stdQuantile(0.95, 4), 2.1318, 2e-4);
});

test('distributions: normal and variance-matched t agree on round trips; t has fatter tails', () => {
  const n = { mean: 100, sd: 10 }, t = { mean: 100, sd: 10, df: 4 };
  for (const d of [n, t]) {
    near(distCdf(d, 100), 0.5, 1e-9);
    near(distCdf(d, distQuantile(d, 0.9)), 0.9, 1e-6);
  }
  assert.ok(1 - distCdf(t, 140) > 1 - distCdf(n, 140), 'P(4 sd above) larger with fat tails');
  assert.ok(1 - distCdf(t, 110) < 1 - distCdf(n, 110), 'and smaller 1 sd above (more mass in the middle)');
  near(distPdf(n, 100), 1 / (10 * Math.sqrt(2 * Math.PI)), 1e-12);
});

test('forecastAt with a fading trend', () => {
  const base = forecastAt(100, 2, 120, 240), up = forecastAt(100, 2, 120, 240, null, 0.5);
  assert.equal(up.sd, base.sd, 'a trend moves the centre, not the spread');
  near(up.mean, 100 + 0.5 * 60 * (1 - Math.exp(-2)), 1e-9);
  near(forecastAt(100, 2, 1e6, 2e6, null, 0.5).mean, 130, 1e-6, 'at most drift × τ');
  near(forecastAt(100, 2, 240 + 1e-7, 240, null, 0.5).mean, forecastAt(100, 2, 240, 240, null, 0.5).mean, 1e-4, 'continuous at the window');
  assert.deepEqual(forecastAt(100, 2, 300, 240, null, 0), forecastAt(100, 2, 300, 240));
});

test('ewmaVol and implied volatility', () => {
  const r = 0.001, closes = [100];
  for (let i = 0; i < 60; i++) closes.push(closes[i] * Math.exp(i % 2 ? -r : r));
  near(ewmaVol(closes, 10), r / Math.sqrt(60), 1e-9, 'equal-sized moves');
  assert.equal(ewmaVol([1, 2, 3], 10), null);
  // σ = 2 $/√s, 300s left: the model probability, and back
  const k = Math.sqrt(260), p = probAbove({ mean: 100030, sd: 2 * k }, 100000);
  near(impliedSigma(p, 100030, 100000, k), 2, 1e-3);
  assert.equal(impliedSigma(0.3, 100030, 100000, k), null, 'market favours the other side');
  assert.equal(impliedSigma(0.5, 100030, 100000, k), null, '50/50');
});
