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

// volatility in log-return per √second from 1-minute closes (oldest first); null with fewer than 20 returns
export function volFromCloses(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 20) return null;
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

// P(X >= level) and P(|X − level| <= band) for X ~ N(d.mean, d.sd²)
export const probAbove = (d, level) => normalCDF((d.mean - level) / d.sd);
export function probWithin(d, level, band) {
  const z = (d.mean - level) / d.sd, w = band / d.sd;
  return Math.max(0, normalCDF(w - z) - normalCDF(-w - z));
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

// DOWN book = UP book mirrored: buying DOWN at p is selling UP at 100¢ − p (the CLOB shows both tokens this way)
export const mirrorBook = book => { const m = {}; for (const k in book) m[1000 - k] = book[k]; return m; };
