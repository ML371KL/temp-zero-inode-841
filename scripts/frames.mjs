// Сравнение двух постановок задачи на одном срезе рынка.
//
//   node scripts/frames.mjs                  — живые данные
//   node scripts/frames.mjs --save snap.json — сохранить срез
//   node scripts/frames.mjs --load snap.json — считать по сохранённому срезу
//   node scripts/frames.mjs --horizon 365    — горизонт стратегии
//
// Зачем этот скрипт существует отдельно от аудита. Аудит проверяет, что панель
// считает то, что заявляет. Здесь проверяется другое, более важное: что выбор
// постановки задачи меняет ответ, и меняет сильно. Пока обе оси главного фронта
// измерялись в разных единицах — доходность делилась на срок, а вероятность
// нет, — панель молча выдавала за «оптимум» ответ одной конкретной постановки,
// нигде её не называя.
//
// Скрипт печатает три фронта на одних и тех же котировках:
//
//   подписка   — эффективный APR против вероятности конвертации этой покупки;
//   сделка     — доход за сделку против той же вероятности (обе за одну сделку);
//   стратегия  — стоимость капитала за горизонт против шанса закончить в BTC.
//
// Первый — то, что показывает режим «Текущая подписка». Третий — то, что
// показывает режим «Стратегия до даты». Второй нужен для контраста: он тоже
// согласован по единицам, но отвечает на разовый вопрос, а не на горизонтный.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  fetchProducts,
  fetchQuote,
  fetchOptionTickers,
  fetchSpot,
  fetchRiskFree,
  fetchKlines,
} from '../web/feeds.js';
import { buildSurface } from '../web/surface.js';
import { History, buildRows, computeStrategy } from '../web/model.js';
import { paretoFront, parseDuration, black76Put } from '../web/quant.js';

const arg = (name, fallback) => {
  const k = process.argv.indexOf(`--${name}`);
  return k >= 0 ? process.argv[k + 1] : fallback;
};

const HORIZON = Number(arg('horizon', 90));
const LOAD = arg('load', null);
const SAVE = arg('save', null);

// Срез хранится сжатым: свечи занимают почти весь объём, а в репозитории он
// должен лежать так, чтобы его не жалко было обновлять.
const readSnap = (path) =>
  JSON.parse(path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8'));
const writeSnap = (path, data) => {
  const json = JSON.stringify(data);
  writeFileSync(path, path.endsWith('.gz') ? gzipSync(Buffer.from(json), { level: 9 }) : json);
};

async function collect() {
  if (LOAD) {
    const snap = readSnap(LOAD);
    console.log(`Срез из файла ${LOAD}, снят ${new Date(snap.now).toISOString()}`);
    return snap;
  }
  console.log('Загрузка живых данных…');
  const now = Date.now();
  const [products, options, spot, riskFree, riskFreeBtc] = await Promise.all([
    fetchProducts(),
    fetchOptionTickers(),
    fetchSpot(),
    fetchRiskFree('USDT'),
    fetchRiskFree('BTC'),
  ]);
  const quotes = {};
  for (const p of products.filter((x) => x.status === 'Available')) {
    const q = await fetchQuote(p.productId);
    if (q) quotes[String(q.productId)] = q;
  }
  const [h1, h4, d1] = await Promise.all([fetchKlines('60', 4), fetchKlines('240', 3), fetchKlines('D', 3)]);
  const snap = { now, spot, riskFree, riskFreeBtc, products, options, quotes, klines: { 60: h1, 240: h4, D: d1 } };
  if (SAVE) {
    writeSnap(SAVE, snap);
    console.log(`Срез сохранён в ${SAVE}`);
  }
  return snap;
}

const snap = await collect();
const surface = buildSurface(snap.options, snap.now);
const history = new History(snap.klines);
const quotes = new Map(Object.entries(snap.quotes));

const rows = buildRows({
  products: snap.products,
  quotes,
  direction: 'BuyLow',
  now: snap.now,
  spot: snap.spot,
  surface,
  history,
  riskFree: snap.riskFree,
  riskFreeBtc: snap.riskFreeBtc,
  amount: 10000,
  vip: true,
  measure: 'max',
  horizonDays: HORIZON,
});

const strategy = computeStrategy({
  rows,
  history,
  spot: snap.spot,
  horizonDays: HORIZON,
  riskFree: snap.riskFree ?? 0,
});

const pc = (x, d = 2) => (x == null || !Number.isFinite(x) ? '     — ' : `${(x * 100).toFixed(d)}%`.padStart(8));
const num = (x, d = 0, w = 8) => (x == null || !Number.isFinite(x) ? '—'.padStart(w) : x.toFixed(d).padStart(w));

console.log(
  `\nСпот ${snap.spot} · оферт ${rows.length} · горизонт ${HORIZON} дней · ` +
    `гибкий депозит USDT ${pc(snap.riskFree).trim()}, BTC ${pc(snap.riskFreeBtc).trim()}`,
);

// ─────────────────────────────────────────────────────────── три фронта

const frontSubscription = rows.filter((r) => r.pareto);
const okDeal = rows.filter((r) => Number.isFinite(r.i) && Number.isFinite(r.pConv));
const dealSet = paretoFront(okDeal, 'i', 'pConv');
const frontDeal = okDeal.filter((r) => dealSet.has(r));
const frontStrategy = strategy?.rows ?? [];

const composition = (list) => {
  const m = new Map();
  for (const r of list) m.set(r.duration, (m.get(r.duration) || 0) + 1);
  return [...m]
    .sort((a, b) => parseDuration(a[0]) - parseDuration(b[0]))
    .map(([d, n]) => `${d}×${n}`)
    .join(' ');
};

console.log('\n═══ 1. Режим «Текущая подписка»: эффективный APR ↑ против P конверсии этой покупки ↓');
console.log('срок     страйк  от спота   P сделки  P за гориз.   APRэфф  APRцикл  ожид.потеря  премия σ');
for (const r of [...frontSubscription].sort((a, b) => a.pConv - b.pConv)) {
  console.log(
    `${r.duration.padEnd(5)} ${num(r.strike, 0)} ${pc(r.moneyness)} ${pc(r.pConv)} ${pc(r.pHorizon, 1)}   ` +
      `${pc(r.aprEff, 1)} ${pc(r.aprChained, 1)} ${pc(r.depth?.expected, 3)}  ${pc(r.volEdge, 1)}`,
  );
}

console.log('\n═══ 2. Та же покупка, но обе оси за сделку: доход i ↑ против P конверсии ↓');
console.log('срок     страйк  от спота   P сделки     i, %   APRэфф  ожид.потеря');
for (const r of [...frontDeal].sort((a, b) => a.pConv - b.pConv)) {
  console.log(
    `${r.duration.padEnd(5)} ${num(r.strike, 0)} ${pc(r.moneyness)} ${pc(r.pConv)} ${pc(r.i, 3)} ${pc(r.aprEff, 1)} ${pc(r.depth?.expected, 3)}`,
  );
}

console.log(`\n═══ 3. Режим «Стратегия до даты»: стоимость за ${HORIZON} дней ↑ против шанса закончить в BTC ↓`);
console.log('срок     страйк  от спота  закончить в BTC   ожид.годовых  медиана  циклов  премия σ');
for (const r of frontStrategy) {
  console.log(
    `${r.duration.padEnd(5)} ${num(r.strike, 0)} ${pc(r.moneyness)} ${pc(r.stratRisk, 1)}        ` +
      `${pc(r.stratAnnual, 1)} ${pc(r.strategy.annualMedian, 1)} ${num(r.strategy.cycles, 0, 6)}  ${pc(r.volEdge, 1)}`,
  );
}
if (strategy) {
  console.log(
    `\nбазы сравнения на тех же траекториях: USDT ${pc(strategy.usdtAnnual)} · ` +
      `BTC ${pc(strategy.btcAnnual, 1)} в среднем, ${pc(strategy.btcAnnualMedian, 1)} по медиане`,
  );
}

// ─────────────────────────────────────────────────────────── расхождение

const key = (r) => `${r.productId}|${r.strike}`;
const overlap = (a, b) => {
  const set = new Set(a.map(key));
  return b.filter((r) => set.has(key(r))).length;
};

console.log('\n═══ Насколько ответы расходятся');
console.log(`подписка : ${composition(frontSubscription)}  (${frontSubscription.length} строк)`);
console.log(`сделка   : ${composition(frontDeal)}  (${frontDeal.length} строк)`);
console.log(`стратегия: ${composition(frontStrategy)}  (${frontStrategy.length} строк)`);
console.log(
  `пересечение подписка↔сделка ${overlap(frontSubscription, frontDeal)}, ` +
    `подписка↔стратегия ${overlap(frontSubscription, frontStrategy)}, ` +
    `сделка↔стратегия ${overlap(frontDeal, frontStrategy)}`,
);

// ─────────────────────────────────────── цена риска в единицах, не зависящих
// от постановки: премия к рынку опционов в пунктах волатильности.

const ranked = [...rows].filter((r) => Number.isFinite(r.volEdge)).sort((a, b) => b.volEdge - a.volEdge);
const place = new Map(ranked.map((r, k) => [key(r), k + 1]));
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
console.log(
  `\nМеста фронтов по единственной безразмерной мере — премии к рынку опционов, п. волатильности\n` +
    `(она не содержит допущений о переразмещении капитала, поэтому одинаково честна ко всем трём):`,
);
for (const [name, list] of [
  ['подписка', frontSubscription],
  ['сделка', frontDeal],
  ['стратегия', frontStrategy],
]) {
  const places = list.map((r) => place.get(key(r))).filter(Boolean);
  console.log(
    `  ${name.padEnd(10)} медиана места ${String(median(places)).padStart(4)} из ${ranked.length}` +
      ` · лучшее ${Math.min(...places)} · худшее ${Math.max(...places)}`,
  );
}
const best = ranked[0];
console.log(
  `  лучшая цена во всей книге: ${best.duration}/${best.strike} · премия σ ${pc(best.volEdge, 2).trim()} · ` +
    `APRэфф ${pc(best.aprEff, 1).trim()} · P сделки ${pc(best.pConv).trim()}`,
);
const positive = rows.filter((r) => r.volEdge > 0).length;
console.log(`  оферт, где Bybit платит за риск больше рынка опционов: ${positive} из ${rows.length}`);

// ─────────────────────────────────────── глубина против частоты

console.log('\n═══ Почему одной вероятности мало: при равном шансе глубина разная');
console.log('срок     страйк  от спота   P сделки  ожид.потеря  потеря при конв.  стресс 5%');
const seen = new Set();
for (const r of [...rows].sort((a, b) => Math.abs(a.pRN - 0.07) - Math.abs(b.pRN - 0.07))) {
  if (seen.has(r.duration) || !r.depth) continue;
  seen.add(r.duration);
  console.log(
    `${r.duration.padEnd(5)} ${num(r.strike, 0)} ${pc(r.moneyness)} ${pc(r.pRN)} ${pc(r.depth.expected, 3)}    ` +
      `${pc(r.depth.conditional)}       ${pc(r.depth.stress)}`,
  );
}
{
  const band = rows.filter((r) => r.pRN > 0.05 && r.pRN < 0.1 && r.depth);
  if (band.length > 1) {
    const lo = band.reduce((a, b) => (b.depth.expected < a.depth.expected ? b : a));
    const hi = band.reduce((a, b) => (b.depth.expected > a.depth.expected ? b : a));
    console.log(
      `\nразмах внутри полосы P от 5% до 10%: от ${pc(lo.depth.expected, 3).trim()} (${lo.duration}) ` +
        `до ${pc(hi.depth.expected, 3).trim()} (${hi.duration}) — отношение ${(hi.depth.expected / lo.depth.expected).toFixed(1)}×`,
    );
  }
}

// ─────────────────────────────────────── скрытый дрейф исторической меры

const longRow = rows.filter((r) => r.timing.tauDays > 100).sort((a, b) => b.timing.tauDays - a.timing.tauDays)[0];
if (longRow) {
  const h = history.returns(longRow.timing.tauDays);
  const k = (longRow.sigma * Math.sqrt(longRow.Teff)) / h.sigma;
  const drift = Math.log(longRow.forward / snap.spot);
  const naive = h.sorted.map((x) => (x - h.mean) * k + drift);
  const meanNaive = naive.reduce((a, x) => a + Math.exp(x), 0) / naive.length;
  const fwd = longRow.forward / snap.spot;
  console.log('\n═══ Скрытый дрейф исторической меры (исправлен мартингальным центрированием)');
  console.log(
    `на ${longRow.duration}: центрирование по медиане давало E[S_T]/S = ${meanNaive.toFixed(5)} при форварде ${fwd.toFixed(5)},\n` +
      `то есть молчаливый прогноз роста на ${((meanNaive / fwd - 1) * 100).toFixed(2)}% за срок ` +
      `(${(((meanNaive / fwd) ** (365 / longRow.timing.tauDays) - 1) * 100).toFixed(1)}% годовых).`,
  );
}
