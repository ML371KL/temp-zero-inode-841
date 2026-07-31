// Диагностика доступности Bybit с текущего адреса.
// Нужна потому, что биржа фильтрует часть дата-центров: с раннеров GitHub
// одни эндпоинты отвечают, другие отдают 403 через CloudFront.
//
//   node scripts/probe.mjs

const HOSTS = ['https://api.bybit.com', 'https://api.bytick.com', 'https://api.bybit.nl'];
const PATHS = [
  '/v5/earn/advance/product?category=DualAssets&coin=BTC',
  '/v5/earn/advance/product-extra-info?category=DualAssets&productId=1',
  '/v5/market/tickers?category=spot&symbol=BTCUSDT',
  '/v5/market/tickers?category=option&baseCoin=BTC',
  '/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D&limit=2',
  '/v5/earn/product?category=FlexibleSaving&coin=USDT',
];

for (const host of HOSTS) {
  console.log(`\n=== ${host}`);
  for (const p of PATHS) {
    const started = Date.now();
    try {
      const res = await fetch(host + p, { headers: { accept: 'application/json' } });
      const text = await res.text();
      let note = '';
      try {
        const body = JSON.parse(text);
        note = `retCode=${body.retCode} ${body.retMsg || ''}`.trim();
        if (body.result?.list) note += ` list=${body.result.list.length}`;
      } catch {
        note = text.slice(0, 80).replace(/\s+/g, ' ');
      }
      console.log(`  ${res.status} ${((Date.now() - started) / 1000).toFixed(1)}s ${p.split('?')[0]} — ${note}`);
    } catch (e) {
      console.log(`  ERR ${p.split('?')[0]} — ${e.message}`);
    }
  }
}
