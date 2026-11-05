// Recent rounds with official results, and the track record kept in this browser.

import { ksFetchResult, ksRefreshResults } from './kalshi.js';
import { twap } from './math.js';
import { pmFetchResult } from './polymarket.js';
import { syncReview } from './review.js';
import { ROUNDS_SHOWN, ROUND_S, S, TWAP_MS, medianHistory } from './state.js';
import { $, currentRound, fmtHM, roundSpan } from './util.js';
import { KS, PM, activeVenues, both, mainVenue } from './venues.js';

// ── Recent rounds + track record ─────────────────────────────────────────────
// official results from each venue; the track record (market + model 60s before the end, own result)
// lives in this browser's localStorage, one store per venue and round length
const TRACK_KEYS = { poly5: 'btc5m-track-v1', poly15: 'btc-track-poly15-v1', kalshi15: 'btc-track-kalshi15-v1' };
const tracks = {};
const trackId = V => V === KS ? 'kalshi15' : 'poly' + ROUND_S / 60;
function trackOf(V) {
  const id = trackId(V);
  if (!tracks[id]) tracks[id] = (() => { try { return JSON.parse(localStorage.getItem(TRACK_KEYS[id])) || {}; } catch { return {}; } })();
  return tracks[id];
}

function saveTrack(V) {
  const t = trackOf(V);
  try {
    const keys = Object.keys(t).sort();
    while (keys.length > 600) delete t[keys.shift()];
    localStorage.setItem(TRACK_KEYS[trackId(V)], JSON.stringify(t));
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

function renderTrack() {
  const st = activeVenues().map(trackStats), el = $('track');
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
    if (!confirm(`Reset the ${activeVenues().map(V => V.name).join(' and ')} track record (${ROUND_S / 60}-minute rounds) in this browser?`)) return;
    for (const V of activeVenues()) { tracks[trackId(V)] = {}; saveTrack(V); }
    renderTrack();
  });
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
