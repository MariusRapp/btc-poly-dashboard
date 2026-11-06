// The coins the dashboard and the recorder follow. Polymarket lists "<coin> Up or Down" rounds of 5 and 15 minutes
// (slug <poly>-updown-5m-<start>), Kalshi 15-minute rounds (series <kalshi>), all on a 60s average at start and end.
// Every symbol below was checked against the live APIs (2026-11-06). Pure: shared with the recorder Worker.
//
// dp = decimals of a price, dc = decimals of a rounded amount ("±$12", "±$0.004"): the coins differ by six orders
// of magnitude. bitfinex: the USDt pair (its USD pairs trade above bank dollars), converted with Coinbase USDT-USD.
export const ASSETS = [
  { id: 'btc',  sym: 'BTC',  name: 'Bitcoin',  dp: 2, dc: 0, poly: 'btc',  kalshi: 'KXBTC15M',  coinbase: 'BTC-USD',  kraken: 'XBTUSD', krakenWs: 'XBT/USD',
    bitstamp: 'btcusd',  gemini: 'BTCUSD',  bitfinex: 'tBTCUST',   binance: 'BTCUSDT',  chainlink: '0xc907E116054Ad103354f2D350FD2514433D57F6f' },
  { id: 'eth',  sym: 'ETH',  name: 'Ethereum', dp: 2, dc: 1, poly: 'eth',  kalshi: 'KXETH15M',  coinbase: 'ETH-USD',  kraken: 'ETHUSD', krakenWs: 'ETH/USD',
    bitstamp: 'ethusd',  gemini: 'ETHUSD',  bitfinex: 'tETHUST',   binance: 'ETHUSDT',  chainlink: '0xF9680D99D6C9589e2a93a78A04A279e509205945' },
  { id: 'sol',  sym: 'SOL',  name: 'Solana',   dp: 3, dc: 2, poly: 'sol',  kalshi: 'KXSOL15M',  coinbase: 'SOL-USD',  kraken: 'SOLUSD', krakenWs: 'SOL/USD',
    bitstamp: 'solusd',  gemini: 'SOLUSD',  bitfinex: 'tSOLUST',   binance: 'SOLUSDT',  chainlink: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC' },
  { id: 'xrp',  sym: 'XRP',  name: 'XRP',      dp: 4, dc: 4, poly: 'xrp',  kalshi: 'KXXRP15M',  coinbase: 'XRP-USD',  kraken: 'XRPUSD', krakenWs: 'XRP/USD',
    bitstamp: 'xrpusd',  gemini: 'XRPUSD',  bitfinex: 'tXRPUST',   binance: 'XRPUSDT',  chainlink: '0x785ba89291f676b5386652eB12b30cF361020694' },
  { id: 'doge', sym: 'DOGE', name: 'Dogecoin', dp: 5, dc: 5, poly: 'doge', kalshi: 'KXDOGE15M', coinbase: 'DOGE-USD', kraken: 'XDGUSD', krakenWs: 'XDG/USD',
    bitstamp: 'dogeusd', gemini: 'DOGEUSD', bitfinex: 'tDOGE:UST', binance: 'DOGEUSDT', chainlink: '0xbaf9327b6564454F4a3364C33eFeEf032b4b4444' },
];
export const assetById = id => ASSETS.find(a => a.id === id) ?? ASSETS[0];

// Series id of a market, as the recorder stores it and the dashboard keeps its track record:
// Bitcoin keeps the names it had before the other coins came (poly5, poly15, kalshi15), the others are prefixed.
export const seriesId = (assetId, venue, lenMin) => (assetId === 'btc' ? '' : assetId + '-') + venue + lenMin;
export const parseSeries = id => {
  const m = /^(?:([a-z]+)-)?(poly|kalshi)(5|15)$/.exec(id || '');
  return m && { asset: m[1] || 'btc', venue: m[2], len: +m[3] * 60 };
};
