import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows } from '../js/recorder.js';

test('mergeRows: a refresh of the last hours replaces changed rows, adds new ones, drops what fell out of the window', () => {
  const old = [{ start: 100, result: 'up' }, { start: 400, result: null }, { start: 700, result: null }];
  const fresh = [{ start: 700, result: 'down' }, { start: 1000, result: null }];
  assert.deepEqual(mergeRows(old, fresh, r => r.start, 300),
    [{ start: 400, result: null }, { start: 700, result: 'down' }, { start: 1000, result: null }]);
  // snapshots: keyed by round and minute, ordered by both
  const snaps = mergeRows([{ start: 0, t: 60 }, { start: 0, t: 120 }], [{ start: 0, t: 120, bid: 0.5 }, { start: 300, t: 360 }], r => r.start + '|' + r.t, 0);
  assert.deepEqual(snaps, [{ start: 0, t: 60 }, { start: 0, t: 120, bid: 0.5 }, { start: 300, t: 360 }]);
});
