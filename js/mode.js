// Market switch: Polymarket / Kalshi / both, and the round length.

import { assetById } from './assets.js';
import { pollChainlinkOnce } from './chainlink.js';
import { yRange } from './charts.js';
import { ksLoad, ksTimer } from './kalshi.js';
import { lad } from './ladder.js';
import { loadPolymarket } from './polymarket.js';
import { backfill, switchExchanges } from './prices.js';
import { selectRound } from './review.js';
import { renderRounds } from './rounds.js';
import { ROUND_MS, ROUND_S, S, TWAP_MS, applyRoundLen, buyPressureSnaps, medianHistory, saveOpts } from './state.js';
import { $, currentRound, roundSpan } from './util.js';
import { KS, PM, VENUES, both, closeFeed, mainVenue } from './venues.js';

// ── Market switch: venue(s) and round length; exchange feeds keep running ───
export function updateTitle(msg) {
  const len = ROUND_S / 60, f = mainVenue().cur;
  $('brand-len').textContent = `· ${len}-minute rounds`;
  document.title = `${S.A.sym} ${len}m · ${both() ? 'Polymarket vs Kalshi' : mainVenue().name}`;
  $('market-title').textContent = msg ?? (
    both() ? `Polymarket + Kalshi · ${roundSpan(currentRound().start / 1000)}` :
    !f ? 'Loading market…' :
    S.venueMode === 'kalshi' ? `${f.question} · ${roundSpan(f.wts)}` : f.question);
}

// buttons, legends, toggles and cards that depend on the mode
export function syncModeUI() {
  document.body.classList.toggle('both', both());
  document.querySelectorAll('[data-asset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.asset === S.asset)));
  document.querySelectorAll('.asym').forEach(el => { el.textContent = S.A.sym; });
  document.querySelectorAll('.aname').forEach(el => { el.textContent = S.A.name; });
  document.querySelectorAll('[data-venue]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.venue === S.venueMode)));
  document.querySelectorAll('[data-len]').forEach(b => {
    b.setAttribute('aria-pressed', String(+b.dataset.len === ROUND_S / 60));
    b.disabled = S.venueMode !== 'poly' && b.dataset.len === '5';
  });
  $('venue-note').hidden = S.venueMode === 'poly';
  $('up-venue').textContent = both() ? '· market' : '· ' + mainVenue().name;
  for (const id of ['up-prob', 'up-bar']) $(id).hidden = both();
  $('up-pair').hidden = !both();
  for (const id of ['leg-pm', 'leg-ks', 'gap-toggle']) $(id).hidden = !both();
  $('leg-gap').hidden = !both() || !S.showGap;
  $('card-arb').hidden = !both();
  $('book-venue').hidden = !both();
  document.querySelectorAll('[data-bv]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.bv === S.bookVenue)));
  document.querySelectorAll('#src [data-v]').forEach(el => el.hidden = !(el.dataset.v === 'poly' ? PM.on : KS.on));
  updateTitle();
}

// another coin: its own exchange feeds, Chainlink feed, volatility and markets; venue and round length stay
export function setAsset(id) {
  const A = assetById(id);
  if (A.id === S.asset) return;
  S.asset = A.id; S.A = A; S.assetGen++;
  S.clPrice = null; S.clStrike = null; S.clState = 'wait';
  S.closes1m = []; S.vols = null;
  buyPressureSnaps.length = 0;
  switchExchanges();
  pollChainlinkOnce();
  setMode(S.venueMode, null, true);
}

export function setMode(venue, lenMin, otherCoin = false) {
  const prevLen = ROUND_MS;
  S.venueMode = venue;
  if (lenMin) S.polyLenMin = lenMin;
  saveOpts();
  S.modeGen++;
  if (S.review) selectRound(null);
  applyRoundLen();
  for (const V of VENUES) {
    closeFeed(V.cur); closeFeed(V.nxt);
    V.cur = V.nxt = V.upcoming = null;
    V.up = V.lastProb = null; V.prob.length = 0;
    V.loading = V.preloading = false; V.retryT = V.preloadRetryT = 0;
  }
  clearTimeout(ksTimer);
  // other markets, same start times
  if (ROUND_MS !== prevLen || otherCoin) { PM.results.clear(); PM.meta.clear(); PM.archive.clear(); }
  if (otherCoin) { KS.results.clear(); KS.meta.clear(); KS.archive.clear(); }
  PM.on = S.venueMode !== 'kalshi';
  KS.on = S.venueMode !== 'poly';
  S.strikeRound = null;
  delete yRange.btc; delete yRange.prob;
  S.lroundKey = ''; lad.feed = undefined;
  syncModeUI();
  renderRounds();
  // a longer round (or another coin) needs more history for the chart and the strike window
  const need = Math.min(Date.now() - 300_000, currentRound().start - TWAP_MS - 10_000);
  if (!medianHistory.length || medianHistory[0].t > need) backfill(need);
  if (PM.on) loadPolymarket();
  if (KS.on) ksLoad();
}
