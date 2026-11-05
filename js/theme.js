// Light/dark theme; copies the CSS color tokens for the canvas charts.

import { EXCH } from './state.js';
import { $ } from './util.js';

// ── Theme ────────────────────────────────────────────────────────────────────
// canvas can't read CSS vars, so the tokens are copied into T on every theme change
export const T = {};
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const ICON_SUN  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : darkMq.matches;
}

export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue('--' + n).trim();
  Object.assign(T, {
    surface: v('surface'), ink1: v('ink-1'), ink2: v('ink-2'), muted: v('muted'),
    grid: v('grid'), axis: v('axis'), band: v('band'), upWash: v('up-wash'), downWash: v('down-wash'),
    vpm: v('v-pm'), vks: v('v-ks'),
  });
  EXCH.forEach((ex, i) => ex.color = v('ex-' + (i + 1)));
  $('theme-btn').innerHTML = isDark() ? ICON_SUN : ICON_MOON;
  // browser bar / home-screen app status bar: follow a theme picked with the button, not just the OS setting
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.content = v('page'));
}

darkMq.addEventListener('change', readTheme);
$('theme-btn').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  readTheme();
});
