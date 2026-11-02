// Paper trading bot: simulated account, no broker, no real money.
// Runs on closed 1h candles of data/gc.json and keeps its state in data/paper.json.
const fs = require('fs');
const CFG = { start: 1000, risk: 0.01, maxLev: 3, cost: 0.0001, atrN: 14, rsiN: 14, don: 20, stopATR: 1.5, tpATR: 3 };
const STATE = 'data/paper.json';

const bars = JSON.parse(fs.readFileSync('data/gc.json'));
const now = Date.now() / 1000;
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

function step(st, i) {
  const b = d[i];
  let exitedNow = false;
  if (st.pos) {
    const p = st.pos, long = p.side === 'long';
    let px = null, reason = null;
    if (long ? b.low <= p.stop : b.high >= p.stop) { px = long ? Math.min(p.stop, b.open) : Math.max(p.stop, b.open); reason = 'stop'; }
    else if (long ? b.high >= p.tp : b.low <= p.tp) { px = p.tp; reason = 'target'; }
    if (px !== null) {
      const gross = (long ? px - p.entry : p.entry - px) * p.qty;
      const fee = px * p.qty * CFG.cost;
      st.cash += gross - fee;
      st.trades.push({ side: p.side, entryTime: p.time, entry: p.entry, exitTime: b.time + 3600, exit: +px.toFixed(2), qty: +p.qty.toFixed(4), pnl: +(gross - fee - p.fee).toFixed(2), reason });
      st.pos = null; exitedNow = true;
    }
  }
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

// Backtest on the available history (not saved), for information only.
{
  const bt = fresh();
  for (let i = 0; i < n; i++) step(bt, i);
  const w = bt.trades.filter(t => t.pnl > 0).length;
  const last = bt.equity[bt.equity.length - 1];
  console.log(`BACKTEST ${n} bars: trades=${bt.trades.length} wins=${w} equity=${last ? last.value : CFG.start} open=${bt.pos ? bt.pos.side : 'none'}`);
}

let st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : null;
if (!st) {
  st = fresh();
  st.lastTime = d[n - 1].time;
  st.begun = d[n - 1].time + 3600;
  st.equity.push({ time: st.begun, value: CFG.start });
  console.log('LIVE start at', new Date(st.begun * 1000).toISOString());
} else {
  for (let i = 0; i < n; i++) if (d[i].time > st.lastTime) step(st, i);
}
fs.writeFileSync(STATE, JSON.stringify(st));
console.log(`LIVE equity=${st.equity[st.equity.length - 1].value} trades=${st.trades.length} pos=${st.pos ? st.pos.side : 'none'}`);
