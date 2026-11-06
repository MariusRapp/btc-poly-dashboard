// Recent rounds with official results, and the track record kept in this browser.

import { KS_FEE, PM_FEE } from './arb.js';
import { seriesId } from './assets.js';
import { ksFetchResult, ksRefreshResults } from './kalshi.js';
import { twap } from './math.js';
import { pmFetchResult } from './polymarket.js';
import { loadRecorded, recorded } from './recorder.js';
import { syncReview } from './review.js';
import { ROUNDS_SHOWN, ROUND_S, S, TWAP_MS, medianHistory } from './state.js';
import { OPEN, backtest, calibration, marketProb, summary } from './stats.js';
import { $, currentRound, fmtHM, roundSpan, signedC } from './util.js';
import { KS, PM, activeVenues, both, mainVenue } from './venues.js';

// ── Recent rounds + track record ─────────────────────────────────────────────
// official results from each venue; the track record (market + model 60s before the end, own result)
// lives in this browser's localStorage, one store per venue and round length
// (Bitcoin keeps the keys it had before the other coins came)
const TRACK_KEYS = { poly5: 'btc5m-track-v1', poly15: 'btc-track-poly15-v1', kalshi15: 'btc-track-kalshi15-v1' };
const trackKey = id => TRACK_KEYS[id] ?? `track-${id}-v1`;
const tracks = {};
// series id of a venue's market in view: poly5, poly15, kalshi15 for Bitcoin, eth-poly5 … for the others
export const trackId = V => seriesId(S.asset, V === KS ? 'kalshi' : 'poly', V === KS ? 15 : ROUND_S / 60);
function trackOf(V) {
  const id = trackId(V);
  if (!tracks[id]) tracks[id] = (() => { try { return JSON.parse(localStorage.getItem(trackKey(id))) || {}; } catch { return {}; } })();
  return tracks[id];
}

function saveTrack(V) {
  const t = trackOf(V);
  try {
    const keys = Object.keys(t).sort();
    while (keys.length > 600) delete t[keys.shift()];
    localStorage.setItem(trackKey(trackId(V)), JSON.stringify(t));
  } catch {}
}

export function setResult(V, ts, res) {
  V.results.set(ts, res);
  const t = trackOf(V);
  if (res !== 'pending' && t[ts] && !t[ts].outcome) { t[ts].outcome = res; saveTrack(V); }
}

export async function refreshRounds() {
  const cur = currentRound().start / 1000, gen = S.modeGen, jobs = [];
  if (PM.on) {
    for (let k = 1; k <= ROUNDS_SHOWN; k++) {
      const ts = cur - ROUND_S * k, r = PM.results.get(ts);
      if (r !== 'up' && r !== 'down') jobs.push(pmFetchResult(ts));
    }
  }
  if (KS.on) jobs.push(ksRefreshResults());
  // tracked rounds from earlier visits that still miss their result
  for (const V of activeVenues()) {
    const t = trackOf(V), fetchOne = V === PM ? pmFetchResult : ksFetchResult;
    // (few for Kalshi: its API allows only ~5–10 requests a second)
    for (const ts of Object.keys(t).filter(ts => !t[ts].outcome && +ts < cur - ROUND_S * ROUNDS_SHOWN).slice(V === PM ? -10 : -3)) jobs.push(fetchOne(+ts));
  }
  await Promise.all(jobs);
  if (gen === S.modeGen) renderRounds();
}

// a round's official result in the current mode; with both venues 'split' when they settled differently
export function roundResult(ts) {
  if (!both()) return mainVenue().results.get(ts);
  const a = PM.results.get(ts), b = KS.results.get(ts), done = r => r === 'up' || r === 'down';
  if (done(a) && done(b)) return a === b ? a : 'split';
  if (a === undefined || b === undefined) return a ?? b;   // one venue has no data (e.g. no Kalshi proxy)
  return 'pending';
}
export const resultName = (ts, res) => res === 'up' ? '▲ Up' : res === 'down' ? '▼ Down' :
  res === 'split' ? `≠ Poly ${PM.results.get(ts) === 'up' ? '▲' : '▼'} · Kalshi ${KS.results.get(ts) === 'up' ? '▲' : '▼'}` : 'pending';

// chips (oldest → newest, tap to open in the charts) and the same rounds in the chart menu (newest first)
export function renderRounds() {
  const cur = currentRound().start / 1000, chips = [], options = [];
  let ups = 0, downs = 0, splits = 0;
  for (let k = ROUNDS_SHOWN; k >= 1; k--) {
    const ts = cur - ROUND_S * k, res = roundResult(ts), time = fmtHM(ts * 1000), name = resultName(ts, res);
    if (res === 'up') ups++; else if (res === 'down') downs++; else if (res === 'split') splits++;
    const cls = res === 'up' || res === 'down' || res === 'split' ? res : '';
    chips.push(`<button type="button" class="rchip ${cls}" data-ts="${ts}" aria-pressed="${S.review?.ts === ts}" title="${time} · ${name} — show in the charts" aria-label="${time} ${name}">${res === 'up' ? '▲' : res === 'down' ? '▼' : res === 'split' ? '≠' : '·'}</button>`);
    options.unshift(`<option value="${ts}">${roundSpan(ts)} · ${name}</option>`);
  }
  if (S.review && S.review.ts < cur - ROUND_S * ROUNDS_SHOWN) options.push(`<option value="${S.review.ts}">${roundSpan(S.review.ts)}</option>`);
  $('rounds').innerHTML = chips.join('');
  $('round-pick').innerHTML = `<option value="">Live · ${roundSpan(cur)}</option>` + options.join('');
  $('round-pick').value = S.review ? String(S.review.ts) : '';
  $('rounds-from').textContent = fmtHM((cur - ROUND_S * ROUNDS_SHOWN) * 1000);
  $('rounds-to').textContent = fmtHM((cur - ROUND_S) * 1000);
  $('rounds-meta').textContent = `▲ ${ups} · ▼ ${downs}` + (both() ? ` · ≠ ${splits}` : '') + ' · official';
  $('rounds-meta').title = both() ? '≠ = Polymarket and Kalshi settled the round differently' : '';
  if (S.review) syncReview();
  renderTrack();
}

function trackStats(V) {
  const recs = Object.values(trackOf(V));
  const scored = recs.filter(r => r.outcome && r.mkt != null && r.model != null);
  const basis  = recs.filter(r => r.outcome && r.own);
  const o = r => r.outcome === 'up' ? 1 : 0;
  const brier = k => scored.reduce((a, r) => a + (r[k] / 100 - o(r)) ** 2, 0) / scored.length;
  return { V, n: scored.length, nb: basis.length,
           fav: scored.length ? Math.round(scored.filter(r => (r.mkt >= 50) === (r.outcome === 'up')).length / scored.length * 100) : null,
           bm: scored.length ? brier('mkt') : null, bmod: scored.length ? brier('model') : null,
           match: basis.filter(r => r.own === r.outcome).length };
}

// the recorder's rounds when it has scored any for the active market(s), else the track record of this browser
export function renderTrack() {
  const vs = activeVenues(), el = $('track');
  for (const V of vs) loadRecorded(trackId(V));
  const server = vs.map(V => ({ V, recs: recorded(trackId(V)) }));
  if (server.every(x => x.recs) && server.some(x => summary(x.recs).n)) return renderServerTrack(el, server);

  const st = vs.map(trackStats);
  if (!st.some(s => s.n || s.nb)) {
    el.innerHTML = '<div class="sig-sub">Track record fills in while the dashboard is open: market and model are recorded 60s before each round ends and checked against the official result.</div>';
    return;
  }
  const rows = [], two = st.length > 1, per = (f, s) => two ? `${s.V.short} ${f(s)}` : f(s);
  const join = (f, cond) => st.filter(cond).map(s => per(f, s)).join(' · ');
  const scored = s => s.n > 0;
  if (st.some(scored)) {
    rows.push(['Rounds scored', join(s => s.n, scored)]);
    rows.push(['Market favourite won <span class="muted">· at −60s</span>', join(s => s.fav + '%', scored)]);
    rows.push(['Brier score <span class="muted">· lower is better</span>',
      join(s => two ? s.bm.toFixed(3) : `market ${s.bm.toFixed(3)}`, scored) +
      ` · model ${st.find(scored).bmod.toFixed(3)}`]);
  }
  if (st.some(s => s.nb)) rows.push(['Own price basis = official result', join(s => `${s.match} / ${s.nb}`, s => s.nb > 0)]);
  el.innerHTML = rows.map(([k, v]) => `<div class="trow"><span>${k}</span><b>${v}</b></div>`).join('') +
    '<div class="track-foot"><span>Stored in this browser</span><button class="link-btn" type="button" id="track-reset">Reset</button></div>';
  $('track-reset').addEventListener('click', () => {
    if (!confirm(`Reset the ${S.A.sym} ${activeVenues().map(V => V.name).join(' and ')} track record (${ROUND_S / 60}-minute rounds) in this browser?`)) return;
    for (const V of activeVenues()) { tracks[trackId(V)] = {}; saveTrack(V); }
    renderTrack();
  });
}

// ── Track record from the recorder (recorder/) ───────────────────────────────
const BT_EDGE = 0.03;   // backtest: buy when the model edge after the fee is at least 3¢ a share
const fmtDay = ts => new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

function renderServerTrack(el, server) {
  const two = server.length > 1;
  const st = server.map(({ V, recs }) => ({ V, recs, s: summary(recs), fee: V === KS ? KS_FEE : PM_FEE })).filter(x => x.s.n);
  const per = f => st.map(x => (two ? x.V.short + ' ' : '') + f(x)).join(' · ');
  const pct = v => Math.round(v * 100) + '%';
  const rows = [
    [`Rounds recorded <span class="muted">· since ${fmtDay(Math.min(...st.map(x => x.s.since)))}</span>`, per(x => x.s.n)],
    ['Market favourite won <span class="muted">· at −60s</span>', per(x => pct(x.s.fav))],
    ['Brier score <span class="muted">· lower is better</span>', per(x => `market ${x.s.brierMkt.toFixed(3)} · model ${x.s.brierModel.toFixed(3)}`)],
    ['Log loss <span class="muted">· punishes confident misses</span>', per(x => `market ${x.s.logMkt.toFixed(3)} · model ${x.s.logModel.toFixed(3)}`)],
    [`Still open at −60s <span class="muted">· market ${OPEN[0] * 100}–${OPEN[1] * 100}%</span>`, per(x => x.s.open.n
      ? `${x.s.open.n} rounds · log loss market ${x.s.open.logMkt.toFixed(3)} · model ${x.s.open.logModel.toFixed(3)}` : 'none yet')],
    [`Model edge ≥ ${BT_EDGE * 100}¢, bought at the ask <span class="muted">· after fees</span>`, per(x => {
      const b = backtest(x.recs, BT_EDGE, x.fee);
      return b.trades ? `<span class="${b.pnl >= 0 ? 'up-t' : 'down-t'}">${signedC(b.perTrade)}</span>&nbsp;a&nbsp;trade · ${b.trades}&nbsp;trades` : 'no trades yet';
    })],
    [`${S.A.sym} (Kraken) settled like the market`, per(x => `${x.s.ownMatch} / ${x.s.ownN}`)],
  ];
  el.innerHTML = rows.map(([k, v]) => `<div class="trow"><span>${k}</span><b>${v}</b></div>`).join('') +
    (!two && st[0].s.n >= 20 ? calibrationChart(st[0].recs, st[0].V) : '') +
    '<div class="track-foot"><span>Recorded on the server every round, also with no tab open</span></div>';
}

// Reliability diagram: forecast probability at −60s (x) against the share of those rounds that went UP (y).
// Points on the diagonal = forecasts mean what they say. Bins of 10 points, shown from 3 rounds.
function calibrationChart(recs, V) {
  const W = 320, H = 176, L = 34, R = 10, T = 8, B = 22, pw = W - L - R, ph = H - T - B;
  const x = p => (L + p * pw).toFixed(1), y = f => (T + (1 - f) * ph).toFixed(1);
  const series = [
    { name: 'Market', key: V === KS ? 'ks' : 'pm', color: V === KS ? 'var(--v-ks)' : 'var(--v-pm)', f: marketProb },
    { name: 'Model', key: '', color: 'var(--ink-1)', f: r => r.model },
  ];
  let svg = '';
  for (const v of [0, 0.5, 1]) {
    svg += `<line class="cal-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="cal-tick" x="${L - 6}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${v * 100}%</text>` +
      `<text class="cal-tick" x="${x(v)}" y="${H - 6}" text-anchor="${v === 0 ? 'start' : v === 1 ? 'end' : 'middle'}">${v * 100}%</text>`;
  }
  svg += `<line class="cal-ref" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>`;
  for (const s of series) {
    const bins = calibration(recs, s.f).filter(b => b.n >= 3);
    if (bins.length > 1) svg += `<polyline class="cal-line" style="stroke:${s.color}" points="${bins.map(b => `${x(b.p)},${y(b.freq)}`).join(' ')}"/>`;
    for (const b of bins) {
      const tip = `${s.name}: forecast ${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}% (avg ${Math.round(b.p * 100)}%) · UP won ${Math.round(b.freq * 100)}% of ${b.n} rounds`;
      svg += `<g class="cal-pt"><title>${tip}</title><circle class="cal-hit" cx="${x(b.p)}" cy="${y(b.freq)}" r="10"/>` +
        `<circle class="cal-dot" style="fill:${s.color}" cx="${x(b.p)}" cy="${y(b.freq)}" r="4"/></g>`;
    }
  }
  return `<div class="cal-wrap"><div class="chart-head"><h2>Calibration</h2><div class="legend">` +
    series.map(s => `<span><i class="lk ${s.key}"></i>${s.name}</span>`).join('') +
    `<span><i class="lk dash"></i>Calibrated</span></div></div>` +
    `<div class="cal-note">Forecast at −60s (across) against how often UP won (up)</div>` +
    `<svg class="cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration of the ${V.name} market and the model over ${recs.length} recorded rounds">${svg}</svg></div>`;
}

export function recordTrack(now, modelP) {
  const { start, end } = currentRound(now), key = start / 1000, T = (end - now) / 1000;
  for (const V of activeVenues()) {
    const t = trackOf(V), rec = t[key] || {};
    // snapshot when the settlement window opens
    if (T <= 60 && T > 45 && rec.mkt == null && V.up !== null && modelP !== null && V.cur?.wts === key) {
      t[key] = { ...rec, mkt: +V.up.toFixed(1), model: +modelP.toFixed(1) };
      saveTrack(V);
    }
    // own result from our price basis, just before the round ends
    if (T <= 3 && !t[key]?.own && S.strikeSrc === 'twap') {
      const settle = twap(medianHistory, end - TWAP_MS, now);
      if (settle !== null) { t[key] = { ...t[key], own: settle >= S.strike ? 'up' : 'down' }; saveTrack(V); }
    }
  }
}
