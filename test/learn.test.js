import test from 'node:test';
import assert from 'node:assert/strict';
import { sigmoid, logit, fitLogistic, predict, crossPredict, chi2p1, stacking } from '../js/learn.js';

const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
// a small deterministic random generator, so the tests are the same every run
const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)(12345);

test('sigmoid / logit', () => {
  near(sigmoid(0), 0.5);
  near(logit(0.5), 0);
  near(sigmoid(logit(0.8)), 0.8, 1e-12);
  near(logit(0), logit(0.01), 1e-12, 'clipped');
});

test('fitLogistic recovers the weights that made the data', () => {
  const X = [], y = [];
  for (let i = 0; i < 4000; i++) { const x = rng() * 4 - 2; X.push([1, x]); y.push(rng() < sigmoid(0.5 + 1.5 * x) ? 1 : 0); }
  const f = fitLogistic(X, y);
  near(f.w[0], 0.5, 0.15); near(f.w[1], 1.5, 0.15);
  assert.ok(f.se[1] > 0 && f.se[1] < 0.1);
  near(predict(f, [1, 0]), sigmoid(f.w[0]), 1e-12);
  assert.equal(fitLogistic([[1, 0]], [1]), null, 'too few rows');
});

test('fitLogistic stays finite on perfectly separated data (ridge)', () => {
  const X = [-2, -1, 1, 2].map(x => [1, x]), y = [0, 0, 1, 1];
  const f = fitLogistic(X, y);
  assert.ok(Number.isFinite(f.w[1]) && f.w[1] > 1);
});

test('crossPredict: every row predicted by a fit that did not see it', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) { const x = rng() * 2 - 1; X.push([1, x]); y.push(rng() < sigmoid(2 * x) ? 1 : 0); }
  const p = crossPredict(X, y, 5);
  assert.equal(p.length, 200);
  assert.ok(p.every(v => v > 0 && v < 1));
});

test('chi2p1', () => {
  near(chi2p1(3.841), 0.05, 1e-3);
  assert.equal(chi2p1(0), 1);
});

test('stacking: a model that is the market adds nothing; one that knows more gets weight', () => {
  const rows = [], informed = [];
  for (let i = 0; i < 3000; i++) {
    const truth = rng() * 6 - 3, noise = (rng() - 0.5) * 3;
    const up = rng() < sigmoid(truth);
    // the market sees the truth with noise; the "model" sees it exactly (informed) or copies the market
    const mkt = sigmoid(truth + noise);
    rows.push({ mkt, model: mkt, up });
    informed.push({ mkt, model: sigmoid(truth), up });
  }
  const a = stacking(rows), b = stacking(informed);
  assert.ok(a === null || Math.abs(a.z) < 3 || !Number.isFinite(a.z), 'collinear: no independent weight');
  assert.ok(b.z > 5 && b.c > 0.5, `informed model: z ${b.z}`);
  assert.ok(b.cvFull < b.cvMkt, 'and it helps out of sample');
  assert.ok(b.p < 0.001);
  assert.equal(stacking(rows.slice(0, 10)), null, 'too few rounds');
});
