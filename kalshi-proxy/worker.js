// Kalshi market-data proxy for the BTC dashboard (Cloudflare Worker).
//
// Kalshi's REST API sends CORS headers only for kalshi.com and answers other browser origins with 403, and its
// WebSocket needs an API key. So the dashboard on GitHub Pages can't read Kalshi directly. This Worker forwards
// the few public, read-only market-data requests the dashboard makes (no API key, no account) and adds CORS
// headers for the dashboard's own origins. Everything else is refused.

const UPSTREAM = 'https://api.elections.kalshi.com';

// browser origins allowed to use the proxy ("null" = the HTML file opened from disk)
const ORIGINS = [
  /^https:\/\/mariusrapp\.github\.io$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  /^null$/,
];

// the read-only endpoints the dashboard uses
const PATHS = [
  /^\/trade-api\/v2\/markets$/,                                                   // market lookup, settled rounds
  /^\/trade-api\/v2\/markets\/trades$/,                                           // trades of a past round
  /^\/trade-api\/v2\/markets\/[A-Z0-9.-]+$/,                                      // one market: target price, last trade
  /^\/trade-api\/v2\/markets\/[A-Z0-9.-]+\/orderbook$/,                           // the book, polled every second
  /^\/trade-api\/v2\/series\/[A-Z0-9]+\/markets\/[A-Z0-9.-]+\/candlesticks$/,    // 1-minute candles
];

// edge cache in seconds: the book for 1s (several viewers → one upstream call), finished time windows for a day
function cacheSeconds(url) {
  const p = url.pathname;
  if (p.endsWith('/orderbook')) return 1;
  if (p.endsWith('/trades') || p.endsWith('/candlesticks')) {
    const end = +(url.searchParams.get('max_ts') || url.searchParams.get('end_ts') || 0);
    if (end && end < Date.now() / 1000 - 120) return 86400;
  }
  return 2;
}

const corsHeaders = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    if (origin === null || !ORIGINS.some(r => r.test(origin))) return new Response('origin not allowed', { status: 403 });
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    if (!PATHS.some(r => r.test(url.pathname))) return new Response('not found', { status: 404, headers: cors });

    const ttl = cacheSeconds(url);
    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'btc-dashboard-proxy/1.0' },
        cf: { cacheTtl: ttl, cacheEverything: true },   // Cloudflare only; ignored elsewhere
      });
    } catch {
      return new Response('Kalshi unreachable', { status: 502, headers: cors });
    }
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', upstream.ok ? `public, max-age=${ttl}` : 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
