import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MOMENTUM_CAP, modelById, defaultParams, paramsOf, modelPath, modelDist, recordInputs, scoreModel, volsFromCloses } from '../js/models.js';
import { probAbove, settlementDist } from '../js/math.js';

const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const vols = { h15: 3e-5, h60: 2e-5, h240: 1.5e-5, ewma: 2.5e-5 };
const inp = (o = {}) => ({ price: 100000, strike: 99980, T: 120, ws: 60, observed: null, vol: k => vols[k], velocity: 0.4, fallback: 1, ...o });

test('catalog: ids, defaults, saved settings checked', () => {
  assert.deepEqual(MODELS.map(m => m.id), ['rw', 'ewma', 'mom', 'fat']);
  assert.equal(modelById('nope').id, 'rw');
  assert.deepEqual(defaultParams(modelById('rw')), { win: 60, f: 1 });
  assert.deepEqual(paramsOf(modelById('rw'), { win: 15, f: 9, x: 1 }), { win: 15, f: 1 }, 'f out of range → default');
  assert.deepEqual(paramsOf(modelById('fat'), null), { df: 4, f: 1 });
});

test('Standard with defaults is the dashboard model', () => {
  const m = modelById('rw'), d = modelDist(m, inp(), defaultParams(m));
  const ref = settlementDist(100000, vols.h60 * 100000, 120);
  near(d.mean, ref.mean); near(d.sd, ref.sd, 1e-9);
  assert.equal(d.df, undefined);
  // window and factor
  near(modelDist(m, inp(), { win: 15, f: 2 }).sd, settlementDist(100000, 2 * vols.h15 * 100000, 120).sd, 1e-9);
});

test('each model changes what it says it changes', () => {
  const std = modelDist(modelById('rw'), inp(), { win: 60, f: 1 });
  const fast = modelDist(modelById('ewma'), inp(), { f: 1 });
  near(fast.sd / std.sd, vols.ewma / vols.h60, 1e-9, 'fast volatility: only the spread');
  const mom = modelDist(modelById('mom'), inp(), { w: 0.5, f: 1 });
  assert.ok(mom.mean > std.mean, 'rising last minute → expects higher');
  near(mom.sd, std.sd, 1e-9);
  near(modelDist(modelById('mom'), inp(), { w: 0, f: 1 }).mean, std.mean, 1e-9, '0% trend = Standard');
  // capped at MOMENTUM_CAP × price ($/s), the same share of the price for every coin
  near(modelDist(modelById('mom'), inp({ velocity: 1000 }), { w: 1, f: 1 }).mean, modelDist(modelById('mom'), inp({ velocity: MOMENTUM_CAP * 100000 }), { w: 1, f: 1 }).mean, 1e-9, 'capped');
  const fat = modelDist(modelById('fat'), inp(), { df: 4, f: 1 });
  assert.equal(fat.df, 4);
  near(fat.sd, std.sd, 1e-9, 'same spread');
  // without candles the fallback σ ($/√s) is used; without anything there is no forecast
  assert.ok(modelDist(modelById('rw'), inp({ vol: () => null, fallback: 3 }), { win: 60, f: 1 }).sd > 0);
  assert.equal(modelPath(modelById('rw'), inp({ vol: () => null, fallback: null }), { win: 60, f: 1 }), null);
});

test('scoring on recorded rounds: inputs from a row, models needing missing inputs are skipped', () => {
  const rec = (start, model, result, extra = {}) => ({ start, snap_t: start + 240, bid: 0.5, ask: 0.52, model, price: 100000, sigma: 2,
    strike: 99990, settle: null, result, ...extra });
  const recs = [rec(0, 0.6, 'up'), rec(300, 0.6, 'down'), rec(600, 0.6, 'up', { vel: 0.2 })];
  const i = recordInputs(recs[0], 300);
  assert.equal(i.T, 60);
  near(i.vol('h60'), 2 / 100000, 1e-15);
  const rw = scoreModel(modelById('rw'), { win: 60, f: 1 }, recs, 300, 0.07, 0.03);
  assert.equal(rw.n, 3);
  // the recorded probability is replaced by the model's own
  near(rw.brierModel, [1, 0, 1].reduce((a, o) => a + (probAbove(settlementDist(100000, 2, 60), 99990) - o) ** 2, 0) / 3, 1e-12);
  assert.equal(scoreModel(modelById('mom'), { w: 0.3, f: 1 }, recs, 300, 0.07, 0.03).n, 1, 'only the round with a speed');
  assert.equal(scoreModel(modelById('ewma'), { f: 1 }, recs, 300, 0.07, 0.03), null, 'no fast volatility recorded yet');
});

test('volsFromCloses', () => {
  const c = [100];
  for (let i = 0; i < 300; i++) c.push(c[i] * Math.exp(i % 2 ? -0.001 : 0.001));
  const v = volsFromCloses(c);
  for (const k of ['h15', 'h60', 'h240', 'ewma']) assert.ok(v[k] > 0, k);
  assert.equal(volsFromCloses([1, 2]).h60, null);
});
