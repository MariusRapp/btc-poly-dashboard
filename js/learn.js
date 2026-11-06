// Learning from the recorded rounds: logistic regression (Newton's method), cross-validation in time-ordered
// folds, and the stacking test "does the model add anything the market price does not already say?".
// Pure: no DOM, no state; covered by test/learn.test.js.
import { normalCDF } from './math.js';
import { logLoss } from './stats.js';

export const sigmoid = x => 1 / (1 + Math.exp(-x));
export const logit = (p, clip = 0.01) => { const q = Math.min(1 - clip, Math.max(clip, p)); return Math.log(q / (1 - q)); };

// solve A·x = b (Gaussian elimination, partial pivoting); A is small (a few features)
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const inverse = A => { const n = A.length, cols = []; for (let j = 0; j < n; j++) { const e = Array(n).fill(0); e[j] = 1; const c = solve(A, e); if (!c) return null; cols.push(c); } return A.map((_, i) => cols.map(c => c[i])); };

// P(y = 1) = σ(w·x); x[0] = 1 is the intercept. A small ridge penalty (not on the intercept) keeps the fit finite
// when the data separate perfectly. Returns weights, their standard errors, the log-likelihood and n; null when
// the rows can't be fitted.
export function fitLogistic(X, y, { ridge = 1e-3, iters = 40 } = {}) {
  const n = X.length, k = X[0]?.length ?? 0;
  if (n < k + 2) return null;
  let w = Array(k).fill(0), H;
  for (let it = 0; it < iters; it++) {
    const g = w.map((v, j) => j ? -ridge * v : 0);
    H = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => a === b && a ? ridge : 0));
    for (let i = 0; i < n; i++) {
      const x = X[i], p = sigmoid(x.reduce((s, v, j) => s + v * w[j], 0)), r = y[i] - p, q = p * (1 - p);
      for (let a = 0; a < k; a++) { g[a] += r * x[a]; for (let b = 0; b < k; b++) H[a][b] += q * x[a] * x[b]; }
    }
    const step = solve(H, g);
    if (!step) return null;
    w = w.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  const cov = inverse(H);
  if (!cov) return null;
  let ll = 0;
  for (let i = 0; i < n; i++) { const p = sigmoid(X[i].reduce((s, v, j) => s + v * w[j], 0)); ll += y[i] ? Math.log(Math.max(p, 1e-15)) : Math.log(Math.max(1 - p, 1e-15)); }
  return { w, se: cov.map((r, i) => Math.sqrt(Math.max(0, r[i]))), ll, n };
}
export const predict = (fit, x) => sigmoid(x.reduce((s, v, j) => s + v * fit.w[j], 0));

// Out-of-sample predictions: rows (oldest first) in `k` consecutive blocks; each block predicted by a fit on the
// others. null where a fold could not be fitted.
export function crossPredict(X, y, k = 5) {
  const n = X.length, out = Array(n).fill(null);
  for (let f = 0; f < k; f++) {
    const a = Math.floor(n * f / k), b = Math.floor(n * (f + 1) / k);
    const tx = [...X.slice(0, a), ...X.slice(b)], ty = [...y.slice(0, a), ...y.slice(b)];
    const fit = fitLogistic(tx, ty);
    if (fit) for (let i = a; i < b; i++) out[i] = predict(fit, X[i]);
  }
  return out;
}

// P(χ² with 1 degree of freedom > x)
export const chi2p1 = x => x > 0 ? 2 * (1 - normalCDF(Math.sqrt(x))) : 1;

// Stacking test on scored rounds [{ mkt, model, up }] (probabilities 0..1): outcome ~ market alone, and
// ~ market + model, both in log-odds (clipped at 1% / 99%). If the model knew nothing the market doesn't, its weight
// would be 0. Also both fits out of sample (5 time-ordered folds), as log loss.
export function stacking(rows) {
  const ok = rows.filter(r => r.mkt != null && r.model != null);
  if (ok.length < 30) return null;
  const y = ok.map(r => r.up ? 1 : 0);
  const Xm = ok.map(r => [1, logit(r.mkt)]), Xf = ok.map(r => [1, logit(r.mkt), logit(r.model)]);
  const fm = fitLogistic(Xm, y), ff = fitLogistic(Xf, y);
  if (!fm || !ff) return null;
  const lr = Math.max(0, 2 * (ff.ll - fm.ll));
  const cv = X => { const p = crossPredict(X, y); const idx = p.map((v, i) => v === null ? -1 : i).filter(i => i >= 0);
    return idx.length ? idx.reduce((s, i) => s + logLoss(p[i], y[i] === 1), 0) / idx.length : null; };
  return {
    n: ok.length, a: ff.w[0], b: ff.w[1], bSe: ff.se[1], c: ff.w[2], cSe: ff.se[2], z: ff.w[2] / ff.se[2],
    lr, p: chi2p1(lr), bAlone: fm.w[1], cvMkt: cv(Xm), cvFull: cv(Xf),
  };
}
