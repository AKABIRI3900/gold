// Two simulated accounts, no broker, no real money.
//  1) rule-based bot  -> data/paper.json   (closed 1h candles of data/gc.json)
//  2) Claude's account -> data/claude.json (entries come from claude-plan.json, exits are checked here)
const fs = require('fs');
const CFG = { start: 1000, risk: 0.01, maxLev: 3, cost: 0.0001, atrN: 14, rsiN: 14, don: 20, stopATR: 1.5, tpATR: 3 };
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const hr = t => Math.floor(t / 3600) * 3600;

const bars = JSON.parse(fs.readFileSync('data/gc.json'));
const now = Math.floor(Date.now() / 1000);
const d = bars.filter(b => b.time + 3600 <= now);
const n = d.length;

const ema = (len) => { const k = 2 / (len + 1); let p; return d.map(b => (p = p === undefined ? b.close : b.close * k + p * (1 - k))); };
const e20 = ema(20), e50 = ema(50);
const rsi = d.map(() => null), atr = d.map(() => null);
{
  let g = 0, l = 0, a = 0;
  for (let i = 1; i < n; i++) {
    const ch = d[i].close - d[i - 1].close, u = Math.max(ch, 0), v = Math.max(-ch, 0);
    const tr = Math.max(d[i].high - d[i].low, Math.abs(d[i].high - d[i - 1].close), Math.abs(d[i].low - d[i - 1].close));
    if (i <= CFG.rsiN) { g += u / CFG.rsiN; l += v / CFG.rsiN; } else { g = (g * (CFG.rsiN - 1) + u) / CFG.rsiN; l = (l * (CFG.rsiN - 1) + v) / CFG.rsiN; }
    if (i <= CFG.atrN) a += tr / CFG.atrN; else a = (a * (CFG.atrN - 1) + tr) / CFG.atrN;
    if (i >= CFG.rsiN) rsi[i] = 100 - 100 / (1 + g / (l || 1e-9));
    if (i >= CFG.atrN) atr[i] = a;
  }
}
const donHi = i => Math.max(...d.slice(i - CFG.don, i).map(b => b.high));
const donLo = i => Math.min(...d.slice(i - CFG.don, i).map(b => b.low));

// Closes the open position when this bar touches the stop or target (stop wins when both are touched).
function exitCheck(st, b) {
  if (!st.pos) return false;
  const p = st.pos, long = p.side === 'long';
  let px = null, reason = null;
  if (long ? b.low <= p.stop : b.high >= p.stop) { px = long ? Math.min(p.stop, b.open) : Math.max(p.stop, b.open); reason = 'stop'; }
  else if (long ? b.high >= p.tp : b.low <= p.tp) { px = p.tp; reason = 'target'; }
  if (px === null) return false;
  const gross = (long ? px - p.entry : p.entry - px) * p.qty;
  const fee = px * p.qty * CFG.cost;
  st.cash += gross - fee;
  st.trades.push({ side: p.side, entryTime: p.time, entry: p.entry, exitTime: b.time + 3600, exit: +px.toFixed(2), qty: +p.qty.toFixed(4), pnl: +(gross - fee - p.fee).toFixed(2), reason });
  st.pos = null;
  return true;
}

function step(st, i) {
  const b = d[i];
  const exitedNow = exitCheck(st, b);
  if (!st.pos && !exitedNow && i >= CFG.don + 1 && atr[i] && rsi[i]) {
    const hi = donHi(i), lo = donLo(i);
    let side = null;
    if (e20[i] > e50[i] && b.close > hi && rsi[i] > 50 && rsi[i] < 75) side = 'long';
    if (e20[i] < e50[i] && b.close < lo && rsi[i] < 50 && rsi[i] > 25) side = 'short';
    if (side) {
      const dist = CFG.stopATR * atr[i];
      const eq = st.cash;
      const qty = Math.min(eq * CFG.risk / dist, eq * CFG.maxLev / b.close);
      const fee = b.close * qty * CFG.cost;
      st.cash -= fee;
      const s = side === 'long' ? 1 : -1;
      st.pos = { side, entry: +b.close.toFixed(2), qty, stop: +(b.close - s * dist).toFixed(2), tp: +(b.close + s * CFG.tpATR * atr[i]).toFixed(2), time: b.time + 3600, fee };
    }
  }
  const unreal = st.pos ? (st.pos.side === 'long' ? b.close - st.pos.entry : st.pos.entry - b.close) * st.pos.qty : 0;
  st.equity.push({ time: b.time + 3600, value: +(st.cash + unreal).toFixed(2) });
  st.lastTime = b.time;
}

const fresh = () => ({ start: CFG.start, cash: CFG.start, pos: null, trades: [], equity: [], lastTime: 0, cfg: CFG });

function bot() {
  {
    const bt = fresh();
    for (let i = 0; i < n; i++) step(bt, i);
    const w = bt.trades.filter(t => t.pnl > 0).length;
    const last = bt.equity[bt.equity.length - 1];
    console.log(`BACKTEST ${n} bars: trades=${bt.trades.length} wins=${w} equity=${last ? last.value : CFG.start} open=${bt.pos ? bt.pos.side : 'none'}`);
  }
  const STATE = 'data/paper.json';
  let st = rj(STATE, null);
  if (!st) {
    st = fresh();
    st.lastTime = d[n - 1].time;
    st.begun = d[n - 1].time + 3600;
    st.equity.push({ time: st.begun, value: CFG.start });
    console.log('BOT start at', new Date(st.begun * 1000).toISOString());
  } else {
    for (let i = 0; i < n; i++) if (d[i].time > st.lastTime) step(st, i);
  }
  fs.writeFileSync(STATE, JSON.stringify(st));
  console.log(`BOT equity=${st.equity[st.equity.length - 1].value} trades=${st.trades.length} pos=${st.pos ? st.pos.side : 'none'}`);
}

async function claude() {
  const FILE = 'data/claude.json';
  const plan = rj('claude-plan.json', null);
  const c = rj(FILE, { start: 1000, cash: 1000, pos: null, trades: [], done: [], eq: 1000, note: '', lastBar: 0, begun: now });
  let live = null;
  try {
    const j = await (await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=1h', { headers: { 'User-Agent': 'Mozilla/5.0' } })).json();
    live = j.chart.result[0].meta.regularMarketPrice;
  } catch (e) { console.log('live price failed', e.message); }

  if (c.pos) {
    for (const b of d) if (b.time >= hr(c.pos.time) + 3600 && b.time > c.lastBar) if (exitCheck(c, b)) break;
    if (c.pos && live) exitCheck(c, { open: live, high: live, low: live, time: now - 3600 });
  }
  c.lastBar = d[n - 1].time;

  if (plan && !c.pos && live && !c.done.includes(plan.id)) {
    const long = plan.side === 'long';
    const ok = long ? plan.stop < live && plan.tp > live : plan.stop > live && plan.tp < live;
    if (!ok) console.log('CLAUDE plan skipped: stop/target on the wrong side of', live);
    else {
      const dist = Math.abs(live - plan.stop);
      const qty = Math.min(c.cash * (plan.risk || 0.01) / dist, c.cash * CFG.maxLev / live);
      const fee = live * qty * CFG.cost;
      c.cash -= fee;
      c.pos = { side: plan.side, entry: +live.toFixed(2), qty, stop: plan.stop, tp: plan.tp, time: now, fee };
      c.done.push(plan.id);
      c.note = plan.note || '';
      console.log('CLAUDE opened', plan.side, live);
    }
  }
  const unreal = c.pos && live ? (c.pos.side === 'long' ? live - c.pos.entry : c.pos.entry - live) * c.pos.qty : 0;
  c.eq = +(c.cash + unreal).toFixed(2);
  c.updated = now;
  fs.writeFileSync(FILE, JSON.stringify(c));
  console.log(`CLAUDE equity=${c.eq} trades=${c.trades.length} pos=${c.pos ? c.pos.side : 'none'}`);
}

bot();
claude();
