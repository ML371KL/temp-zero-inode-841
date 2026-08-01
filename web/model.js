// Сборка строк таблицы: из сырых котировок, опционной поверхности и истории
// цен получаются готовые к показу оферты со всеми метриками риска и доходности.
// Модуль без DOM — его же используют скрипты записи истории.

import {
  productTiming,
  interestRate,
  effectiveApr,
  chainedApr,
  valueOffer,
  moneynessZ,
  twapEffectiveT,
  logReturns,
  empiricalCdf,
  empiricalShortfall,
  empiricalMeanGross,
  percentileFromQuantiles,
  paretoFront,
  apyFromE8,
  basisFromConversion,
  breakevenStrike,
  cyclesToRecover,
  YEAR_DAYS,
} from './quant.js';
import { volAt, forwardAt, hasExactExpiry } from './surface.js';

/**
 * Историческое распределение доходностей.
 *
 * Ряды разной частоты покрывают разную глубину: часовой — месяцы,
 * четырёхчасовой — год-полтора, дневной — пять лет. Перекрывающиеся окна
 * создают иллюзию большой выборки: тысяча часовых окон по шесть дней внутри
 * трёхмесячного ряда — это порядка десятка независимых наблюдений и, по сути,
 * замер тренда последних месяцев. Поэтому ряд выбирается по максимальной
 * глубине истории при достаточном разрешении горизонта (не менее четырёх шагов),
 * а не по числу окон.
 */
export class History {
  constructor(series) {
    // series: { '60': {stepMs, series:[[ts,close]]}, '240': {...}, 'D': {...} }
    this.raw = series;
    this.cache = new Map();
  }

  pick(tauDays) {
    const candidates = [];
    for (const key of ['60', '240', 'D']) {
      const s = this.raw[key];
      if (!s || !s.series?.length || !s.stepMs) continue;
      const bars = Math.round((tauDays * 86_400_000) / s.stepMs);
      if (bars < 1) continue;
      const spanDays = (s.series.length * s.stepMs) / 86_400_000;
      candidates.push({ key, bars, spanDays, windows: s.series.length - bars, stepMs: s.stepMs });
    }
    if (!candidates.length) return null;
    // Разрешение: горизонт должен укладываться хотя бы в четыре шага ряда,
    // иначе округление до целых баров искажает сам горизонт.
    const resolved = candidates.filter((c) => c.bars >= 4 && c.windows > 30);
    const pool = resolved.length ? resolved : candidates.filter((c) => c.windows > 30);
    if (!pool.length) return null;
    return pool.sort((a, b) => b.spanDays - a.spanDays)[0];
  }

  /**
   * Экстремумы цены по контрольным точкам внутри горизонта.
   *
   * Отвечает на вопрос «если крутить одну и ту же оферту, дойдёт ли цена до
   * страйка хотя бы на одном из сеттлментов за горизонт H». Контрольные точки —
   * концы циклов: t + c, t + 2c, … пока укладываются в H.
   *
   * Считать это как 1 − (1 − p)^n нельзя: соседние циклы сильно зависимы, и
   * если рынок ушёл вниз и там остался, промахи идут подряд. Замер на пяти
   * годах BTC: формула независимости завышает шанс выхода на 10–22 процентных
   * пункта. Поэтому частота берётся прямо по историческим траекториям.
   *
   * Для каждого старта запоминается максимум и минимум отношения цены к
   * стартовой по всем контрольным точкам, ряды сортируются и кэшируются —
   * дальше вероятность для любого страйка это один двоичный поиск.
   */
  pathExtremes(cycleDays, horizonDays) {
    const n = Math.floor(horizonDays / cycleDays);
    if (!(n >= 1)) return null;
    const id = `path:${cycleDays.toFixed(4)}:${horizonDays}`;
    const cached = this.cache.get(id);
    if (cached) return cached;

    // Берём самый глубокий ряд, в котором цикл разрешается хотя бы одним баром.
    let best = null;
    for (const key of ['60', '240', 'D']) {
      const s = this.raw[key];
      if (!s?.series?.length || !s.stepMs) continue;
      const cycleBars = Math.round((cycleDays * 86_400_000) / s.stepMs);
      if (cycleBars < 1) continue;
      const spanDays = (s.series.length * s.stepMs) / 86_400_000;
      if (!best || spanDays > best.spanDays) best = { key, cycleBars, spanDays, series: s.series };
    }
    if (!best || best.series.length <= n * best.cycleBars) return null;

    const closes = best.series.map((r) => r[1]);
    // Нарастающий максимум по контрольным точкам: running[k] — распределение
    // максимума отношения цены к стартовой за первые k циклов. Отсюда сразу
    // берётся и шанс выйти к любому моменту внутри горизонта, и ожидаемое
    // время до выхода, причём для любого страйка это k двоичных поисков.
    const running = Array.from({ length: n }, () => []);
    for (let i = 0; i + n * best.cycleBars < closes.length; i++) {
      const s0 = closes[i];
      if (!(s0 > 0)) continue;
      let hi = -Infinity;
      for (let k = 1; k <= n; k++) {
        const v = closes[i + k * best.cycleBars] / s0;
        if (v > hi) hi = v;
        running[k - 1].push(hi);
      }
    }
    for (const arr of running) arr.sort((a, b) => a - b);
    const hit = {
      running,
      maxima: running[n - 1] ?? [],
      cycles: n,
      cycleDays,
      spanDays: best.spanDays,
      series: best.key,
      independent: cycleDays > 0 ? best.spanDays / (n * cycleDays) : null,
    };
    this.cache.set(id, hit);
    return hit;
  }

  /** Отсортированные логарифмические доходности на горизонте tauDays. */
  returns(tauDays) {
    const p = this.pick(tauDays);
    if (!p) return null;
    const id = `${p.key}:${p.bars}`;
    let hit = this.cache.get(id);
    if (!hit) {
      const closes = this.raw[p.key].series.map((r) => r[1]);
      const sorted = logReturns(closes, p.bars);
      // Среднее и разброс самой выборки: по ним она приводится к сегодняшнему
      // рынку. Считаем один раз вместе с рядом, чтобы не пересчитывать на
      // каждую строку таблицы.
      const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
      const variance =
        sorted.length > 1 ? sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (sorted.length - 1) : 0;
      hit = {
        sorted,
        mean,
        sigma: Math.sqrt(variance),
        key: p.key,
        bars: p.bars,
        spanDays: p.spanDays,
        // Сколько в выборке непересекающихся окон — честная мера её веса.
        independent: tauDays > 0 ? p.spanDays / tauDays : null,
      };
      this.cache.set(id, hit);
    }
    return hit;
  }
}

const SERIES_LABEL = { 60: '1ч', 240: '4ч', D: '1д' };

/**
 * Ключ корзины сводки перцентилей. Должен побайтово совпадать с
 * bucketKey из scripts/record.mjs — иначе сводка молча не найдётся.
 */
export function statsBucketKey(duration, isVip, direction, moneyness) {
  const half = Math.max(-60, Math.min(60, Math.round(moneyness * 200)));
  return `${duration}|${isVip ? 1 : 0}|${direction === 'BuyLow' ? 'B' : 'S'}|${half}`;
}

/**
 * Полный расчёт одной оферты (страйк + направление внутри продукта).
 */
export function buildRow({ product, level, direction, now, spot, surface, history, riskFree, amount, stats }) {
  const timing = productTiming(product, now);
  const strike = Number(level.selectPrice);
  const apy = apyFromE8(level.apyE8);
  const i = interestRate(apy, timing.yieldDays);
  const aprEff = effectiveApr(apy, timing.yieldDays, timing.lockDays);
  const aprChained = chainedApr(apy, timing.yieldDays, timing.cycleDays);

  const T = Math.max(timing.tauDays, 0) / YEAR_DAYS;
  const Teff = twapEffectiveT(T);
  const sigma = surface ? volAt(surface, spot, strike, T) : null;
  const forward = surface ? forwardAt(surface, spot, T) : spot;

  const valued =
    sigma > 0
      ? valueOffer({ direction, strike, apy, timing, forward, sigma, riskFree })
      : { pTriggerRN: null, offerVol: null, volEdge: null, edgeApr: null, fairValue: null, optionPrice: null };

  // Историческая частота срабатывания на том же горизонте.
  const hist = history ? history.returns(timing.tauDays) : null;
  let pHist = null;
  let pHistScaled = null;
  let shortfall = null;
  if (hist && hist.sorted.length) {
    const x = Math.log(strike / spot);
    const below = empiricalCdf(hist.sorted, x);
    pHist = direction === 'BuyLow' ? below : 1 - below;
    shortfall = empiricalShortfall(hist.sorted, spot, strike, direction);

    // Та же выборка, приведённая к сегодняшнему рынку.
    //
    // Сырая историческая частота описывает мир, в котором BTC ходил с
    // волатильностью около 52% годовых и рос на 12% в год. Сегодня рынок
    // опционов оценивает ближайшие дни в 17–25%. Подставлять в решение о
    // завтрашней оферте распределение пятилетней давности — значит мерить не
    // сегодняшний риск, а средний за пять лет.
    //
    // Поэтому у выборки убирается её собственный дрейф (направление прошлого —
    // плохой прогноз), масштаб приводится к текущей волатильности, а сносом
    // ставится сегодняшний форвард. Остаётся то, ради чего историю и берут:
    // форма распределения — толстые хвосты и асимметрия, которых нет у
    // логнормального приближения.
    if (sigma > 0 && hist.sigma > 0 && Teff > 0) {
      const k = (sigma * Math.sqrt(Teff)) / hist.sigma;
      const drift = Math.log(forward / spot);
      const shifted = hist.sorted.map((r) => (r - hist.mean) * k + drift);
      const belowScaled = empiricalCdf(shifted, x);
      pHistScaled = direction === 'BuyLow' ? belowScaled : 1 - belowScaled;
    }
  }

  // Ставка, которую платил бы рынок опционов за тот же риск, в тех же единицах
  // (эффективный APR). Разница с фактической офертой — это и есть премия Bybit.
  let fairAprEff = null;
  if (valued.optionPrice != null && timing.lockDays > 0) {
    const ratio = direction === 'BuyLow' ? valued.optionPrice / strike : valued.optionPrice / forward;
    if (ratio < 1) fairAprEff = ((ratio / (1 - ratio)) * YEAR_DAYS) / timing.lockDays;
  }

  // Ожидаемая чистая доходность по историческому распределению.
  //
  // Buy Low: выплата на вложенный доллар равна (1+i)·min(1, S/K), а её
  // ожидание — (1+i)(1 − E[(K−S)⁺]/K). Здесь единица берётся из того, что
  // вложен ровно доллар, и это точно.
  //
  // Sell High считается относительно другой базы: вложен BTC, стоящий сегодня
  // spot, а выплата равна (1+i)·min(S, K). Ожидание в долях сегодняшней
  // стоимости — (1+i)(E[S]/spot − E[(S−K)⁺]/spot). Подставлять сюда единицу
  // вместо E[S]/spot нельзя: это молча приравнивает ожидаемую цену BTC к
  // текущей и на длинных сроках занижает результат на весь исторический дрейф.
  let expNetApr = null;
  if (shortfall != null && timing.lockDays > 0) {
    let value = null;
    if (direction === 'BuyLow') {
      value = (1 + i) * (1 - shortfall);
    } else if (hist?.sorted.length) {
      const meanGross = empiricalMeanGross(hist.sorted);
      if (meanGross != null) value = (1 + i) * (meanGross - shortfall);
    }
    if (value != null) expNetApr = ((value - 1) * YEAR_DAYS) / timing.lockDays;
  }

  // Где текущая ставка стоит относительно того, что предлагалось за последний
  // месяц на таком же сроке и таком же расстоянии от спота.
  const moneyness = strike / spot - 1;
  let aprPercentile = null;
  let aprBucketN = null;
  if (stats?.buckets) {
    const bucket = stats.buckets[statsBucketKey(product.duration, product.isVipProduct, direction, moneyness)];
    if (bucket) {
      aprPercentile = percentileFromQuantiles(stats.quantileLevels, bucket.q, apy);
      aprBucketN = bucket.n;
    }
  }

  return {
    productId: product.productId,
    duration: product.duration,
    isVip: !!product.isVipProduct,
    direction,
    strike,
    apy,
    i,
    aprEff,
    aprChained,
    timing,
    maxInvest: Number(level.maxInvestmentAmount),
    quoteExpiresAt: Number(level.expiredAt),
    spot,
    forward,
    sigma,
    Teff,
    exactExpiry: surface ? hasExactExpiry(surface, timing.settle) : false,
    pRN: valued.pTriggerRN,
    pHist,
    pHistScaled,
    histInfo: hist
      ? {
          series: SERIES_LABEL[hist.key] || hist.key,
          n: hist.sorted.length,
          spanDays: hist.spanDays,
          independent: hist.independent,
        }
      : null,
    z: moneynessZ(spot, strike, sigma, Teff),
    moneyness,
    aprPercentile,
    aprBucketN,
    offerVol: valued.offerVol,
    volEdge: valued.volEdge,
    edgeApr: valued.edgeApr,
    fairValue: valued.fairValue,
    fairAprEff,
    shortfall,
    expNetApr,
    // Деньги на введённую сумму.
    money: computeMoney({ direction, amount, strike, i, spot }),
  };
}

function computeMoney({ direction, amount, strike, i, spot }) {
  if (!(amount > 0)) return null;
  if (direction === 'BuyLow') {
    const payout = amount * (1 + i);
    return {
      interest: payout - amount,
      payoutUsdt: payout,
      btcIfConverted: payout / strike,
      // Сколько стоит полученный BTC по сегодняшней цене — мера «бумажного» убытка,
      // если бы конвертация случилась прямо сейчас по этому страйку.
      btcValueAtSpot: (payout / strike) * spot,
    };
  }
  // Sell High: сумма задаётся в BTC.
  const payoutBtc = amount * (1 + i);
  return {
    interest: payoutBtc - amount,
    payoutBtc,
    usdtIfSold: payoutBtc * strike,
    btcValueAtSpot: payoutBtc * spot,
  };
}

// Ниже этого числа независимых окон историческая частота перестаёт быть
// оценкой чего-либо. При 8 наблюдениях стандартная ошибка вероятности около
// 10 процентных пунктов — такой оценке нельзя позволять управлять отбором.
export const MIN_INDEPENDENT_WINDOWS = 30;

/** Какую вероятность считать рабочей. */
export function pickProbability(row, measure) {
  const a = row.pRN;
  // В осторожном режиме сравниваем с нормированной историей: сырая описывает
  // волатильность пятилетней давности, а решение принимается про сегодня.
  const b = measure === 'hist' ? row.pHist : (row.pHistScaled ?? row.pHist);
  if (measure === 'rn') return a;
  if (measure === 'hist' || measure === 'hist-scaled') return b;
  if (a == null) return b;
  if (b == null) return a;
  // В осторожном режиме историческую оценку берём в расчёт только там, где под
  // ней есть выборка. На длинных сроках её нет: 237-дневных окон в пяти годах
  // помещается восемь штук, и «худшая из двух» превращалась бы в «случайная
  // из двух».
  const thin = row.histInfo != null && row.histInfo.independent < MIN_INDEPENDENT_WINDOWS;
  return thin ? a : Math.max(a, b);
}

/**
 * Сборка всех строк по направлению с учётом фильтров интерфейса.
 */
export function buildRows({ products, quotes, direction, now, spot, surface, history, riskFree, amount, vip, measure, stats }) {
  const rows = [];
  for (const product of products) {
    if (product.status !== 'Available') continue;
    if (product.isVipProduct && !vip) continue;
    const timing = productTiming(product, now);
    if (!timing.open) continue;
    // Расхождение метки срока и окна начисления означает, что модель тайминга
    // не описывает продукт. Показывать по нему доходность нельзя.
    if (!timing.labelMatches) continue;

    const quote = quotes.get(String(product.productId));
    if (!quote) continue;
    const levels = direction === 'BuyLow' ? quote.buyLowPrice : quote.sellHighPrice;
    for (const level of levels || []) {
      const row = buildRow({ product, level, direction, now, spot, surface, history, riskFree, amount, stats });
      row.pConv = pickProbability(row, measure);
      // Доходность на единицу риска: сколько эффективного APR приходится
      // на процент вероятности конвертации.
      row.aprPerRisk = row.pConv > 1e-6 && row.aprEff != null ? row.aprEff / row.pConv : null;
      row.excess = row.aprEff != null && riskFree != null ? row.aprEff - riskFree : null;
      rows.push(row);
    }
  }
  const front = paretoFront(rows, 'aprEff', 'pConv');
  for (const r of rows) r.pareto = front.has(r);
  markLadderInversions(rows);
  return rows;
}

/**
 * Перекосы внутри одной лестницы страйков.
 *
 * По смыслу инструмента ставка обязана расти по мере приближения страйка к
 * рынку: ближе страйк — выше шанс конвертации — выше плата за риск. На длинных
 * сроках Bybit это правило регулярно нарушает, и тогда соседний страйк даёт
 * одновременно меньший риск и большую ставку. Такая оферта бессмысленна:
 * тот же продукт, тот же срок, тот же сеттлмент — просто хуже по обоим
 * параметрам. Помечаем её и запоминаем, чем именно она побита.
 */
export function markLadderInversions(rows) {
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push(r);
  }
  for (const list of byProduct.values()) {
    for (const a of list) {
      // Для Buy Low безопаснее меньший страйк, для Sell High — больший.
      const safer = (b) => (a.direction === 'BuyLow' ? b.strike < a.strike : b.strike > a.strike);
      let best = null;
      for (const b of list) {
        if (b === a || !safer(b)) continue;
        if (b.apy >= a.apy - 1e-12 && (!best || b.apy > best.apy)) best = b;
      }
      a.laddered = best ? { strike: best.strike, apy: best.apy, row: best } : null;
    }
  }
  return rows;
}

/**
 * Отбор в блок «оптимальные варианты».
 * Порог риска задаёт пользователь; внутри порога берём фронт Парето —
 * набор, который нельзя улучшить по доходности, не увеличив риск.
 */
export function pickBest({ rows, maxP, limit = 6 }) {
  const eligible = rows.filter((r) => r.pConv != null && r.pConv <= maxP && r.aprEff != null);
  const front = paretoFront(eligible, 'aprEff', 'pConv');
  // Только фронт и ничего кроме фронта. Добор доминируемых оферт «для полноты»
  // противоречил самому назначению блока: показанная там оферта заведомо хуже
  // другой показанной оферты сразу по доходности и по риску.
  return eligible
    .filter((r) => front.has(r))
    .sort((a, b) => b.aprEff - a.aprEff)
    .slice(0, limit);
}

/**
 * Подбор Sell High под конкретную позицию в BTC.
 * basis — фактическая цена, по которой BTC попал на баланс. Порог безубытка
 * ниже себестоимости на величину начисляемого процента.
 */
export function analyzeSellHigh({ rows, basis, qty, spot, history, measure = 'max', horizonDays = 90 }) {
  const out = rows.map((r) => {
    const be = breakevenStrike(basis, r.apy, r.timing.yieldDays);
    const payoutBtc = qty > 0 ? qty * (1 + r.i) : null;
    const usdtIfSold = payoutBtc != null ? payoutBtc * r.strike : null;
    const spent = qty > 0 ? qty * basis : null;
    const rec = cyclesToRecover(
      basis,
      spot,
      r.apy,
      r.timing.yieldDays,
      r.timing.lockDays,
      r.timing.cycleDays,
    );

    // Ожидаемая выручка в USDT по историческому распределению:
    // E[(1+i)·min(S_T, K)] = (1+i)·(E[S_T] − E[(S_T − K)⁺]).
    let expReturnVsBasis = null;
    const hist = history ? history.returns(r.timing.tauDays) : null;
    if (hist?.sorted.length && r.shortfall != null && basis > 0 && r.timing.lockDays > 0) {
      const meanGross = empiricalMeanGross(hist.sorted);
      if (meanGross != null) {
        const expPerBtc = (1 + r.i) * spot * (meanGross - r.shortfall);
        expReturnVsBasis = ((expPerBtc / basis - 1) * YEAR_DAYS) / r.timing.lockDays;
      }
    }

    // Шанс выйти за общий горизонт, если крутить именно эту оферту.
    //
    // Без приведения к общему горизонту вероятности несравнимы: 47% за цикл в
    // 55 дней и 41% за цикл в 237 дней — это совершенно разные вещи, а фронт,
    // построенный по такой оси, механически вытаскивает наверх самые длинные
    // продукты. Здесь считается частота по историческим траекториям, поэтому
    // зависимость соседних циклов учтена.
    let pExitHorizon = null;
    let horizonInfo = null;
    let expExitDays = null;
    let expProfitRate = null;
    if (history && basis > 0) {
      const ext = history.pathExtremes(r.timing.cycleDays, horizonDays);
      if (ext && ext.maxima.length) {
        const ratio = r.strike / spot;
        pExitHorizon = 1 - empiricalCdf(ext.maxima, ratio);
        horizonInfo = { cycles: ext.cycles, n: ext.maxima.length, independent: ext.independent, series: ext.series };

        // Ожидаемое время до выхода, ограниченное горизонтом.
        //
        // Без него две оферты с одинаковой прибылью и одинаковым шансом выйти
        // выглядят равноценными, хотя одна освобождает капитал через неделю, а
        // другая через полгода. E[min(T, n)] = Σ P(T > k), а P(T > k) — это
        // доля траекторий, у которых нарастающий максимум за k циклов не достал
        // до страйка.
        let sum = 1;
        for (let k = 1; k < ext.cycles; k++) sum += empiricalCdf(ext.running[k - 1], ratio);
        expExitDays = sum * r.timing.cycleDays;
        if (expExitDays > 0) {
          // Ожидаемая доходность выхода в годовых: прибыль, взвешенная шансом
          // её получить, отнесённая к ожидаемому времени ожидания.
          expProfitRate = ((((1 + r.i) * r.strike) / basis - 1) * pExitHorizon * YEAR_DAYS) / expExitDays;
        }
      } else {
        // Цикл длиннее горизонта: за это время оферта просто не успевает
        // рассчитаться ни разу, и шанс выхода равен нулю.
        pExitHorizon = 0;
        horizonInfo = { cycles: 0, n: 0, independent: 0, series: null };
      }
    }

    return {
      ...r,
      breakeven: be,
      profitable: r.strike >= be,
      pExitHorizon,
      horizonInfo,
      expExitDays,
      expProfitRate,
      // Запас над порогом безубытка в процентах цены.
      cushion: be > 0 ? r.strike / be - 1 : null,
      payoutBtc,
      usdtIfSold,
      profitUsdt: usdtIfSold != null && spent != null ? usdtIfSold - spent : null,
      // Доходность выхода не зависит от размера позиции: продаётся (1+i) монеты
      // по цене K против себестоимости basis. Раньше она считалась только при
      // введённом количестве, из-за чего отбор до ввода количества был слеп.
      profitPct: basis > 0 ? ((1 + r.i) * r.strike) / basis - 1 : null,
      recovery: rec,
      expReturnVsBasis,
    };
  });

  const profitable = out.filter((r) => r.profitable);
  const exitMode = profitable.length > 0;

  // Осторожная оценка вероятности меняет направление вместе со смыслом
  // срабатывания. Пока выход безубыточен, продажа — желанный исход, и
  // осторожно предполагать меньшую из двух вероятностей. Как только выхода
  // нет, срабатывание означает продажу в убыток, и осторожно предполагать
  // большую. Режим «худшая из двух» брал максимум всегда и в первом случае
  // выдавал желаемое за действительное.
  if (measure === 'max') {
    for (const r of out) {
      if (r.pRN == null || r.pHist == null) continue;
      r.pConv = exitMode ? Math.min(r.pRN, r.pHist) : Math.max(r.pRN, r.pHist);
    }
  }

  // Фронт выхода строится по паре «прибыль от продажи — вероятность продажи».
  //
  // Раньше здесь стоял эффективный APR, механически перенесённый со стороны
  // Buy Low. Это была ошибка. Вдоль лестницы Sell High ставка и вероятность
  // срабатывания движутся в одну сторону: чем ниже страйк, тем и APR выше, и
  // продажа вероятнее. Пара из двух согласованных величин фронта почти не даёт
  // (на живых данных из 186 безубыточных оферт на нём оказывались две) и всегда
  // тянет к самому низкому страйку, то есть к минимальной выручке.
  //
  // Настоящий компромисс выхода другой: выше страйк — больше денег на руки, но
  // меньше шанс, что продажа состоится. Прибыль и вероятность действительно
  // тянут в разные стороны, и фронт по ним содержателен: те же данные дают 16
  // недоминируемых оферт с выручкой от долей процента до 36%.
  // Фронт строится по шансу выйти за общий горизонт, а не по вероятности за
  // цикл: только так оферты разных сроков сравнимы между собой.
  const axis = profitable.some((r) => Number.isFinite(r.pExitHorizon)) ? 'pExitHorizon' : 'pConv';
  // Оферты с нулевым шансом выйти за горизонт исключаются до построения фронта.
  // Формально самая прибыльная из них недоминируема — по прибыли её никто не
  // превосходит, — и она садилась на край фронта с обещанием +36% при шансе
  // получить их, равном нулю. Недоминируемость здесь вырождена: реализовать
  // такую прибыль за горизонт нельзя ни при каком исходе.
  const reachable = axis === 'pExitHorizon' ? profitable.filter((r) => r.pExitHorizon > 0) : profitable;
  const front = paretoFront(reachable, 'profitPct', axis, false);
  for (const r of out) r.sellPareto = front.has(r);

  // Убыточные уходят вниз: они не решают задачу выхода, даже если ставка выше.
  return out.sort(
    (a, b) => Number(b.profitable) - Number(a.profitable) || (b.aprEff ?? -1) - (a.aprEff ?? -1),
  );
}

/**
 * Фронт Парето целиком, от минимального риска к максимальному, с предельной
 * ценой риска для каждого шага.
 *
 * Предельная цена риска — это сколько процентных пунктов эффективного APR
 * добавляет один процентный пункт вероятности конвертации при переходе к
 * следующей точке фронта. Именно она отвечает на вопрос «стоит ли шагнуть
 * дальше»: на одних участках шаг почти бесплатен, на других за десятую долю
 * процента доходности приходится платить процентами риска.
 *
 * Первая точка сравнивается с безрисковой ставкой при нулевом риске.
 */
export function frontierWithMargins(rows, riskFree = 0) {
  const front = rows.filter((r) => r.pareto && Number.isFinite(r.pConv) && Number.isFinite(r.aprEff));
  front.sort((a, b) => a.pConv - b.pConv);
  let prevApr = riskFree;
  let prevP = 0;
  return front.map((r) => {
    const dP = r.pConv - prevP;
    const marginal = dP > 1e-9 ? (r.aprEff - prevApr) / dP : null;
    const step = { ...r, marginal, gainApr: r.aprEff - prevApr, gainP: dP };
    prevApr = r.aprEff;
    prevP = r.pConv;
    return step;
  });
}

/**
 * Ответы на вопрос «что оптимально в целом», не привязанные к ползунку.
 *
 * Их три, потому что единственного ответа не существует: «максимум доходности
 * при минимуме риска» — два критерия сразу, и выбор между ними зависит от того,
 * чем вы считаете конвертацию.
 *
 *  market — лучшая цена риска по рынку опционов, в пунктах волатильности.
 *           Величина безразмерная и потому сравнимая по всей поверхности, но
 *           она не говорит, сколько этот перекос стоит в деньгах.
 *  money  — та же премия, выраженная в годовой доходности на капитал. Учитывает
 *           вегу оферты и срок блокировки, поэтому ближе к решению «сколько я
 *           недополучаю в год». Ранговая корреляция с market около 0.4, то есть
 *           это действительно разные ответы, а не два вида одного.
 *  expected — максимум ожидаемой чистой доходности по исторической мере:
 *           процент минус ожидаемая потеря на конвертации.
 *  yield  — максимум эффективного APR. Осмысленно, если конвертация вас
 *           устраивает: то есть страйк — цена, по которой вы и так готовы купить.
 */
export function pickAnchors(rows) {
  const top = (key) => {
    const pool = rows.filter((r) => Number.isFinite(r[key]));
    return pool.length ? pool.reduce((a, b) => (b[key] > a[key] ? b : a)) : null;
  };

  // Якорь может оказаться доминируемой офертой: критерии у него свои, а пара
  // «доходность — вероятность» устроена иначе. Это не ошибка, но пользователь
  // обязан это видеть, поэтому ищем, чем именно якорь побит.
  const usable = rows.filter((r) => Number.isFinite(r.pConv) && Number.isFinite(r.aprEff));
  const dominatorOf = (r) => {
    if (!r || !Number.isFinite(r.pConv)) return null;
    const better = usable.filter(
      (b) => b !== r && b.aprEff >= r.aprEff && b.pConv <= r.pConv && (b.aprEff > r.aprEff || b.pConv < r.pConv),
    );
    return better.length ? better.reduce((a, b) => (b.aprEff > a.aprEff ? b : a)) : null;
  };

  const out = {};
  for (const [id, key] of [
    ['market', 'volEdge'],
    ['money', 'edgeApr'],
    ['expected', 'expNetApr'],
    ['yield', 'aprEff'],
  ]) {
    const row = top(key);
    out[id] = row ? { row, key, value: row[key], dominator: dominatorOf(row) } : null;
  }
  return out;
}

/**
 * Фронт выхода целиком, от самого вероятного к самому дорогому, с ценой шага.
 *
 * Цена шага здесь — сколько процентных пунктов прибыли добавляет отказ от
 * одного процентного пункта шанса выйти за горизонт. Зеркальный аналог цены
 * шага на стороне Buy Low, только платят здесь не риском, а вероятностью
 * того, что сделка вообще состоится.
 */
export function exitFrontier(rows, { limit = 0 } = {}) {
  const front = rows.filter((r) => r.profitable && r.sellPareto && Number.isFinite(r.profitPct));
  const key = front.some((r) => Number.isFinite(r.pExitHorizon)) ? 'pExitHorizon' : 'pConv';
  const sorted = [...front].sort((a, b) => b[key] - a[key]);
  let prev = null;
  const out = sorted.map((r) => {
    const dP = prev ? prev[key] - r[key] : null;
    const dProfit = prev ? r.profitPct - prev.profitPct : null;
    const step = { ...r, exitAxis: key, gainProfit: dProfit, costP: dP, marginal: dP > 1e-9 ? dProfit / dP : null };
    prev = r;
    return step;
  });
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Отбор в блок «оптимальные Sell High».
 *
 * Если безубыточные оферты есть — берём их фронт Парето: там срабатывание
 * желанно, значит максимизируем и ставку, и вероятность продажи.
 *
 * Если рынок ушёл ниже себестоимости и безубыточного выхода нет, знак риска
 * переворачивается обратно: сработавший страйк означает принудительную продажу
 * BTC дешевле, чем он был куплен. Поэтому здесь нужен фронт по максимуму ставки
 * при минимуме вероятности срабатывания — заработок в BTC без фиксации убытка.
 */
export function pickBestSell({ rows, limit = 6 }) {
  const profitable = rows.filter((r) => r.profitable && Number.isFinite(r.profitPct));
  if (profitable.length) {
    // Сортируем по вероятности продажи от большей к меньшей: сверху самый
    // реалистичный выход, ниже — всё более дорогие, но всё менее вероятные.
    const key = profitable.some((r) => Number.isFinite(r.pExitHorizon)) ? 'pExitHorizon' : 'pConv';
    const front = profitable.filter((r) => r.sellPareto).sort((a, b) => b[key] - a[key]);
    // Берём не край фронта, а равномерный срез по нему. Шесть первых строк —
    // это шесть самых вероятных и самых дешёвых выходов подряд, они отличаются
    // друг от друга на доли процента и прячут весь остальной размах: на живых
    // данных фронт тянется от +0.6% до +36% прибыли.
    if (front.length <= limit) return { mode: 'exit', axis: key, rows: front };
    const picked = [];
    for (let k = 0; k < limit; k++) {
      picked.push(front[Math.round((k * (front.length - 1)) / (limit - 1))]);
    }
    return { mode: 'exit', axis: key, rows: [...new Set(picked)] };
  }

  // Режим ожидания меряет риск тем же горизонтом, что и режим выхода: иначе
  // вероятности за цикл у пятидневного и у 237-дневного продукта сравнивались бы
  // напрямую, а это величины разной размерности. Здесь срабатывание страйка —
  // принудительная продажа ниже себестоимости, поэтому шанс минимизируется.
  const axis = rows.some((r) => Number.isFinite(r.pExitHorizon)) ? 'pExitHorizon' : 'pConv';
  const usable = rows.filter((r) => Number.isFinite(r.aprEff) && Number.isFinite(r[axis]));
  const front = paretoFront(usable, 'aprEff', axis, true);
  const waiting = usable
    .filter((r) => front.has(r))
    .sort((a, b) => a[axis] - b[axis])
    .slice(0, limit);
  for (const r of waiting) r.waitPareto = true;
  return {
    mode: 'wait',
    axis,
    rows: waiting.length ? waiting : usable.sort((a, b) => a[axis] - b[axis]).slice(0, limit),
  };
}
