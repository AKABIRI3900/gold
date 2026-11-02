// Price alerts (ring once) and Yahoo headlines. Information only: nothing here places an order.
const fs = require('fs');
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (e) { return d; } };
const hdr = { 'User-Agent': 'Mozilla/5.0' };
const now = Math.floor(Date.now() / 1000);

(async () => {
  const rules = rj('alerts.json', { alerts: [] }).alerts;
  const st = rj('data/alerts-state.json', { rang: {}, prices: {} });
  const out = [];

  for (const s of new Set(rules.map(r => r.symbol))) {
    try {
      const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1h`, { headers: hdr })).json();
      const m = j.chart.result[0].meta;
      st.prices[s] = { price: m.regularMarketPrice, time: m.regularMarketTime };
    } catch (e) { console.log('quote failed', s, e.message); }
  }
  for (const r of rules) {
    const q = st.prices[r.symbol];
    if (!q || st.rang[r.id]) continue;
    if (r.type === 'above' ? q.price >= r.price : q.price <= r.price) {
      st.rang[r.id] = { time: q.time, price: q.price };
      out.push(`${r.symbol} ${r.type === 'above' ? 'at or above' : 'at or below'} ${r.price}: now ${q.price}${r.note ? ' (' + r.note + ')' : ''}`);
    }
  }
  fs.writeFileSync('data/alerts-state.json', JSON.stringify(st));
  if (out.length) fs.writeFileSync('ringing.txt', out.join('\n') + '\n\nA price alert is information, not an order and not financial advice.\n');

  const dec = t => t.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const seen = new Map(rj('data/news.json', { items: [] }).items.map(i => [i.link, i]));
  for (const s of ['GC=F', 'GLD']) {
    try {
      const x = await (await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`, { headers: hdr })).text();
      for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const g = t => { const r = m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return r ? dec(r[1]) : ''; };
        const link = g('link'), title = g('title');
        if (link && title && !seen.has(link)) seen.set(link, { sym: s, title, link, time: Math.floor(Date.parse(g('pubDate')) / 1000) || 0, first: now });
      }
    } catch (e) { console.log('news failed', s, e.message); }
  }
  const items = [...seen.values()].sort((a, b) => b.time - a.time).slice(0, 30);
  fs.writeFileSync('data/news.json', JSON.stringify({ updated: now, items }));
  console.log(`WATCH rang=${out.length} news=${items.length} prices=${JSON.stringify(st.prices)}`);
})();
