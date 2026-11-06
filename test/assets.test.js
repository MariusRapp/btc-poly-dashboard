import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSETS, assetById, seriesId, parseSeries } from '../js/assets.js';

test('assets: every coin has every symbol', () => {
  const keys = ['id', 'sym', 'name', 'dp', 'dc', 'poly', 'kalshi', 'coinbase', 'kraken', 'krakenWs', 'bitstamp', 'gemini', 'bitfinex', 'binance', 'chainlink'];
  for (const a of ASSETS) for (const k of keys) assert.ok(a[k] !== undefined && a[k] !== '', `${a.id}.${k}`);
  assert.equal(new Set(ASSETS.map(a => a.id)).size, ASSETS.length);
  assert.equal(assetById('nope').id, 'btc');
  assert.equal(assetById('eth').kalshi, 'KXETH15M');
});

test('series ids: Bitcoin keeps the old names, the others are prefixed, and they parse back', () => {
  assert.equal(seriesId('btc', 'poly', 5), 'poly5');
  assert.equal(seriesId('btc', 'kalshi', 15), 'kalshi15');
  assert.equal(seriesId('eth', 'poly', 15), 'eth-poly15');
  assert.deepEqual(parseSeries('poly5'), { asset: 'btc', venue: 'poly', len: 300 });
  assert.deepEqual(parseSeries('doge-kalshi15'), { asset: 'doge', venue: 'kalshi', len: 900 });
  assert.equal(parseSeries('poly7'), null);
  assert.equal(parseSeries(null), null);
  for (const a of ASSETS) for (const [v, l] of [['poly', 5], ['poly', 15], ['kalshi', 15]])
    assert.deepEqual(parseSeries(seriesId(a.id, v, l)), { asset: a.id, venue: v, len: l * 60 });
});
