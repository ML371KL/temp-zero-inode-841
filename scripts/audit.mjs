// Независимая перепроверка расчётов панели на живых данных.
//
//   node scripts/audit.mjs
//
// Отличие от selftest.mjs: там проверяются формулы сами по себе, здесь —
// весь конвейер целиком на настоящих котировках, причём ключевые величины
// пересчитываются вторым, независимым способом: аналитику сверяем с
// Монте-Карло, отбор — с полным перебором.

import {
  fetchProducts,
  fetchQuote,
  fetchOptionTickers,
  fetchSpot,
  fetchRiskFree,
  fetchKlines,
} from '../web/feeds.js';
import { buildSurface, volAt, forwardAt } from '../web/surface.js';
import { empiricalCdf } from '../web/quant.js';
import {
  History,
  buildRows,
  pickBest,
  pickBestSell,
  analyzeSellHigh,
  exitFrontier,
  frontierWithMargins,
  pickAnchors,
} from '../web/model.js';
import {
  productTiming,
  interestRate,
  basisFromConversion,
  effectiveApr,
  chainedApr,
  black76Put,
  black76Call,
  twapEffectiveT,
  apyFromE8,
  YEAR_DAYS,
  MS_DAY,
} from '../web/quant.js';

let failed = 0;
let passed = 0;
const problems = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    problems.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const pc = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);

// ─────────────────────────────────────────── детерминированный Монте-Карло

// Генератор mulberry32 с фиксированным зерном: аудит должен быть воспроизводим.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Пара нормальных из равномерных, преобразование Бокса — Мюллера.
function* normals(seed, n) {
  const u = rng(seed);
  for (let k = 0; k < n; k += 2) {
    const u1 = Math.max(u(), 1e-12);
    const u2 = u();
    const r = Math.sqrt(-2 * Math.log(u1));
    yield r * Math.cos(2 * Math.PI * u2);
    yield r * Math.sin(2 * Math.PI * u2);
  }
}

/**
 * Прямое моделирование цены сеттлмента под мерой Q и подсчёт нужных величин.
 * Возвращает вероятность срабатывания и ожидание выплаты на единицу вложения.
 */
function monteCarlo({ F, K, sigma, T, direction, i, n = 400_000, seed = 12345 }) {
  const vol = sigma * Math.sqrt(T);
  const drift = -0.5 * vol * vol;
  let trigger = 0;
  let payoff = 0;
  for (const z of normals(seed, n)) {
    const S = F * Math.exp(drift + vol * z);
    if (direction === 'BuyLow') {
      if (S <= K) trigger++;
      payoff += (1 + i) * Math.min(1, S / K);
    } else {
      if (S >= K) trigger++;
      payoff += ((1 + i) * Math.min(S, K)) / F;
    }
  }
  return { p: trigger / n, value: payoff / n, se: 0.5 / Math.sqrt(n) };
}

// ─────────────────────────────────────────── сбор живых данных

console.log('Загрузка живых данных…');
const now = Date.now();
const [products, options, spot, riskFree] = await Promise.all([
  fetchProducts(),
  fetchOptionTickers(),
  fetchSpot(),
  fetchRiskFree(),
]);
const surface = buildSurface(options, now);
const quotes = new Map();
for (const p of products.filter((x) => x.status === 'Available')) {
  const q = await fetchQuote(p.productId);
  if (q) quotes.set(String(q.productId), q);
}
const [h1, h4, d1] = await Promise.all([fetchKlines('60', 4), fetchKlines('240', 3), fetchKlines('D', 3)]);
const history = new History({ 60: h1, 240: h4, D: d1 });

const opts = {
  products,
  quotes,
  now,
  spot,
  surface,
  history,
  riskFree,
  amount: 10000,
  vip: true,
  measure: 'max',
};
const buy = buildRows({ ...opts, direction: 'BuyLow' });
const sell = buildRows({ ...opts, direction: 'SellHigh' });

console.log(
  `спот ${spot.toFixed(2)} · продуктов ${products.length} · оферт Buy Low ${buy.length} · Sell High ${sell.length}\n`,
);

// ─────────────────────────────────────────── 1. Тайминг

console.log('── 1. Тайминг и начисление');
{
  let labelBad = 0;
  let cycleBad = [];
  let lockBad = 0;
  for (const p of products) {
    const t = productTiming(p, now);
    if (!t.labelMatches) labelBad++;
    // Цикл обязан быть больше окна начисления и кратен суткам с точностью до
    // задержки выдачи: продукты выпускаются раз в сутки.
    const extra = t.cycleDays - t.yieldDays;
    if (!(extra > 0 && extra <= 1.0001)) cycleBad.push(`${p.duration}: +${extra.toFixed(4)}д`);
    // Проверка осмысленна только для открытых окон: у закрытого продукта
    // подписаться уже нельзя, и остаток блокировки естественно короче срока.
    if (t.open && !(t.lockDays >= t.yieldDays)) lockBad++;
  }
  ok('окно начисления совпадает с меткой срока у всех продуктов', labelBad === 0, `расхождений ${labelBad}`);
  ok('простой между циклами в пределах суток у всех продуктов', cycleBad.length === 0, cycleBad.join(', ') || 'ок');
  ok('блокировка не короче начисления', lockBad === 0);

  const r = buy[0];
  const t = r.timing;
  ok(
    'эффективный APR = APY·D/L на живой строке',
    Math.abs(r.aprEff - (r.apy * t.yieldDays) / t.lockDays) < 1e-12,
    `${pc(r.aprEff)}`,
  );
  ok(
    'APR в цикле = APY·D/цикл на живой строке',
    Math.abs(r.aprChained - (r.apy * t.yieldDays) / t.cycleDays) < 1e-12,
    `${pc(r.aprChained)}`,
  );
  ok('APR в цикле не выше эффективного', buy.every((x) => x.aprChained <= x.aprEff + 1e-12));
  ok(
    'процент за срок = APY·D/365',
    buy.every((x) => Math.abs(x.i - (x.apy * x.timing.yieldDays) / YEAR_DAYS) < 1e-15),
  );
}

// ─────────────────────────────────────────── 2. Вероятности против Монте-Карло

console.log('\n── 2. Вероятность конвертации: аналитика против Монте-Карло');
{
  // Берём разнородную выборку: короткие и длинные сроки, ближние и дальние страйки.
  const sample = [...buy].sort((a, b) => a.pRN - b.pRN).filter((r) => r.sigma > 0);
  const picks = [sample[0], sample[Math.floor(sample.length / 4)], sample[Math.floor(sample.length / 2)], sample[sample.length - 1]];
  let worst = 0;
  for (const r of picks) {
    if (!r) continue;
    const mc = monteCarlo({ F: r.forward, K: r.strike, sigma: r.sigma, T: r.Teff, direction: 'BuyLow', i: r.i });
    const diff = Math.abs(mc.p - r.pRN);
    worst = Math.max(worst, diff);
    ok(
      `P(конв) ${r.duration} страйк ${r.strike}`,
      diff < 4 * mc.se + 1e-4,
      `аналитика ${pc(r.pRN)}, Монте-Карло ${pc(mc.p)}, расхождение ${(diff * 100).toFixed(3)} п.п.`,
    );
  }
  ok('максимальное расхождение по вероятности мало', worst < 0.003, `${(worst * 100).toFixed(3)} п.п.`);

  // Справедливая стоимость: аналитика против того же Монте-Карло.
  const r = picks[2];
  if (r) {
    const mc = monteCarlo({ F: r.forward, K: r.strike, sigma: r.sigma, T: r.Teff, direction: 'BuyLow', i: r.i });
    const df = Math.exp((-(riskFree ?? 0) * r.timing.lockDays) / YEAR_DAYS);
    ok(
      'справедливая стоимость против Монте-Карло',
      Math.abs(mc.value * df - r.fairValue) < 5e-4,
      `аналитика ${r.fairValue.toFixed(6)}, Монте-Карло ${(mc.value * df).toFixed(6)}`,
    );
  }

  // Sell High: вероятность продажи должна дополнять вероятность падения ниже страйка.
  const s = sell.find((x) => x.sigma > 0 && Number.isFinite(x.pRN));
  if (s) {
    const mc = monteCarlo({ F: s.forward, K: s.strike, sigma: s.sigma, T: s.Teff, direction: 'SellHigh', i: s.i });
    ok(
      `P(продажи) ${s.duration} страйк ${s.strike}`,
      Math.abs(mc.p - s.pRN) < 4 * mc.se + 1e-4,
      `аналитика ${pc(s.pRN)}, Монте-Карло ${pc(mc.p)}`,
    );
  }
}

// ─────────────────────────────────────────── 3. Волатильность оферты

console.log('\n── 3. Волатильность оферты и премия');
{
  let bad = 0;
  let worstResidual = 0;
  for (const r of buy) {
    if (!(r.offerVol > 0) || !(r.i > 0)) continue;
    // По определению: цена пута при волатильности оферты равна K·i/(1+i).
    const target = (r.strike * r.i) / (1 + r.i);
    const price = black76Put(r.forward, r.strike, r.offerVol, r.Teff);
    const residual = Math.abs(price - target) / r.strike;
    worstResidual = Math.max(worstResidual, residual);
    if (residual > 1e-6) bad++;
  }
  ok('волатильность оферты решает своё уравнение', bad === 0, `максимальная невязка ${worstResidual.toExponential(2)}`);

  let signBad = [];
  for (const r of buy) {
    if (r.volEdge == null || r.edgeApr == null) continue;
    // Знаки премии по волатильности и по доходности обязаны совпадать:
    // и то и другое — «оферта щедрее или скупее рынка».
    const rf = riskFree ?? 0;
    const edgeNoRf = r.edgeApr + rf;
    if (Math.sign(r.volEdge) !== Math.sign(edgeNoRf) && Math.abs(edgeNoRf) > 1e-9 && Math.abs(r.volEdge) > 1e-9) {
      signBad.push(`${r.duration}/${r.strike}: σ ${pc(r.volEdge)} против APR ${pc(edgeNoRf)}`);
    }
  }
  ok('знаки премии по волатильности и по доходности согласованы', signBad.length === 0, signBad.slice(0, 3).join('; ') || 'ок');

  // Кривая «эквивалент цены опциона» на графике лестницы. Проверяем, что она
  // действительно получена из цены опциона, а не из чего-то ещё: обратный
  // пересчёт ставки в цену пута обязан вернуть исходную цену.
  let fairBad = 0;
  let fairWorst = 0;
  for (const r of buy) {
    if (!Number.isFinite(r.fairAprEff) || !(r.sigma > 0)) continue;
    const iFair = (r.fairAprEff * r.timing.lockDays) / YEAR_DAYS;
    const priceFromRate = (r.strike * iFair) / (1 + iFair);
    const priceDirect = black76Put(r.forward, r.strike, r.sigma, r.Teff);
    const rel = Math.abs(priceFromRate - priceDirect) / r.strike;
    fairWorst = Math.max(fairWorst, rel);
    if (rel > 1e-9) fairBad++;
  }
  ok('кривая справедливой ставки восстанавливает цену опциона', fairBad === 0, `максимальная невязка ${fairWorst.toExponential(2)}`);

  // Взаимное расположение двух кривых обязано совпадать со знаком премии:
  // ставка Bybit ниже справедливой ровно тогда, когда премия отрицательна.
  const orderBad = buy.filter(
    (r) =>
      Number.isFinite(r.fairAprEff) &&
      Number.isFinite(r.aprEff) &&
      Number.isFinite(r.volEdge) &&
      Math.abs(r.aprEff - r.fairAprEff) > 1e-9 &&
      Math.sign(r.aprEff - r.fairAprEff) !== Math.sign(r.volEdge),
  );
  ok('положение кривых согласовано со знаком премии', orderBad.length === 0, `расхождений ${orderBad.length}`);

  const sellSign = sell.filter((r) => {
    if (r.offerVol == null || !(r.i > 0)) return false;
    const target = (r.forward * r.i) / (1 + r.i);
    return Math.abs(black76Call(r.forward, r.strike, r.offerVol, r.Teff) - target) / r.forward > 1e-6;
  });
  ok('волатильность оферты Sell High решает своё уравнение', sellSign.length === 0, `нарушений ${sellSign.length}`);
}

// ─────────────────────────────────────────── 4. Поверхность волатильности

console.log('\n── 4. Поверхность волатильности');
{
  ok('экспирации собраны', surface.expiries.length >= 5, `${surface.expiries.length}`);
  let monoBad = 0;
  for (const e of surface.expiries) {
    for (let k = 1; k < e.smile.length; k++) if (e.smile[k].x <= e.smile[k - 1].x) monoBad++;
  }
  ok('улыбка упорядочена по страйкам', monoBad === 0);

  // Полная дисперсия обязана расти со сроком: иначе поверхность допускает
  // календарный арбитраж, и интерполяция даёт мнимую волатильность.
  let varBad = [];
  for (let T = 2 / 365; T < 0.9; T *= 1.6) {
    const a = volAt(surface, spot, spot, T);
    const b = volAt(surface, spot, spot, T * 1.6);
    if (a != null && b != null && b * b * T * 1.6 < a * a * T - 1e-9) {
      varBad.push(`T=${(T * 365).toFixed(1)}д`);
    }
  }
  ok('полная дисперсия не убывает со сроком (нет календарного арбитража)', varBad.length === 0, varBad.join(', ') || 'ок');

  const exact = buy.filter((r) => r.exactExpiry).length;
  ok('часть офёрт попадает точно в котируемую экспирацию', exact > 0, `${exact} из ${buy.length}`);

  let fwdBad = 0;
  for (const r of buy) if (!(r.forward > 0) || Math.abs(r.forward / spot - 1) > 0.5) fwdBad++;
  ok('форварды в разумных пределах', fwdBad === 0);
}

// ─────────────────────────────────────────── 5. Фронт Парето полным перебором

console.log('\n── 5. Фронт Парето: сверка с полным перебором');
{
  const usable = buy.filter((r) => Number.isFinite(r.pConv) && Number.isFinite(r.aprEff));
  // Доминирование: строго не хуже по обоим и строго лучше хотя бы по одному.
  const dominated = (a) =>
    usable.some((b) => b !== a && b.aprEff >= a.aprEff && b.pConv <= a.pConv && (b.aprEff > a.aprEff || b.pConv < a.pConv));

  const bruteFront = usable.filter((r) => !dominated(r));
  const modelFront = usable.filter((r) => r.pareto);

  const missing = bruteFront.filter((r) => !r.pareto);
  const extra = modelFront.filter((r) => dominated(r));
  ok('во фронте нет доминируемых оферт', extra.length === 0, `лишних ${extra.length}`);
  ok(
    'фронт совпадает с полным перебором',
    missing.length === 0,
    missing.length ? `пропущено ${missing.length}: ${missing.slice(0, 3).map((r) => `${r.duration}/${r.strike}`).join(', ')}` : `${modelFront.length} строк`,
  );

  // Каждая оферта вне фронта обязана быть побита кем-то из фронта.
  const uncovered = usable.filter(
    (a) => !a.pareto && !modelFront.some((b) => b.aprEff >= a.aprEff && b.pConv <= a.pConv),
  );
  ok('каждая оферта вне фронта побита офертой с фронта', uncovered.length === 0, `непокрытых ${uncovered.length}`);

  // Перекошенная оферта не может быть на фронте по построению: соседний страйк
  // того же продукта даёт и большую ставку, и меньший риск.
  ok(
    'перекосы лестницы не попадают на фронт',
    buy.filter((r) => r.laddered && r.pareto).length === 0,
    `перекошенных всего ${buy.filter((r) => r.laddered).length}`,
  );

  const steps = frontierWithMargins(buy, riskFree ?? 0);
  ok('фронт отсортирован по возрастанию риска', steps.every((r, k) => k === 0 || r.pConv >= steps[k - 1].pConv));
  ok('доходность вдоль фронта не убывает', steps.every((r, k) => k === 0 || r.aprEff >= steps[k - 1].aprEff - 1e-12));
  let margBad = 0;
  for (let k = 1; k < steps.length; k++) {
    const expected = (steps[k].aprEff - steps[k - 1].aprEff) / (steps[k].pConv - steps[k - 1].pConv);
    if (Math.abs(steps[k].marginal - expected) > 1e-9) margBad++;
  }
  ok('цена шага пересчитана верно', margBad === 0);
  ok(
    'первый шаг отсчитывается от безрисковой ставки',
    Math.abs(steps[0].gainApr - (steps[0].aprEff - (riskFree ?? 0))) < 1e-12,
  );
}

// ─────────────────────────────────────────── 6. Якоря

console.log('\n── 6. Якоря: сверка с полным перебором');
{
  const anchors = pickAnchors(buy);
  const maxBy = (key) => buy.filter((r) => Number.isFinite(r[key])).reduce((a, b) => (b[key] > a[key] ? b : a));

  for (const [id, key] of [
    ['market', 'volEdge'],
    ['money', 'edgeApr'],
    ['expected', 'expNetApr'],
    ['yield', 'aprEff'],
  ]) {
    const brute = maxBy(key);
    const got = anchors[id]?.row;
    ok(
      `якорь ${id} = максимум по ${key}`,
      got && Math.abs(got[key] - brute[key]) < 1e-12,
      `${got?.duration}/${got?.strike} ${pc(got?.[key])} против ${brute.duration}/${brute.strike} ${pc(brute[key])}`,
    );
  }

  // Проверка на скрытую ловушку: якорь может оказаться доминируемой офертой.
  const usable = buy.filter((r) => Number.isFinite(r.pConv) && Number.isFinite(r.aprEff));
  for (const [id, a] of Object.entries(anchors)) {
    if (!a) continue;
    const r = a.row;
    const better = usable.filter(
      (b) => b !== r && b.aprEff >= r.aprEff && b.pConv <= r.pConv && (b.aprEff > r.aprEff || b.pConv < r.pConv),
    );
    // Доминируемый якорь — не ошибка, но панель обязана об этом предупреждать.
    ok(
      `якорь ${id}: признак доминирования выставлен корректно`,
      Boolean(a.dominator) === better.length > 0,
      better.length ? `доминируется ${better.length} офертами, предупреждение ${a.dominator ? 'есть' : 'ОТСУТСТВУЕТ'}` : 'на фронте',
    );
    if (a.dominator) {
      console.log(
        `       якорь ${id} (${r.duration}/${r.strike}, APR ${pc(r.aprEff)}, P ${pc(r.pConv)}, страйк ${pc(r.moneyness)} от спота) ` +
          `побит ${a.dominator.duration}/${a.dominator.strike} (APR ${pc(a.dominator.aprEff)}, P ${pc(a.dominator.pConv)}, ` +
          `страйк ${pc(a.dominator.moneyness)} от спота)`,
      );
    }
  }
}

// ─────────────────────────────────────────── 7. Блок «Оптимальные Buy Low»

console.log('\n── 7. Отбор в блок «Оптимальные Buy Low»');
{
  for (const maxP of [0.05, 0.09, 0.15, 0.3]) {
    const best = pickBest({ rows: buy, maxP });
    const overThreshold = best.filter((r) => r.pConv > maxP);
    ok(`порог ${pc(maxP, 0)}: ни одна карточка не превышает порог`, overThreshold.length === 0, `${best.length} карточек`);

    // Внутри порога фронт подмножества обязан совпадать с глобальным фронтом,
    // ограниченным этим порогом: доминирующая оферта всегда имеет меньший риск,
    // а значит тоже проходит фильтр.
    const within = buy.filter((r) => Number.isFinite(r.pConv) && r.pConv <= maxP && Number.isFinite(r.aprEff));
    const globalFrontWithin = within.filter((r) => r.pareto);
    const shownFront = best.filter((r) => r.pareto);
    const missing = globalFrontWithin.filter((r) => !best.includes(r) && shownFront.length < 6);
    ok(
      `порог ${pc(maxP, 0)}: фронт внутри порога совпадает с глобальным`,
      missing.length === 0,
      `на фронте внутри порога ${globalFrontWithin.length}, показано ${shownFront.length}`,
    );
    ok(`порог ${pc(maxP, 0)}: в блоке только оферты с фронта`, best.every((r) => r.pareto));

    // Карточки обязаны идти по убыванию доходности.
    const sorted = best.every((r, k) => k === 0 || best[k - 1].aprEff >= r.aprEff);
    ok(`порог ${pc(maxP, 0)}: карточки упорядочены по доходности`, sorted);
  }

  // Наивысшая доходность внутри порога обязана быть первой карточкой.
  const maxP = 0.15;
  const best = pickBest({ rows: buy, maxP });
  const bestPossible = buy
    .filter((r) => Number.isFinite(r.pConv) && r.pConv <= maxP && Number.isFinite(r.aprEff))
    .reduce((a, b) => (b.aprEff > a.aprEff ? b : a));
  ok(
    'первая карточка — максимум доходности внутри порога',
    best[0] && Math.abs(best[0].aprEff - bestPossible.aprEff) < 1e-12,
    `${best[0]?.duration}/${best[0]?.strike} ${pc(best[0]?.aprEff)}`,
  );
}

// ─────────────────────────────────────────── 8. Согласованность строк

console.log('\n── 8. Внутренняя согласованность строк');
{
  let badMoneyness = 0;
  let badZ = 0;
  let badMoney = 0;
  let badProb = 0;
  for (const r of buy) {
    if (Math.abs(r.moneyness - (r.strike / spot - 1)) > 1e-12) badMoneyness++;
    // Страйк Buy Low котируется ниже цены на момент котировки, но спот идёт
    // потоком и за секунды может опуститься ниже страйка. Ловим только заметное
    // превышение, а не эту неизбежную рассинхронизацию.
    if (r.moneyness > 0.005) badZ++;
    if (r.money) {
      const expected = 10000 * (1 + r.i);
      if (Math.abs(r.money.payoutUsdt - expected) > 1e-9) badMoney++;
      if (Math.abs(r.money.btcIfConverted - expected / r.strike) > 1e-12) badMoney++;
    }
    if (r.pRN != null && (r.pRN < 0 || r.pRN > 1)) badProb++;
    if (r.pHist != null && (r.pHist < 0 || r.pHist > 1)) badProb++;
  }
  ok('удалённость от спота посчитана верно', badMoneyness === 0);
  ok('страйки Buy Low не выше спота более чем на 0.5%', badZ === 0, `нарушений ${badZ}`);
  ok('денежные величины согласованы со ставкой', badMoney === 0);
  ok('вероятности лежат в [0,1]', badProb === 0);

  // Осторожный режим берёт максимум там, где историческая оценка опирается на
  // достаточную выборку, и только рыночную там, где не опирается. Подробные
  // проверки обеих ветвей — в разделе 9.
  const measured = buy.filter((r) => r.pRN != null && r.pHist != null);
  const useMax = measured.every((r) => {
    const thinRow = r.histInfo != null && r.histInfo.independent < 30;
    const h = r.pHistScaled ?? r.pHist;
    const want = thinRow ? r.pRN : Math.max(r.pRN, h);
    return Math.abs(r.pConv - want) < 1e-12;
  });
  ok('осторожный режим учитывает вес исторической выборки', useMax, `проверено строк ${measured.length}`);

  // Монотонность внутри одного продукта: дальше страйк — ниже риск и ниже ставка.
  const byProduct = new Map();
  for (const r of buy) {
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push(r);
  }
  let monoP = [];
  let monoApr = [];
  for (const [pid, list] of byProduct) {
    const s = [...list].sort((a, b) => a.strike - b.strike);
    for (let k = 1; k < s.length; k++) {
      if (s[k].pRN != null && s[k - 1].pRN != null && s[k].pRN < s[k - 1].pRN - 1e-9) monoP.push(pid);
      if (s[k].apy < s[k - 1].apy - 1e-9) monoApr.push(`${s[k].duration}/${s[k].strike}`);
    }
  }
  ok('внутри продукта риск растёт со страйком', monoP.length === 0, `нарушений ${monoP.length}`);
  // Это свойство котировок биржи, а не расчёта: на длинных сроках Bybit
  // регулярно выдаёт лестницы, где более рискованный страйк платит меньше.
  // Панель такие оферты помечает, поэтому здесь достаточно учёта.
  const flagged = buy.filter((r) => r.laddered).length;
  ok(
    'перекосы лестницы найдены и помечены',
    flagged >= monoApr.length,
    `нарушений монотонности ${monoApr.length}, помечено оферт ${flagged}`,
  );
  console.log(
    `       примеры: ${monoApr.slice(0, 3).join(', ') || 'нет'} · доля помеченных ${((flagged / buy.length) * 100).toFixed(1)}%`,
  );
}

// ─────────────────────────────────────────── 9. Историческая мера

console.log('\n── 9. Историческая мера');
{
  const withHist = buy.filter((r) => r.histInfo);
  ok('историческая оценка посчитана для всех строк', withHist.length === buy.length, `${withHist.length} из ${buy.length}`);
  const thin = withHist.filter((r) => r.histInfo.independent < 20);
  console.log(
    `       глубина выборки: минимум ${Math.min(...withHist.map((r) => r.histInfo.independent)).toFixed(0)} ` +
      `независимых окон, строк с выборкой тоньше 20 окон: ${thin.length}`,
  );
  let shortfallBad = 0;
  for (const r of buy) {
    if (r.shortfall == null) continue;
    if (r.shortfall < 0 || r.shortfall > 1) shortfallBad++;
    // Ожидаемая потеря не может быть больше вероятности её наступления.
    if (r.pHist != null && r.shortfall > r.pHist + 1e-9) shortfallBad++;
  }
  ok('ожидаемая потеря не превышает вероятность конвертации', shortfallBad === 0, `нарушений ${shortfallBad}`);

  const scaled = buy.filter((r) => r.pHistScaled != null);
  ok(
    'нормированная историческая мера лежит в [0,1]',
    scaled.every((r) => r.pHistScaled >= 0 && r.pHistScaled <= 1),
    `строк ${scaled.length} из ${buy.length}`,
  );
  let monoScaled = 0;
  const groups = new Map();
  for (const r of scaled) {
    if (!groups.has(r.productId)) groups.set(r.productId, []);
    groups.get(r.productId).push(r);
  }
  for (const list of groups.values()) {
    const srt = [...list].sort((a, b) => a.strike - b.strike);
    for (let k = 1; k < srt.length; k++) if (srt[k].pHistScaled < srt[k - 1].pHistScaled - 1e-12) monoScaled++;
  }
  ok('нормированная мера растёт со страйком внутри продукта', monoScaled === 0, `нарушений ${monoScaled}`);
  const shrunk = scaled.filter((r) => r.pHistScaled < r.pHist).length;
  console.log(`       нормировка снизила вероятность у ${shrunk} строк из ${scaled.length}`);

  // Осторожный режим не должен опираться на историческую частоту там, где она
  // построена на горстке независимых окон.
  const thinSample = buy.filter((r) => r.histInfo && r.histInfo.independent < 30 && r.pRN != null && r.pHist != null);
  const thickSample = buy.filter((r) => r.histInfo && r.histInfo.independent >= 30 && r.pRN != null && r.pHist != null);
  ok(
    'тонкая историческая выборка исключена из осторожной оценки',
    thinSample.every((r) => Math.abs(r.pConv - r.pRN) < 1e-12),
    `строк с тонкой выборкой ${thinSample.length}`,
  );
  ok(
    'на плотной выборке осторожная оценка берёт максимум',
    thickSample.every((r) => Math.abs(r.pConv - Math.max(r.pRN, r.pHistScaled ?? r.pHist)) < 1e-12),
    `строк с плотной выборкой ${thickSample.length}`,
  );
}

// ─────────────────────────────────────────── 10. Блок Sell High

console.log('\n── 10. Sell High: себестоимость, безубыток, отбор');
{
  // Сценарий, который реально бывает: конвертация случилась выше рынка.
  const convStrike = spot * 1.06;
  const convApy = 0.4;
  const convDays = 1;
  const basis = basisFromConversion(convStrike, convApy, convDays);
  const qty = 0.2;

  // Себестоимость: за A долларов пришло A(1+i)/K монет, значит цена монеты K/(1+i).
  const iConv = interestRate(convApy, convDays);
  const spent = 10000;
  const gotBtc = (spent * (1 + iConv)) / convStrike;
  ok(
    'себестоимость = потрачено / получено',
    Math.abs(basis - spent / gotBtc) < 1e-9,
    `${basis.toFixed(2)} против ${(spent / gotBtc).toFixed(2)}`,
  );
  ok('себестоимость ниже страйка конвертации', basis < convStrike);

  const analyzed = analyzeSellHigh({ rows: sell, basis, qty, spot, history, measure: 'max' });

  // Признак безубыточности обязан совпадать с прямым сравнением денег.
  let flagBad = [];
  for (const r of analyzed) {
    const revenue = qty * (1 + r.i) * r.strike;
    const cost = qty * basis;
    const byMoney = revenue >= cost - 1e-9;
    if (byMoney !== r.profitable) flagBad.push(`${r.duration}/${r.strike}`);
  }
  ok('признак безубытка совпадает с прямым счётом денег', flagBad.length === 0, flagBad.slice(0, 3).join(', ') || 'ок');

  // Порог безубытка обязан быть ровно той точкой, где прибыль обращается в ноль.
  let beBad = 0;
  for (const r of analyzed) {
    const atBreakeven = qty * (1 + r.i) * r.breakeven - qty * basis;
    if (Math.abs(atBreakeven) > 1e-6) beBad++;
  }
  ok('на пороге безубытка прибыль равна нулю', beBad === 0, `нарушений ${beBad}`);

  ok(
    'выручка и прибыль согласованы',
    analyzed.every(
      (r) => Math.abs(r.usdtIfSold - qty * (1 + r.i) * r.strike) < 1e-9 && Math.abs(r.profitUsdt - (r.usdtIfSold - qty * basis)) < 1e-9,
    ),
  );
  ok(
    'запас над порогом согласован с прибылью по знаку',
    analyzed.every((r) => Math.sign(r.cushion) === Math.sign(r.profitUsdt) || Math.abs(r.profitUsdt) < 1e-6),
  );

  // Выплата Sell High: проданный колл. Сверяем оценку с Монте-Карло.
  const s = analyzed.find((r) => r.sigma > 0 && r.i > 0);
  if (s) {
    const mc = monteCarlo({ F: s.forward, K: s.strike, sigma: s.sigma, T: s.Teff, direction: 'SellHigh', i: s.i });
    const df = Math.exp((-(riskFree ?? 0) * s.timing.lockDays) / YEAR_DAYS);
    ok(
      'справедливая стоимость Sell High против Монте-Карло',
      Math.abs(mc.value * df - s.fairValue) < 1e-3,
      `аналитика ${s.fairValue.toFixed(6)}, Монте-Карло ${(mc.value * df).toFixed(6)}`,
    );
  }

  // Ожидаемая доходность Sell High обязана считаться от стоимости биткоина,
  // а не от единицы: иначе теряется весь исторический дрейф цены.
  const withHist = analyzed.filter((r) => r.expNetApr != null && r.shortfall != null);
  let driftBad = 0;
  for (const r of withHist.slice(0, 40)) {
    const h = history.returns(r.timing.tauDays);
    const meanGross = h ? h.sorted.reduce((a, x) => a + Math.exp(x), 0) / h.sorted.length : null;
    if (meanGross == null) continue;
    const expected = (((1 + r.i) * (meanGross - r.shortfall) - 1) * YEAR_DAYS) / r.timing.lockDays;
    if (Math.abs(expected - r.expNetApr) > 1e-9) driftBad++;
  }
  ok('ожидаемая доходность Sell High учитывает дрейф цены', driftBad === 0, `нарушений ${driftBad}`);

  // Циклы до безубытка: рост количества монет обязан закрывать разрыв.
  let recBad = [];
  for (const r of analyzed) {
    const rec = r.recovery;
    if (rec.cycles == null || rec.cycles === 0) continue;
    const grown = (1 + r.i) ** rec.cycles;
    if (grown < basis / spot - 1e-9) recBad.push(`${r.duration}/${r.strike}`);
    // Длительность обязана учитывать простой между окнами подписки.
    const expectedDays = r.timing.lockDays + (rec.cycles - 1) * r.timing.cycleDays;
    if (Math.abs(rec.days - expectedDays) > 1e-9) recBad.push(`срок ${r.duration}`);
  }
  ok('циклы до безубытка закрывают разрыв и учитывают простой', recBad.length === 0, recBad.slice(0, 3).join(', ') || 'ок');

  // Отбор в режиме выхода: фронт по максимуму обеих величин.
  const best = pickBestSell({ rows: analyzed });
  ok('режим определён верно', best.mode === (analyzed.some((r) => r.profitable) ? 'exit' : 'wait'), best.mode);
  if (best.mode === 'exit') {
    ok('в режиме выхода показаны только безубыточные', best.rows.every((r) => r.profitable));
    const pool = analyzed.filter(
      (r) => r.profitable && Number.isFinite(r.profitPct) && Number.isFinite(r.pExitHorizon),
    );
    const dominated = (a) =>
      pool.some(
        (b) =>
          b !== a &&
          b.profitPct >= a.profitPct &&
          b.pExitHorizon >= a.pExitHorizon &&
          (b.profitPct > a.profitPct || b.pExitHorizon > a.pExitHorizon),
      );
    const brute = pool.filter((r) => !dominated(r));
    const model = pool.filter((r) => r.sellPareto);
    ok(
      'фронт выхода совпадает с полным перебором',
      brute.length === model.length && brute.every((r) => r.sellPareto),
      `перебор ${brute.length}, модель ${model.length}`,
    );
  }

  // Тот же набор, но при недостижимой себестоимости: должен включиться режим ожидания.
  const deep = analyzeSellHigh({ rows: sell, basis: spot * 4, qty, spot, history, measure: 'max' });
  const waiting = pickBestSell({ rows: deep });
  ok('при недостижимой себестоимости включается режим ожидания', waiting.mode === 'wait');
  ok('в режиме ожидания риск минимален среди показанных', waiting.rows.every((r, k) => k === 0 || r.pConv >= waiting.rows[k - 1].pConv));
  const deepPool = deep.filter((r) => Number.isFinite(r.aprEff) && Number.isFinite(r.pConv));
  const waitDominated = (a) =>
    deepPool.some((b) => b !== a && b.aprEff >= a.aprEff && b.pConv <= a.pConv && (b.aprEff > a.aprEff || b.pConv < a.pConv));
  ok('в режиме ожидания показаны только недоминируемые', waiting.rows.every((r) => !waitDominated(r)));

  // Направление осторожной оценки вероятности.
  const exitRows = analyzed.filter((r) => r.pRN != null && r.pHist != null);
  const waitRows = deep.filter((r) => r.pRN != null && r.pHist != null);
  ok(
    'в режиме выхода осторожная вероятность — меньшая из двух',
    exitRows.every((r) => Math.abs(r.pConv - Math.min(r.pRN, r.pHist)) < 1e-12),
    `проверено ${exitRows.length}`,
  );
  ok(
    'в режиме ожидания осторожная вероятность — большая из двух',
    waitRows.every((r) => Math.abs(r.pConv - Math.max(r.pRN, r.pHist)) < 1e-12),
    `проверено ${waitRows.length}`,
  );

  // Перекосы лестницы на стороне Sell High: безопаснее — страйк выше.
  let ladderBad = [];
  const byProduct = new Map();
  for (const r of sell) {
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push(r);
  }
  for (const list of byProduct.values()) {
    const s2 = [...list].sort((a, b) => b.strike - a.strike);
    for (let k = 1; k < s2.length; k++) if (s2[k].apy < s2[k - 1].apy - 1e-9) ladderBad.push(`${s2[k].duration}/${s2[k].strike}`);
  }
  // Прибыль выхода — свойство самой оферты, а не размера позиции. Раньше она
  // считалась только при введённом количестве, и до ввода отбор был слеп.
  const noQty = analyzeSellHigh({ rows: sell, basis, qty: 0, spot, history, measure: 'max' });
  ok(
    'доходность выхода считается и без указанного количества',
    noQty.every((r) => Number.isFinite(r.profitPct)),
    `строк ${noQty.length}`,
  );
  ok(
    'прибыль выхода = (1+i)K/себестоимость − 1',
    analyzed.every((r) => Math.abs(r.profitPct - (((1 + r.i) * r.strike) / basis - 1)) < 1e-12),
  );

  // Горизонт выхода: приведение вероятностей к общему сроку.
  {
    const H = 90;
    const withH = analyzed.filter((r) => Number.isFinite(r.pExitHorizon));
    ok('шанс выхода посчитан для всех строк', withH.length === analyzed.length, `${withH.length} из ${analyzed.length}`);
    ok('шанс выхода лежит в [0,1]', withH.every((r) => r.pExitHorizon >= 0 && r.pExitHorizon <= 1));
    ok(
      'оферта длиннее горизонта не даёт шанса выйти',
      analyzed.filter((r) => r.timing.cycleDays > H).every((r) => r.pExitHorizon === 0),
      `таких оферт ${analyzed.filter((r) => r.timing.cycleDays > H).length}`,
    );
    // Чем выше страйк, тем труднее до него дойти.
    let mono = 0;
    const grp = new Map();
    for (const r of withH) {
      if (!grp.has(r.productId)) grp.set(r.productId, []);
      grp.get(r.productId).push(r);
    }
    for (const list of grp.values()) {
      const srt = [...list].sort((a, b) => a.strike - b.strike);
      for (let k = 1; k < srt.length; k++) if (srt[k].pExitHorizon > srt[k - 1].pExitHorizon + 1e-12) mono++;
    }
    ok('шанс выхода убывает со страйком', mono === 0, `нарушений ${mono}`);

    // Зависимость соседних циклов обязана снижать оценку против формулы
    // независимых попыток. Сравнение должно быть однородным по мере: рабочая
    // вероятность строки взята из рынка опционов, а траекторная оценка — из
    // истории, поэтому для формулы берём историческую же частоту за цикл.
    let cmp = 0;
    let higher = 0;
    let worst = 0;
    for (const r of withH) {
      const n = r.horizonInfo?.cycles ?? 0;
      if (n < 2 || !(r.pExitHorizon > 0)) continue;
      const cycleRet = history.returns(r.timing.cycleDays);
      if (!cycleRet?.sorted.length) continue;
      const pCycleHist = 1 - empiricalCdf(cycleRet.sorted, Math.log(r.strike / spot));
      if (!(pCycleHist > 0)) continue;
      const indep = 1 - (1 - pCycleHist) ** n;
      cmp++;
      const gap = r.pExitHorizon - indep;
      if (gap > 1e-9) higher++;
      worst = Math.min(worst, gap);
    }
    ok(
      'оценка по траекториям не выше формулы независимых попыток',
      higher === 0,
      `сравнено ${cmp}, выше у ${higher}, максимальное занижение ${(worst * 100).toFixed(1)} п.п.`,
    );

    // Фронт выхода упорядочен и цена шага пересчитана верно.
    const steps = exitFrontier(analyzed);
    ok('фронт выхода упорядочен по убыванию шанса', steps.every((r, k) => k === 0 || r[r.exitAxis] <= steps[k - 1][r.exitAxis] + 1e-12));
    ok('прибыль вдоль фронта выхода не убывает', steps.every((r, k) => k === 0 || r.profitPct >= steps[k - 1].profitPct - 1e-12));
    let margBad = 0;
    for (let k = 1; k < steps.length; k++) {
      const want = (steps[k].profitPct - steps[k - 1].profitPct) / (steps[k - 1][steps[k].exitAxis] - steps[k][steps[k].exitAxis]);
      if (Number.isFinite(want) && Math.abs(steps[k].marginal - want) > 1e-9) margBad++;
    }
    ok('цена шага на фронте выхода пересчитана верно', margBad === 0, `строк ${steps.length}`);
  }

  const flaggedSell = sell.filter((r) => r.laddered).length;
  ok(
    'перекосы лестницы Sell High помечены',
    flaggedSell >= ladderBad.length,
    `нарушений ${ladderBad.length}, помечено ${flaggedSell}`,
  );

  console.log(
    `       себестоимость ${basis.toFixed(2)} при споте ${spot.toFixed(2)} · безубыточных ${analyzed.filter((r) => r.profitable).length} из ${analyzed.length} · режим ${best.mode}`,
  );
}

console.log(`\nИтого: ${passed} успешно, ${failed} провалено`);
if (problems.length) {
  console.log('\nПроблемы:');
  for (const p of problems) console.log(`  · ${p}`);
}
process.exit(failed ? 1 : 0);
