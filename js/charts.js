// The two canvas charts (BTC vs strike, implied UP probability), their tooltips and the render loop.

import { KALSHI_PROXY } from './kalshi.js';
import { renderLadder } from './ladder.js';
import { firstIdx, forecastAt, niceStep, normalPdf, twap } from './math.js';
import { sigmaUsd } from './model.js';
import { EXCH, S, TWAP_MS, medianHistory } from './state.js';
import { T } from './theme.js';
import { $, currentRound, fmtClock, fmtHM, fmtNum, fmtP, fmtPts, signedUsd } from './util.js';
import { KS, PM, activeVenues } from './venues.js';

let plotGutter = 72;

// ── Canvas plumbing ──────────────────────────────────────────────────────────
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function setupCanvas(id) {
  const el = $(id);
  const c = { el, ctx: el.getContext('2d'), w: 0, h: 0, dpr: 1 };
  const fit = () => {
    c.dpr = window.devicePixelRatio || 1;
    c.w = el.clientWidth; c.h = el.clientHeight;
    el.width = Math.round(c.w * c.dpr); el.height = Math.round(c.h * c.dpr);
    redrawCharts();   // resizing clears the canvas
  };
  new ResizeObserver(fit).observe(el);
  fit();
  return c;
}

// pointer → shared crosshair; touch keeps it visible briefly after lifting the finger
export function attachHover(el, name) {
  const update = e => {
    const r = el.getBoundingClientRect();
    S.hoverFrac = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width - plotGutter)));
    S.hoverSrc = name;
    wakeFrame();
  };
  const clear = () => { S.hoverFrac = null; S.hoverSrc = null; redrawCharts(); };
  el.addEventListener('pointerdown', e => { clearTimeout(S.touchClearTimer); update(e); });
  el.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons) update(e); });
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') clear(); });
  el.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') S.touchClearTimer = setTimeout(clear, 2500); });
  el.addEventListener('pointercancel', clear);
}

// x-domain of both charts: the whole round (incl. the strike window before it) or a rolling window
function domain(now) {
  if (S.viewMode === 'round') { const { start, end } = currentRound(now); return { t0: start - TWAP_MS, t1: end }; }
  return { t0: now - S.windowMs, t1: now };
}

// what both charts show: the live round / rolling window, or a past round picked in the menu
// `lines`: one probability series per active venue
function chartView(now) {
  if (S.review) {
    const r = S.review;
    return { live: false, t0: r.start - TWAP_MS, t1: r.end, tNow: r.end, start: r.start, end: r.end, round: true,
             med: r.btc, lines: activeVenues().map(V => ({ V, hist: r.probs[V.key] || [] })),
             strike: r.strike ?? null, strikeSrc: 'twap',
             empty: r.loading ? 'Loading round…' : 'No data for this round' };
  }
  const { start, end } = currentRound(now);
  return { live: true, ...domain(now), tNow: now, start, end, round: S.viewMode === 'round',
           med: medianHistory, lines: activeVenues().map(V => ({ V, hist: V.prob })), strike: S.strike, strikeSrc: S.strikeSrc, empty: null };
}

// visible slice (+ the point just before the window) reduced to one point per pixel-wide time bucket.
// Buckets are aligned to absolute time, not to the moving window edge: a point never changes bucket
// while the chart scrolls, so the line only translates instead of re-shaping every frame.
function series(arr, cutoff, xOf, msPerPx) {
  const pts = [];
  let lo = Infinity, hi = -Infinity, lastB = null;
  for (let i = Math.max(0, firstIdx(arr, cutoff) - 1); i < arr.length; i++) {
    const v = arr[i], b = Math.floor(v.t / msPerPx);
    if (v.p < lo) lo = v.p;
    if (v.p > hi) hi = v.p;
    if (b === lastB) pts[pts.length - 1].p = v.p;
    else { pts.push({ x: xOf(b * msPerPx), p: v.p }); lastB = b; }
  }
  return { pts, lo, hi };
}

// y-axis range eased toward its target (grow fast, shrink slowly) — a hard rescale every frame
// makes the whole line jump whenever an extreme scrolls out of the window
export const yRange = {};
let frameDt = 16, lastFrameT = 0;   // per animation frame (order book)
let chartDt = 16, lastChartT = 0, chartEasing = false;   // per chart redraw, see render()
function easeRange(key, lo, hi) {
  const r = yRange[key];
  if (!r) return (yRange[key] = { lo, hi });
  const kGrow = 1 - Math.exp(-chartDt / 150), kShrink = 1 - Math.exp(-chartDt / 800);
  r.lo += (lo - r.lo) * (lo < r.lo ? kGrow : kShrink);
  r.hi += (hi - r.hi) * (hi > r.hi ? kGrow : kShrink);
  // still visibly moving (more than ~0.2% of the height): redraw every frame until it settles
  if (Math.abs(lo - r.lo) + Math.abs(hi - r.hi) > (r.hi - r.lo) * 0.002) chartEasing = true;
  return r;
}

// polyline vertices; step = hold each value until the next point; extends flat to xEnd ("now")
function vertices(pts, yOf, step, xEnd) {
  const out = [];
  let prevY = null;
  for (const p of pts) {
    const y = yOf(p.p);
    if (step && prevY !== null) out.push([p.x, prevY]);
    out.push([p.x, y]);
    prevY = y;
  }
  if (xEnd > out[out.length - 1][0]) out.push([xEnd, prevY]);
  return out;
}

function strokeVerts(ctx, verts, color, width) {
  ctx.beginPath();
  ctx.moveTo(verts[0][0], verts[0][1]);
  for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i][0], verts[i][1]);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();
}

// ~10% wash between the line and a reference level: up color above it, down color below
function washVerts(ctx, verts, baseY, PW, H) {
  const path = new Path2D();
  path.moveTo(verts[0][0], baseY);
  for (const [x, y] of verts) path.lineTo(x, y);
  path.lineTo(verts[verts.length - 1][0], baseY);
  path.closePath();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, PW, baseY);     ctx.clip(); ctx.fillStyle = T.upWash;   ctx.fill(path); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(0, baseY, PW, H - baseY); ctx.clip(); ctx.fillStyle = T.downWash; ctx.fill(path); ctx.restore();
}

// round view: the two 60s averaging windows (strike before the round, settlement at its end) when
// switched on, otherwise just a hairline where the round starts
function roundBands(ctx, xOf, Y1, labels, start, end) {
  if (!S.showBands) { vline(ctx, xOf(start), 0, Y1); return; }
  ctx.font = '10px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const [a, b, lbl] of [[start - TWAP_MS, start, 'strike avg'], [end - TWAP_MS, end, 'settlement avg']]) {
    const xa = xOf(a), xb = xOf(b);
    ctx.fillStyle = T.band; ctx.fillRect(xa, 0, xb - xa, Y1);
    if (labels) { ctx.fillStyle = T.muted; ctx.fillText(lbl, (xa + xb) / 2, 2); }
  }
  ctx.textAlign = 'left';
}

// solid hairline grid with clean tick values in the right gutter (no label where the end tag sits)
function yGrid(ctx, lo, hi, yOf, PW, Y0, Y1, target, fmt, tagY) {
  const step = niceStep(hi - lo, target);
  if (!(step > 0)) return;
  ctx.font = '11px ' + FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineWidth = 1;
  for (let i = Math.ceil(lo / step), n = 0; i * step <= hi && n < 40; i++, n++) {
    const v = i * step, y = Math.round(yOf(v)) + .5;
    if (y < Y0 - 1 || y > Y1 + 1) continue;
    ctx.strokeStyle = T.grid;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PW, y); ctx.stroke();
    if (tagY !== null && Math.abs(y - tagY) < 15) continue;
    ctx.fillStyle = T.muted;
    ctx.fillText(fmt(v, step), PW + 8, y);
  }
}

function xAxis(ctx, t0, t1, PW, Y1, fmt) {
  ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Y1 + .5); ctx.lineTo(PW, Y1 + .5); ctx.stroke();
  ctx.font = '11px ' + FONT; ctx.fillStyle = T.muted; ctx.textBaseline = 'top';
  const n = Math.max(2, Math.min(6, Math.floor(PW / 110)));
  for (let i = 0; i <= n; i++) {
    ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center';
    ctx.fillText(fmt(t0 + (t1 - t0) * i / n), PW * i / n, Y1 + 7);
  }
  ctx.textAlign = 'left';
}

// threshold reference (strike, 50%): the one place a dashed line is right
function refLine(ctx, y, PW) {
  ctx.setLineDash([4, 4]); ctx.strokeStyle = T.ink2; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PW, y); ctx.stroke();
  ctx.setLineDash([]);
}

function vline(ctx, x, Y0, Y1) {
  ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, Y0); ctx.lineTo(Math.round(x) + .5, Y1); ctx.stroke();
}

// 8px dot with a 2px surface ring
function dot(ctx, x, y, color) {
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = T.surface; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = color;     ctx.fill();
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

// value at the line end (label inside a fill: surface-colored text)
function endTag(ctx, x, y, text, Y0, Y1) {
  ctx.font = '600 11px ' + FONT;
  const tw = ctx.measureText(text).width, h = 18;
  const ty = Math.max(Y0 + h / 2 - 4, Math.min(Y1 - h / 2 + 4, y));
  ctx.fillStyle = T.ink1; rrect(ctx, x + 6, ty - h / 2, tw + 12, h, 4); ctx.fill();
  ctx.fillStyle = T.surface; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(text, x + 12, ty + .5);
}

function emptyState(ctx, PW, Y0, Y1, msg) {
  ctx.fillStyle = T.muted; ctx.font = '12px ' + FONT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(msg, PW / 2, (Y0 + Y1) / 2);
  ctx.textAlign = 'left';
}

// tooltip: DOM built once, values written with textContent
function makeTip(id, rows) {
  const el = $(id), refs = {};
  const time = document.createElement('div'); time.className = 'tip-time'; el.appendChild(time);
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'tip-row';
    const name = document.createElement('span'); name.className = 'tip-name';
    if (r.key) { const k = document.createElement('i'); k.className = 'lk ' + r.key; if (r.color) k.style.background = r.color; name.appendChild(k); }
    const label = document.createTextNode(r.label);
    name.appendChild(label);
    const val = document.createElement('b');
    row.append(name, val); el.appendChild(row);
    refs[r.id] = { row, val, label };
  }
  return { el, time, refs };
}

function placeTip(tip, x, PW) {
  tip.el.hidden = false;
  const w = tip.el.offsetWidth;
  let left = x + 14;
  if (left + w > PW) left = x - 14 - w;
  tip.el.style.left = Math.max(0, left) + 'px';
}

// hovered time, clamped to "now" (the round view has empty future space on the right)
function hoverTime(t0, D, now) { return Math.min(now, t0 + S.hoverFrac * D); }

// ── BTC chart ────────────────────────────────────────────────────────────────
function drawBtc(v) {
  const c = btcC, ctx = c.ctx, W = c.w, H = c.h;
  if (!W || !H) return;
  const now = v.tNow, strike = v.strike, strikeSrc = v.strikeSrc, hist = v.med;
  ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // gutter sized to the widest label so both charts share the same plot width;
  // measured with every digit as 0 so it doesn't wobble as the price changes
  ctx.font = '600 11px ' + FONT;
  plotGutter = Math.max(64, Math.ceil(ctx.measureText((S.lastMedianP !== null ? fmtNum(S.lastMedianP) : '00,000.00').replace(/\d/g, '0')).width) + 26);
  const PW = W - plotGutter, Y0 = 16, Y1 = H - 6;
  if (PW < 40) return;
  const { t0, t1 } = v, D = t1 - t0, msPerPx = D / PW;
  const xOf = t => (t - t0) / D * PW, xNow = Math.min(PW, xOf(now));
  if (v.round) roundBands(ctx, xOf, H, true, v.start, v.end);

  const med = series(hist, t0, xOf, msPerPx);
  if (!med.pts.length) { btcTip.el.hidden = true; emptyState(ctx, PW, Y0, Y1, v.empty ?? 'Waiting for trades…'); return; }

  let lo = med.lo, hi = med.hi;
  const exLines = [];
  if (S.showExchanges && v.live) for (const ex of EXCH) {
    if (!ex.enabled) continue;
    const s = series(ex.trades, t0, xOf, msPerPx);
    if (!s.pts.length) continue;
    exLines.push([ex, s]);
    lo = Math.min(lo, s.lo); hi = Math.max(hi, s.hi);
  }
  if (strike !== null) { lo = Math.min(lo, strike); hi = Math.max(hi, strike); }
  const fc = forecastPath(v);
  if (fc) for (const p of fc.pts) { lo = Math.min(lo, p.mean - p.sd); hi = Math.max(hi, p.mean + p.sd); }   // ±1σ in view
  const pad = Math.max((hi - lo) * 0.12, 3);
  ({ lo, hi } = easeRange('btc', lo - pad, hi + pad));
  const yOf = p => Y0 + (hi - p) / (hi - lo) * (Y1 - Y0);

  const lastP = med.pts[med.pts.length - 1].p;
  yGrid(ctx, lo, hi, yOf, PW, Y0, Y1, (Y1 - Y0) < 240 ? 4 : 6,
    (v, step) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: step < 1 ? 2 : 0, maximumFractionDigits: step < 1 ? 2 : 0 }),
    xNow >= PW - 1 ? yOf(lastP) : null);

  const verts = vertices(med.pts, yOf, false, xNow);
  if (strike !== null) washVerts(ctx, verts, yOf(strike), PW, H);
  for (const [ex, s] of exLines) strokeVerts(ctx, vertices(s.pts, yOf, false, xNow), ex.color, 1.25);
  if (fc) drawForecast(ctx, fc, xOf, yOf, PW, Y0, Y1, strike);
  if (!!fc === $('leg-fc').hidden) $('leg-fc').hidden = !fc;

  if (strike !== null) refLine(ctx, Math.round(yOf(strike)) + .5, PW);
  strokeVerts(ctx, verts, T.ink1, 2);

  // strike label on top of the line; in the round view it sits in the still-empty future on the right
  if (strike !== null) {
    const sy = Math.round(yOf(strike)) + .5;
    const lbl = (strikeSrc === 'twap' ? 'Strike ' : 'Strike ≈ ') + fmtP(strike);
    ctx.font = '11px ' + FONT;
    const lw = ctx.measureText(lbl).width;
    const right = PW - lw - 12 - (fc ? fcWidth(PW) : 0);   // left of the settlement distribution when it is shown
    const lx = xNow + 100 < right ? right : 4;
    const ly = sy - 12 > Y0 + 4 ? sy - 11 : sy + 11;
    ctx.fillStyle = T.surface; rrect(ctx, lx, ly - 8, lw + 8, 16, 4); ctx.fill();
    ctx.fillStyle = T.ink2; ctx.textBaseline = 'middle'; ctx.fillText(lbl, lx + 4, ly);
  }
  dot(ctx, xNow, yOf(lastP), T.ink1);
  endTag(ctx, xNow, yOf(lastP), fmtNum(lastP), Y0, Y1);

  if (S.hoverFrac === null) { btcTip.el.hidden = true; return; }
  const R = btcTip.refs;
  // in the future part of the round with the forecast on: what the model expects at that moment
  const hf = t0 + S.hoverFrac * D;
  if (fc && hf > now) {
    const x = xOf(hf), p = fc.at(hf);
    vline(ctx, x, Y0, Y1);
    dot(ctx, x, yOf(p.mean), T.ink2);
    if (S.hoverSrc !== 'btc') { btcTip.el.hidden = true; return; }
    btcTip.time.textContent = fmtClock(hf) + (hf > v.end - TWAP_MS ? ' · settlement avg' : '');
    for (const k in R) R[k].row.hidden = k !== 'fc' && k !== 'f68';
    R.fc.val.textContent = fmtP(p.mean);
    R.f68.val.textContent = `${fmtP(p.mean - p.sd)} – ${fmtP(p.mean + p.sd)}`;
    placeTip(btcTip, x, PW);
    return;
  }
  R.fc.row.hidden = R.f68.row.hidden = true;
  R.med.row.hidden = R.vs.row.hidden = false;
  const ht = hoverTime(t0, D, now), x = xOf(ht);
  const i  = firstIdx(hist, ht);
  const a = hist[i - 1], b = hist[i];
  const pt = !a ? b : !b ? a : (ht - a.t <= b.t - ht ? a : b);
  if (!pt) { btcTip.el.hidden = true; return; }
  vline(ctx, x, Y0, Y1);
  dot(ctx, x, yOf(pt.p), T.ink1);
  if (S.hoverSrc !== 'btc') { btcTip.el.hidden = true; return; }

  btcTip.time.textContent = fmtClock(pt.t);
  btcTip.refs.med.val.textContent = fmtP(pt.p);
  btcTip.refs.vs.val.textContent  = strike !== null ? signedUsd(pt.p - strike) : '—';
  for (const ex of EXCH) {
    const r = btcTip.refs[ex.key];
    r.row.hidden = !S.showExchanges || !ex.enabled || !v.live;
    if (r.row.hidden) continue;
    const j = firstIdx(ex.trades, ht + 1) - 1;
    r.val.textContent = j >= 0 ? fmtP(ex.trades[j].p) : '—';
  }
  placeTip(btcTip, x, PW);
}

// ── Model forecast (toggle) ──────────────────────────────────────────────────
// From now to the round end, the spread the model expects: ±1σ and ±2σ (68% / 95% of outcomes) of the price until
// the settlement window opens, then of the window's running average, which at the end is the settlement average.
// At the right edge its distribution, split at the strike (above: up wash, below: down wash). Live round view only.
// px the settlement distribution takes at the right edge: 46, at most 12% of the plot (phones)
const fcWidth = PW => Math.min(46, Math.round(PW * 0.12));

function forecastPath(v) {
  if (!S.showFc || !v.live || !v.round || v.strike === null || S.lastMedianP === null) return null;
  const now = v.tNow, end = v.end, T = (end - now) / 1000;
  if (T <= 1) return null;
  const price = S.lastMedianP, sigma = sigmaUsd(), ws = (end - TWAP_MS - now) / 1000;
  const observed = ws < 0 ? twap(medianHistory, end - TWAP_MS, now) : null;
  const at = tMs => forecastAt(price, sigma, (tMs - now) / 1000, ws, observed);
  // denser inside the window, where the shape bends
  const a = Math.max(ws, 0), ts = [0];
  if (a > 0) for (let k = 1; k <= 30; k++) ts.push(a * k / 30);
  for (let k = 1; k <= 24; k++) ts.push(a + (T - a) * k / 24);
  const pts = ts.map(t => ({ t: now + t * 1000, ...forecastAt(price, sigma, t, ws, observed) }));
  pts[0].sd = 0;
  return { pts, at, end: pts[pts.length - 1] };
}

function drawForecast(ctx, fc, xOf, yOf, PW, Y0, Y1, strike) {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y0 - 8, PW, Y1 - Y0 + 8); ctx.clip();
  // ±2σ (lighter) under ±1σ: one neutral ink, the band has no side
  for (const [k, alpha] of [[2, 0.07], [1, 0.10]]) {
    ctx.beginPath();
    fc.pts.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.mean + k * p.sd); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    for (let i = fc.pts.length - 1; i >= 0; i--) ctx.lineTo(xOf(fc.pts[i].t), yOf(fc.pts[i].mean - k * fc.pts[i].sd));
    ctx.closePath();
    ctx.globalAlpha = alpha; ctx.fillStyle = T.ink1; ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  fc.pts.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.mean); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = T.ink2; ctx.lineWidth = 1; ctx.stroke();

  // settlement distribution: density across the price axis, drawn leftwards from the right edge
  const d = fc.end, peak = normalPdf(d.mean, d), shape = new Path2D(), FC_W = fcWidth(PW);
  shape.moveTo(PW, yOf(d.mean + 3.5 * d.sd));
  for (let k = 0; k <= 64; k++) { const p = d.mean + 3.5 * d.sd * (1 - k / 32); shape.lineTo(PW - FC_W * normalPdf(p, d) / peak, yOf(p)); }
  shape.closePath();
  const ys = Math.max(Y0 - 8, Math.min(Y1, yOf(strike)));
  for (const [y0, y1, color] of [[0, ys, T.up], [ys, Y1 + 8, T.down]]) {
    ctx.save(); ctx.beginPath(); ctx.rect(PW - FC_W - 1, y0, FC_W + 1, y1 - y0); ctx.clip();
    ctx.globalAlpha = 0.4; ctx.fillStyle = color; ctx.fill(shape); ctx.restore();
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = T.ink2; ctx.lineWidth = 1; ctx.stroke(shape);
  ctx.restore();
}

// ── Probability chart ────────────────────────────────────────────────────────
// one venue: ink line with the up/down wash against 50%. Both venues: a line per venue in its color,
// optionally the gap between them shaded (the price gap / mispricing between the two markets).
function drawProb(v) {
  const c = probC, ctx = c.ctx, W = c.w, H = c.h;
  if (!W || !H) return;
  ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const now = v.tNow, dual = v.lines.length > 1;

  const PW = W - plotGutter, Y0 = 10, Y1 = H - 24;
  if (PW < 40) return;
  const { t0, t1 } = v, D = t1 - t0, msPerPx = D / PW;
  const xOf = t => (t - t0) / D * PW, xNow = Math.min(PW, xOf(now));
  if (v.round) roundBands(ctx, xOf, Y1, false, v.start, v.end);
  xAxis(ctx, t0, t1, PW, Y1, v.round ? fmtHM : fmtClock);

  const lines = [];
  let sLo = Infinity, sHi = -Infinity;
  for (const L of v.lines) {
    const s = series(L.hist, t0, xOf, msPerPx);
    if (!s.pts.length) continue;
    lines.push({ ...L, s, color: dual ? (L.V === PM ? T.vpm : T.vks) : T.ink1 });
    sLo = Math.min(sLo, s.lo); sHi = Math.max(sHi, s.hi);
  }
  if (!lines.length) {
    probTip.el.hidden = true;
    emptyState(ctx, PW, Y0, Y1, v.empty ?? (v.lines.some(L => L.V === KS) && !KALSHI_PROXY ? 'Kalshi needs its proxy (see README)' : 'Waiting for market…'));
    return;
  }

  const pad = Math.max(5, (sHi - sLo) * 0.4);
  const { lo, hi } = easeRange('prob', Math.max(0, sLo - pad), Math.min(100, sHi + pad));
  const yOf = p => Y0 + (hi - p) / ((hi - lo) || 1) * (Y1 - Y0);

  for (const L of lines) { L.last = L.s.pts[L.s.pts.length - 1].p; L.verts = vertices(L.s.pts, yOf, true, xNow); }
  yGrid(ctx, lo, hi, yOf, PW, Y0, Y1, 3, v => v.toFixed(0) + '%', xNow >= PW - 1 && !dual ? yOf(lines[0].last) : null);
  const baseY = yOf(Math.max(lo, Math.min(hi, 50)));
  if (!dual) washVerts(ctx, lines[0].verts, baseY, PW, Y1);
  else if (S.showGap && lines.length === 2) {
    // the band between the two step lines: one forward, the other back
    const [a, b] = lines, path = new Path2D();
    path.moveTo(a.verts[0][0], a.verts[0][1]);
    for (const [x, y] of a.verts) path.lineTo(x, y);
    for (let i = b.verts.length - 1; i >= 0; i--) path.lineTo(b.verts[i][0], b.verts[i][1]);
    path.closePath();
    ctx.save(); ctx.beginPath(); ctx.rect(Math.max(a.verts[0][0], b.verts[0][0]), 0, PW, Y1); ctx.clip();
    ctx.globalAlpha = 0.14; ctx.fillStyle = T.ink2; ctx.fill(path);   // neutral: the gap has no side
    ctx.restore();
  }
  const show50 = lo < 50 && hi > 50;
  if (show50) refLine(ctx, Math.round(baseY) + .5, PW);
  if (show50 === $('leg-50').hidden) $('leg-50').hidden = !show50;
  for (const L of lines) strokeVerts(ctx, L.verts, L.color, 2);
  for (const L of lines) dot(ctx, xNow, yOf(L.last), L.color);
  // end tags; with two lines, pushed apart so they never overlap
  const tags = lines.map(L => ({ y: yOf(L.last), text: (dual ? L.V.short + ' ' : '') + L.last.toFixed(1) + '%' }));
  if (tags.length === 2 && Math.abs(tags[0].y - tags[1].y) < 20) {
    const [u, d] = tags[0].y <= tags[1].y ? tags : [tags[1], tags[0]], mid = (u.y + d.y) / 2;
    u.y = mid - 10; d.y = mid + 10;
  }
  for (const tg of tags) endTag(ctx, xNow, tg.y, tg.text, Y0, Y1);

  if (S.hoverFrac === null) { probTip.el.hidden = true; return; }
  const ht = hoverTime(t0, D, now), x = xOf(ht);
  vline(ctx, x, Y0, Y1);
  const at = L => { const j = firstIdx(L.hist, ht + 1) - 1; return j >= 0 ? L.hist[j].p : null; };
  const vals = lines.map(L => ({ L, p: at(L) }));
  if (vals.every(o => o.p === null)) { probTip.el.hidden = true; return; }
  for (const o of vals) if (o.p !== null) dot(ctx, x, yOf(Math.max(lo, Math.min(hi, o.p))), o.L.color);
  if (S.hoverSrc !== 'prob') { probTip.el.hidden = true; return; }
  probTip.time.textContent = fmtClock(ht);
  const R = probTip.refs, get = V => vals.find(o => o.L.V === V)?.p ?? null;
  R.up.row.hidden = dual; R.pm.row.hidden = R.ks.row.hidden = R.gap.row.hidden = !dual;
  if (!dual) R.up.val.textContent = vals[0].p !== null ? vals[0].p.toFixed(1) + '%' : '—';
  else {
    const pp = get(PM), pk = get(KS);
    R.pm.val.textContent = pp !== null ? pp.toFixed(1) + '%' : '—';
    R.ks.val.textContent = pk !== null ? pk.toFixed(1) + '%' : '—';
    R.gap.val.textContent = pp !== null && pk !== null ? fmtPts(pp - pk) : '—';
  }
  placeTip(probTip, x, PW);
}

// The charts are redrawn only as often as they visibly change: every frame while the pointer is on them, the
// y-axis eases or a short rolling window scrolls; otherwise once the time axis has moved a pixel, and at least
// 10 times a second for new prices. Between redraws the loop sleeps on a timer instead of spinning on frames,
// unless the order book is animating.
let frameReq = 0, frameTimer = 0;
export function wakeFrame() {
  clearTimeout(frameTimer); frameTimer = 0;
  if (!frameReq) frameReq = requestAnimationFrame(render);
}
function redrawCharts() { lastChartT = 0; wakeFrame(); }

function chartGap(view) {
  if (S.hoverFrac !== null || chartEasing) return 0;
  const PW = btcC.w - plotGutter;
  return PW > 0 ? Math.min(100, (view.t1 - view.t0) / PW) : 100;
}

function render() {
  frameReq = 0;
  const now = Date.now();
  frameDt = Math.min(100, now - (lastFrameT || now)); lastFrameT = now;
  const view = chartView(now);
  let gap = chartGap(view);
  if (now - lastChartT >= gap - 8) {   // 8ms slack: frames land on vsync, not on the millisecond
    chartDt = Math.min(250, now - (lastChartT || now)); lastChartT = now;
    chartEasing = false;
    drawBtc(view);
    drawProb(view);
    gap = chartGap(view);
  }
  const moving = renderLadder(frameDt);
  const wait = lastChartT + gap - Date.now();
  if (moving || wait < 24) frameReq = requestAnimationFrame(render);
  else { lastFrameT = 0; frameTimer = setTimeout(wakeFrame, wait - 8); }
}

export const btcTip = makeTip('btc-tip', [
  { id:'med', label:'Median',    key:' ' },
  { id:'vs',  label:'vs strike', key:'ghost' },
  { id:'fc',  label:'Model expects', key:'ghost' },
  { id:'f68', label:'68% between', key:'ghost' },
  ...EXCH.map((ex, i) => ({ id: ex.key, label: ex.name, key: ' ', color: `var(--ex-${i + 1})` })),
]);
const probTip = makeTip('prob-tip', [
  { id:'up',  label:'UP probability', key:' ' },
  { id:'pm',  label:'Polymarket', key:'pm' },
  { id:'ks',  label:'Kalshi',     key:'ks' },
  { id:'gap', label:'Gap',        key:'ghost' },
]);
export const btcC  = setupCanvas('btc-canvas');
export const probC = setupCanvas('prob-canvas');
