// Text panels: KPIs, time left, signals, data sources, live status. updateUI() runs on a timer (main.js).

import { checkAlerts } from './alerts.js';
import { updateLab } from './analysis.js';
import { updatePaper } from './paper.js';
import { arbState, bestEdge, modelEdges, updateArb, updateLive, updateSources } from './arb.js';
import { btcC, probC } from './charts.js';
import { KALSHI_PROXY, ksCheckSwitch } from './kalshi.js';
import { firstIdx, twap } from './math.js';
import { activeModel, computeModelProb, expectedSettlement, ksTarget, strikeNote, updateStrike, velocity } from './model.js';
import { updateModelCard } from './modelcard.js';
import { checkRoundSwitch } from './polymarket.js';
import { recordTrack } from './rounds.js';
import { EXCH, ROUND_S, S, TWAP_MS, buyPressureSnaps, medianHistory } from './state.js';
import { $, currentRound, fmtAmt, fmtC, fmtClock, fmtP, secsLeft, signedC, winLabel } from './util.js';
import { KS, PM, activeVenues, both, mainVenue } from './venues.js';

// ── Panels (text updates are throttled; charts redraw every frame) ───────────
S.lastSlowT = 0;

function updateTime() {
  const s = secsLeft(), m = Math.floor(s / 60), r = s % 60;
  $('time-left').textContent = `${m}:${String(r).padStart(2, '0')}`;
  $('time-fill').style.width = ((ROUND_S - s) / ROUND_S * 100).toFixed(1) + '%';
  $('time-meter').dataset.level = s < 30 ? 'crit' : s < 60 ? 'warn' : 'ok';
  $('round-end').textContent = s > 60
    ? 'Round ends ' + fmtClock(currentRound().end)
    : `Settlement average · ${60 - s}s of 60s recorded`;
}

export function updateUI(now) {
  if (PM.on) checkRoundSwitch(now);
  if (KS.on) ksCheckSwitch(now);
  updateStrike(now);
  updateTime();

  const med = S.lastMedianP;
  const modelP = computeModelProb();
  $('btc-price').textContent = med !== null ? fmtP(med) : '—';
  const chip = $('close-chip'), exp = expectedSettlement(now);
  if (exp && S.strike !== null) {
    const d = exp.value - S.strike, above = d >= 0;
    $('btc-delta').className = 'kpi-delta ' + (above ? 'up-t' : 'down-t');
    $('btc-delta-text').textContent =
      `${above ? '▲' : '▼'} ${fmtP(Math.abs(d))} ${above ? 'above' : 'below'} strike` +
      (exp.locked > 0 ? ' · settlement avg' : ` (${above ? '+' : '−'}${Math.abs(d / S.strike * 100).toFixed(2)}%)`);
    // "close" = outcome still open according to the model (or within $50 until it is available)
    chip.hidden = modelP !== null ? (modelP < 25 || modelP > 75) : Math.abs(d / S.strike) >= 7e-4;   // ($50 on BTC)
  } else {
    $('btc-delta').className = 'kpi-delta muted';
    $('btc-delta-text').textContent = med === null ? 'Waiting for trades…' : 'Waiting for strike…';
    chip.hidden = true;
  }
  const kt = ksTarget();
  $('btc-sub').textContent =
    (S.strike === null ? 'Strike fetching…' : `Strike ${S.strikeSrc === 'twap' ? '' : '≈ '}${fmtP(S.strike)} (${strikeNote()})`) +
    (KS.on ? ` · Kalshi target ${kt !== null ? fmtP(kt) : '—'}` : '') +
    (PM.on ? ` · Chainlink ${S.clPrice !== null ? fmtP(S.clPrice) : '—'}` : '');

  const mName = activeModel().id === 'rw' ? 'Model' : activeModel().name;   // name the model when it is not the Standard one
  const modelTxt = `${mName} ${modelP !== null ? modelP.toFixed(1) + '%' : '—'}`;
  if (both()) {
    $('up-pm').textContent = PM.up !== null ? PM.up.toFixed(1) + '%' : '—';
    $('up-ks').textContent = KS.up !== null ? KS.up.toFixed(1) + '%' : '—';
    $('up-sub').textContent = PM.up === null && KS.up === null ? 'Waiting for order books…' : modelTxt;
  } else {
    const up = mainVenue().up;
    if (up !== null) {
      $('up-prob').textContent = up.toFixed(1) + '%';
      $('up-bar').classList.remove('idle');
      $('seg-up').style.flexGrow   = up;
      $('seg-down').style.flexGrow = 100 - up;
      $('up-sub').textContent = `Down ${(100 - up).toFixed(1)}% · ${modelTxt}`;
    } else {
      $('up-prob').textContent = '—';
      $('up-bar').classList.add('idle');
      $('seg-up').style.flexGrow = $('seg-down').style.flexGrow = 1;
      $('up-sub').textContent = S.venueMode === 'kalshi' && !KALSHI_PROXY ? 'Kalshi proxy not set up' : 'Waiting for order book…';
    }
  }

  if (now - S.lastSlowT >= 1000) {
    S.lastSlowT = now;
    const arb = both() ? arbState() : null;
    updateSignals(now, modelP);
    updateModelCard();
    updateLab();
    updatePaper();
    if (arb) updateArb(arb);
    updateSources();
    updateLive();
    recordTrack(now, modelP);
    checkAlerts(now, modelP, exp, arb);
    btcC.el.setAttribute('aria-label',
      `${S.A.sym} median price ${med !== null ? fmtP(med) : 'unknown'}${S.strike !== null ? ', strike ' + fmtP(S.strike) : ''}, ${winLabel()}`);
    probC.el.setAttribute('aria-label', 'Implied UP probability: ' + activeVenues().map(V =>
      `${V.name} ${V.up !== null ? V.up.toFixed(1) + '%' : 'unknown'}`).join(', ') + `, ${winLabel()}`);
  }
}

function updateSignals(now, modelP) {
  // Model edge: the best side across the active venues; the line below lists every side
  const per = modelP === null ? [] : activeVenues().map(V => ({ V, e: modelEdges(V, modelP) })).filter(o => o.e);
  const ev = $('edge-val');
  if (per.length) {
    const best = bestEdge(per.flatMap(o => o.e));
    if (best && best.edge > 0) {
      ev.textContent = (both() ? best.V.short + ' ' : '') + (best.side === 'up' ? '▲ UP ' : '▼ DOWN ') + signedC(best.edge);
      ev.className = 'sig-value ' + (best.side === 'up' ? 'up-t' : 'down-t');
    } else {
      ev.textContent = 'None';
      ev.className = 'sig-value';
    }
    const side = (name, x) => !x ? `${name} —` : `${name} ${both() ? '' : fmtC(x.price) + ' → '}${signedC(x.edge)}`;
    $('edge-sub').textContent = per.map(({ V, e: [u, d] }) =>
      both() ? `${V.short} ${side('UP', u)} / ${side('DOWN', d)}` : `${side('UP', u)} · ${side('DOWN', d)}`
    ).join(' · ') + ' · per share after fees';
  } else {
    ev.textContent = '—';
    ev.className = 'sig-value';
    $('edge-sub').textContent = 'Needs order book, strike and price';
  }

  // Projected settlement — 30s momentum extrapolated into the final-minute average
  const s = secsLeft(), vel = velocity(now);
  if (S.lastMedianP !== null && vel !== null) {
    let proj;
    if (s > 60) proj = S.lastMedianP + vel * (s - 30);
    else {
      const end = currentRound(now).end, done = twap(medianHistory, end - TWAP_MS, now) ?? S.lastMedianP, e = (60 - s) / 60;
      proj = done * e + (S.lastMedianP + vel * s / 2) * (1 - e);
    }
    $('proj-val').textContent = fmtP(proj);
    const sub = $('proj-sub');
    sub.replaceChildren();
    if (S.strike !== null) {
      const above = proj >= S.strike, sp = document.createElement('span');
      sp.className = above ? 'up-t' : 'down-t';
      sp.textContent = above ? '▲ above strike' : '▼ below strike';
      sub.append(sp, ' · ');
    }
    sub.append(`momentum ${vel >= 0 ? '+' : '−'}${fmtAmt(Math.abs(vel * 60))}/min ·${s < 30 ? 'high' : s < 90 ? 'medium' : 'low'} confidence`);
  } else {
    $('proj-val').textContent = '—';
  }

  // Buy pressure over the chart window (round view: since round start, at least 30s) + trend vs ~90s ago
  $('bp-label').textContent = 'Buy pressure · ' + winLabel();
  const cut = S.viewMode === 'round' ? Math.min(now - 30_000, currentRound(now).start) : now - S.windowMs;
  let b = 0, sl = 0;
  for (const ex of EXCH) {
    if (!ex.enabled) continue;
    for (let i = firstIdx(ex.trades, cut); i < ex.trades.length; i++) ex.trades[i].sell ? sl += ex.trades[i].q : b += ex.trades[i].q;
  }
  if (b + sl > 0) {
    const pct = b / (b + sl) * 100;
    buyPressureSnaps.push({ t: now, pct });
    while (buyPressureSnaps.length && buyPressureSnaps[0].t < now - 300_000) buyPressureSnaps.shift();
    $('bp-val').textContent = pct.toFixed(0) + '% buy';
    $('bp-bar').classList.remove('idle');
    $('bp-buy').style.flexGrow  = pct;
    $('bp-sell').style.flexGrow = 100 - pct;
    let ref = null;
    for (let i = buyPressureSnaps.length - 1; i >= 0; i--) if (now - buyPressureSnaps[i].t >= 90_000) { ref = buyPressureSnaps[i]; break; }
    const sub = $('bp-sub');
    sub.replaceChildren();
    if (ref) {
      const diff = pct - ref.pct, sp = document.createElement('span');
      sp.className = diff > 2 ? 'up-t' : diff < -2 ? 'down-t' : '';
      sp.textContent = diff > 2 ? '▲ rising' : diff < -2 ? '▼ falling' : '→ steady';
      sub.append(sp, ` vs 90s ago (${ref.pct.toFixed(0)}%)`);
    } else {
      sub.textContent = 'Trend shows after 90s of data';
    }
  } else {
    $('bp-val').textContent = '—';
    $('bp-bar').classList.add('idle');
  }
}
