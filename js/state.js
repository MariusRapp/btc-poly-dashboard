// Shared state and settings. `S` holds the values that several modules assign (an imported binding cannot be
// assigned); constants, chart/market options remembered per browser and the list of exchanges live here too.
import { assetById } from './assets.js';

export const S = {};   // shared state that several modules assign


// ── State ────────────────────────────────────────────────────────────────────
export const TWAP_MS  = 60_000;    // strike and settlement are 60s averages (Chainlink TWAP stream / CF Benchmarks BRTI)
export const STALE_MS = 120_000;   // an exchange without trades for this long drops out of the median
export const MAX_BUF  = 40_000;    // trades kept per exchange
export const MED_BUF  = 150_000;   // median points kept: a 15-minute round plus the minute before it at busy times

// chart options and the market choice, remembered per browser
const OPTS_KEY = 'btc5m-opts';
const opts = (() => { try { return JSON.parse(localStorage.getItem(OPTS_KEY)) || {}; } catch { return {}; } })();

// which venue(s): 'poly', 'kalshi' or 'both'. Kalshi only lists 15-minute rounds, so Kalshi and both run on 15m;
// Polymarket alone runs on 5m or 15m.
S.venueMode = ['poly', 'kalshi', 'both'].includes(opts.venue) ? opts.venue : 'poly';
// which coin (assets.js); ?asset=eth picks one and is remembered like the other choices
S.asset = assetById((() => { try { return new URLSearchParams(location.search).get('asset'); } catch { return null; } })() || opts.asset).id;
S.A = assetById(S.asset);   // its symbols and decimals
S.assetGen = 0;             // bumped on every coin switch; price loads started before it are dropped
S.polyLenMin = opts.len === 15 ? 15 : 5;
export let ROUND_MS = 300_000, ROUND_S = 300;
export function applyRoundLen() {
  const min = S.venueMode === 'poly' ? S.polyLenMin : 15;
  ROUND_MS = min * 60_000; ROUND_S = min * 60;
}
applyRoundLen();
S.modeGen = 0;            // bumped on every market switch; async loads started before it are dropped

S.viewMode = 'round';    // 'round' (whole round incl. strike window) or 'rolling'
S.windowMs = 30_000;     // rolling window

// color is filled from the --ex-N tokens by readTheme()
export const EXCH = [
  { key:'coinbase', name:'Coinbase' },
  { key:'kraken',   name:'Kraken' },
  { key:'bitstamp', name:'Bitstamp' },
  { key:'gemini',   name:'Gemini' },
  { key:'bitfinex', name:'Bitfinex', note:'USDT→USD' },
  { key:'binance',  name:'Binance', note:'USDT→USD' },
].map(e => ({ ...e, color:'', trades:[], lastP:null, lastTT:0, enabled:true, ws:null, lastMsgT:0 }));
export const EX = Object.fromEntries(EXCH.map(e => [e.key, e]));

S.showExchanges = !!opts.ex;
S.usdtUsd = 1;            // converts Binance and Bitfinex USDT prices to USD (live from Coinbase USDT-USD)

S.lastMedianP = null;
S.tpsCount = 0;
S.tps = 0;
S.tpsTick = Date.now();
export const medianHistory = [];   // {t, p} — t is trade time, kept monotonic

S.strike = null;
S.strikeSrc = null;
S.strikeRound = null;
S.clStrike = null;
S.bookView = 'now';       // order book card: 'now' or 'next'

S.showBands = !!opts.bands;   // the two 60s averaging windows (off by default)
S.showFc = !!opts.fc;         // the model forecast cone and settlement distribution (off by default)
S.showGap = opts.gap !== false;   // both venues: shade the gap between the two probabilities
S.bookSide = opts.side === 'down' ? 'down' : 'up';   // order book card: UP shares, or DOWN (the UP book mirrored)
S.bookVenue = opts.bv === 'kalshi' ? 'kalshi' : 'poly';   // order book card with both venues on
export const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify({
  ex: S.showExchanges, bands: S.showBands, fc: S.showFc, model: S.modelId, mp: S.modelParams, gap: S.showGap, side: S.bookSide, bv: S.bookVenue, venue: S.venueMode, len: S.polyLenMin, asset: S.asset })); } catch {} };

// past round shown in the charts (null = live)
export const ROUNDS_SHOWN = 24;
S.review = null;

S.clPrice = null;
S.clState = 'wait';
S.closes1m = [];         // 1-minute closes of the last hours, oldest first (model.js)
S.vols = null;           // volatilities from them (models.js volsFromCloses)
S.modelId = typeof opts.model === 'string' ? opts.model : 'rw';   // the model in use (models.js)
S.modelParams = opts.mp && typeof opts.mp === 'object' ? opts.mp : {};   // its settings, per model

export const buyPressureSnaps = [];  // {t, pct}

// crosshair: fraction of the plot width under the pointer, shared by both charts
S.hoverFrac = null;
S.hoverSrc = null;
S.touchClearTimer = null;
