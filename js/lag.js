// Book vs price: does the order book keep up with the coin's price? When the price jumps, the model in use says
// how far the UP probability should move; if the book's mid has not followed (yet), its quotes are stale for a
// moment — the classic edge on these short rounds, raced for by bots. Two things, per venue:
//   live:  over the last 2s, the move the price implies against the move the book made
//   jumps: each price jump the model reads as ≥ 5 pts, and how long the book took to cover half of it
//          (negative when the book moved first: market makers watching a faster feed than our median)
// Times are when this browser received the data (exchange timestamps would mix in clock offsets).
import { firstIdx, probAbove } from './math.js';
import { activeModel, activeParams, modelInputs } from './model.js';
import { modelDist } from './models.js';
import { recvMedian } from './prices.js';
import { S } from './state.js';
import { $, currentRound, fmtAmt, fmtC, fmtPts } from './util.js';
import { KS, PM, activeVenues, both } from './venues.js';

const WIN = 2000;           // the live window, ms
const JUMP = 5;             // pts of model probability that count as a jump
const HALF = 0.5;           // the book has reacted once it covered this share of the move
const GIVE_UP = 8000;       // … within this long, else it did not follow
const LAG_SHOW = 3;         // pts the book trails by before the card calls it lagging
const KEEP = 50;            // jumps kept per venue

const lag = { [PM.key]: { events: [], open: null, coolT: 0 }, [KS.key]: { events: [], open: null, coolT: 0 } };
export const lagState = { live: null };

// last point at or before t of a time series [{ t, p }]
const at = (arr, t) => { const i = firstIdx(arr, t + 1) - 1; return i >= 0 ? arr[i] : null; };

// UP probability (pts) the model in use gives at another price, all else as now
function probAt(inp, m, p, price) {
  const d = modelDist(m, { ...inp, price }, p);
  return d ? probAbove(d, inp.strike) * 100 : null;
}

// every 200ms (main.js): the live gap, and the jumps
export function lagTick(now) {
  const inp = modelInputs(now), price = S.lastMedianP;
  lagState.live = null;
  if (!inp || price === null || recvMedian.length < 2) return;
  const then = at(recvMedian, now - WIN);
  if (!then) return;
  const m = activeModel(), p = activeParams(m), p1 = probAt(inp, m, p, price), p0 = probAt(inp, m, p, then.p);
  if (p1 === null || p0 === null) return;
  const dModel = p1 - p0, live = { dPrice: price - then.p, dModel, venues: [] };
  for (const V of activeVenues()) {
    const L = lag[V.key], b1 = V.prob[V.prob.length - 1], b0 = at(V.prob, now - WIN);
    if (V.up === null || !b1 || !b0 || V.cur?.wts * 1000 !== currentRound(now).start) continue;
    live.venues.push({ V, dBook: b1.p - b0.p, gap: dModel - (b1.p - b0.p) });
    // a new jump: when did the price cover half of it (its moment), what was the book then
    if (!L.open && now >= L.coolT && Math.abs(dModel) >= JUMP && (p1 > 3 && p1 < 97 || p0 > 3 && p0 < 97)) {
      const from = firstIdx(recvMedian, now - WIN);
      let tHalf = now;
      for (let i = from; i < recvMedian.length; i++) {
        const q = probAt(inp, m, p, recvMedian[i].p);
        if (q !== null && (q - p0) * Math.sign(dModel) >= HALF * Math.abs(dModel)) { tHalf = recvMedian[i].t; break; }
      }
      L.open = { t0: now - WIN, tHalf, m0: b0.p, need: dModel, dPrice: live.dPrice };
    }
    if (L.open) {
      const o = L.open, dir = Math.sign(o.need);
      // the first book point after the jump began that covered half of the move
      const hit = V.prob.slice(firstIdx(V.prob, o.t0)).find(x => (x.p - o.m0) * dir >= HALF * Math.abs(o.need));
      if (hit || now - o.tHalf > GIVE_UP) {
        L.events.push({ t: o.tHalf, need: o.need, react: hit ? hit.t - o.tHalf : null });
        if (L.events.length > KEEP) L.events.shift();
        L.open = null; L.coolT = now + 5000;
      }
    }
  }
  lagState.live = live;
}

// how a venue's book followed the recent jumps
export function lagStats(V) {
  const ev = lag[V.key].events;
  if (!ev.length) return null;
  const r = ev.filter(e => e.react !== null).map(e => e.react).sort((a, b) => a - b);
  return { n: ev.length, followed: r.length, first: r.filter(x => x < 0).length, med: r.length ? r[r.length >> 1] : null };
}

const secs = ms => (ms < 0 ? '−' : '') + (Math.abs(ms) / 1000).toFixed(1) + 's';

// the Signals row, every second
export function renderLag() {
  const val = $('lag-val'), sub = $('lag-sub'), live = lagState.live;
  if (!live || !live.venues.length) { val.textContent = '—'; val.className = 'sig-value'; sub.textContent = 'Needs price, strike, model and the running round’s book'; return; }
  const worst = live.venues.reduce((a, x) => !a || Math.abs(x.gap) > Math.abs(a.gap) ? x : a, null);
  const lagging = Math.abs(live.dModel) >= LAG_SHOW && Math.abs(worst.gap) >= LAG_SHOW && Math.sign(worst.gap) === Math.sign(live.dModel);
  val.textContent = lagging ? `${both() ? worst.V.short + ' ' : ''}lags ${Math.abs(worst.gap).toFixed(0)} pts ${worst.gap > 0 ? '▲' : '▼'}` : 'In step';
  val.className = 'sig-value' + (lagging ? ' warn' : '');
  const book = live.venues.map(x => `${both() ? x.V.short + ' ' : ''}book ${fmtPts(x.dBook)}`).join(', ');
  const st = live.venues.map(x => ({ V: x.V, s: lagStats(x.V) })).filter(x => x.s);
  const hist = st.map(({ V, s }) => `${both() ? V.short + ' ' : ''}` + (s.med !== null
    ? `follows jumps in ${secs(s.med)} (median of ${s.followed}${s.first ? `, ${s.first} moved first` : ''}${s.followed < s.n ? `, ${s.n - s.followed} did not follow` : ''})`
    : `did not follow ${s.n} jump${s.n > 1 ? 's' : ''}`)).join(' · ');
  sub.textContent = `Last 2s: ${S.A.sym} ${live.dPrice >= 0 ? '+' : '−'}${fmtAmt(Math.abs(live.dPrice))} → model ${fmtPts(live.dModel)}, ${book}` +
    (hist ? ` · ${hist}` : ` · no ${JUMP}-pt jump yet`) + (KS.on ? ' · Kalshi is polled once a second' : '');
}

// a stale book worth an alert: lagging ≥ 5 pts behind a jump of ≥ 6
export function staleBook() {
  const live = lagState.live;
  if (!live || Math.abs(live.dModel) < 6) return null;
  const v = live.venues.find(x => Math.abs(x.gap) >= 5 && Math.sign(x.gap) === Math.sign(live.dModel));
  if (!v) return null;
  const f = v.V.cur, side = live.dModel > 0 ? 'up' : 'down';
  let price = null;
  if (f) {
    if (side === 'up') { let ba = 1000; for (const k in f.asks) if (+k < ba) ba = +k; price = ba < 1000 ? ba / 1000 : null; }
    else { let bb = 0; for (const k in f.bids) if (+k > bb) bb = +k; price = bb > 0 ? 1 - bb / 1000 : null; }
  }
  return { V: v.V, side, gap: v.gap, dModel: live.dModel, price, text: price !== null ? `${side.toUpperCase()} ask ${fmtC(price)}` : '' };
}
