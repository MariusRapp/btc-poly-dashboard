// Paper bot: trades the running round by itself, without money, by the rules ticked in its card (strategies.js).
// A signal becomes a market order that fills at the live book after the reaction time. The quotes may have moved
// by then: nothing fills above the signal's price + the slippage limit, else the order is missed. Taker fees as
// for the manual paper trades. Rules with exits sell their shares again into the bids (take profit, stop loss,
// time limit, before the end); everything else is held and settled with the official result (paper.js), in a
// list of its own. The bot runs only while this page is open and only trades the coin and market(s) in view;
// every order, fill, miss and sale goes to its activity list.
import { arbState } from './arb.js';
import { lagState } from './lag.js';
import { computeModelProb } from './model.js';
import { EXIT_TEXT, esc, exportCsv, feeOf, liveFeed, liveVenue, makeLedger, newTrade, pnlOf, quoteBuy, quoteSell, renderList, saveLedger, summaryTiles, usd } from './paper.js';
import { EXIT_KEYS, STRATEGIES, exitWhy, ruleById, ruleParams } from './strategies.js';
import { ROUND_S, S } from './state.js';
import { $, currentRound, fmtC, fmtClock } from './util.js';
import { KS, PM, activeVenues, both } from './venues.js';

// ── Settings, remembered in this browser ─────────────────────────────────────
const CFG_KEY = 'paperbot-cfg', DEFAULT_ON = ['arb', 'edge', 'meanrev'], DELAYS = [0, 0.5, 1, 2, 5], SLIPS = [0, 1, 2, 5];
const clampQty = x => Math.max(1, Math.min(100000, Math.round(+x || 10)));
const cfg = (() => {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch {}
  const rules = {};
  for (const R of STRATEGIES) { const r = c.rules?.[R.id]; rules[R.id] = { on: r ? !!r.on : DEFAULT_ON.includes(R.id), p: ruleParams(R, r?.p) }; }
  return { on: !!c.on, qty: clampQty(c.qty), delay: DELAYS.includes(c.delay) ? c.delay : 1, slip: SLIPS.includes(c.slip) ? c.slip : 2, rules };
})();
const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} };

const B = makeLedger('paperbot-v1', 2000, () => render());
const SHOW = 600;   // rows in the list (the totals count them all)
const venueOf = k => k === 'kalshi' ? KS : PM;
const sideTxt = (side, V) => side.toUpperCase() + (both() ? ' ' + V.short : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── Activity ─────────────────────────────────────────────────────────────────
const logs = [];
let logDirty = true;
function log(text, cls = '') {
  logs.unshift({ t: Date.now(), text, cls });
  if (logs.length > 40) logs.pop();
  logDirty = true;
}

// ── The running round as the rules see it ───────────────────────────────────
// only books that are live: Polymarket's socket open, Kalshi's poll answered within the last 5s
function snapshot(now) {
  const { start, end } = currentRound(now), venues = [];
  for (const V of activeVenues()) {
    const f = liveFeed(V);
    if (!f || f.state !== 'live' || f.mid === null || (V === KS && now - f.lastMsgT > 5000)) continue;
    let bb = 0, ba = 1000;
    for (const k in f.bids) if (+k > bb) bb = +k;
    for (const k in f.asks) if (+k < ba) ba = +k;
    venues.push({ key: V.key, fee: feeOf(V), bid: bb / 1000, ask: ba / 1000, mid: f.mid, spread: (ba - bb) / 1000, hist: V.prob });
  }
  if (!venues.length) return null;
  const live = lagState.live;
  return { now, start, T: (end - now) / 1000, len: ROUND_S, model: computeModelProb(), venues,
           arb: both() && venues.length === 2 ? arbState() : null,
           lag: live && { dModel: live.dModel, venues: live.venues.map(x => ({ key: x.V.key, gap: x.gap, dBook: x.dBook })) } };
}

// ── Orders ───────────────────────────────────────────────────────────────────
const pend = [];          // on their way (reaction time): buys { rule, key, legs, … } and sales { sell: trade id }
const tries = new Map();  // `${rule}|${key}|${round start}` → { n, last }: orders sent this round (filled or missed)

// A rule trades a market (its signal key) at most `n` times a round, default once; one position at a time; and
// it pauses after a trade (its window, at least 10s), so the same jump does not trigger it again.
function blocked(R, p, key, start, now) {
  if (pend.some(o => o.rule === R.id && o.key === key)) return true;
  const tr = tries.get(`${R.id}|${key}|${start}`), oids = new Set();
  let last = tr?.last ?? 0;
  for (let i = B.trades.length - 1; i >= 0 && B.trades[i].t >= start - 300_000; i--) {
    const t = B.trades[i];
    if (t.rule !== R.id || t.key !== key) continue;
    if (t.start * 1000 === start) { oids.add(t.oid); if (t.exit && !t.sold) return true; }
    last = Math.max(last, t.t, t.sold?.t ?? 0);
  }
  if (Math.max(oids.size, tr?.n ?? 0) >= (p.n ?? 1)) return true;
  return now - last < Math.max(10, p.win ?? 0) * 1000;
}

function send(R, p, sig, key, c, now) {
  const qty = Math.max(1, Math.min(cfg.qty, sig.n ?? Infinity)), legs = [];
  for (const l of sig.legs) {
    const V = venueOf(l.venue), q = quoteBuy(V, l.side, qty);
    if (!q) return;
    legs.push({ V, side: l.side, limit: Math.min(0.999, q.worst + cfg.slip / 100) });
  }
  const tk = `${R.id}|${key}|${c.start}`, tr = tries.get(tk) ?? { n: 0, last: 0 };
  tr.n++; tr.last = now; tries.set(tk, tr);
  if (tries.size > 300) for (const k of tries.keys()) if (+k.split('|')[2] < c.start) tries.delete(k);
  const o = { rule: R.id, key, legs, qty, why: sig.why, start: c.start, at: now + cfg.delay * 1000,
              oid: now.toString(36) + Math.random().toString(36).slice(2, 5),
              exit: R.exits ? Object.fromEntries(EXIT_KEYS.map(k => [k, p[k]])) : null };
  log(`${R.name}: ${sig.why} → buy ${legs.map(l => `${qty} ${sideTxt(l.side, l.V)}`).join(' + ')}`, 'ord');
  if (cfg.delay) pend.push(o); else fill(o, now);
}

// the order reaches the book: what is there now, up to the limit
function fill(o, now) {
  const R = ruleById(o.rule), got = [];
  for (const l of o.legs) {
    const f = liveFeed(l.V), same = f && f.wts * 1000 === o.start, q = same ? quoteBuy(l.V, l.side, o.qty, l.limit) : null;
    if (!q) { log(`${R.name}: missed ${sideTxt(l.side, l.V)}, ${same ? `nothing left at ${fmtC(l.limit)} or less` : 'the round is over'}`, 'miss'); continue; }
    got.push([newTrade(l.V, l.side, q, now, { rule: o.rule, key: o.key, oid: o.oid, why: o.why, ...(o.exit && { exit: o.exit }) }), l.V]);
  }
  if (!got.length) return;
  // a pair with a leg missing is a plain bet on one side: unwind it (exits() sells it on the next tick)
  const unwind = got.length < o.legs.length;
  for (const [t] of got) { if (unwind) t.exit = { unwind: 1 }; B.trades.push(t); }
  saveLedger(B);
  render();
  log(`${R.name}: bought ${got.map(([t, V]) => `${t.qty} ${sideTxt(t.side, V)} @ ${fmtC(t.avg)}`).join(' + ')} for $${got.reduce((a, [t]) => a + t.total, 0).toFixed(2)} incl. fees` +
    (unwind ? ' · the other leg missed: selling it again' : ''), 'buy');
}

// open positions of rules with exits: sold when the rule says so (also while the bot is off, until they are flat)
function exits(now) {
  const { start, end } = currentRound(now), T = (end - now) / 1000;
  for (let i = B.trades.length - 1; i >= 0 && B.trades[i].t >= start; i--) {
    const t = B.trades[i];
    if (!t.exit || t.sold || pend.some(o => o.sell === t.id)) continue;
    const V = liveVenue(t), q = V && quoteSell(V, t.side, t.qty);
    if (!q || q.qty < t.qty) continue;
    const why = exitWhy((q.net - t.total) / t.qty, (now - t.t) / 1000, T, t.exit);
    if (!why) continue;
    const o = { sell: t.id, why, at: now + cfg.delay * 1000 };
    if (cfg.delay) pend.push(o); else sell(o, now);
  }
}

function sell(o, now) {
  let t = null;
  for (let i = B.trades.length - 1; i >= 0 && !t; i--) if (B.trades[i].id === o.sell) t = B.trades[i];
  if (!t || t.sold) return;
  const R = ruleById(t.rule), V = liveVenue(t), q = V && quoteSell(V, t.side, t.qty);
  if (!q || q.qty < t.qty) {   // the bids ran out meanwhile: exits() tries again; a round that is over is held to the end
    if (!V) log(`${R.name}: could not sell ${t.qty} ${t.side.toUpperCase()}, the round is over: held to the end`, 'miss');
    return;
  }
  t.sold = { t: now, avg: +q.avg.toFixed(4), fees: +q.fees.toFixed(4), net: +q.net.toFixed(4), why: o.why };
  t.pnl = +(q.net - t.total).toFixed(4);
  saveLedger(B);
  render();
  // a stop that fills at a profit (or a target at a loss): the book moved between the signal and the fill
  const moved = (o.why === 'stop' && t.pnl > 0) || (o.why === 'target' && t.pnl < 0) ? ', the book moved during the reaction time' : '';
  log(`${R.name}: sold ${t.qty} ${sideTxt(t.side, V)} @ ${fmtC(q.avg)} (${EXIT_TEXT[o.why]}${moved}) → ${usd(t.pnl)}`, t.pnl > 0 ? 'won' : 'lost');
}

// every 200ms (main.js): orders due, exits, then the ticked rules' signals
export function botTick(now) {
  for (let i = 0; i < pend.length;) {
    if (now < pend[i].at) { i++; continue; }
    const o = pend.splice(i, 1)[0];
    o.sell ? sell(o, now) : fill(o, now);
  }
  exits(now);
  if (!cfg.on) return;
  const c = snapshot(now);
  if (!c) return;
  for (const R of STRATEGIES) {
    const rc = cfg.rules[R.id];
    if (!rc.on || (R.both && !both())) continue;
    let sigs;
    try { sigs = R.signal(c, rc.p); } catch (e) { console.warn('bot rule', R.id, e); continue; }
    for (const sig of sigs) {
      const key = sig.key ?? sig.legs[0].venue;
      if (!blocked(R, rc.p, key, c.start, now)) send(R, rc.p, sig, key, c, now);
    }
  }
}

// ── Card ─────────────────────────────────────────────────────────────────────
function setOn(on) {
  cfg.on = on;
  saveCfg();
  if (!on) for (let i = pend.length - 1; i >= 0; i--) if (!pend[i].sell) pend.splice(i, 1);   // buys on their way are cancelled
  const names = STRATEGIES.filter(R => cfg.rules[R.id].on).map(R => R.name).join(', ');
  log(on ? `Bot on · ${names || 'no rule ticked'}` : 'Bot off · no new trades', 'sys');
  updateBot();
}

function ruleHtml(R) {
  const rc = cfg.rules[R.id], has = R.params.length > 0;
  return `<div class="rule${rc.on ? '' : ' off'}" data-id="${R.id}">` +
    `<div class="rule-top"><label class="rule-name"><input type="checkbox" data-rule="${R.id}"${rc.on ? ' checked' : ''}>${R.name}</label>` +
    `<span class="rule-stat" id="rs-${R.id}"></span>` +
    (has ? `<button type="button" class="link-btn" data-set="${R.id}" aria-expanded="false" aria-controls="rp-${R.id}">Settings</button>` : '') + '</div>' +
    `<div class="rule-desc">${esc(R.desc)}</div>` +
    (has ? `<div class="rule-set" id="rp-${R.id}" hidden>` + R.params.map(q =>
      `<label class="rparam"><span>${q.label}</span><span class="rp-in"><input type="number" inputmode="decimal" data-rule="${R.id}" data-k="${q.k}" ` +
      `min="${q.min}" max="${q.max}" step="${q.step}" value="${rc.p[q.k]}">${q.unit ? `<span>${q.unit}</span>` : ''}</span>${q.hint ? `<small>${q.hint}</small>` : ''}</label>`).join('') +
      `<div class="rule-set-foot"><button type="button" class="link-btn" data-reset="${R.id}">Defaults</button></div></div>` : '') +
    '</div>';
}

export function initBot() {
  $('bot-rules').innerHTML = STRATEGIES.map(ruleHtml).join('');   // built once: an input keeps its focus while stats update
  $('bot-filter').innerHTML = '<option value="">All rules</option>' + STRATEGIES.map(R => `<option value="${R.id}">${R.name}</option>`).join('');
  $('bot-qty').value = cfg.qty;
  $('bot-delay').value = String(cfg.delay);
  $('bot-slip').value = String(cfg.slip);
  $('bot-on').addEventListener('click', () => setOn(!cfg.on));
  $('bot-qty').addEventListener('change', e => { cfg.qty = clampQty(e.target.value); e.target.value = cfg.qty; saveCfg(); });
  $('bot-delay').addEventListener('change', e => { cfg.delay = +e.target.value; saveCfg(); });
  $('bot-slip').addEventListener('change', e => { cfg.slip = +e.target.value; saveCfg(); });
  $('bot-rules').addEventListener('change', e => {
    const el = e.target, R = ruleById(el.dataset.rule);
    if (!R) return;
    const rc = cfg.rules[R.id];
    if (el.dataset.k === undefined) {
      rc.on = el.checked;
      el.closest('.rule').classList.toggle('off', !rc.on);
      log(`${R.name} ${rc.on ? 'ticked' : 'unticked'}`, 'sys');
    } else {
      const q = R.params.find(x => x.k === el.dataset.k), v = parseFloat(el.value);
      rc.p[q.k] = Number.isFinite(v) ? Math.min(q.max, Math.max(q.min, v)) : q.def;
      el.value = rc.p[q.k];
    }
    saveCfg();
    renderRules();
  });
  $('bot-rules').addEventListener('click', e => {
    const b = e.target.closest('[data-set]'), r = e.target.closest('[data-reset]');
    if (b) {
      const panel = $('rp-' + b.dataset.set);
      panel.hidden = !panel.hidden;
      b.setAttribute('aria-expanded', String(!panel.hidden));
      b.textContent = panel.hidden ? 'Settings' : 'Close';
    }
    if (r) {
      const R = ruleById(r.dataset.reset), rc = cfg.rules[R.id];
      rc.p = ruleParams(R, null);
      for (const el of $('rp-' + R.id).querySelectorAll('input[data-k]')) el.value = rc.p[el.dataset.k];
      saveCfg();
    }
  });
  $('bot-filter').addEventListener('change', render);
  $('bot').addEventListener('click', e => {
    if (e.target.id === 'bot-reset' && confirm('Delete all of the bot’s paper trades in this browser?')) { B.trades = []; tries.clear(); pend.length = 0; saveLedger(B); render(); }
    if (e.target.id === 'bot-csv') exportCsv(B.trades, 'paper-bot-trades.csv', ['rule', 'why', 'oid', 'sold_t', 'sold_avg', 'sold_fees', 'sold_net', 'sold_why']);
  });
  if (cfg.on) log('Bot on (resumed) · ' + STRATEGIES.filter(R => cfg.rules[R.id].on).map(R => R.name).join(', '), 'sys');
  render();
  updateBot();
}

// an order's legs as one bet (arbitrage: both legs of a pair), for the totals
function bets(trades) {
  const out = [];
  for (const t of trades) {
    const a = out[out.length - 1];
    if (!a || !t.oid || a.oid !== t.oid) { out.push(t); continue; }
    const qty = Math.max(a.qty, t.qty), w = k => a[k] != null && t[k] != null ? (a[k] * a.qty + t[k] * t.qty) / qty : null;
    out[out.length - 1] = { ...a, qty, total: a.total + t.total, mkt: w('mkt'), model: w('model'),
                            pnl: a.pnl != null && t.pnl != null ? a.pnl + t.pnl : null };
  }
  return out;
}

// each rule's line: result, trades, how often it won, open; for sales: what holding to the end would have made
function renderRules() {
  for (const R of STRATEGIES) {
    const own = B.trades.filter(t => t.rule === R.id), bs = bets(own), done = bs.filter(t => t.pnl != null), open = bs.length - done.length;
    const pnl = done.reduce((a, t) => a + t.pnl, 0), wins = done.filter(t => t.pnl > 0).length, parts = [];
    if (R.both && !both()) parts.push('<span class="tag" title="Needs both venues on the same round: pick Both above">needs Both</span>');
    if (done.length) parts.push(`<b class="${pnl >= 0 ? 'up-t' : 'down-t'}">${usd(pnl)}</b>`, plural(done.length, R.both ? 'pair' : 'trade'), `${Math.round(wins / done.length * 100)}% won`);
    if (open) parts.push(`${open} open`);
    const sold = own.filter(t => t.sold && t.result);
    if (sold.length) {
      const held = sold.reduce((a, t) => a + pnlOf(t, t.result), 0), got = sold.reduce((a, t) => a + t.pnl, 0);
      parts.push(`<span title="The ${plural(sold.length, 'sale')} with an official result made ${usd(got)}; held to the end they would have made ${usd(held)}">held: ${usd(held)}</span>`);
    }
    $('rs-' + R.id).innerHTML = parts.join(' · ') || '<span class="muted">no trades yet</span>';
  }
}

function render() {
  const f = $('bot-filter').value, list = f ? B.trades.filter(t => t.rule === f) : B.trades, foot = $('bot-foot');
  $('bot-stats').innerHTML = list.length ? summaryTiles(bets(list))
    : `<div class="sig-sub">${f ? 'No trades by this rule yet.' : 'No trades yet. Tick rules below, switch the bot on and it buys and sells the running round by itself; every trade is settled like your own.'}</div>`;
  renderList(B, $('bot-list'), list.slice(-SHOW), t => ruleById(t.rule)?.name ?? t.rule);
  foot.hidden = !B.trades.length;
  foot.innerHTML = `<span>${plural(B.trades.length, 'trade')} · stored in this browser${list.length > SHOW ? ` · list: newest ${SHOW}` : ''}${B.trades.length >= B.max ? ` (last ${B.max})` : ''}</span>` +
    '<span><button class="link-btn" type="button" id="bot-csv">CSV</button> · <button class="link-btn" type="button" id="bot-reset">Reset</button></span>';
  renderRules();
}

// switch, status line and activity, every second (panels.js)
export function updateBot() {
  const now = Date.now(), start = currentRound(now).start, live = activeVenues().filter(V => liveFeed(V));
  let open = 0;
  for (let i = B.trades.length - 1; i >= 0 && B.trades[i].t >= start; i--) { const t = B.trades[i]; if (t.exit && !t.sold && liveVenue(t)) open++; }
  const market = `${S.A.sym} ${both() ? 'Poly + Kalshi' : activeVenues()[0]?.short ?? ''} ${ROUND_S / 60}m`;
  const ticked = STRATEGIES.filter(R => cfg.rules[R.id].on && (!R.both || both())), sells = pend.filter(o => o.sell).length;
  $('bot-venue').textContent = market;
  $('bot-on').setAttribute('aria-pressed', String(cfg.on));
  $('bot-on-text').textContent = cfg.on ? 'Bot on' : 'Bot off';
  const st = $('bot-status');
  st.className = 'bot-status' + (cfg.on ? ' on' : '');
  st.textContent = !cfg.on
    ? (open ? `Off · still selling ${plural(open, 'open position')} by ${open === 1 ? 'its' : 'their'} rule` : 'Off. Switched on, it trades the running round by the ticked rules, until you switch it off.')
    : !ticked.length ? 'On, but no rule for this market is ticked'
    : !live.length ? 'On · waiting for the running round’s order book'
    : `On · ${plural(ticked.length, 'rule')} on ${market}, while this page is open` +
      (pend.length - sells ? ` · ${plural(pend.length - sells, 'order')} on the way` : '') + (open ? ` · ${plural(open, 'open position')}` : '');
  if (logDirty) {
    logDirty = false;
    $('bot-log').innerHTML = logs.map(l => `<div class="${l.cls}"><time>${fmtClock(l.t)}</time><span>${esc(l.text)}</span></div>`).join('');
  }
}
