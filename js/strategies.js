// The paper bot's rules: pure functions from a snapshot of the running round to what the bot would buy. No DOM,
// no state; covered by test/strategies.test.js. The engine (bot.js) builds the snapshot, fills the orders at the
// live book after a reaction time, sells the positions of the rules with exits again and settles the rest.
//
// Snapshot `c`: { now (ms), start (ms, round start), T (s left), len (round s), model (UP % or null),
//   venues: [{ key: 'poly' | 'kalshi', fee, bid, ask (best UP bid / ask, 0..1, or null), mid (UP, 0..1),
//              spread, hist: [{ t, p: UP % }] (this venue's probability history) }],
//   arb: arb.js arbState() with both venues on, else null,
//   lag: { dModel, venues: [{ key, gap, dBook }] } (lag.js, last 2s), or null }
// A signal: { legs: [{ venue, side }], why, key? (counts against the rule's trades a round; default the venue),
//             n? (at most this many shares) }
import { buyEdge } from './math.js';

const c1 = x => Math.round(x * 1000) / 10 + '¢';
const pts = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(0) + ' pts';
const pc = x => Math.round(x * 100) + '%';
const venueName = k => k === 'kalshi' ? 'Kalshi' : 'Poly';

// the biggest move of the UP mid within the last `win` s of this round: up from the window's low, down from its high
export function breakout(hist, now, win, start) {
  const from = Math.max(now - win * 1000, start);
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = hist.length - 1; i >= 0 && hist[i].t >= from; i--) { lo = Math.min(lo, hist[i].p); hi = Math.max(hi, hist[i].p); n++; }
  if (n < 2) return null;
  const cur = hist[hist.length - 1].p;
  return { cur, up: cur - lo, down: hi - cur };
}

// Should an open position be sold now? gain = what selling now nets a share minus what it cost a share (both fees in:
// right after buying that is already spread + two fees below zero, ~4¢ at 50¢). Settings in ¢ and s; 0 switches a
// limit off. `unwind`: one leg of an arbitrage pair whose other leg missed, sold again at once.
export function exitWhy(gain, heldS, T, p) {
  if (p.unwind) return 'unwind';
  if (p.tp > 0 && gain * 100 >= p.tp) return 'target';
  if (p.sl > 0 && gain * 100 <= -p.sl) return 'stop';
  if (p.hold > 0 && heldS >= p.hold) return 'time';
  if (p.before > 0 && T <= p.before) return 'end';
  return null;
}
export const EXIT_KEYS = ['tp', 'sl', 'hold', 'before'];

// the price a side is bought at: UP at the ask, DOWN at 100¢ − the UP bid
const askOf = (v, side) => side === 'up' ? v.ask : v.bid !== null ? 1 - v.bid : null;

const MAX_N = { k: 'n', label: 'Trades a round', unit: '', min: 1, max: 10, step: 1, def: 2, hint: 'per market' };
const exitParams = (tp, sl, hold, before) => [
  { k: 'tp', label: 'Take profit', unit: '¢', min: 0, max: 50, step: 0.5, def: tp, hint: 'a share, after both fees · 0 = off' },
  { k: 'sl', label: 'Stop loss', unit: '¢', min: 0, max: 50, step: 0.5, def: sl, hint: 'after both fees: a new position starts ~4¢ down · 0 = off' },
  { k: 'hold', label: 'Sell after', unit: 's', min: 0, max: 900, step: 5, def: hold, hint: '0 = no time limit' },
  { k: 'before', label: 'Sell before the end', unit: 's', min: 0, max: 300, step: 5, def: before, hint: '0 = hold to the end' },
];

// a jump of the UP price within the window, on a book with a tight spread and away from 0 / 100
function jumps(c, p) {
  if (c.T < p.last) return [];
  const out = [];
  for (const v of c.venues) {
    const b = breakout(v.hist, c.now, p.win, c.start);
    if (!b || v.spread > 0.04 || b.cur < 10 || b.cur > 90) continue;
    const dir = b.up >= p.move && b.up >= b.down ? 1 : b.down >= p.move ? -1 : 0;
    if (dir) out.push({ v, dir, move: dir > 0 ? b.up : b.down });
  }
  return out;
}

// deterministic "random" number in [0, 1) for a round (the coin flip), so a reload does not flip again
const hash01 = (s, salt) => {
  let x = Math.imul((s ^ salt) >>> 0, 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
};

export const STRATEGIES = [
  {
    id: 'arb', name: 'Arbitrage', both: true,
    desc: 'Both venues only: buys UP on one and DOWN on the other when the pair costs under $1 after fees and still pays after the chance that the two settle apart. As many pairs as the books have under $1, at most the shares setting. Held to the end; if one leg misses, the other is sold again at once.',
    params: [{ k: 'edge', label: 'Min. edge', unit: '¢', min: 0, max: 10, step: 0.1, def: 0.5, hint: 'a pair, after the split risk' }, { ...MAX_N, def: 1, hint: 'each way' }],
    signal(c, p) {
      const a = c.arb;
      if (!a || c.T < 10) return [];
      const out = [];
      for (const [r, pm, key] of [[a.upPm, 'up', 'arb-up'], [a.downPm, 'down', 'arb-down']]) {
        if (!r || r.ev == null || r.ev * 100 < p.edge || r.pairs < 1) continue;
        out.push({ key, n: Math.floor(r.pairs), legs: [{ venue: 'poly', side: pm }, { venue: 'kalshi', side: pm === 'up' ? 'down' : 'up' }],
                   why: `pair ${c1(r.pa + r.pb + r.fees)} with fees, ${r.ev >= 0 ? '+' : '−'}${c1(Math.abs(r.ev))} after the split risk` });
      }
      return out;
    },
  },
  {
    id: 'edge', name: 'Model edge',
    desc: 'Buys the side the model in use (Model card) gives a higher chance than its ask plus the fee, by at least the edge. Once a round per market, held to the end.',
    params: [
      { k: 'edge', label: 'Min. edge', unit: '¢', min: 1, max: 30, step: 0.5, def: 5, hint: 'a share, after the fee' },
      { k: 'from', label: 'Not in the first', unit: 's', min: 0, max: 600, step: 5, def: 30, hint: 'of the round' },
      { k: 'last', label: 'Not in the last', unit: 's', min: 0, max: 300, step: 5, def: 60, hint: 'of the round' },
    ],
    signal(c, p) {
      if (c.model === null || c.len - c.T < p.from || c.T < p.last) return [];
      const out = [];
      for (const v of c.venues) {
        let best = null;
        for (const side of ['up', 'down']) {
          const price = askOf(v, side), win = side === 'up' ? c.model / 100 : 1 - c.model / 100;
          if (price === null) continue;
          const edge = buyEdge(price, win, v.fee);
          if (!best || edge > best.edge) best = { side, price, win, edge };
        }
        if (best && best.edge * 100 >= p.edge)
          out.push({ legs: [{ venue: v.key, side: best.side }], why: `model ${pc(best.win)} vs ask ${c1(best.price)}: +${c1(best.edge)} after the fee` });
      }
      return out;
    },
  },
  {
    id: 'meanrev', name: 'Mean reversion', exits: true,
    desc: 'When the UP price jumps by the move within the window, takes the other side and sells again once the jump has partly come back (take profit), at the stop, after the time limit or before the end. Fees count both ways.',
    params: [
      { k: 'move', label: 'Jump of', unit: 'pts', min: 3, max: 50, step: 1, def: 15, hint: 'UP price, in % points' },
      { k: 'win', label: 'Within', unit: 's', min: 5, max: 180, step: 5, def: 30, hint: 'also the pause after a trade' },
      { k: 'last', label: 'Not in the last', unit: 's', min: 0, max: 300, step: 5, def: 60, hint: 'late jumps are the result arriving' },
      ...exitParams(3, 12, 120, 30), MAX_N,
    ],
    signal(c, p) {
      return jumps(c, p).map(({ v, dir, move }) => ({
        legs: [{ venue: v.key, side: dir > 0 ? 'down' : 'up' }],
        why: `UP ${pts(dir * move)} in ${p.win}s on ${venueName(v.key)}: fade it`,
      }));
    },
  },
  {
    id: 'momentum', name: 'Momentum', exits: true,
    desc: 'The opposite bet: when the UP price jumps by the move within the window, follows it, and sells at the target, the stop, the time limit or before the end.',
    params: [
      { k: 'move', label: 'Jump of', unit: 'pts', min: 3, max: 50, step: 1, def: 10, hint: 'UP price, in % points' },
      { k: 'win', label: 'Within', unit: 's', min: 5, max: 180, step: 5, def: 30, hint: 'also the pause after a trade' },
      { k: 'last', label: 'Not in the last', unit: 's', min: 0, max: 300, step: 5, def: 30, hint: 'of the round' },
      ...exitParams(6, 12, 0, 20), MAX_N,
    ],
    signal(c, p) {
      return jumps(c, p).map(({ v, dir, move }) => ({
        legs: [{ venue: v.key, side: dir > 0 ? 'up' : 'down' }],
        why: `UP ${pts(dir * move)} in ${p.win}s on ${venueName(v.key)}: follow it`,
      }));
    },
  },
  {
    id: 'stale', name: 'Stale book', exits: true,
    desc: 'When the coin’s price jumps and a book has not followed yet (Book vs price in Signals), buys the side the price points to at the old quotes and sells once the book has caught up. Bots race for this; set the reaction time honestly.',
    params: [
      { k: 'gap', label: 'Book behind by', unit: 'pts', min: 2, max: 25, step: 1, def: 5, hint: 'vs what the model reads from the jump' },
      ...exitParams(2, 10, 20, 10), { ...MAX_N, def: 3 },
    ],
    signal(c, p) {
      const L = c.lag;
      if (!L || c.T < 15 || Math.abs(L.dModel) < p.gap) return [];
      const side = L.dModel > 0 ? 'up' : 'down';
      return L.venues.filter(x => Math.abs(x.gap) >= p.gap && Math.sign(x.gap) === Math.sign(L.dModel) && c.venues.some(v => v.key === x.key))
        .map(x => ({ legs: [{ venue: x.key, side }], why: `price says ${pts(L.dModel)}, ${venueName(x.key)} book ${pts(x.dBook)} in 2s` }));
    },
  },
  {
    id: 'fav', name: 'Late favourite',
    desc: 'In the last seconds, buys the side the market already prices high, while its ask is at most the cap: the bet that favourites are a little underpriced near the end. Once a round per market, held to the end.',
    params: [
      { k: 'last', label: 'In the last', unit: 's', min: 10, max: 300, step: 5, def: 60, hint: 'of the round' },
      { k: 'min', label: 'Favourite from', unit: '%', min: 55, max: 99, step: 1, def: 85, hint: 'market mid' },
      { k: 'cap', label: 'Pay at most', unit: '¢', min: 60, max: 99.5, step: 0.5, def: 95, hint: 'ask, before the fee' },
    ],
    signal(c, p) {
      if (c.T > p.last || c.T < 3) return [];
      const out = [];
      for (const v of c.venues) {
        const side = v.mid >= 0.5 ? 'up' : 'down', prob = side === 'up' ? v.mid : 1 - v.mid, ask = askOf(v, side);
        if (ask !== null && prob * 100 >= p.min && ask * 100 <= p.cap)
          out.push({ legs: [{ venue: v.key, side }], why: `${side.toUpperCase()} at ${pc(prob)} with ${Math.round(c.T)}s left, ask ${c1(ask)}` });
      }
      return out;
    },
  },
  {
    id: 'coin', name: 'Coin flip',
    desc: 'Baseline without any edge: one random side a round at a random moment, held to the end. What spread and fees cost on their own; a rule should beat it.',
    params: [],
    signal(c) {
      const s = Math.round(c.start / 1000), at = 0.1 + 0.75 * hash01(s, 1), side = hash01(s, 2) < 0.5 ? 'up' : 'down';
      if (c.len - c.T < at * c.len || c.T < 10) return [];
      return c.venues.map(v => ({ legs: [{ venue: v.key, side }], why: `${side.toUpperCase()} by chance` }));
    },
  },
];
export const ruleById = id => STRATEGIES.find(R => R.id === id);

// a rule's settings: saved values where valid (a number within its range), defaults otherwise
export function ruleParams(R, saved) {
  const out = {};
  for (const q of R.params) {
    const v = saved?.[q.k];
    out[q.k] = typeof v === 'number' && Number.isFinite(v) && v >= q.min && v <= q.max ? v : q.def;
  }
  return out;
}
