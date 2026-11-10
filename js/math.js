// Pure functions: no DOM, no state. Shared with the recorder Worker (recorder/) and covered by test/math.test.js.

// first index with arr[i].t >= t (arrays are time-ordered)
export function firstIdx(arr, t) {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >>> 1; arr[m].t < t ? (a = m + 1) : (b = m); }
  return a;
}

// time-weighted average of a step series over [a, b]; tolerates up to 10s missing at the start
export function twap(arr, a, b) {
  let i = firstIdx(arr, a) - 1;
  if (i < 0) {
    if (!arr.length || arr[0].t > a + 10_000) return null;
    i = 0; a = arr[0].t;
  }
  if (a >= b) return null;
  let sum = 0, t = a, p = arr[i].p;
  for (let j = i + 1; j < arr.length && arr[j].t < b; j++) { sum += p * (arr[j].t - t); t = arr[j].t; p = arr[j].p; }
  sum += p * (b - t);
  return sum / (b - a);
}

// Abramowitz & Stegun normal CDF approximation
export function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = 1 - (Math.exp(-0.5*z*z)/2.5066282746) *
    t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  return z >= 0 ? p : 1 - p;
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// volatility in log-return per √second from 1-minute closes (oldest first); null with fewer than `min` returns
export function volFromCloses(closes, min = 20) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < Math.max(2, min)) return null;
  const mean = r.reduce((a, v) => a + v, 0) / r.length;
  const sd1m = Math.sqrt(r.reduce((a, v) => a + (v - mean) ** 2, 0) / (r.length - 1));
  return sd1m / Math.sqrt(60);
}

// Where the settlement average (mean price over the round's last 60s) lands, with the price as Brownian motion
// without drift; σ in $ per √s, T = seconds to the end, `observed` = average of the part of the window already seen.
//   T >= 60s:  N(price, σ²·(T − 40))           (40 = 60 − 60/3: averaging over the last minute removes a third)
//   T <  60s:  N(observed·e + price·(1 − e), σ²·T³ / (3·60²)),  e = share of the window already observed
export function settlementDist(price, sigma, T, observed = null) {
  let mean = price, sd;
  if (T >= 60) sd = sigma * Math.sqrt(T - 40);
  else {
    const e = (60 - T) / 60;
    if (observed !== null) mean = observed * e + price * (1 - e);
    sd = sigma * Math.sqrt(T ** 3 / 3) / 60;
  }
  return { mean, sd: Math.max(sd, 1e-6) };
}

// volatility with more weight on recent minutes: exponentially weighted mean of squared 1-minute log returns,
// weights halving every `halfLife` minutes; per √second. null with fewer than 10 returns
export function ewmaVol(closes, halfLife) {
  if (closes.length < 11) return null;
  const lam = Math.pow(0.5, 1 / halfLife);
  let w = 1, sw = 0, sv = 0;
  for (let i = closes.length - 1; i >= 1; i--) { const r = Math.log(closes[i] / closes[i - 1]); sv += w * r * r; sw += w; w *= lam; }
  return Math.sqrt(sv / sw) / Math.sqrt(60);
}

// The model's forecast path: what decides the round, seen from now, t seconds ahead. Times are seconds from now;
// `ws` = when the settlement window opens (negative once it has), `observed` = average of the window seen so far.
//   before the window (t <= ws): the price,                 N(price, σ²·t)
//   inside it: the running average of the window, [ws, t]:  mean (observed·o + price·L) / (t − ws),
//              Var = σ²·(a·L² + L³/3) / (t − ws)²,  a = max(ws, 0), L = t − a, o = a − ws (seconds already observed)
// At t = end this is settlementDist; at t = ws both pieces meet.
// `drift` ($/s) adds a trend that fades out: it moves the price by drift·τ·(1 − e^(−t/τ)), at most drift·τ.
export function forecastAt(price, sigma, t, ws, observed = null, drift = 0, tau = 60) {
  const g = s => tau * (1 - Math.exp(-s / tau)), G = s => tau * s - tau * tau * (1 - Math.exp(-s / tau));
  if (t <= ws) return { mean: price + drift * g(Math.max(0, t)), sd: sigma * Math.sqrt(Math.max(0, t)) };
  const a = Math.max(ws, 0), L = t - a, span = t - ws, o = a - ws;
  return { mean: ((observed ?? price) * o + price * L + drift * (G(t) - G(a))) / span,
           sd: sigma * Math.sqrt(a * L * L + L ** 3 / 3) / span };
}

// ── Distributions: { mean, sd, df } is the normal when df is missing, else a Student-t with df degrees of freedom
// scaled to the same sd (heavier tails, same spread). Needs df > 2.
function lgamma(x) {   // Lanczos approximation
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
             12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(x, a, b) {   // continued fraction of the incomplete beta function (Numerical Recipes)
  const tiny = 1e-300, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    for (const aa of [m * (b - m) * x / ((qam + m2) * (a + m2)), -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))]) {
      d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d; h *= d * c;
    }
    if (Math.abs(d * c - 1) < 3e-12) break;
  }
  return h;
}
function betainc(x, a, b) {   // regularized incomplete beta I_x(a, b)
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(x, a, b) / a : 1 - bt * betacf(1 - x, b, a) / b;
}
export function tCdf(x, df) {
  const p = 0.5 * betainc(df / (df + x * x), df / 2, 0.5);
  return x >= 0 ? 1 - p : p;
}
export const tPdf = (x, df) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - (df + 1) / 2 * Math.log(1 + x * x / df));

// standard quantile (normal, or unit Student-t), by bisection; memoised: the charts ask for the same few every frame
const qMemo = new Map();
export function stdQuantile(p, df) {
  const key = p + '|' + (df || 0);
  if (qMemo.has(key)) return qMemo.get(key);
  const cdf = df ? x => tCdf(x, df) : normalCDF;
  let lo = -60, hi = 60;
  for (let i = 0; i < 90; i++) { const m = (lo + hi) / 2; if (cdf(m) < p) lo = m; else hi = m; }
  if (qMemo.size > 500) qMemo.clear();
  qMemo.set(key, (lo + hi) / 2);
  return (lo + hi) / 2;
}
const tScale = df => Math.sqrt((df - 2) / df);   // unit Student-t → sd 1
export function distCdf(d, x) {
  const z = (x - d.mean) / d.sd;
  return d.df ? tCdf(z / tScale(d.df), d.df) : normalCDF(z);
}
export function distPdf(d, x) {
  const z = (x - d.mean) / d.sd;
  if (!d.df) return Math.exp(-0.5 * z * z) / (d.sd * 2.5066282746);
  const s = tScale(d.df);
  return tPdf(z / s, d.df) / (d.sd * s);
}
export const distQuantile = (d, p) => d.mean + d.sd * (d.df ? tScale(d.df) : 1) * stdQuantile(p, d.df);

// P(X >= level) and P(|X − level| <= band)
export const probAbove = (d, level) => 1 - distCdf(d, level);
export const probWithin = (d, level, band) => Math.max(0, distCdf(d, level + band) - distCdf(d, level - band));

// The volatility a market price implies under the standard model: the σ ($/√s) for which N(mean, (σ·k)²) puts the
// market's probability above the strike (k = the sd per unit σ, e.g. forecastAt with σ = 1). null when the market
// favours the other side than the price does — no volatility explains that — or sits too close to 50/50.
export function impliedSigma(pMarket, mean, strike, k) {
  const z = stdQuantile(Math.min(0.999, Math.max(0.001, pMarket))), gap = mean - strike;
  if (Math.abs(z) < 0.03 || gap === 0 || Math.sign(z) !== Math.sign(gap) || !(k > 0)) return null;
  return gap / (k * z);
}

// taker fee per share at price p (0..1) on both venues: rate × p × (1 − p)
export const takerFee = (p, rate) => rate * p * (1 - p);
// expected gain per $1 share of buying at `price` when the side wins with probability `pWin`, after the fee
export const buyEdge = (price, pWin, rate) => pWin - price - takerFee(price, rate);

export function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

// one book side as [price 0..1, size], best level first; `mirror` turns UP prices into DOWN / NO prices
export function bookLevels(book, desc, mirror) {
  return Object.keys(book).map(Number).sort((a, b) => desc ? b - a : a - b)
    .map(k => [(mirror ? 1000 - k : k) / 1000, book[k]]);
}

// buy one share on each venue at the asks; walk both books while a pair still costs under $1 after fees
export function walkPair(A, feeA, B, feeB) {
  let i = 0, j = 0, qa = A[0]?.[1] ?? 0, qb = B[0]?.[1] ?? 0, pairs = 0, profit = 0, top = null;
  while (i < A.length && j < B.length) {
    const pa = A[i][0], pb = B[j][0], fees = takerFee(pa, feeA) + takerFee(pb, feeB), edge = 1 - pa - pb - fees;
    if (!top) top = { pa, pb, fees, edge };
    if (edge <= 0) break;
    const q = Math.min(qa, qb);
    pairs += q; profit += q * edge; qa -= q; qb -= q;
    if (qa <= 1e-9) { i++; qa = A[i]?.[1] ?? 0; }
    if (qb <= 1e-9) { j++; qb = B[j]?.[1] ?? 0; }
  }
  return top && { ...top, pairs, profit };
}

// buy `n` shares from ask levels [price, size] (best first), level by level, with the taker fee on each;
// fewer shares when the book runs out. null when there is nothing to buy. `worst` = the last level's price.
export function fillOrder(levels, n, rate) {
  let left = n, cost = 0, fees = 0, got = 0, worst = null;
  for (const [p, sz] of levels) {
    if (left <= 0) break;
    const q = Math.min(left, sz);
    cost += q * p; fees += q * takerFee(p, rate); got += q; left -= q; worst = p;
  }
  return got > 0 ? { qty: got, avg: cost / got, fees, total: cost + fees, worst } : null;
}

// sell `n` shares into bid levels [price, size] (best first): the same walk, the fee comes off the proceeds
export function sellOrder(levels, n, rate) {
  const f = fillOrder(levels, n, rate);
  return f && { qty: f.qty, avg: f.avg, fees: f.fees, net: f.qty * f.avg - f.fees, worst: f.worst };
}

// A paper limit order to buy up to `n` shares at `limit` or less, against ask levels [price, size] (best first).
// `taker`: the order arrives and crosses the book: each level at its own price, with the taker fee. Afterwards it
// rests, and a seller who comes down to the limit fills it there as a maker: the limit price, no fee (both venues
// charge takers only). A paper fill leaves the book as it was, so `used` (level in 0.1¢ → shares) keeps what the
// order already took at each level: those shares must not fill it twice. A level that shrank or vanished is
// forgotten that far, size added later is new. Mutates `used`; shares in steps of 0.01.
// → { qty, cost, fees } of this fill, or null
export function matchLimit(levels, limit, n, used, taker, rate) {
  const seen = new Set();
  let left = n, qty = 0, cost = 0, fees = 0;
  for (const [p, sz] of levels) {
    if (p > limit + 1e-9 || left < 0.005) break;
    const k = String(Math.round(p * 1000)), u = Math.min(used[k] ?? 0, sz);
    const take = Math.max(0, Math.floor(Math.min(sz - u, left) * 100 + 1e-6) / 100);
    seen.add(k);
    used[k] = u + take;
    if (!take) continue;
    qty += take; cost += take * (taker ? p : limit); left -= take;
    if (taker) fees += take * takerFee(p, rate);
  }
  for (const k of Object.keys(used)) if (!seen.has(k)) delete used[k];
  return qty > 0 ? { qty: Math.round(qty * 100) / 100, cost, fees } : null;
}

// DOWN book = UP book mirrored: buying DOWN at p is selling UP at 100¢ − p (the CLOB shows both tokens this way)
export const mirrorBook = book => { const m = {}; for (const k in book) m[1000 - k] = book[k]; return m; };
