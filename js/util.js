// DOM lookup, number and time formatting, JSON fetch, round timing.

import { ROUND_MS, ROUND_S, S } from './state.js';

export const $ = id => document.getElementById(id);

// ── Formatting & small helpers ───────────────────────────────────────────────
export const fmtP     = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
export const fmtNum   = n => n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
export const fmtSz    = n => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 1 });
export const fmtClock = t => new Date(t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
export const fmtHM    = t => new Date(t).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
export const signedUsd = d => (d >= 0 ? '+' : '−') + fmtP(Math.abs(d));
export const winLabel = () => S.viewMode === 'round' ? 'this round' : S.windowMs < 60_000 ? (S.windowMs / 1000) + 's' : (S.windowMs / 60_000) + 'm';
export const getJSON  = async url => { const r = await fetch(url); if (!r.ok) throw new Error(r.status + ' ' + url); return r.json(); };

export function currentRound(now = Date.now()) {
  const start = Math.floor(now / ROUND_MS) * ROUND_MS;
  return { start, end: start + ROUND_MS };
}
export function secsLeft() { return ROUND_S - (Math.floor(Date.now() / 1000) % ROUND_S); }

export const fmtPts = d => (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' pts';
export const signedC = x => { const r = Math.round(x * 1000) / 1000; return (r < 0 ? '−' : '+') + fmtC(Math.abs(r)); };

export const roundSpan = ts => `${fmtHM(ts * 1000)}–${fmtHM(ts * 1000 + ROUND_MS)}`;
export const fmtC = (v, d = 1) => String(Math.round(v * 100 * 10 ** d) / 10 ** d) + '¢';
