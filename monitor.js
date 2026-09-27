// 雲端釋票監控：在 GitHub Actions 上跑真的 Chromium，於 ibon 頁面內同源 fetch 票區資料
// 有票 → POST 到 Apps Script（寄 Gmail＋寫試算表）
const { chromium } = require('playwright');

const SHOWS = [
  { key: '1128', label: '11/28(六) 18:00', url: 'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=B0CBGGE8&PRODUCT_ID=B0CB1UNY&strItem=WEB%e7%b6%b2%e7%ab%99%e5%85%a5%e5%8f%a31' },
  { key: '1129', label: '11/29(日) 15:00', url: 'https://orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx?PERFORMANCE_ID=B0CC4N01&PRODUCT_ID=B0CB1UNY&strItem=WEB%E7%B6%B2%E7%AB%99%E5%85%A5%E5%8F%A31' }
];
const EVENT = 'MAMAMOO 2026 <4WARD> in TAIPEI';
const GAS_URL = process.env.GAS_URL || '';
const NEED = +(process.env.NEED || 2);
const INTERVAL = +(process.env.INTERVAL_SEC || 3) * 1000;       // 每次請求間隔（兩場輪流）
const RUN_MS = +(process.env.RUN_MINUTES || 340) * 60000;       // Actions 單次上限 6 小時，留餘裕
const HEARTBEAT_MS = 30 * 60000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isSoldOut = a => a === '已售完' || a === '0' || a === '';
const countOf = a => { const m = String(a).match(/\d+/); return m ? +m[0] : null; };
const qualifies = a => !isSoldOut(a) && (countOf(a) === null || countOf(a) >= NEED);
const tw = () => new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const log = (...a) => console.log(`[${tw()}]`, ...a);

async function post(payload) {
  if (!GAS_URL) { log('（未設定 GAS_URL）', JSON.stringify(payload)); return; }
  try {
    const r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...payload, event: EVENT, sentAt: tw(), source: 'cloud' }), redirect: 'follow' });
    log('GAS', payload.type, r.status);
  } catch (e) { log('GAS 失敗', e.message); }
}

async function openPage(browser) {
  const ctx = await browser.newContext({
    locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  const r = await page.goto(SHOWS[0].url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Cloudflare 驗證頁（Just a moment…）最多等 30 秒自動通過
  for (let i = 0; i < 15; i++) {
    const html = await page.content();
    if (html.includes('jsonData')) { log('頁面就緒', r && r.status()); return page; }
    await sleep(2000);
  }
  const html = await page.content();
  log('開頁失敗', r && r.status(), await page.title(), html.includes('連線暫時受限') ? '（ibon 限流頁）' : '');
  await ctx.close();
  return null;
}

async function pollOnce(page, url) {
  return page.evaluate(async u => {
    const t0 = performance.now();
    try {
      const r = await fetch(u, { cache: 'no-store', credentials: 'include' });
      const h = await r.text();
      const ms = Math.round(performance.now() - t0);
      if (r.status !== 200 || h.includes('連線暫時受限')) return { ok: false, blocked: true, status: r.status, ms };
      const m = h.match(/jsonData\s*=\s*'(\[.*?\])'\s*;/s);
      if (!m) return { ok: false, status: r.status, ms, err: '找不到 jsonData' };
      return { ok: true, ms, areas: JSON.parse(m[1]).map(a => ({ id: a.PERFORMANCE_PRICE_AREA_ID, name: a.NAME, price: a.PRICE, amount: String(a.AMOUNT) })) };
    } catch (e) { return { ok: false, status: 0, err: String(e) }; }
  }, url);
}

(async () => {
  const start = Date.now();
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const state = {};  // key -> {id: {amount, since}}
  const stat = { polls: 0, ok: 0, blocked: 0, err: 0, lastMs: 0 };
  let page = null, consecutiveBad = 0, lastHb = 0, idx = 0, firstReported = false;

  while (Date.now() - start < RUN_MS) {
    if (!page) {
      page = await openPage(browser);
      if (!page) {
        stat.blocked++;
        if (!firstReported) { firstReported = true; await post({ type: 'BLOCKED', note: '雲端主機開啟 ibon 頁面失敗（可能被擋），1 分鐘後重試' }); }
        await sleep(60000); continue;
      }
      if (!firstReported) { firstReported = true; await post({ type: 'HEARTBEAT', note: '雲端監控啟動成功，已連上 ibon' }); lastHb = Date.now(); }
    }
    const show = SHOWS[idx++ % SHOWS.length];
    const res = await pollOnce(page, show.url);
    stat.polls++;
    if (res.ok) {
      stat.ok++; stat.lastMs = res.ms; consecutiveBad = 0;
      await process(show, res.areas);
    } else {
      res.blocked ? stat.blocked++ : stat.err++;
      consecutiveBad++;
      log('失敗', show.key, JSON.stringify(res));
      if (consecutiveBad >= 3) {
        // 重開頁面（更新 cookie）；持續被擋則退避
        await page.context().close().catch(() => {}); page = null;
        const wait = Math.min(10, consecutiveBad - 2) * 60000;
        if (res.blocked) await post({ type: 'BLOCKED', show: show.label, note: `被 ibon 限流（HTTP ${res.status}），暫停 ${wait / 60000} 分鐘` });
        await sleep(wait);
        continue;
      }
    }
    if (Date.now() - lastHb > HEARTBEAT_MS) {
      lastHb = Date.now();
      const summary = SHOWS.map(s => { const x = state[s.key]; if (!x) return `${s.label}: 未查`; const av = Object.values(x).filter(a => !isSoldOut(a.amount)).length; return `${s.label}: ${av ? av + ' 區有位' : '全售完'}`; }).join('；');
      await post({ type: 'HEARTBEAT', note: `雲端：累計 ${stat.polls} 次（成功 ${stat.ok}、被擋 ${stat.blocked}、錯誤 ${stat.err}），回應 ${stat.lastMs}ms。${summary}` });
    }
    if (stat.polls % 100 === 0) log('統計', JSON.stringify(stat));
    await sleep(INTERVAL * (0.8 + Math.random() * 0.4));
  }
  log('本輪結束，交給下一輪排程', JSON.stringify(stat));
  await browser.close();

  async function process(show, areas) {
    const prev = state[show.key];
    const next = {}, alerts = [];
    for (const a of areas) {
      const p = prev && prev[a.id];
      next[a.id] = { name: a.name, amount: a.amount, since: p && p.amount === a.amount ? p.since : Date.now() };
      const wasOut = !p || isSoldOut(p.amount), nowOut = isSoldOut(a.amount);
      if (wasOut && !nowOut) {
        if (qualifies(a.amount)) alerts.push(a);
        else await post({ type: 'SINGLE', show: show.label, area: a.name, price: a.price, amount: a.amount, note: `只釋出 ${a.amount}，不足 ${NEED} 張` });
      } else if (!wasOut && nowOut) {
        await post({ type: 'SOLDOUT', show: show.label, area: a.name, price: a.price, amount: a.amount, note: `又賣完了，這次釋出約持續 ${Math.round((Date.now() - p.since) / 1000)} 秒` });
      } else if (!wasOut && !nowOut && p.amount !== a.amount) {
        await post({ type: 'CHANGE', show: show.label, area: a.name, price: a.price, amount: a.amount, note: `${p.amount} → ${a.amount}` });
      }
    }
    state[show.key] = next;
    if (alerts.length) {
      log('🎫 有票', show.label, alerts.map(a => a.name + ':' + a.amount).join(', '));
      await post({ type: 'ALERT', show: show.label, url: show.url, items: alerts, need: NEED });
    }
  }
})();
