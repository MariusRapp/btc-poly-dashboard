// Entry point: builds the sources table and tooltips, wires up the controls, starts the feeds and timers.

import { alertsOn, setAlerts } from './alerts.js';
import { pollChainlink } from './chainlink.js';
import { attachHover, btcC, probC, wakeFrame, yRange } from './charts.js';
import { ksLoad, ksSchedule } from './kalshi.js';
import { setBookSide, setBookVenue, setBookView } from './ladder.js';
import { setMode, syncModeUI } from './mode.js';
import { updateUI } from './panels.js';
import { loadPolymarket } from './polymarket.js';
import { backfill, connectExchanges, getMedian, seedUsdt } from './prices.js';
import { selectRound, syncBandLegend } from './review.js';
import { onRecorded } from './recorder.js';
import { refreshRounds, renderRounds, renderTrack } from './rounds.js';
import { EX, EXCH, ROUND_S, S, TWAP_MS, saveOpts } from './state.js';
import { readTheme } from './theme.js';
import { $, currentRound } from './util.js';
import { KS, PM, activeVenues, both, pushProbPoint } from './venues.js';

// Panels, round switches, the track record and alerts run on a timer: a hidden tab gets no animation frames,
// and they have to keep going in the background (desktop; a locked phone suspends the page either way).
function tick() {
  const now = Date.now();
  if (now - S.tpsTick >= 1000) { S.tps = S.tpsCount; S.tpsCount = 0; S.tpsTick = now; }
  updateUI(now);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
// data sources table (doubles as the table view for the exchange lines)
const srcEl = $('src');
EXCH.forEach((ex, i) => {
  srcEl.insertAdjacentHTML('beforeend',
    `<label class="src-name"><input type="checkbox" checked data-key="${ex.key}"><i class="lk" style="background:var(--ex-${i + 1})"></i>${ex.name}${ex.note ? ` <span class="muted">· ${ex.note}</span>` : ''}</label>` +
    `<span class="src-v" id="sp-${ex.key}">—</span><span class="src-d" id="sd-${ex.key}">—</span>` +
    `<span class="src-s"><i class="dot" id="sdot-${ex.key}"></i></span>`);
});
srcEl.insertAdjacentHTML('beforeend',
  `<span class="src-name"><i class="lk ghost"></i>Chainlink · Polygon</span>` +
  `<span class="src-v" id="sp-cl">—</span><span class="src-d" id="sd-cl">—</span><span class="src-s"><i class="dot" id="sdot-cl"></i></span>` +
  `<span class="src-name" data-v="poly"><i class="lk ghost"></i>Chainlink strike <span class="muted">· vs 60s avg</span></span>` +
  `<span class="src-v" id="sp-cls" data-v="poly">—</span><span class="src-d" id="sd-cls" data-v="poly">—</span><span class="src-s" data-v="poly"><i class="dot" id="sdot-cls"></i></span>` +
  `<span class="src-name" data-v="poly"><i class="lk pm"></i>Polymarket book</span>` +
  `<span class="src-v" id="sp-pm" data-v="poly" style="grid-column:span 2">—</span><span class="src-s" data-v="poly"><i class="dot" id="sdot-pm"></i></span>` +
  `<span class="src-name" data-v="kalshi"><i class="lk ghost"></i>Kalshi target <span class="muted">· vs 60s avg</span></span>` +
  `<span class="src-v" id="sp-kst" data-v="kalshi">—</span><span class="src-d" id="sd-kst" data-v="kalshi">—</span><span class="src-s" data-v="kalshi"><i class="dot" id="sdot-kst"></i></span>` +
  `<span class="src-name" data-v="kalshi"><i class="lk ks"></i>Kalshi book <span class="muted">· via proxy</span></span>` +
  `<span class="src-v" id="sp-ks" data-v="kalshi" style="grid-column:span 2">—</span><span class="src-s" data-v="kalshi"><i class="dot" id="sdot-ks"></i></span>`);
srcEl.addEventListener('change', e => {
  const ex = EX[e.target.dataset.key];
  if (!ex) return;
  ex.enabled = e.target.checked;
  e.target.closest('.src-name').classList.toggle('off', !ex.enabled);
  S.lastMedianP = getMedian();
});

// chart legend entries for the optional exchange lines
$('legend-ex').innerHTML = EXCH.map((ex, i) => `<span><i class="lk" style="background:var(--ex-${i + 1})"></i>${ex.name}</span>`).join('');
$('show-ex').checked = S.showExchanges;
$('legend-ex').hidden = !S.showExchanges;
$('show-ex').addEventListener('change', e => {
  S.showExchanges = e.target.checked;
  $('legend-ex').hidden = !S.showExchanges;
  saveOpts();
});
$('show-bands').checked = S.showBands;
$('show-bands').addEventListener('change', e => {
  S.showBands = e.target.checked;
  syncBandLegend();
  saveOpts();
});
$('show-fc').checked = S.showFc;
$('show-fc').addEventListener('change', e => {
  S.showFc = e.target.checked;
  delete yRange.btc;   // the cone widens the price axis: snap to the new range
  saveOpts();
});
$('show-gap').checked = S.showGap;
$('show-gap').addEventListener('change', e => {
  S.showGap = e.target.checked;
  $('leg-gap').hidden = !both() || !S.showGap;
  saveOpts();
});

// market switch: Polymarket / Kalshi / both, and the round length (Polymarket alone only)
document.querySelectorAll('[data-venue]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.venue !== S.venueMode) setMode(b.dataset.venue);
}));
document.querySelectorAll('[data-len]').forEach(b => b.addEventListener('click', () => {
  if (!b.disabled && +b.dataset.len !== ROUND_S / 60) setMode(S.venueMode, +b.dataset.len);
}));
document.querySelectorAll('[data-bv]').forEach(b => b.addEventListener('click', () => { setBookVenue(b.dataset.bv); saveOpts(); }));

// time window buttons (they belong to the live view: picking one while a past round is open goes back to live)
const winBtns = document.querySelectorAll('#win-seg button');
winBtns.forEach(btn => btn.addEventListener('click', () => {
  winBtns.forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  if (btn.dataset.s) { S.viewMode = 'rolling'; S.windowMs = parseInt(btn.dataset.s) * 1000; }
  else S.viewMode = 'round';
  if (S.review) selectRound(null);
  syncBandLegend();
  S.lastSlowT = 0;
  delete yRange.btc; delete yRange.prob;   // new window: snap the y-axis instead of easing
}));

// round menu, round chips (tap again to go back to live), order book Now / Next
$('round-pick').addEventListener('change', e => selectRound(e.target.value));
$('rv-back').addEventListener('click', () => selectRound(null));
$('rounds').addEventListener('click', e => {
  const chip = e.target.closest('.rchip');
  if (!chip) return;
  const ts = +chip.dataset.ts;
  selectRound(S.review?.ts === ts ? null : ts);
  const card = $('card-charts'), top = card.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight * 0.6) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelectorAll('[data-book]').forEach(b => b.addEventListener('click', () => setBookView(b.dataset.book)));
document.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => { setBookSide(b.dataset.side); saveOpts(); }));
setBookSide(S.bookSide);

$('alert-btn').addEventListener('click', () => setAlerts(!alertsOn, true));
try { if (localStorage.getItem('alerts') === '1') setAlerts(true, false); } catch {}
// browsers only allow audio after an interaction: unlock the beep on the first tap if alerts were already on
document.addEventListener('pointerdown', () => {
  if (alertsOn && !S.audioCtx) try { S.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}, { once: true });

// keep the screen on: a phone that locks suspends the page, its sockets drop and the gap has to be refetched.
// The browser releases the lock whenever the page is hidden; it is taken again when the page comes back.
let wakeOn = false, wakeLock = null, wakePending = false;
async function acquireWake() {
  if (!wakeOn || wakeLock || wakePending || document.hidden) return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wakeOn) { lock.release(); return; }
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch (e) {
    console.warn('wake lock:', e.message);
  } finally {
    wakePending = false;
  }
}
function setWake(on) {
  wakeOn = on;
  $('wake-btn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('wake', on ? '1' : '0'); } catch {}
  if (on) acquireWake();
  else { wakeLock?.release(); wakeLock = null; }
}
if ('wakeLock' in navigator) {
  $('wake-btn').hidden = false;
  $('wake-btn').addEventListener('click', () => setWake(!wakeOn));
  // some browsers only grant it after a tap: retry on any tap while it is wanted but not held
  document.addEventListener('pointerdown', () => { if (wakeOn && !wakeLock) acquireWake(); });
  try { if (localStorage.getItem('wake') === '1') setWake(true); } catch {}
}

onRecorded(() => renderTrack());   // the recorder's rounds arrived or refreshed
readTheme();
attachHover(btcC.el, 'btc');
attachHover(probC.el, 'prob');
PM.on = S.venueMode !== 'kalshi';
KS.on = S.venueMode !== 'poly';
syncModeUI();
renderRounds();
syncBandLegend();

seedUsdt().finally(connectExchanges);   // rate first, so no Binance trade is stored unconverted
// history for the chart, the strike window before the round and the model — then live feeds take over
backfill(Math.min(Date.now() - 300_000, currentRound().start - TWAP_MS - 10_000));
pollChainlink();
if (PM.on) loadPolymarket();
if (KS.on) ksLoad();
tick();
setInterval(tick, 200);
wakeFrame();

// Safety sampler: ensure each probability history always has a recent point even during quiet markets
setInterval(() => { for (const V of activeVenues()) if (V.lastProb !== null) pushProbPoint(V, V.lastProb); }, 1000);
setInterval(refreshRounds, 30_000);

// watchdog: mobile browsers can leave sockets open but silent — close them so they reconnect
setInterval(() => {
  const now = Date.now();
  for (const ex of EXCH) if (ex.ws && ex.ws.readyState === 1 && now - ex.lastMsgT > 90_000) ex.ws.close();
  for (const f of [PM.cur, PM.nxt]) if (f?.ws && f.ws.readyState === 1 && now - f.lastMsgT > 90_000) f.ws.close();
}, 10_000);

// back from the background (phone locked, tab switched): reconnect stale feeds and refill the gap
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = null;
  acquireWake();
  if (away < 15_000) return;
  const now = Date.now();
  for (const ex of EXCH) if (ex.ws && now - ex.lastMsgT > 10_000) ex.ws.close();
  for (const f of [PM.cur, PM.nxt]) if (f?.ws && now - f.lastMsgT > 10_000) f.ws.close();
  if (KS.on && KS.cur && !KS.cur.closed) ksSchedule(0);   // the poll slowed down in the background
  // a round that ended meanwhile is switched by checkRoundSwitch (reloads if the preloaded one is stale too)
  backfill(now - Math.min(away + 30_000, 6 * 60_000));
  refreshRounds();
});
