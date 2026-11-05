// Rounds stored by the recorder Worker (recorder/), fetched per market and refreshed every few minutes. Without a
// reachable recorder the dashboard falls back to the track record kept in this browser.
// ?recorder=<url> uses another recorder and is remembered in this browser (?recorder= with nothing clears it).
import { toRecords } from './stats.js';

const RECORDER_DEFAULT = 'https://btc-recorder.mariusrapp-kit.workers.dev';
export const RECORDER = (() => {
  let q = null;
  try { q = new URLSearchParams(location.search).get('recorder'); } catch {}
  try {
    if (q !== null) q ? localStorage.setItem('recorder', q) : localStorage.removeItem('recorder');
    q = localStorage.getItem('recorder') || q;
  } catch {}
  return (q || RECORDER_DEFAULT).replace(/\/+$/, '');
})();

const REFRESH_MS = 5 * 60_000;
const DAYS = { poly5: 7, poly15: 14, kalshi15: 14 };   // about 2,000 and 1,300 rounds
const store = new Map();                               // series → { recs, t, pending }
let onUpdate = () => {};
export const onRecorded = f => { onUpdate = f; };

// the stored rounds of a series ('poly5' | 'poly15' | 'kalshi15'), or null until they have loaded
export const recorded = series => store.get(series)?.recs ?? null;

export async function loadRecorded(series) {
  const e = store.get(series) || store.set(series, { recs: null, t: 0, pending: false }).get(series);
  if (e.pending || Date.now() - e.t < REFRESH_MS) return;
  e.pending = true;
  try {
    const r = await fetch(`${RECORDER}/rounds?series=${series}&days=${DAYS[series] ?? 7}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    e.recs = toRecords(await r.json());
    onUpdate(series);
  } catch (err) {
    console.warn('recorder', series, err.message);
  } finally {
    e.t = Date.now();
    e.pending = false;
  }
}
