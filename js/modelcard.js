// The Model card: what the model in use computes, live and step by step (curve of where the settlement average
// lands, the four steps to the probability, market vs model, the edge), the collection of models with their score
// on recorded rounds, and the settings of the one in use.
import { KS_FEE, PM_FEE, modelEdges } from './arb.js';
import { distCdf, distPdf, distQuantile, impliedSigma, niceStep, probAbove, takerFee } from './math.js';
import { activeModel, activeParams, modelInputs } from './model.js';
import { EWMA_HALF_LIFE, MODELS, modelPath, paramsOf, scoreModel } from './models.js';
import { recorded } from './recorder.js';
import { trackId } from './rounds.js';
import { ROUND_S, S, saveOpts } from './state.js';
import { $, fmtC, fmtP, signedC } from './util.js';
import { KS, PM, both, mainVenue } from './venues.js';

const pct = v => (v * 100).toFixed(v > 0.995 || v < 0.005 ? 1 : 0) + '%';
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtUsd0 = v => '$' + Math.round(v).toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BT_EDGE = 0.03;
// the venue the card explains: the one in view; with both venues, Polymarket
const cardVenue = () => both() ? PM : mainVenue();

// ── Setup: the collection and the settings ───────────────────────────────────
export function initModelCard() {
  renderList();
  renderParams();
  $('mdl-list').addEventListener('click', e => {
    const b = e.target.closest('[data-model]');
    if (b && b.dataset.model !== S.modelId) { S.modelId = b.dataset.model; changed(true); }
  });
  $('mdl-reset').addEventListener('click', () => { delete S.modelParams[activeModel().id]; changed(true); });
  attachCurveHover();
}

// the model or a setting changed: remember it, and let every panel catch up at once
function changed(rebuild) {
  saveOpts();
  if (rebuild) { renderList(); renderParams(); }
  scoreKey = '';
  S.lastSlowT = 0;   // signals and KPIs on the next tick
  updateModelCard();
}

function renderList() {
  $('mdl-list').innerHTML = MODELS.map(m => `
    <button type="button" class="mcard" role="radio" aria-checked="${m.id === activeModel().id}" data-model="${m.id}">
      <span class="mcard-top"><i class="mcard-radio"></i><span class="mcard-name">${esc(m.name)}</span></span>
      <span class="mcard-tag">${esc(m.tagline)}</span>
      <span class="mcard-chips">${m.assumes.map(a => `<span>${esc(a)}</span>`).join('')}</span>
      <span class="mcard-score" id="msc-${m.id}">—</span>
    </button>`).join('');
}

function renderParams() {
  const m = activeModel(), p = activeParams(m);
  $('mdl-set-name').textContent = m.name;
  $('mdl-params').innerHTML = m.params.map(q => {
    const help = q.help ? `<div class="sig-sub">${esc(q.help)}</div>` : '';
    if (q.type === 'choice') return `<div class="mparam"><div class="mparam-top"><span>${esc(q.label)}</span>
        <div class="seg sm" role="group" aria-label="${esc(q.label)}">${q.options.map(([v, l]) =>
          `<button type="button" data-param="${q.key}" data-value="${v}" aria-pressed="${p[q.key] === v}">${esc(l)}</button>`).join('')}</div></div>${help}</div>`;
    return `<div class="mparam"><div class="mparam-top"><label for="mp-${q.key}">${esc(q.label)}</label><output id="mpo-${q.key}">${esc(q.fmt ? q.fmt(p[q.key]) : p[q.key])}</output></div>
      <input type="range" id="mp-${q.key}" data-param="${q.key}" min="${q.min}" max="${q.max}" step="${q.step}" value="${p[q.key]}">${help}</div>`;
  }).join('');
  const set = (key, v) => {
    S.modelParams = { ...S.modelParams, [m.id]: { ...activeParams(m), [key]: v } };
    const q = m.params.find(x => x.key === key), out = $('mpo-' + key);
    if (out) out.textContent = q.fmt ? q.fmt(v) : v;
    changed(false);
  };
  $('mdl-params').querySelectorAll('input[type=range]').forEach(el => el.addEventListener('input', () => set(el.dataset.param, +el.value)));
  $('mdl-params').querySelectorAll('button[data-param]').forEach(el => el.addEventListener('click', () => {
    set(el.dataset.param, +el.dataset.value);
    el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
  }));
}

// ── Score of every model on the recorded rounds of the market in view ────────
let scoreKey = '';
function renderScores() {
  const V = cardVenue(), series = trackId(V), recs = recorded(series);
  const key = `${series}|${recs ? recs.length + ':' + (recs[recs.length - 1]?.start ?? '') : 'none'}|${JSON.stringify(S.modelParams)}`;
  if (key === scoreKey) return;
  scoreKey = key;
  const fee = V === KS ? KS_FEE : PM_FEE, withSnap = recs?.filter(r => r.snap_t != null && r.result).length ?? 0;
  for (const m of MODELS) {
    const el = $('msc-' + m.id);
    if (!el) continue;
    if (!recs) { el.textContent = 'Not scored yet: the recorder collects the rounds of this market.'; continue; }
    const sc = scoreModel(m, paramsOf(m, S.modelParams[m.id]), recs, ROUND_S, fee, BT_EDGE);
    if (!sc) {
      el.textContent = withSnap ? 'Scored once the recorder also stores this model’s inputs (recorder update).'
                                : 'Not scored yet: no recorded round of this market has ended with a snapshot.';
      continue;
    }
    const bt = sc.bt.trades ? `${signedC(sc.bt.perTrade)} a trade (${sc.bt.trades})` : 'no trades';
    el.innerHTML = `Brier <b>${sc.brierModel.toFixed(3)}</b> vs market ${sc.brierMkt.toFixed(3)} · ${sc.n} rounds · ` +
      `edge ≥ ${BT_EDGE * 100}¢: ${bt}` + (sc.n < 50 ? ' · <i>too few rounds to judge</i>' : '');
    el.title = 'On recorded rounds of this market, 60s before the end. Brier: lower is better. Backtest: buy the side with ' +
      'a model edge of at least 3¢ at the best ask, after fees.';
  }
}

// ── Live: called every second (panels.js) and on every change ───────────────
let cur = null;   // what the curve shows, for the hover
export function updateModelCard() {
  renderScores();
  const m = activeModel(), p = activeParams(m), inp = modelInputs(), V = cardVenue();
  $('mdl-for').textContent = `· ${m.name}`;
  const path = inp && modelPath(m, inp, p);
  if (!path) {
    cur = null;
    $('mdl-svg').innerHTML = '';
    $('mdl-steps').innerHTML = '<li class="mstep"><span class="ms-s">Needs the BTC price, the strike and the volatility…</span></li>';
    $('mdl-vs').innerHTML = $('mdl-edge').innerHTML = '';
    return;
  }
  const d = path(inp.T), setup = m.setup(inp, p), pUp = probAbove(d, inp.strike);
  cur = { d, inp, pUp };
  drawCurve();
  renderSteps(m, p, inp, d, setup, pUp);
  renderVs(V, inp, d, setup.sigma, pUp);
  renderEdge(V, pUp);
}

// 1–4: from the distance to the strike to the probability
function renderSteps(m, p, inp, d, { sigma, drift }, pUp) {
  const inWin = inp.observed !== null;
  const base = inWin ? (inp.observed * (60 - inp.T) + inp.price * inp.T) / 60 : inp.price, gap = base - inp.strike;
  const shift = d.mean - base, z = (d.mean - inp.strike) / d.sd;
  const volSrc = !S.vols ? 'rough, from the last minute — candles still loading'
    : m.id === 'rw' ? `last ${p.win >= 60 ? p.win / 60 + ' h' : p.win + ' min'} of 1-minute moves`
    : m.id === 'ewma' ? `1-minute moves, weight halving every ${EWMA_HALF_LIFE} min` : 'last hour of 1-minute moves';
  const leaning = Math.abs(z) < 0.15 ? 'a coin flip' : Math.abs(z) < 1 ? 'within one typical move: still open'
    : Math.abs(z) < 2 ? 'more than one typical move: leaning' : 'far beyond a typical move: nearly decided';
  const rows = [
    ['Distance to the strike', `<span class="${gap >= 0 ? 'up-t' : 'down-t'}">${gap >= 0 ? '▲' : '▼'} ${fmtP(Math.abs(gap))}</span>`,
      inWin ? `Settlement average so far ${fmtP(inp.observed)} over ${Math.round(60 - inp.T)}s of 60; the rest counted at today’s ${fmtP(inp.price)}, against the strike ${fmtP(inp.strike)}`
            : `BTC ${fmtP(inp.price)} (median of exchanges) against the strike ${fmtP(inp.strike)} (60s average before the start)`],
    ['Typical move until the end', `±${fmtUsd0(d.sd)}`,
      `${fmtDur(inp.T)} left · volatility ${sigma.toFixed(2)} $/√s (${volSrc}${p.f && p.f !== 1 ? `, ×${p.f.toFixed(2)}` : ''}). ` +
      'Moves grow with the square root of time; averaging the last minute damps them.' +
      (drift ? ` Trend: the last minute’s speed adds ${shift >= 0 ? '+' : '−'}${fmtUsd0(Math.abs(shift))}.` : '')],
    ['Typical moves away from the strike', `${Math.abs(z).toFixed(1)}×`, `${fmtUsd0(Math.abs(d.mean - inp.strike))} ÷ ${fmtUsd0(d.sd)} — ${leaning}`],
    ['UP probability', pct(pUp), `The share of the curve right of the strike${d.df ? `, with fat tails (${d.df})` : ''}. DOWN: ${pct(1 - pUp)}.`],
  ];
  $('mdl-steps').innerHTML = rows.map(([l, v, s], i) =>
    `<li class="mstep n${i === 3 ? ' result' : ''}"><span class="ms-l">${l}</span><span class="ms-v">${v}</span><span class="ms-s">${s}</span></li>`).join('');
}

// market vs model on one 0–100% scale, and what the market price implies
function renderVs(V, inp, d, sigma, pUp) {
  $('mdl-vs-venue').textContent = `· ${V.name}`;
  if (V.up === null) { $('mdl-vs').innerHTML = '<div class="vs-text">Waiting for the order book…</div>'; return; }
  const pm = V.up / 100, a = Math.min(pm, pUp), b = Math.max(pm, pUp), diff = (pUp - pm) * 100;
  let why;
  const imp = impliedSigma(pm, d.mean, inp.strike, d.sd / sigma);
  if (Math.abs(pm - 0.5) < 0.012) why = 'The market sits at 50/50.';
  else if (imp === null) why = 'The market favours the other side than the price does. No amount of volatility explains that: it may weigh a trend, ' +
    'the index the round settles on (Chainlink / CF Benchmarks) or news differently.';
  else {
    const r = imp / sigma, move = fmtUsd0(d.sd * r);
    why = r > 1.15 ? `The market prices in about <b>${r.toFixed(1)}×</b> the movement the model expects (±${move} instead of ±${fmtUsd0(d.sd)} by the end): it takes the round as more open.`
        : r < 0.87 ? `The market prices in only about <b>${r.toFixed(1)}×</b> the movement the model expects (±${move} instead of ±${fmtUsd0(d.sd)}): it takes the round as more decided.`
        : 'Market and model expect about the same movement; the gap is small.';
  }
  $('mdl-vs').innerHTML = `
    <div class="vs-scale" role="img" aria-label="Market ${pct(pm)}, model ${pct(pUp)}">
      <div class="vs-track"></div>
      <div class="vs-gap" style="left:${a * 100}%;width:${(b - a) * 100}%"></div>
      <div class="vs-mark ${V === KS ? 'ks' : 'pm'}" style="left:${pm * 100}%" title="Market ${pct(pm)}"></div>
      <div class="vs-mark md" style="left:${pUp * 100}%" title="Model ${pct(pUp)}"></div>
    </div>
    <div class="vs-ticks"><span>0% UP</span><span>50%</span><span>100%</span></div>
    <div class="legend"><span><i class="lk ${V === KS ? 'ks' : 'pm'} thick"></i>Market (mid) ${pct(pm)}</span><span><i class="lk thick"></i>Model ${pct(pUp)}</span></div>
    <div class="vs-text">${Math.abs(diff) < 0.5 ? 'They agree.' : `The model sees UP <b>${Math.abs(diff).toFixed(1)} pts ${diff > 0 ? 'higher' : 'lower'}</b>.`} ${why}</div>`;
}

// the edge of each side: model probability − best ask − fee
function renderEdge(V, pUp) {
  $('mdl-edge-venue').textContent = `· ${V.name}`;
  const e = modelEdges(V, pUp * 100), rate = V === KS ? KS_FEE : PM_FEE;
  if (!e) { $('mdl-edge').innerHTML = '<div class="vs-text">Needs the order book of the running round…</div>'; return; }
  const col = (x, pWin) => x ? [fmtC(pWin), fmtC(x.price), fmtC(takerFee(x.price, rate), 2), `<span class="${x.edge > 0 ? 'pos' : ''}">${signedC(x.edge)}</span>`]
                             : [fmtC(pWin), '—', '—', '—'];
  const up = col(e[0], pUp), down = col(e[1], 1 - pUp);
  const rows = [['Model: chance this side wins', 0], ['Best ask (what one share costs)', 1], [`Taker fee (${rate} × p × (1 − p))`, 2], ['Edge per $1 share', 3]];
  $('mdl-edge').innerHTML = `<table class="edge-t"><thead><tr><th></th><th>UP</th><th>DOWN</th></tr></thead><tbody>` +
    rows.map(([l, i]) => `<tr${i === 3 ? ' class="sum"' : ''}><td>${l}</td><td>${up[i]}</td><td>${down[i]}</td></tr>`).join('') +
    '</tbody></table><div class="vs-text">A share pays $1 if its side wins. Edge = model chance − price − fee: what a share earns on average ' +
    'if the model is right. Below zero, the market wants more than the model thinks the share is worth.</div>';
}

// ── The curve: density of the settlement average, split at the strike ──────
// drawn at the width it is shown at, so its labels keep their size on a phone
let CW = 560;
const CH = 200, CL = 6, CR = 6, CT = 30, CB = 22;
function drawCurve() {
  const { d, inp, pUp } = cur, svg = $('mdl-svg');
  CW = Math.max(280, Math.round($('mdl-curve').clientWidth || 560));
  let lo = Math.min(distQuantile(d, 0.002), inp.strike, inp.price), hi = Math.max(distQuantile(d, 0.998), inp.strike, inp.price);
  const padX = (hi - lo) * 0.04; lo -= padX; hi += padX;
  const PW = CW - CL - CR, base = CH - CB, xOf = v => CL + (v - lo) / (hi - lo) * PW;
  const N = 140, xs = Array.from({ length: N + 1 }, (_, i) => lo + (hi - lo) * i / N), peak = distPdf(d, d.mean);
  const yOf = v => base - distPdf(d, v) / peak * (base - CT);
  const pts = (from, to) => [from, ...xs.filter(x => x > from && x < to), to].map(x => `${xOf(x).toFixed(1)},${yOf(x).toFixed(1)}`).join(' ');
  const area = (from, to, cls) => to > from ? `<polygon class="${cls}" points="${xOf(from).toFixed(1)},${base} ${pts(from, to)} ${xOf(to).toFixed(1)},${base}"/>` : '';
  const k = Math.min(hi, Math.max(lo, inp.strike)), xs_ = xOf(inp.strike), xn = xOf(inp.price);
  let g = area(lo, k, 'mc-down') + area(k, hi, 'mc-up') + `<polyline class="mc-line" points="${pts(lo, hi)}"/>`;
  g += `<line class="mc-axis" x1="${CL}" x2="${CW - CR}" y1="${base + .5}" y2="${base + .5}"/>`;
  const step = niceStep(hi - lo, CW < 420 ? 3 : 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += `<text class="mc-tick" x="${xOf(v).toFixed(1)}" y="${CH - 6}" text-anchor="middle">${fmtUsd0(v)}</text>`;
  // strike (dashed) and BTC now (solid), labels at the top, pushed apart when close
  g += `<line class="mc-strike" x1="${xs_}" x2="${xs_}" y1="${CT - 14}" y2="${base}"/><line class="mc-now" x1="${xn}" x2="${xn}" y1="${CT - 14}" y2="${base}"/>`;
  // the two labels: centred over their line, kept inside the plot and apart from each other
  const labels = [[xs_, `Strike ${fmtP(inp.strike)}`], [xn, `now ${fmtP(inp.price)}`]]
    .map(([x, text]) => { const w = text.length * 6.4; return { text, w, x: Math.max(2, Math.min(CW - w - 2, x - w / 2)) }; })
    .sort((p, q) => p.x - q.x);
  const [l1, l2] = labels;
  if (l1.x + l1.w + 10 > l2.x) { l2.x = l1.x + l1.w + 10; if (l2.x + l2.w > CW - 2) { l2.x = CW - 2 - l2.w; l1.x = Math.max(2, l2.x - 10 - l1.w); } }
  for (const l of labels) g += `<text class="mc-lbl" x="${l.x.toFixed(1)}" y="${CT - 18}">${l.text}</text>`;
  // the two shares, inside their areas when there is room
  for (const [p, q, name] of [[pUp, 1 - pUp / 2, 'UP'], [1 - pUp, (1 - pUp) / 2, 'DOWN']]) {
    if (p < 0.08) continue;
    const x = xOf(distQuantile(d, q)), y = Math.max(CT + 14, (yOf(distQuantile(d, q)) + base) / 2 + 4);
    g += `<text class="mc-big" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${name} ${pct(p)}</text>`;
  }
  if (hoverX !== null) {
    const v = lo + (hoverX - CL) / PW * (hi - lo);
    if (v >= lo && v <= hi) {
      g += `<line class="mc-hair" x1="${hoverX}" x2="${hoverX}" y1="${CT}" y2="${base}"/>`;
      showTip(v, hoverX);
    }
  }
  svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`);
  svg.setAttribute('aria-label', `Settlement average: ${pct(pUp)} of outcomes above the strike ${fmtP(inp.strike)}`);
  svg.innerHTML = g;
}

let hoverX = null;
function showTip(v, x) {
  const tip = $('mdl-tip'), above = 1 - distCdf(cur.d, v);
  tip.innerHTML = `<div class="tip-time">Settlement average…</div><div class="tip-row"><span class="tip-name">above ${fmtP(v)}</span><b>${pct(above)}</b></div>` +
    `<div class="tip-row"><span class="tip-name">below</span><b>${pct(1 - above)}</b></div>`;
  tip.hidden = false;
  const box = $('mdl-curve').getBoundingClientRect(), px = x / CW * box.width, w = tip.offsetWidth;
  tip.style.left = Math.max(0, px + 14 + w > box.width ? px - 14 - w : px + 14) + 'px';
}
function attachCurveHover() {
  const el = $('mdl-svg'), wrap = $('mdl-curve');
  const move = e => {
    const r = el.getBoundingClientRect();
    hoverX = Math.max(CL, Math.min(CW - CR, (e.clientX - r.left) / r.width * CW));
    if (cur) drawCurve();
  };
  const leave = () => { hoverX = null; $('mdl-tip').hidden = true; if (cur) drawCurve(); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointerleave', leave);
  wrap.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') setTimeout(leave, 2500); });
}
