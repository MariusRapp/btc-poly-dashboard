// The "Recorded rounds" card: three views of what the recorder stored for the market in view, with the model in use.
//   Model vs market  — does the model know anything the market price doesn't? (learn.js stacking)
//   By minute       — market and model minute by minute (recorder v3 snapshots): when in a round is there an edge?
//   By hour         — UP share, typical move and spread by hour of the day (viewer's time)
// Rendered only when its data, the model or a choice changed; the snapshots are loaded on first use of their view.
import { KS_FEE, PM_FEE } from './arb.js';
import { parseSeries, seriesId } from './assets.js';
import { stacking } from './learn.js';
import { activeModel, activeParams, modelSeries } from './model.js';
import { LEARN_MIN, rescore } from './models.js';
import { loadRecorded, loadSnaps, recorded, recordedSnaps, recordedVersion } from './recorder.js';
import { ROUND_S, S } from './state.js';
import { OPEN, backtest, isOpen, marketProb, scored, scores } from './stats.js';
import { $, fmtAmt, signedC } from './util.js';

const BT_EDGE = 0.03;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const read = (k, ok, def) => { try { const v = localStorage.getItem(k); return ok.includes(v) ? v : def; } catch { return def; } };
const lab = {
  view: read('lab-view', ['stack', 'round', 'hour'], 'stack'),
  metric: read('lab-metric', ['up', 'move', 'spread'], 'up'),
  days: read('lab-days', ['all', 'wd', 'we'], 'all'),
  key: '', width: 0,
};
const msg = t => `<div class="sig-sub lab-msg">${t}</div>`;
const trow = (k, v) => `<div class="trow"><span>${k}</span><b>${v}</b></div>`;

export function initLab() {
  const sync = () => document.querySelectorAll('[data-lab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lab === lab.view)));
  document.querySelectorAll('[data-lab]').forEach(b => b.addEventListener('click', () => {
    lab.view = b.dataset.lab; store('lab-view', lab.view); sync(); updateLab(true);
  }));
  $('lab-body').addEventListener('click', e => {
    const b = e.target.closest('[data-metric], [data-days]');
    if (!b) return;
    if (b.dataset.metric) { lab.metric = b.dataset.metric; store('lab-metric', lab.metric); }
    if (b.dataset.days) { lab.days = b.dataset.days; store('lab-days', lab.days); }
    updateLab(true);
  });
  let t = null;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => updateLab(true), 200); });
  sync();
}

// called every second (panels.js) and when data arrives; draws only when something it shows changed
export function updateLab(force = false) {
  const series = modelSeries(), recs = recorded(series), snaps = lab.view === 'round' ? recordedSnaps(series) : null;
  const ks = seriesId(S.asset, 'kalshi', 15), ksRecs = ROUND_S === 900 ? recorded(ks) : null;
  const width = Math.round($('lab-body').clientWidth || 600);
  const key = [series, lab.view, lab.metric, lab.days, recordedVersion(), !!recs, !!snaps, !!ksRecs,
               activeModel().id, JSON.stringify(activeParams()), width].join('|');
  if (!force && key === lab.key) return;
  lab.key = key; lab.width = width;
  loadRecorded(series);
  if (ROUND_S === 900) loadRecorded(ks);   // the index averages Kalshi publishes: typical moves for the 15m rounds
  const V = parseSeries(series), name = `${S.A.sym} ${V.venue === 'kalshi' ? 'Kalshi' : 'Polymarket'} ${V.len / 60}m`;
  $('lab-meta').textContent = name + ' · ' + activeModel().name;
  $('lab-body').innerHTML = lab.view === 'stack' ? viewStack(recs) : lab.view === 'round' ? viewRound(series, snaps) : viewHour(recs, ksRecs);
}

// ── Model vs market ──────────────────────────────────────────────────────────
function viewStack(recs) {
  if (!recs) return msg('Waiting for the recorder’s rounds of this market…');
  const m = activeModel(), rows = scored(rescore(m, activeParams(m), recs, ROUND_S));
  const st = stacking(rows.map(r => ({ mkt: marketProb(r), model: r.model, up: r.result === 'up' })));
  if (!st) return msg(`Needs 30 recorded rounds with market and model 60s before the end; has ${rows.length}` +
    (m.learned ? ` (the Learned model is scored from ${LEARN_MIN})` : '') + '.');
  const sure = st.n >= 200, helps = st.cvFull !== null && st.cvMkt !== null && st.cvFull < st.cvMkt;
  const verdict = st.p < 0.01 && st.c > 0 && helps ? 'The model adds information the market does not price'
    : st.p < 0.05 && st.c < 0 ? 'Where the model differs from the market, the market tends to be right'
    : st.p < 0.05 ? 'A hint that the model adds something' + (helps ? '' : ', but not out of sample')
    : 'No sign that the model knows more than the market';
  const pm = (v, se) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(2)} ± ${se.toFixed(2)}`;
  return `<div class="lab-verdict">${verdict}${sure ? '' : ' <span class="muted">· too few rounds to be sure</span>'}</div>` +
    trow(`Rounds <span class="muted">· 60s before the end, with result</span>`, st.n) +
    trow(`Weight on the market <span class="muted">· 1 = at face value</span>`, pm(st.b, st.bSe)) +
    trow(`Weight on the model <span class="muted">· 0 = adds nothing</span>`, `${pm(st.c, st.cSe)} · ${Math.abs(st.z).toFixed(1)}× its ±`) +
    trow(`Chance of a weight this far from 0 by luck`, st.p < 0.001 ? '<0.1%' : (st.p * 100).toFixed(st.p < 0.1 ? 1 : 0) + '%') +
    (st.cvMkt !== null && st.cvFull !== null ? trow(`Log loss out of sample <span class="muted">· 5 folds in time order</span>`,
      `market ${st.cvMkt.toFixed(3)} · market + model ${st.cvFull.toFixed(3)}`) : '') +
    `<div class="sig-sub lab-note">Fits the outcome on the market’s log-odds alone, then on market and model together (logistic regression).
     If the model only repeated what the price already says, its weight would be 0, give or take about twice its ±. A weight on the market
     above 1 means its favourites won more often than its price said (too cautious), below 1 less often (too sure). Out of sample, each fifth of
     the rounds is predicted by a fit on the other four. Switch models in the Model card to test each one.</div>`;
}

// ── Through the round ────────────────────────────────────────────────────────
function viewRound(series, data) {
  if (!data) { loadSnaps(series); return msg('Loading every minute’s snapshot of the last days…'); }
  if (data.missing) return msg('The recorder has no minute snapshots yet: they come with recorder v3 (npm run migrate:3, then deploy).');
  const len = ROUND_S, mins = len / 60, m = activeModel(), p = activeParams(m);
  const fee = parseSeries(series).venue === 'kalshi' ? KS_FEE : PM_FEE;
  const buckets = [];
  for (let k = mins; k >= 1; k--) {
    const rows = data.recs.filter(r => (r.result === 'up' || r.result === 'down') && Math.round((r.start + len - r.snap_t) / 60) === k);
    const sc = scored(rescore(m, p, rows, len));
    if (!sc.length) { buckets.push({ k, n: 0 }); continue; }
    const mk = scores(sc, marketProb), md = scores(sc, r => r.model), bt = backtest(sc, BT_EDGE, fee);
    buckets.push({ k, n: sc.length, mkt: mk.log, mod: md.log, open: sc.filter(isOpen).length / sc.length, bt });
  }
  const have = buckets.filter(b => b.n);
  if (!have.length) return msg(`No finished round with snapshots yet (${data.recs.length} snapshots so far).`);
  const rounds = new Set(data.recs.filter(r => r.result).map(r => r.start)).size;
  return `<div class="sig-sub lab-note">${rounds} rounds of the last ${data.days} days, a snapshot every minute; each minute’s
    market and ${esc(m.name)} model against the official result.</div>` + roundChart(buckets) + roundTable(buckets);
}

// log loss of market and model by minutes left (one axis: same unit); one line per forecaster
function roundChart(bs) {
  const W = Math.max(300, Math.min(900, lab.width)), H = 190, L = 40, R = 12, T = 12, B = 30, pw = W - L - R, ph = H - T - B;
  const pts = bs.filter(b => b.n), hi = Math.max(...pts.flatMap(b => [b.mkt, b.mod])) * 1.1, lo = 0;
  const x = i => L + (bs.length === 1 ? pw / 2 : i / (bs.length - 1) * pw), y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
  const venue = parseSeries(modelSeries()).venue === 'kalshi' ? 'ks' : 'pm';
  let g = '';
  const step = hi > 0.6 ? 0.2 : hi > 0.3 ? 0.1 : 0.05;
  for (let v = 0; v <= hi; v += step) g += `<line class="cal-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
    `<text class="cal-tick" x="${L - 6}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${v.toFixed(2)}</text>`;
  const every = bs.length > 8 ? 2 : 1;
  bs.forEach((b, i) => { if (i % every === 0 || i === bs.length - 1) g += `<text class="cal-tick" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${b.k}m</text>`; });
  for (const [key, cls, name] of [['mkt', venue, 'Market'], ['mod', 'md', 'Model']]) {
    const line = bs.map((b, i) => b.n ? `${x(i).toFixed(1)},${y(b[key]).toFixed(1)}` : null).filter(Boolean).join(' ');
    g += `<polyline class="cal-line lab-${cls}" points="${line}"/>`;
    bs.forEach((b, i) => { if (b.n) g += `<g class="cal-pt"><title>${b.k} min left · ${name} log loss ${b[key].toFixed(3)} · ${b.n} rounds</title>` +
      `<circle class="cal-hit" cx="${x(i).toFixed(1)}" cy="${y(b[key]).toFixed(1)}" r="11"/><circle class="cal-dot lab-${cls}" cx="${x(i).toFixed(1)}" cy="${y(b[key]).toFixed(1)}" r="4"/></g>`; });
  }
  return `<div class="chart-head"><h3 class="sub">Log loss by minutes left <span class="muted">· lower is better</span></h3>
    <div class="legend"><span><i class="lk ${venue} thick"></i>Market</span><span><i class="lk thick"></i>Model</span></div></div>
    <svg class="cal lab-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Log loss of market and model by minutes left">${g}</svg>`;
}

function roundTable(bs) {
  const rows = bs.filter(b => b.n).map(b => {
    const bt = b.bt.trades ? `<span class="${b.bt.pnl >= 0 ? 'up-t' : 'down-t'}">${signedC(b.bt.perTrade)}</span> · ${b.bt.trades}` : '—';
    return `<tr><td>${b.k}m</td><td>${b.n}</td><td>${Math.round(b.open * 100)}%</td><td>${b.mkt.toFixed(3)}</td><td>${b.mod.toFixed(3)}</td><td>${bt}</td>` +
      `<td>${b.bt.sizeMed !== null ? Math.round(b.bt.sizeMed).toLocaleString('en-US') : '—'}</td></tr>`;
  }).join('');
  return `<div class="lab-scroll"><table class="edge-t lab-t"><thead><tr><th>Left</th><th>Rounds</th><th>Open</th><th>Market</th><th>Model</th>` +
    `<th>Edge ≥ ${BT_EDGE * 100}¢</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<div class="sig-sub lab-note">Open: market still ${OPEN[0] * 100}–${OPEN[1] * 100}%. Market and Model: log loss. Edge: buying the side with a
     model edge of at least ${BT_EDGE * 100}¢ at the best ask, after fees — per trade and how many. Size: median shares at that ask.</div>`;
}

// ── Time of day ──────────────────────────────────────────────────────────────
const METRICS = { up: 'UP share', move: 'Typical move', spread: 'Spread at −60s' };
function viewHour(recs, ksRecs) {
  const seg = (attr, cur, items) => `<div class="seg sm" role="group">${items.map(([v, l]) =>
    `<button type="button" data-${attr}="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</div>`;
  const controls = `<div class="lab-ctl">${seg('metric', lab.metric, Object.entries(METRICS))}` +
    `${seg('days', lab.days, [['all', 'Every day'], ['wd', 'Mon–Fri'], ['we', 'Sat–Sun']])}</div>`;
  if (!recs) return controls + msg('Waiting for the recorder’s rounds of this market…');
  const ksBy = new Map((ksRecs || []).map(r => [r.start, r]));
  const move = r => r.settle != null && r.strike != null ? Math.abs(r.settle - r.strike)
    : r.k_settle != null && r.k_strike != null ? Math.abs(r.k_settle - r.k_strike)
    : (k => k?.k_settle != null && k.k_strike != null ? Math.abs(k.k_settle - k.k_strike) : null)(ksBy.get(r.start));
  const dayOk = r => { const d = new Date(r.start * 1000).getDay(), we = d === 0 || d === 6; return lab.days === 'all' || (lab.days === 'we') === we; };
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, vals: [] }));
  let n = 0, first = Infinity, last = 0;
  for (const r of recs) {
    if (!dayOk(r)) continue;
    const v = lab.metric === 'up' ? (r.result === 'up' ? 1 : r.result === 'down' ? 0 : null)
            : lab.metric === 'move' ? (r.result ? move(r) : null)
            : (r.bid != null && r.ask != null ? r.ask - r.bid : null);
    if (v === null) continue;
    hours[new Date(r.start * 1000).getHours()].vals.push(v);
    n++; first = Math.min(first, r.start); last = Math.max(last, r.start);
  }
  if (!n) return controls + msg(lab.metric === 'spread' ? 'No recorded snapshot with both sides of the book yet.' : 'No recorded round with this yet.');
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  for (const b of hours) b.v = !b.vals.length ? null : lab.metric === 'up' ? b.vals.reduce((a, x) => a + x, 0) / b.vals.length
                                                     : lab.metric === 'move' ? med(b.vals) : b.vals.reduce((a, x) => a + x, 0) / b.vals.length;
  const tz = -new Date().getTimezoneOffset() / 60, days = Math.max(1, Math.round((last - first) / 86400));
  const fmt = v => lab.metric === 'up' ? Math.round(v * 100) + '%' : lab.metric === 'move' ? fmtAmt(v) : (v * 100).toFixed(1) + '¢';
  const what = lab.metric === 'up' ? 'Share of rounds that went UP (official result), by the hour they started'
    : lab.metric === 'move' ? 'Median distance from the strike at the end (60s averages)' : 'Average gap between best bid and ask 60s before the end';
  return controls + `<div class="sig-sub lab-note">${what} · ${n} rounds over ${days} day${days > 1 ? 's' : ''} · your time (UTC${tz >= 0 ? '+' : '−'}${Math.abs(tz)})</div>` +
    hourChart(hours, fmt) + hourTable(hours, fmt);
}

// one column per hour; UP share grows up or down from 50%, the others from 0. Thin hours (under 10 rounds) fainter.
function hourChart(hours, fmt) {
  const W = Math.max(300, Math.min(900, lab.width)), H = 180, L = 40, R = 6, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const up = lab.metric === 'up', vs = hours.filter(b => b.v !== null).map(b => b.v);
  const dev = up ? Math.max(0.1, ...vs.map(v => Math.abs(v - 0.5))) * 1.15 : 0;
  const lo = up ? 0.5 - dev : 0, hi = up ? 0.5 + dev : Math.max(...vs) * 1.15 || 1, base = up ? 0.5 : 0;
  const y = v => T + (1 - (v - lo) / (hi - lo)) * ph, slot = pw / 24, bw = Math.min(24, slot - 2);
  let g = '';
  const ticks = up ? [lo, 0.5, hi].map(v => Math.round(v * 100) / 100) : [0, hi / 2, hi];
  for (const v of ticks) g += `<line class="cal-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
    `<text class="cal-tick" x="${L - 6}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`;
  for (const b of hours) {
    const cx = L + slot * (b.h + 0.5);
    if (b.h % (W < 420 ? 6 : 3) === 0) g += `<text class="cal-tick" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${String(b.h).padStart(2, '0')}</text>`;
    if (b.v === null) continue;
    // (an hour right at 50% still gets a 2px mark, so it reads as "even", not as "no data")
    const flat = Math.abs(y(b.v) - y(base)) < 2, y0 = y(base) + (flat ? 1 : 0), y1 = flat ? y0 - 2 : y(b.v);
    const top = Math.min(y0, y1), h = Math.max(2, Math.abs(y1 - y0)), pos = y1 <= y0;
    const cls = up && !flat ? (b.v >= base ? 'tod-up' : 'tod-down') : 'tod-bar';
    // rounded at the data end (4px), square at the baseline
    const r = Math.min(4, h, bw / 2), x0 = cx - bw / 2, x1 = cx + bw / 2;
    const d = pos ? `M${x0},${y0}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${y0}Z`
                  : `M${x0},${y0}V${top + h - r}Q${x0},${top + h} ${x0 + r},${top + h}H${x1 - r}Q${x1},${top + h} ${x1},${top + h - r}V${y0}Z`;
    g += `<g class="tod-g${b.vals.length < 10 ? ' thin' : ''}"><title>${String(b.h).padStart(2, '0')}:00–${String(b.h).padStart(2, '0')}:59 · ${fmt(b.v)} · ${b.vals.length} rounds` +
      `${b.vals.length < 10 ? ' (few)' : ''}</title><rect class="cal-hit" x="${(cx - slot / 2).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${ph}"/>` +
      `<path class="${cls}" d="${d}"/></g>`;
  }
  if (up) g += `<line class="cal-ref" x1="${L}" x2="${W - R}" y1="${y(0.5).toFixed(1)}" y2="${y(0.5).toFixed(1)}"/>`;
  return `<svg class="cal lab-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${METRICS[lab.metric]} by hour of the day">${g}</svg>`;
}

function hourTable(hours, fmt) {
  const rows = hours.filter(b => b.v !== null).map(b => `<tr><td>${String(b.h).padStart(2, '0')}:00</td><td>${b.vals.length}</td><td>${fmt(b.v)}</td></tr>`).join('');
  return `<details class="lab-details"><summary>Table</summary><table class="edge-t lab-t"><thead><tr><th>Hour</th><th>Rounds</th>` +
    `<th>${METRICS[lab.metric]}</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}
