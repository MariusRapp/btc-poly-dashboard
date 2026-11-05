// Market switch: Polymarket / Kalshi / both, and the round length.

import { yRange } from './charts.js';
import { ksLoad, ksTimer } from './kalshi.js';
import { lad } from './ladder.js';
import { loadPolymarket } from './polymarket.js';
import { backfill } from './prices.js';
import { selectRound } from './review.js';
import { renderRounds } from './rounds.js';
import { ROUND_MS, ROUND_S, S, TWAP_MS, applyRoundLen, medianHistory, saveOpts } from './state.js';
import { $, currentRound, roundSpan } from './util.js';
import { KS, PM, VENUES, both, closeFeed, mainVenue } from './venues.js';

// ── Market switch: venue(s) and round length; exchange feeds keep running ───
export function updateTitle(msg) {
  const len = ROUND_S / 60, f = mainVenue().cur;
  $('brand-len').textContent = `· ${len}-minute rounds`;
  document.title = `BTC ${len}m · ${both() ? 'Polymarket vs Kalshi' : mainVenue().name}`;
  $('market-title').textContent = msg ?? (
    both() ? `Polymarket + Kalshi · ${roundSpan(currentRound().start / 1000)}` :
    !f ? 'Loading market…' :
    S.venueMode === 'kalshi' ? `${f.question} · ${roundSpan(f.wts)}` : f.question);
}

// buttons, legends, toggles and cards that depend on the mode
export function syncModeUI() {
  document.body.classList.toggle('both', both());
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

export function setMode(venue, lenMin) {
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
  if (ROUND_MS !== prevLen) { PM.results.clear(); PM.meta.clear(); PM.archive.clear(); }   // other markets, same start times
  PM.on = S.venueMode !== 'kalshi';
  KS.on = S.venueMode !== 'poly';
  S.strikeRound = null;
  delete yRange.btc; delete yRange.prob;
  S.lroundKey = ''; lad.feed = undefined;
  syncModeUI();
  renderRounds();
  // a longer round needs more history for the chart and the strike window
  const need = currentRound().start - TWAP_MS - 10_000;
  if (!medianHistory.length || medianHistory[0].t > need) backfill(need);
  if (PM.on) loadPolymarket();
  if (KS.on) ksLoad();
}
