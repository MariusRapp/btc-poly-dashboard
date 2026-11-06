// Alerts: toast, beep, vibration, and a system notification while the tab is in the background.

import { EDGE_ALERT, bestEdge, modelEdges } from './arb.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtSz, signedC, signedUsd } from './util.js';
import { activeVenues, both } from './venues.js';

// ── Alerts: toast + beep + vibration, system notification while the tab is in the background ──
S.audioCtx = null;
export let alertsOn = false, lastSide = null, lastSideRound = null, lastCrossAlertT = 0, toastTimer = null;
const alerted = new Set();   // `${kind}|${round start}`: each kind fires once per round

function toast(title, body) {
  $('toast-title').textContent = title;
  $('toast-body').textContent = body;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

function beep() {
  if (!S.audioCtx) return;
  try {
    const o = S.audioCtx.createOscillator(), g = S.audioCtx.createGain(), t = S.audioCtx.currentTime;
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(S.audioCtx.destination);
    o.start(t); o.stop(t + 0.26);
  } catch {}
}

function alertUser(title, body) {
  toast(title, body);
  beep();
  try { navigator.vibrate?.(150); } catch {}
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'btc5m' }); } catch {}
  }
}

export async function setAlerts(on, fromClick) {
  alertsOn = on;
  $('alert-btn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('alerts', on ? '1' : '0'); } catch {}
  if (!on || !fromClick) return;
  try { S.audioCtx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)(); await S.audioCtx.resume(); } catch {}
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  toast('Alerts on', 'Strike crossings in the last minute, model edges of 5¢+ after fees' + (both() ? ', Poly/Kalshi arbitrage' : ''));
}

function alertOnce(kind, start, title, body) {
  const k = kind + '|' + S.asset + '|' + start;
  if (alerted.has(k)) return;
  alerted.add(k);
  if (alerted.size > 200) alerted.delete(alerted.values().next().value);
  alertUser(title, body);
}

export function checkAlerts(now, modelP, exp, arb) {
  const { start, end } = currentRound(now), T = (end - now) / 1000;
  if (lastSideRound !== start) { lastSideRound = start; lastSide = null; }
  if (exp && S.strike !== null) {
    const side = exp.value >= S.strike ? 'up' : 'down';
    if (alertsOn && T <= 60 && lastSide && side !== lastSide && now - lastCrossAlertT > 8000) {
      lastCrossAlertT = now;
      alertUser(side === 'up' ? '▲ Now above strike' : '▼ Now below strike',
        `${Math.round(T)}s left · settlement avg ${signedUsd(exp.value - S.strike)} vs strike`);
    }
    lastSide = side;
  }
  if (!alertsOn) return;
  if (modelP !== null && T > 60 && T < ROUND_S - 30) for (const V of activeVenues()) {
    const best = bestEdge(modelEdges(V, modelP) || []);
    if (!best || best.edge < EDGE_ALERT) continue;
    alertOnce('edge-' + V.key, start, `Model edge: buy ${best.side.toUpperCase()}${both() ? ' on ' + V.name : ''}`,
      `${fmtC(best.price)} ask + fee vs model ${(best.side === 'up' ? modelP : 100 - modelP).toFixed(0)}% → ${signedC(best.edge)} per share`);
  }
  // both venues: a pair (UP on one, DOWN on the other) below $1 after fees, with some size behind it, that still
  // earns at least 0.5¢ once the chance of the venues settling apart is taken off (arb.js splitRisk)
  if (arb && T > 5) for (const [k, r, name] of [['arb-up', arb.upPm, 'Poly UP + Kalshi NO'], ['arb-down', arb.downPm, 'Poly DOWN + Kalshi YES']]) {
    if (!r || r.ev === null || r.ev < 0.005 || r.pairs < 5) continue;
    alertOnce(k, start, `Arbitrage: ${name}`, `${fmtC(r.pa)} + ${fmtC(r.pb)} + fees → +${fmtC(r.edge)} per pair, ` +
      `+${fmtC(r.ev)} after the split risk, up to ${fmtSz(r.pairs)} pairs`);
  }
}
