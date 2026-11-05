// Polymarket: market lookup (Gamma), order book over the CLOB WebSocket, round switch with the next market
// preloaded, official results and past rounds.

import { setBookView } from './ladder.js';
import { updateTitle } from './mode.js';
import { fetchVol } from './model.js';
import { refreshRounds, setResult } from './rounds.js';
import { ROUND_MS, ROUND_S, S, TWAP_MS } from './state.js';
import { currentRound, fmtClock, getJSON } from './util.js';
import { PM, archiveRound, closeFeed, makeFeed, onBookChange, retireFeed, setLevel } from './venues.js';

export async function pmFetchResult(ts) {
  const gen = S.modeGen;
  try {
    const ev = await fetchEvent(ts);
    const m = ev?.markets[0];
    if (!m || gen !== S.modeGen) return;
    PM.meta.set(ts, parseMarket(ev, ts));
    const outcomes = JSON.parse(m.outcomes || '[]'), prices = JSON.parse(m.outcomePrices || '[]').map(Number);
    const win = m.closed ? outcomes[prices.indexOf(1)] : null;
    setResult(PM, ts, win === 'Up' ? 'up' : win === 'Down' ? 'down' : 'pending');
  } catch {}
}

// ── Polymarket ───────────────────────────────────────────────────────────────
const GAMMA = 'https://gamma-api.polymarket.com';
const PM_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// rounds are listed as btc-updown-5m-<start> and btc-updown-15m-<start>
async function fetchEvent(wts) {
  const d = await getJSON(`${GAMMA}/events?slug=btc-updown-${ROUND_S / 60}m-${wts}`);
  return d[0]?.markets?.length ? d[0] : null;
}

// market of the running round (Gamma lists the rounds about an hour ahead)
async function findMarket() {
  const base = currentRound().start / 1000;
  for (const wts of [base, base + ROUND_S]) {
    try { const event = await fetchEvent(wts); if (event) return { wts, event }; } catch {}
  }
  return null;
}

function parseMarket(event, wts) {
  const m   = event.markets[0];
  const ids = JSON.parse(m.clobTokenIds || '[]');
  return { wts, question: m.question || event.title, yesId: ids[0] || null, cid: m.conditionId, tick: +m.orderPriceMinTickSize || 0.01 };
}

function connectFeed(f) {
  if (f.closed) return;
  f.bids = {}; f.asks = {}; f.state = 'wait'; f.stamp = 'Connecting…';
  const ws = f.ws = new WebSocket(PM_WS);
  ws.onopen = () => {
    ws.send(JSON.stringify({ assets_ids: [f.yesId], type: 'market' }));
    f.state = 'live'; f.stamp = 'Live'; f.lastMsgT = Date.now();
  };
  ws.onmessage = e => {
    f.lastMsgT = Date.now();
    let msgs;
    try { msgs = JSON.parse(e.data); } catch { return; }
    let changed = false;
    for (const msg of (Array.isArray(msgs) ? msgs : [msgs])) {
      const et = msg.event_type, mine = msg.asset_id === f.yesId;
      if (et === 'book' && mine) {
        f.bids = {}; f.asks = {};
        for (const b of (msg.bids || [])) setLevel(f, f.bids, b.price, b.size);
        for (const a of (msg.asks || [])) setLevel(f, f.asks, a.price, a.size);
        if (+msg.tick_size < 0.01) f.fine = true;
        changed = true;
      } else if (et === 'price_change') {
        // price_changes[] has an asset_id per entry and also carries the DOWN token; `changes` is the older format
        for (const c of (msg.price_changes || msg.changes || [])) {
          if ((c.asset_id ?? msg.asset_id) !== f.yesId) continue;
          setLevel(f, String(c.side).toUpperCase() === 'BUY' ? f.bids : f.asks, c.price, c.size);
          changed = true;
        }
      } else if (et === 'last_trade_price' && mine) {
        f.last = parseFloat(msg.price); changed = true;
      } else if (et === 'tick_size_change' && mine && +msg.new_tick_size < 0.01) {
        f.fine = true; changed = true;
      }
    }
    if (!changed) return;
    onBookChange(PM, f);
    f.stamp = 'Live · ' + fmtClock(f.lastMsgT);
  };
  ws.onclose = () => {
    if (f.ws !== ws || f.closed) return;
    f.state = 'err'; f.stamp = 'Reconnecting…';
    setTimeout(() => connectFeed(f), 2500);
  };
  ws.onerror = () => ws.close();
}

// ── Round switch: the preloaded next market takes over at the boundary, no reload ──
export function checkRoundSwitch(now) {
  const rs = currentRound(now).start / 1000, cur = PM.cur, nxt = PM.nxt;
  if (cur && cur.wts >= rs) {
    if (!PM.preloading && now >= PM.preloadRetryT && (!nxt || nxt.wts !== cur.wts + ROUND_S)) preloadNext();
    return;
  }
  if (PM.loading) return;
  if (nxt && nxt.wts === rs) return promoteNext();
  retireFeed(PM, cur);
  if (nxt && nxt.wts < rs) retireFeed(PM, nxt);   // away for over a round: the preloaded one has ended too
  if (now >= PM.retryT) loadPolymarket();
}

async function preloadNext() {
  const wts = PM.cur.wts + ROUND_S, gen = S.modeGen;
  PM.preloading = true;
  try {
    const event = await fetchEvent(wts);
    const m = event && parseMarket(event, wts);
    if (!m?.yesId) throw new Error('next round not listed yet');
    if (gen !== S.modeGen || !PM.cur || PM.cur.wts + ROUND_S !== wts) return;
    closeFeed(PM.nxt);
    PM.nxt = makeFeed(m);
    PM.meta.set(wts, m);
    connectFeed(PM.nxt);
  } catch (e) {
    if (gen === S.modeGen) PM.preloadRetryT = Date.now() + 10_000;
  } finally {
    if (gen === S.modeGen) PM.preloading = false;
  }
}

function promoteNext() {
  archiveRound(PM);
  closeFeed(PM.cur);
  const cur = PM.cur = PM.nxt;
  PM.nxt = null;
  const from = cur.wts * 1000 - TWAP_MS;
  PM.prob.length = 0;
  for (const p of cur.hist) if (p.t >= from) PM.prob.push(p);
  cur.hist = [];
  PM.up = PM.lastProb = cur.mid !== null ? cur.mid * 100 : null;
  updateTitle();
  if (S.bookView === 'next') setBookView('now');
  PM.preloadRetryT = 0;
  fetchVol();
  refreshRounds();
}

// probability so far in the running round (Polymarket keeps about one point a minute), ahead of the live points
async function backfillProbHistory(f) {
  const roundStart = f.wts * 1000, roundEnd = roundStart + ROUND_MS;
  try {
    // a time range, not interval=all: that thins out markets listed long before (15m rounds: ~1 point per round)
    const r = await fetch(`https://clob.polymarket.com/prices-history?market=${f.yesId}&startTs=${f.wts - 60}&endTs=${Math.floor(Date.now() / 1000)}&fidelity=1`);
    if (!r.ok) return;
    const d = await r.json();
    if (!Array.isArray(d.history) || PM.cur !== f) return;
    const first = PM.prob[0]?.t ?? Infinity;
    PM.prob.unshift(...d.history.map(h => ({ t: h.t * 1000, p: h.p * 100 }))
      .filter(h => h.t >= roundStart - TWAP_MS && h.t < roundEnd && h.t < first).sort((a, b) => a.t - b.t));
  } catch {}
}

// full (re)load: first start, or when no preloaded market fits (e.g. back after a long time in the background)
export async function loadPolymarket() {
  if (PM.loading) return;
  PM.loading = true;
  const gen = S.modeGen;
  try {
    updateTitle('Loading market…');
    fetchVol();
    refreshRounds();
    const result = await findMarket();
    if (gen !== S.modeGen) return;
    const m = result && parseMarket(result.event, result.wts);
    if (!m?.yesId) {
      updateTitle('No active market – retrying…');
      PM.retryT = Date.now() + 8000;
      return;
    }
    if (PM.cur && PM.cur.wts !== m.wts) archiveRound(PM);
    closeFeed(PM.cur);
    if (PM.nxt && PM.nxt.wts <= m.wts) { closeFeed(PM.nxt); PM.nxt = null; }
    const f = PM.cur = makeFeed(m);
    PM.meta.set(m.wts, m);
    PM.prob.length = 0;
    PM.up = PM.lastProb = null;
    updateTitle();
    await backfillProbHistory(f);
    if (gen === S.modeGen && PM.cur === f) connectFeed(f);
  } finally {
    if (gen === S.modeGen) PM.loading = false;
  }
}

export async function pmReviewProb(ts) {
  const arch = PM.archive.get(ts);
  if (arch?.length && arch[0].t <= ts * 1000 + 15_000) return arch;
  let m = PM.meta.get(ts);
  if (!m) {
    const ev = await fetchEvent(ts);
    if (!ev) return [];
    m = parseMarket(ev, ts); PM.meta.set(ts, m);
  }
  const a = ts - 60, b = ts + ROUND_S, bySec = new Map();
  try {
    let cursor = '';
    for (let page = 0; page < ROUND_S / 30; page++) {   // ~1000 trades cover a few minutes
      const d = await getJSON(`https://data-api.polymarket.com/v2/trades?conditionId=${m.cid}&limit=1000${cursor}`);
      const rows = d.data || [];
      let oldest = Infinity;
      for (const r of rows) {
        oldest = Math.min(oldest, r.timestamp);
        if (r.timestamp < a || r.timestamp > b) continue;
        const up = r.token_id ? r.token_id === m.yesId : r.outcome === 'Up';
        if (!bySec.has(r.timestamp)) bySec.set(r.timestamp, []);
        bySec.get(r.timestamp).push(up ? +r.price : 1 - r.price);
      }
      if (!d.pagination?.has_more || !rows.length || oldest < a) break;
      cursor = '&cursor=' + encodeURIComponent(d.pagination.next_cursor);
    }
  } catch (e) {
    // fallback: Polymarket's price history, about one point a minute
    console.warn('round trades:', e.message);
    const d = await getJSON(`https://clob.polymarket.com/prices-history?market=${m.yesId}&startTs=${a}&endTs=${b}&fidelity=1`);
    return (d.history || []).map(h => ({ t: h.t * 1000, p: h.p * 100 })).sort((x, y) => x.t - y.t);
  }
  // one point per second: the median trade price
  return [...bySec.keys()].sort((x, y) => x - y).map(s => {
    const v = bySec.get(s).sort((x, y) => x - y), n = v.length;
    return { t: s * 1000, p: (n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2) * 100 };
  });
}
