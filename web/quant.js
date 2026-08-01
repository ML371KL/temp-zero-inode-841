// Ядро расчётов Dual Assets BTC/USDT.
// Модуль без DOM и без сети: одинаково исполняется в браузере и в Node (scripts/*.mjs).
// Все формулы задокументированы в docs/МАТЕМАТИКА.md — правки держать синхронными.

export const MS_DAY = 86_400_000;
export const YEAR_DAYS = 365;

// Окно усреднения цены сеттлмента: Bybit берёт среднюю спот-цену за 30 минут до 08:00 UTC.
export const TWAP_WINDOW_DAYS = 30 / (24 * 60);

// ────────────────────────────────────────────────────────────── статистика

// Нормальная функция распределения, алгоритм Hart (1968).
// Взят ради относительной точности в хвостах: наивные приближения дают 1e-7
// абсолютной ошибки, а нас интересуют вероятности порядка 1e-3 и меньше.
export function normCdf(x) {
  const z = Math.abs(x);
  let c;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.071067811865475) {
      let b = 0.0352624965998911 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 0.0883883476483184 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * b) / d;
    } else {
      let f = z + 0.65;
      f = z + 4 / f;
      f = z + 3 / f;
      f = z + 2 / f;
      f = z + 1 / f;
      c = e / (f * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

// ────────────────────────────────────────────────────────────── Блэк-76

// Цены без дисконтирования: это математическое ожидание выплаты под мерой Q.
// Дисконт применяется отдельно, на уровне оценки сделки, потому что срок
// удержания денег (до expectReceiveAt) не совпадает со сроком опциона (до settlementTime).
export function black76Put(F, K, sigma, T) {
  if (!(T > 0) || !(sigma > 0)) return Math.max(0, K - F);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + (v * v) / 2) / v;
  const d2 = d1 - v;
  return K * normCdf(-d2) - F * normCdf(-d1);
}

export function black76Call(F, K, sigma, T) {
  if (!(T > 0) || !(sigma > 0)) return Math.max(0, F - K);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + (v * v) / 2) / v;
  const d2 = d1 - v;
  return F * normCdf(d1) - K * normCdf(d2);
}

// Обратная задача: какая волатильность оправдывает данную премию.
// Цена монотонна по sigma, поэтому обычная бисекция надёжнее Ньютона на краях.
export function impliedVol(price, F, K, T, isCall) {
  const intrinsic = isCall ? Math.max(0, F - K) : Math.max(0, K - F);
  const upper = isCall ? F : K;
  if (!(T > 0) || !(price > intrinsic + 1e-12) || price >= upper) return null;
  const priceOf = (s) => (isCall ? black76Call(F, K, s, T) : black76Put(F, K, s, T));
  let lo = 1e-4;
  let hi = 5;
  if (priceOf(hi) < price) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (priceOf(mid) < price) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

// Дисперсия среднего по хвосту траектории меньше дисперсии точечной цены.
// Для среднего геометрического броуновского движения на отрезке [T-Δ, T]
// дисперсия логарифма ≈ σ²(T − 2Δ/3). На 8-часовых продуктах поправка
// срезает около 4% срока, на длинных незаметна, но считаем честно.
export function twapEffectiveT(T_years, windowDays = TWAP_WINDOW_DAYS) {
  const delta = windowDays / YEAR_DAYS;
  return Math.max(T_years - (2 * delta) / 3, T_years * 0.05, 1e-9);
}

// ────────────────────────────────────────────────────────────── тайминг продукта

const DURATION_RE = /^(\d+(?:\.\d+)?)([hd])$/i;

export function parseDuration(text) {
  const m = DURATION_RE.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'h' ? n / 24 : n;
}

/**
 * Разбор тайминга продукта — ключевое место всей панели.
 *
 * Проценты начисляются строго в окне [subscribeEndAt, settlementTime] и равны
 * номинальному сроку продукта, независимо от того, когда вы подписались.
 * Деньги при этом заперты с момента покупки и до expectReceiveAt
 * (сеттлмент + ~20 минут на перевод). Разница между этими двумя интервалами —
 * мёртвое время, за которое процент не платят.
 */
export function productTiming(product, now) {
  const subStart = Number(product.subscribeStartAt);
  const subEnd = Number(product.subscribeEndAt);
  const settle = Number(product.settlementTime);
  const receive = Number(product.expectReceiveAt);

  // Момент, с которого деньги реально уходят из-под контроля.
  const entry = Math.max(now, subStart);

  const yieldDays = (settle - subEnd) / MS_DAY; // окно начисления процентов
  const labelDays = parseDuration(product.duration);
  const lockDays = (receive - entry) / MS_DAY; // реальная блокировка капитала
  const tauDays = (settle - entry) / MS_DAY; // горизонт ценового риска
  const idleDays = lockDays - yieldDays; // мёртвое время

  // Длина цикла при непрерывном повторении оферты.
  //
  // Продукты каждого срока выпускаются раз в сутки, поэтому деньги, вернувшиеся
  // после сеттлмента, не могут сразу зайти в следующую такую же оферту: надо
  // дождаться закрытия очередного окна подписки. Для суточного продукта это
  // означает цикл в двое суток на одни сутки начисления, то есть вдвое меньшую
  // доходность, чем показывает разовая покупка перед самым закрытием окна.
  const k = Math.max(1, Math.ceil((receive - subEnd) / MS_DAY));
  const nextWindow = subEnd + k * MS_DAY;
  const cycleDays = (nextWindow - settle) / MS_DAY + yieldDays;

  return {
    cycleDays,
    entry,
    subStart,
    subEnd,
    settle,
    receive,
    yieldDays,
    labelDays,
    lockDays,
    tauDays,
    idleDays,
    // Доля срока, за которую действительно платят. 1.0 — идеал, 0.62 — типичный «1d».
    dilution: lockDays > 0 ? yieldDays / lockDays : 0,
    // Подписка ещё открыта? Даём 60 секунд запаса на дорогу ордера.
    open: now >= subStart && now < subEnd - 60_000,
    msToClose: subEnd - now,
    // Метка срока и фактическое окно начисления должны совпадать; расхождение —
    // повод не доверять расчёту, а не молча подставлять метку.
    labelMatches: labelDays == null ? false : Math.abs(labelDays - yieldDays) < 1e-6,
  };
}

// Простые проценты за номинальный срок: payout = amount × (1 + apy × D/365).
export function interestRate(apy, yieldDays) {
  return (apy * yieldDays) / YEAR_DAYS;
}

// Главная метрика панели: доходность, приведённая к реальному сроку блокировки.
export function effectiveApr(apy, yieldDays, lockDays) {
  if (!(lockDays > 0)) return null;
  return (apy * yieldDays) / lockDays;
}

/**
 * Доходность стратегии, которую крутят непрерывно: та же ставка, но
 * приведённая к длине полного цикла «подписка — сеттлмент — следующая подписка».
 * Отвечает на вопрос «сколько это даст в год, если делать так всё время»,
 * тогда как эффективный APR отвечает на вопрос «сколько даст эта конкретная
 * покупка прямо сейчас».
 */
export function chainedApr(apy, yieldDays, cycleDays) {
  if (!(cycleDays > 0)) return null;
  return (apy * yieldDays) / cycleDays;
}

// ────────────────────────────────────────────────────────────── оценка оферты

/**
 * Экономика одной оферты.
 *
 * Buy Low на сумму A USDT: к сеттлменту начислено A(1+i).
 *   S_T > K  → возвращают A(1+i) USDT
 *   S_T ≤ K  → возвращают A(1+i)/K биткоинов, что в USDT стоит A(1+i)·S_T/K
 * То есть выплата = A(1+i)·min(1, S_T/K) — это в точности проданный обеспеченный
 * пут со страйком K в количестве A(1+i)/K штук.
 *
 * Sell High на Q BTC: к сеттлменту начислено Q(1+i) BTC.
 *   S_T < K  → остаются Q(1+i) BTC
 *   S_T ≥ K  → возвращают Q(1+i)·K USDT
 * Выплата в USDT = Q(1+i)·min(S_T, K) — проданный колл со страйком K.
 */
export function valueOffer({ direction, strike, apy, timing, forward, sigma, riskFree = 0 }) {
  const i = interestRate(apy, timing.yieldDays);
  const T = Math.max(timing.tauDays, 0) / YEAR_DAYS;
  const Teff = twapEffectiveT(T);
  const K = strike;
  const F = forward;

  // Дисконт применяем на срок реального удержания денег, а не на срок опциона.
  const df = Math.exp((-riskFree * Math.max(timing.lockDays, 0)) / YEAR_DAYS);

  let fairPerUnit; // ожидание выплаты под Q, в единицах вложенного капитала
  let optionPrice = null;
  let pTrigger = null; // вероятность конвертации под мерой Q

  if (sigma > 0 && Teff > 0) {
    const v = sigma * Math.sqrt(Teff);
    const d1 = (Math.log(F / K) + (v * v) / 2) / v;
    const d2 = d1 - v;
    if (direction === 'BuyLow') {
      optionPrice = black76Put(F, K, sigma, Teff);
      fairPerUnit = (1 + i) * (1 - optionPrice / K);
      pTrigger = normCdf(-d2);
    } else {
      optionPrice = black76Call(F, K, sigma, Teff);
      fairPerUnit = ((1 + i) * (F - optionPrice)) / F;
      pTrigger = normCdf(d2);
    }
  }

  // Оферта, переведённая в волатильность: при какой sigma премия ровно справедлива.
  // Сравнение с рыночной sigma — самый чистый ответ на вопрос «дорого или дёшево».
  let offerVol = null;
  if (Teff > 0 && i > 0) {
    offerVol =
      direction === 'BuyLow'
        ? impliedVol((K * i) / (1 + i), F, K, Teff, false)
        : impliedVol((F * i) / (1 + i), F, K, Teff, true);
  }

  const fairValue = fairPerUnit == null ? null : fairPerUnit * df;
  // Премия сверх справедливой цены, приведённая к годовым на срок блокировки.
  const edgeApr =
    fairValue == null || !(timing.lockDays > 0)
      ? null
      : ((fairValue - 1) * YEAR_DAYS) / timing.lockDays;

  return {
    i,
    T,
    Teff,
    optionPrice,
    pTriggerRN: pTrigger,
    offerVol,
    marketVol: sigma ?? null,
    volEdge: offerVol != null && sigma > 0 ? offerVol - sigma : null,
    fairValue,
    edgeApr,
  };
}

// Расстояние до страйка в стандартных отклонениях. Отрицательное для Buy Low.
export function moneynessZ(spot, strike, sigma, Teff) {
  if (!(sigma > 0) || !(Teff > 0)) return null;
  return Math.log(strike / spot) / (sigma * Math.sqrt(Teff));
}

// ────────────────────────────────────────────────────────── эмпирика по свечам

/**
 * Эмпирическое распределение логарифмических доходностей на горизонте.
 * closes — равномерный ряд цен закрытия (по возрастанию времени),
 * bars — горизонт в шагах ряда. Окна перекрывающиеся: это смещает оценку
 * стандартной ошибки, но не саму частоту, а нам нужна именно частота.
 */
export function logReturns(closes, bars) {
  const out = [];
  for (let k = bars; k < closes.length; k++) {
    const a = closes[k - bars];
    const b = closes[k];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  out.sort((x, y) => x - y);
  return out;
}

// Доля выборки не выше x. Возвращает частоту, а не сглаженную оценку.
export function empiricalCdf(sorted, x) {
  if (!sorted.length) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/**
 * Ожидаемая величина конвертационного убытка по эмпирическому распределению.
 * Для Buy Low: E[(K − S_T)⁺]/K — доля вложенного капитала, теряемая на разнице
 * между страйком и рынком (BTC оценивается по рыночной цене сеттлмента).
 * Для Sell High симметрично: E[(S_T − K)⁺]/S — упущенный рост.
 */
export function empiricalShortfall(sorted, spot, strike, direction) {
  if (!sorted.length) return null;
  let acc = 0;
  for (const r of sorted) {
    const s = spot * Math.exp(r);
    acc += direction === 'BuyLow' ? Math.max(0, strike - s) : Math.max(0, s - strike);
  }
  const mean = acc / sorted.length;
  return direction === 'BuyLow' ? mean / strike : mean / spot;
}

// Среднее значение множителя цены на горизонте: E[S_T]/S_0 по выборке.
export function empiricalMeanGross(sorted) {
  if (!sorted.length) return null;
  let acc = 0;
  for (const r of sorted) acc += Math.exp(r);
  return acc / sorted.length;
}

/**
 * Положение значения в распределении, заданном набором квантилей.
 * Между узлами интерполируем линейно, за краями возвращаем 0 или 1:
 * утверждать «сегодняшняя ставка в 99-м перцентиле» на основании месяца
 * наблюдений всё равно нельзя точнее.
 */
export function percentileFromQuantiles(levels, values, x) {
  if (!levels?.length || !values?.length || levels.length !== values.length) return null;
  if (x <= values[0]) return levels[0];
  if (x >= values[values.length - 1]) return levels[levels.length - 1];
  for (let k = 1; k < values.length; k++) {
    if (x <= values[k]) {
      const span = values[k] - values[k - 1];
      const w = span > 0 ? (x - values[k - 1]) / span : 0;
      return levels[k - 1] + w * (levels[k] - levels[k - 1]);
    }
  }
  return levels[levels.length - 1];
}

// ─────────────────────────────────────────────────────────────── ранжирование

/**
 * Множество Парето по двум критериям.
 * По умолчанию: эффективный APR максимизируем, вероятность срабатывания
 * минимизируем — это ответ на «максимум доходности при минимуме риска»,
 * любая оферта вне фронта строго хуже какой-то оферты на фронте по обоим осям.
 *
 * Для уже конвертированной позиции знак второго критерия меняется: там
 * срабатывание Sell High означает желанный выход в USDT, и его вероятность
 * тоже максимизируется (minimizeSecond = false).
 */
export function paretoFront(rows, aprKey = 'aprEff', riskKey = 'pConv', minimizeSecond = true) {
  const usable = rows.filter((r) => Number.isFinite(r[aprKey]) && Number.isFinite(r[riskKey]));
  const sign = minimizeSecond ? 1 : -1;
  const sorted = [...usable].sort((a, b) => sign * (a[riskKey] - b[riskKey]) || b[aprKey] - a[aprKey]);
  const front = [];
  let best = -Infinity;
  for (const r of sorted) {
    if (r[aprKey] > best + 1e-12) {
      front.push(r);
      best = r[aprKey];
    }
  }
  return new Set(front);
}

// ────────────────────────────────────────────────────── себестоимость и Sell High

/**
 * Себестоимость BTC, полученного из сработавшего Buy Low.
 * Конвертируется не только тело, но и начисленный процент, поэтому фактическая
 * цена покупки ниже страйка: за A USDT приходит A(1+i)/K биткоинов,
 * то есть цена = K/(1+i).
 */
export function basisFromConversion(strike, apy, yieldDays) {
  const i = interestRate(apy, yieldDays);
  return strike / (1 + i);
}

/**
 * Минимальный страйк Sell High, при котором выход в USDT не убыточен.
 * Продаётся Q(1+i) BTC по цене K, выручка Q(1+i)K должна покрыть Q·basis,
 * отсюда K ≥ basis/(1+i). Проценты позволяют выходить и ниже себестоимости.
 */
export function breakevenStrike(basis, apy, yieldDays) {
  return basis / (1 + interestRate(apy, yieldDays));
}

/**
 * Сколько подряд идущих циклов Sell High при текущей ставке нужно, чтобы
 * накопленный процент в BTC закрыл разрыв между рынком и себестоимостью.
 * Считаем консервативно: цена стоит на месте, продажа не срабатывает,
 * растёт только количество BTC.
 */
export function cyclesToRecover(basis, spot, apy, yieldDays, lockDays, cycleDays = lockDays, maxCycles = 400) {
  const i = interestRate(apy, yieldDays);
  if (!(i > 0) || !(spot > 0) || !(basis > spot)) return { cycles: 0, days: 0 };
  const n = Math.log(basis / spot) / Math.log(1 + i);
  const cycles = Math.ceil(n);
  if (!Number.isFinite(cycles) || cycles > maxCycles) return { cycles: null, days: null };
  // Первый цикл идёт от сегодняшнего дня до зачисления, а каждый следующий —
  // полный оборот с простоем между окнами подписки. Считать все циклы по
  // сроку блокировки значило бы выбросить этот простой и обещать возврат
  // к безубытку заметно раньше, чем он наступит.
  return { cycles, days: lockDays + (cycles - 1) * cycleDays };
}

// ─────────────────────────────────────────────────────────────── утилиты

export function apyFromE8(e8) {
  return Number(e8) / 1e8;
}

// Bybit усекает выплату до точности монеты, а не округляет: в примере из
// документации 21.48389… превращается в 21.4838. Разница копеечная, но
// сверять расчёт с биржей нужно именно так.
export function truncate(x, digits) {
  const f = 10 ** digits;
  return Math.floor(x * f + 1e-9) / f;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
