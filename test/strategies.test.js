import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, breakout, exitWhy, ruleById, ruleParams } from '../js/strategies.js';

const NOW = 1_700_000_100_000, START = 1_700_000_000_000;   // 100s into a 5-minute round
const defaults = R => ruleParams(R, null);
// a venue with a steady UP price, then the given points (seconds before now, UP %)
const venue = (o = {}) => ({ key: 'poly', fee: 0.07, bid: 0.49, ask: 0.51, mid: 0.5, spread: 0.02, hist: [], ...o });
const hist = pts => pts.map(([s, p]) => ({ t: NOW - s * 1000, p }));
const snap = (o = {}) => ({ now: NOW, start: START, T: 200, len: 300, model: null, venues: [venue()], arb: null, lag: null, ...o });

test('catalog: ids, every rule has a signal and valid defaults', () => {
  assert.deepEqual(STRATEGIES.map(R => R.id), ['arb', 'edge', 'meanrev', 'momentum', 'stale', 'fav', 'coin']);
  for (const R of STRATEGIES) {
    assert.equal(typeof R.signal, 'function');
    for (const q of R.params) assert.ok(q.def >= q.min && q.def <= q.max, `${R.id}.${q.k} default in range`);
    if (R.exits) for (const k of ['tp', 'sl', 'hold', 'before']) assert.ok(R.params.some(q => q.k === k), `${R.id} has exit ${k}`);
  }
  assert.equal(ruleById('nope'), undefined);
});

test('ruleParams: saved values inside the range, defaults otherwise', () => {
  const R = ruleById('meanrev');
  const p = ruleParams(R, { move: 20, win: 9999, tp: 'x', sl: 0 });
  assert.equal(p.move, 20);
  assert.equal(p.win, 30, 'out of range → default');
  assert.equal(p.tp, R.params.find(q => q.k === 'tp').def, 'not a number → default');
  assert.equal(p.sl, 0, '0 is a valid "off"');
});

test('breakout: up from the low, down from the high, only this round and window', () => {
  const h = hist([[40, 20], [25, 50], [20, 45], [10, 60], [0, 58]]);
  assert.deepEqual(breakout(h, NOW, 30, START), { cur: 58, up: 13, down: 2 });
  assert.equal(breakout(h, NOW, 30, NOW - 5000), null, 'one point in the window is no move');
  assert.equal(breakout([], NOW, 30, START), null);
});

test('exitWhy: target, stop, time, before the end; 0 = off', () => {
  const p = { tp: 3, sl: 10, hold: 120, before: 30 };
  assert.equal(exitWhy(0.031, 5, 200, p), 'target');
  assert.equal(exitWhy(-0.10, 5, 200, p), 'stop');
  assert.equal(exitWhy(0, 120, 200, p), 'time');
  assert.equal(exitWhy(0, 5, 30, p), 'end');
  assert.equal(exitWhy(0.01, 5, 200, p), null);
  assert.equal(exitWhy(0.5, 999, 1, { tp: 0, sl: 0, hold: 0, before: 0 }), null, 'everything off: held to the end');
  assert.equal(exitWhy(0.5, 0, 200, { unwind: 1 }), 'unwind', 'a lone arbitrage leg goes at once');
});

test('model edge: the better side once it beats ask + fee by the edge, not early or late', () => {
  const R = ruleById('edge'), p = defaults(R);
  assert.deepEqual(R.signal(snap({ model: 50 }), p), [], 'no edge at a fair price');
  const s = R.signal(snap({ model: 62 }), p);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].legs, [{ venue: 'poly', side: 'up' }]);
  assert.equal(R.signal(snap({ model: 38 }), p)[0].legs[0].side, 'down');
  assert.deepEqual(R.signal(snap({ model: 62, T: 290 }), p), [], 'first 30s');
  assert.deepEqual(R.signal(snap({ model: 62, T: 50 }), p), [], 'last 60s');
  assert.deepEqual(R.signal(snap({ model: null }), p), []);
});

test('mean reversion fades a jump, momentum follows it; quiet books, wide spreads and the end do not count', () => {
  const MR = ruleById('meanrev'), MO = ruleById('momentum');
  const up = venue({ mid: 0.66, bid: 0.65, ask: 0.67, hist: hist([[60, 50], [28, 50], [20, 55], [5, 64], [0, 66]]) });
  assert.equal(MR.signal(snap({ venues: [up] }), defaults(MR))[0].legs[0].side, 'down');
  assert.equal(MO.signal(snap({ venues: [up] }), defaults(MO))[0].legs[0].side, 'up');
  const down = venue({ mid: 0.34, bid: 0.33, ask: 0.35, hist: hist([[28, 50], [0, 34]]) });
  assert.equal(MR.signal(snap({ venues: [down] }), defaults(MR))[0].legs[0].side, 'up');
  const quiet = venue({ hist: hist([[28, 50], [10, 53], [0, 52]]) });
  assert.deepEqual(MR.signal(snap({ venues: [quiet] }), defaults(MR)), []);
  assert.deepEqual(MR.signal(snap({ venues: [{ ...up, spread: 0.08 }] }), defaults(MR)), [], 'wide spread');
  assert.deepEqual(MR.signal(snap({ venues: [up], T: 40 }), defaults(MR)), [], 'last minute');
  const edge = venue({ mid: 0.95, hist: hist([[28, 70], [0, 95]]) });
  assert.deepEqual(MR.signal(snap({ venues: [edge] }), defaults(MR)), [], 'near 100: the result, not noise');
});

test('stale book: the side the price points to, only on a book that lags in that direction', () => {
  const R = ruleById('stale'), p = defaults(R);
  const lag = { dModel: 9, venues: [{ key: 'poly', gap: 7, dBook: 2 }] };
  assert.deepEqual(R.signal(snap({ lag }), p)[0].legs, [{ venue: 'poly', side: 'up' }]);
  assert.deepEqual(R.signal(snap({ lag: { dModel: 9, venues: [{ key: 'poly', gap: -7, dBook: 16 }] } }), p), [], 'book overshot');
  assert.deepEqual(R.signal(snap({ lag: { dModel: 3, venues: [{ key: 'poly', gap: 3, dBook: 0 }] } }), p), [], 'small jump');
  assert.deepEqual(R.signal(snap({ lag, venues: [] }), p), [], 'book not live');
});

test('late favourite: only near the end, only at or under the cap', () => {
  const R = ruleById('fav'), p = defaults(R);
  const fav = venue({ mid: 0.1, bid: 0.09, ask: 0.11 });   // DOWN at 90%, its ask = 100 − 9 = 91¢
  assert.deepEqual(R.signal(snap({ venues: [fav], T: 45 }), p)[0].legs, [{ venue: 'poly', side: 'down' }]);
  assert.deepEqual(R.signal(snap({ venues: [fav], T: 120 }), p), [], 'too early');
  assert.deepEqual(R.signal(snap({ venues: [venue({ mid: 0.97, bid: 0.96, ask: 0.98 })], T: 45 }), p), [], 'ask above the cap');
});

test('arbitrage: a pair that pays after the split risk, both legs, size from the books', () => {
  const R = ruleById('arb'), p = defaults(R);
  const arb = { upPm: { pa: 0.45, pb: 0.5, fees: 0.035, edge: 0.015, ev: 0.012, pairs: 37.5 }, downPm: { pa: 0.55, pb: 0.5, fees: 0.035, edge: -0.085, ev: -0.09, pairs: 0 } };
  const s = R.signal(snap({ arb }), p);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, 'arb-up');
  assert.equal(s[0].n, 37);
  assert.deepEqual(s[0].legs, [{ venue: 'poly', side: 'up' }, { venue: 'kalshi', side: 'down' }]);
  assert.deepEqual(R.signal(snap({ arb: { upPm: { ...arb.upPm, ev: null } } }), p), [], 'no split estimate: no trade');
  assert.deepEqual(R.signal(snap({ arb: { upPm: { ...arb.upPm, ev: 0.003 } } }), p), [], 'below the edge');
});

test('coin flip: the same side and moment for a round on every reload', () => {
  const R = ruleById('coin');
  const late = R.signal(snap({ T: 20 }), {}), early = R.signal(snap({ T: 295 }), {});
  assert.equal(late.length, 1);
  assert.deepEqual(early, [], 'its moment has not come in the first seconds');
  assert.deepEqual(R.signal(snap({ T: 20 }), {}), late);
  const sides = new Set();
  for (let k = 0; k < 40; k++) sides.add(R.signal(snap({ start: START + k * 300_000, T: 20 }), {})[0].legs[0].side);
  assert.equal(sides.size, 2, 'both sides come up');
});
