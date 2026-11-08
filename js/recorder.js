// Rounds stored by the recorder Worker (recorder/), fetched per market and refreshed every few minutes. Without a
// reachable recorder the dashboard falls back to the track record kept in this browser.
// ?recorder=<url> uses another recorder and is remembered in this browser (?recorder= with nothing clears it).
import { parseSeries } from './assets.js';
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
// Reads cost: D1 bills every row a query reads (5 million a day on the free plan). So the whole window is loaded at
// most once an hour; the refreshes in between ask only for the last hours (all that can still change: results and
// settlements come in minutes after a round) and merge them in.
const FULL_MS = 60 * 60_000, RECENT_HOURS = { rounds: 3, snaps: 2 };
const daysOf = series => parseSeries(series)?.len === 300 ? 7 : 14;   // about 2,000 and 1,300 rounds
const store = new Map();                                              // series → { recs, t, fullT, pending }
let onUpdate = () => {}, version = 0;
export const onRecorded = f => { onUpdate = f; };
// bumped whenever new data arrived (rounds or snapshots of any series)
export const recordedVersion = () => version;

// rows of a refresh merged into what is there (same key: the new row wins), oldest first, older than `fromS` dropped
export function mergeRows(old, fresh, key, fromS) {
  const m = new Map(old.filter(r => r.start >= fromS).map(r => [key(r), r]));
  for (const r of fresh) m.set(key(r), r);
  return [...m.values()].sort((a, b) => a.start - b.start || (a.t ?? 0) - (b.t ?? 0));
}

// the stored rounds of a series (assets.js seriesId: 'poly5', 'kalshi15', 'eth-poly5', …), or null until they have loaded
export const recorded = series => store.get(series)?.recs ?? null;

export async function loadRecorded(series) {
  const e = store.get(series) || store.set(series, { recs: null, t: 0, fullT: 0, pending: false }).get(series);
  if (e.pending || Date.now() - e.t < REFRESH_MS) return;
  e.pending = true;
  const full = !e.recs || Date.now() - e.fullT > FULL_MS, days = daysOf(series);
  try {
    const r = await fetch(`${RECORDER}/rounds?series=${series}&${full ? 'days=' + days : 'hours=' + RECENT_HOURS.rounds}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const recs = toRecords(await r.json());
    e.recs = full ? recs : mergeRows(e.recs, recs, x => x.start, Date.now() / 1000 - days * 86400);
    if (full) e.fullT = Date.now();
    version++;
    onUpdate(series);
  } catch (err) {
    console.warn('recorder', series, err.message);
  } finally {
    e.t = Date.now();
    e.pending = false;
  }
}

// Every minute's snapshot of the rounds of a series (recorder v3, GET /snaps), the last `SNAP_DAYS` days, each with
// its round's strike and result. Loaded only when the analysis asks for them (a few hundred kB), refreshed like the rounds.
// null until loaded; { recs: [] , missing: true } when the recorder has none (not on v3 yet).
const SNAP_DAYS = 3;
const snapStore = new Map();
export const recordedSnaps = series => snapStore.get(series)?.data ?? null;
export async function loadSnaps(series) {
  const e = snapStore.get(series) || snapStore.set(series, { data: null, t: 0, fullT: 0, pending: false }).get(series);
  if (e.pending || Date.now() - e.t < REFRESH_MS) return;
  e.pending = true;
  const full = !e.data?.recs?.length || Date.now() - e.fullT > FULL_MS;
  try {
    const r = await fetch(`${RECORDER}/snaps?series=${series}&${full ? 'days=' + SNAP_DAYS : 'hours=' + RECENT_HOURS.snaps}`, { signal: AbortSignal.timeout(20_000) });
    if (r.status === 503 || r.status === 404) e.data = { recs: [], missing: true };
    else if (!r.ok) throw new Error('HTTP ' + r.status);
    else {
      const recs = toRecords(await r.json()).map(x => ({ ...x, snap_t: x.t }));
      e.data = { recs: full ? recs : mergeRows(e.data.recs, recs, x => x.start + '|' + x.t, Date.now() / 1000 - SNAP_DAYS * 86400), days: SNAP_DAYS };
      if (full) e.fullT = Date.now();
    }
    version++;
    onUpdate(series);
  } catch (err) {
    console.warn('recorder snaps', series, err.message);
  } finally {
    e.t = Date.now();
    e.pending = false;
  }
}
