// Chainlink BTC/USD on Polygon over JSON-RPC eth_call: price for the sources table and the strike fallback.

import { S } from './state.js';

// ── Chainlink (Polygon): price for the sources table + on-chain strike fallback ──
// Two read-only calls to the aggregator contract as plain JSON-RPC eth_call, no library needed.
// (polygon-rpc.com now wants an API key; 1rpc.io answers these calls with zeros.)
const CL_RPCS    = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'];
const FEED_ADDR  = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const SEL_LATEST = '0xfeaf968c';   // latestRoundData()
const SEL_ROUND  = '0x9a6fc8f5';   // getRoundData(uint80)
let clRpc = 0;                     // the RPC that answered last is asked first

// both calls return (roundId uint80, answer int256, startedAt, updatedAt, answeredInRound): five 32-byte words
export function decodeRound(hex) {
  const word = i => BigInt('0x' + hex.slice(2 + i * 64, 66 + i * 64));
  let answer = word(1);
  if (answer >= 1n << 255n) answer -= 1n << 256n;
  return { id: word(0), price: Number(answer) / 1e8, ts: Number(word(3)) };
}

async function clCall(data) {
  let err;
  for (let k = 0; k < CL_RPCS.length; k++) {
    const i = (clRpc + k) % CL_RPCS.length;
    try {
      const r = await fetch(CL_RPCS[i], {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: FEED_ADDR, data }, 'latest'] }),
      });
      const j = await r.json();
      if (!r.ok || !/^0x[0-9a-f]{320}$/i.test(j.result || '')) throw new Error(j.error?.message || `HTTP ${r.status}`);
      clRpc = i;
      return decodeRound(j.result);
    } catch (e) { err = e; }
  }
  throw err;
}

const clLatest = () => clCall(SEL_LATEST);
const clRound  = id => clCall(SEL_ROUND + id.toString(16).padStart(64, '0'));

export async function pollChainlink() {
  try {
    const d = await clLatest();
    if (d.price > 0) { S.clPrice = d.price; S.clState = 'live'; }
  } catch (e) {
    S.clState = 'wait';
    console.warn('CL poll:', e.message);
  }
  setTimeout(pollChainlink, 12000);
}

// on-chain Chainlink round in force at the round start (fallback strike + cross-check)
export async function fetchStrike(wts) {
  const done = v => { if (S.strikeRound === wts * 1000) S.clStrike = v; };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const latest = await clLatest();
      if (latest.ts > 0 && latest.ts <= wts) return done(latest.price);
      // round ids are (phase << 64) | n: step back through the phase to the round in force at the start
      const phase = latest.id >> 64n, n = latest.id & 0xFFFFFFFFFFFFFFFFn;
      for (let i = 1n; i <= 80n && i < n; i++) {
        const r = await clRound((phase << 64n) | (n - i));
        if (r.ts > 0 && r.ts <= wts) return done(r.price);
      }
      return;
    } catch (e) {
      console.warn('fetchStrike attempt', attempt, ':', e.message);
    }
  }
}
