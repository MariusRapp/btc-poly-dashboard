// The model catalog. Each model turns the live inputs into the distribution of the settlement average — and of the
// path to it, for the forecast cone. All share one skeleton (the price as a random walk, averaged over the last
// 60s); they differ in how much it moves, whether a trend continues, and how often big jumps happen.
// Pure: the dashboard picks one (S.modelId, S.modelParams); recorded rounds can re-score any of them.
import { ewmaVol, forecastAt, probAbove, volFromCloses } from './math.js';
import { backtest, summary } from './stats.js';

// Inputs: { price, strike, T (s to the end), ws (s until the settlement window opens, T − 60),
//           observed (average of the window so far, or null), vol(kind) → volatility per √s as a log return for
//           'h15' | 'h60' | 'h240' | 'ewma' (null when unknown), velocity ($/s over the last 60s, or null),
//           fallback (σ in $/√s when no candles have loaded yet, or null) }
const sigmaOf = (inp, kind, f) => {
  const v = inp.vol(kind);
  return (v != null ? v * inp.price : inp.fallback) * f;
};
const pct = v => Math.round(v * 100) + '%';
const FACTOR = { key: 'f', label: 'Volatility ×', type: 'range', min: 0.5, max: 2, step: 0.05, def: 1, fmt: v => v.toFixed(2) + '×',
                 help: 'Scales the expected movement: above 1 the model expects bigger moves, so its probabilities stay closer to 50%.' };
export const EWMA_HALF_LIFE = 10;   // minutes
export const MOMENTUM_CAP = 2;      // $/s: a trend the model takes on at most

// ── Adding a model ───────────────────────────────────────────────────────────
// Add an object to MODELS; the Model card lists it, scores it on recorded rounds and builds its settings:
//
//   {
//     id: 'mine', name: 'My model',                         // id: short, unique, kept in the browser's settings
//     tagline: 'One sentence: what it assumes, in plain words.',
//     assumes: ['no trend', 'bell curve', '…'],             // short tags on its card
//     params: [                                             // its settings (may be empty)
//       { key: 'k', label: 'Shown name', type: 'range', min: 0, max: 1, step: 0.05, def: 0.5, fmt: v => v.toFixed(2), help: '…' },
//       { key: 'c', label: 'Shown name', type: 'choice', options: [[15, '15 min'], [60, '1 h']], def: 60 },
//     ],
//     // σ in $ per √s for the price path, a drift in $/s (a trend fading out within about a minute; 0 for none),
//     // and df for Student-t tails (leave out for the bell curve). sigmaOf(inp, 'h15' | 'h60' | 'h240' | 'ewma', factor)
//     // gives the volatility the recorder also stores, so the model can be scored.
//     setup: (inp, p) => ({ sigma: sigmaOf(inp, 'h60', 1), drift: 0 }),
//     needs: p => ['h60'],                                  // recorded inputs it needs to be scored: h15 h60 h240 ewma vel
//   }
//
// A model that is not a random walk at all (e.g. one trained on the recorder's rounds) can still use this shape:
// its probability goes in through a fitted mean and spread, or a small extension gives the card and the scoring
// a `prob(inp, p)` hook.

export const MODELS = [
  {
    id: 'rw', name: 'Standard',
    tagline: 'No direction: from here BTC is as likely to go up as down. How far it typically moves comes from the recent 1-minute moves.',
    assumes: ['no trend', 'bell curve', 'volatility of the last hour'],
    params: [
      { key: 'win', label: 'Volatility from the last', type: 'choice', options: [[15, '15 min'], [60, '1 h'], [240, '4 h']], def: 60,
        help: 'Short: reacts fast to calm or hectic phases, but is noisy. Long: steady, but slow to notice a change.' },
      FACTOR,
    ],
    setup: (inp, p) => ({ sigma: sigmaOf(inp, 'h' + p.win, p.f), drift: 0 }),
    needs: p => ['h' + p.win],
  },
  {
    id: 'ewma', name: 'Fast volatility',
    tagline: `Like Standard, but the latest minutes count most (weight halves every ${EWMA_HALF_LIFE} min): it notices quickly when the market gets calm or hectic.`,
    assumes: ['no trend', 'bell curve', 'recent minutes weigh most'],
    params: [FACTOR],
    setup: (inp, p) => ({ sigma: sigmaOf(inp, 'ewma', p.f), drift: 0 }),
    needs: () => ['ewma'],
  },
  {
    id: 'mom', name: 'Momentum',
    tagline: 'Like Standard, but part of the last minute’s trend carries on and fades out within about a minute.',
    assumes: ['short trends carry on', 'bell curve', 'volatility of the last hour'],
    params: [
      { key: 'w', label: 'Trend that carries on', type: 'range', min: 0, max: 1, step: 0.05, def: 0.3, fmt: pct,
        help: 'Share of the last minute’s speed the model expects to continue. 0% is the Standard model.' },
      FACTOR,
    ],
    setup: (inp, p) => ({ sigma: sigmaOf(inp, 'h60', p.f), drift: Math.max(-MOMENTUM_CAP, Math.min(MOMENTUM_CAP, p.w * (inp.velocity ?? 0))) }),
    needs: () => ['h60', 'vel'],
  },
  {
    id: 'fat', name: 'Fat tails',
    tagline: 'Same typical movement as Standard, but big jumps happen more often than a bell curve allows (Student-t).',
    assumes: ['no trend', 'big jumps more often', 'volatility of the last hour'],
    params: [
      { key: 'df', label: 'Tails', type: 'range', min: 3, max: 30, step: 1, def: 4, fmt: v => v <= 5 ? `fat (${v})` : v >= 20 ? `like a bell (${v})` : `medium (${v})`,
        help: 'Lower: big jumps more likely, and close rounds look more decided. 30 is almost the bell curve.' },
      FACTOR,
    ],
    setup: (inp, p) => ({ sigma: sigmaOf(inp, 'h60', p.f), drift: 0, df: p.df }),
    needs: () => ['h60'],
  },
];

export const modelById = id => MODELS.find(m => m.id === id) ?? MODELS[0];
export const defaultParams = m => Object.fromEntries(m.params.map(p => [p.key, p.def]));

// saved settings, checked against the model's parameters (unknown keys and out-of-range values fall back)
export function paramsOf(m, saved = {}) {
  const out = defaultParams(m);
  for (const p of m.params) {
    const v = saved?.[p.key];
    if (p.type === 'choice' ? p.options.some(([o]) => o === v) : typeof v === 'number' && v >= p.min && v <= p.max) out[p.key] = v;
  }
  return out;
}

// t (seconds from now) → distribution { mean, sd, df } of what decides the round then; t = T is the settlement average.
// null when the model lacks an input (no volatility yet).
export function modelPath(m, inp, p) {
  const { sigma, drift, df } = m.setup(inp, p);
  if (!(sigma > 0)) return null;
  return t => { const d = forecastAt(inp.price, sigma, t, inp.ws, inp.observed, drift); return { mean: d.mean, sd: Math.max(d.sd, 1e-6), df }; };
}
export const modelDist = (m, inp, p) => modelPath(m, inp, p)?.(inp.T) ?? null;
export const modelSigma = (m, inp, p) => m.setup(inp, p).sigma;

// ── Scoring on recorded rounds (recorder/): each snapshot about 60s before the end, re-computed with this model ──
// The recorder stores the inputs: price, strike, σ of the last hour ($/√s) and, since its second version,
// the 15-minute, 4-hour and fast volatilities and the last minute's speed.
export function recordInputs(r, len) {
  const T = r.start + len - r.snap_t;
  const vols = { h60: r.sigma != null && r.price ? r.sigma / r.price : null, h15: r.vol15 ?? null, h240: r.vol240 ?? null, ewma: r.ewma ?? null };
  return { price: r.price, strike: r.strike, T, ws: T - 60, observed: null, vol: k => vols[k], velocity: r.vel ?? null, fallback: null };
}

// rounds this model can be re-scored on: snapshot, result and every input it needs
function scorable(m, p, recs) {
  const need = m.needs(p), has = { h60: 'sigma', h15: 'vol15', h240: 'vol240', ewma: 'ewma', vel: 'vel' };
  return recs.filter(r => r.snap_t != null && r.price != null && r.strike != null && (r.result === 'up' || r.result === 'down') &&
    need.every(k => r[has[k]] != null));
}

// Brier score, favourite hit rate and backtest of this model on the recorded rounds; null without any
export function scoreModel(m, p, recs, len, fee, minEdge) {
  const rows = scorable(m, p, recs).map(r => {
    const d = modelDist(m, recordInputs(r, len), p);
    return d && { ...r, model: probAbove(d, r.strike) };
  }).filter(Boolean);
  const s = summary(rows);
  return s.n ? { ...s, bt: backtest(rows, minEdge, fee) } : null;
}

// the live volatilities from 1-minute closes (oldest first) — the same the recorder stores per snapshot
export function volsFromCloses(closes) {
  return {
    h15: volFromCloses(closes.slice(-16), 10), h60: volFromCloses(closes.slice(-61)), h240: volFromCloses(closes.slice(-241)),
    ewma: ewmaVol(closes.slice(-241), EWMA_HALF_LIFE),
  };
}
