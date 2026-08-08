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

/**
 * Обратная функция распределения: рациональное приближение Acklam плюс один
 * шаг уточнения Галлея по normCdf. Нужна для стресс-квантиля под мерой Q —
 * «насколько глубоко уйдёт цена в худших 5% исходов». Без уточнения Acklam
 * даёт относительную ошибку 1e-9, с уточнением — машинную точность.
 */
const ACK_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACK_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACK_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACK_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

export function normInv(p) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((ACK_C[0] * q + ACK_C[1]) * q + ACK_C[2]) * q + ACK_C[3]) * q + ACK_C[4]) * q + ACK_C[5]) /
      ((((ACK_D[0] * q + ACK_D[1]) * q + ACK_D[2]) * q + ACK_D[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((ACK_A[0] * r + ACK_A[1]) * r + ACK_A[2]) * r + ACK_A[3]) * r + ACK_A[4]) * r + ACK_A[5]) * q) /
      (((((ACK_B[0] * r + ACK_B[1]) * r + ACK_B[2]) * r + ACK_B[3]) * r + ACK_B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((ACK_C[0] * q + ACK_C[1]) * q + ACK_C[2]) * q + ACK_C[3]) * q + ACK_C[4]) * q + ACK_C[5]) /
      ((((ACK_D[0] * q + ACK_D[1]) * q + ACK_D[2]) * q + ACK_D[3]) * q + 1);
  }
  // Шаг Галлея: e — невязка по функции распределения, u — по плотности.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
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
export function valueOffer({ direction, strike, apy, timing, forward, sigma, riskFree = 0, riskFreeBtc = 0 }) {
  const i = interestRate(apy, timing.yieldDays);
  const T = Math.max(timing.tauDays, 0) / YEAR_DAYS;
  const Teff = twapEffectiveT(T);
  const K = strike;
  const F = forward;

  // Дисконтирование у двух направлений разное, и это не косметика.
  //
  // Buy Low вложен в USDT и в USDT же возвращается: ожидание выплаты надо
  // привести к сегодняшнему дню по долларовой ставке, причём на срок реального
  // удержания денег, а не на срок опциона — простой между сеттлментом и
  // зачислением тоже стоит денег.
  //
  // Sell High вложен в BTC, а его выплата нормируется на форвард. Деление на F
  // уже содержит рыночный дисконт: при нулевой ставке заимствования монеты
  // DF_T·F = S, то есть (F−C)/F — это и есть стоимость в долях сегодняшнего
  // биткоина. Умножать это ещё и на долларовый дисконт значит применить его
  // дважды. Правильная поправка здесь — ставка, под которую можно было бы
  // отдать сам биткоин, и только на срок, пока он заперт.
  const df =
    direction === 'BuyLow'
      ? Math.exp((-riskFree * Math.max(timing.lockDays, 0)) / YEAR_DAYS)
      : Math.exp((-riskFreeBtc * Math.max(timing.lockDays, 0)) / YEAR_DAYS);

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

// ─────────────────────────────────────────────────── глубина конвертации
//
// Вероятность конвертации отвечает только на вопрос «как часто», и этого мало.
// При одной и той же вероятности 7% восьмичасовая оферта теряет 0.04% капитала,
// а 236-дневная — 1.6%: у первой страйк в проценте от рынка, у второй в половине.
// Поэтому рядом с частотой нужна величина: сколько именно теряется в среднем,
// сколько теряется в тех случаях, когда конвертация всё-таки случилась, и
// насколько глубоко уходит цена в неудачных пяти процентах исходов.
//
// Для Buy Low потеря считается в долях вложенного USDT: конвертация отдаёт BTC
// по страйку, а рынок оценивает его в S_T, значит теряется (K − S_T)/K.
// Для Sell High симметрично — упущенный рост (S_T − K) в долях сегодняшней
// стоимости монеты.

export const STRESS_LEVEL = 0.05;

/** Профиль глубины под мерой Q: аналитически из тех же цен опционов. */
export function rnLossProfile({ direction, forward, strike, sigma, Teff, spot, level = STRESS_LEVEL }) {
  if (!(sigma > 0) || !(Teff > 0) || !(strike > 0) || !(forward > 0)) return null;
  const v = sigma * Math.sqrt(Teff);
  const d1 = (Math.log(forward / strike) + (v * v) / 2) / v;
  const d2 = d1 - v;
  const base = direction === 'BuyLow' ? strike : spot > 0 ? spot : forward;
  const price = direction === 'BuyLow' ? black76Put(forward, strike, sigma, Teff) : black76Call(forward, strike, sigma, Teff);
  const p = direction === 'BuyLow' ? normCdf(-d2) : normCdf(d2);
  // Квантиль цены сеттлмента под Q: S = F·exp(σ√T·z − σ²T/2).
  // Для Buy Low плохой исход — низкая цена, для Sell High — высокая.
  const z = normInv(direction === 'BuyLow' ? level : 1 - level);
  const sq = forward * Math.exp(v * z - (v * v) / 2);
  const stress = direction === 'BuyLow' ? Math.max(0, (strike - sq) / base) : Math.max(0, (sq - strike) / base);
  return {
    expected: price / base,
    conditional: p > 1e-9 ? price / base / p : null,
    stress,
  };
}

/** Профиль глубины по эмпирической выборке логарифмических доходностей. */
export function empiricalLossProfile(sorted, spot, strike, direction, level = STRESS_LEVEL) {
  if (!sorted?.length || !(spot > 0) || !(strike > 0)) return null;
  const base = direction === 'BuyLow' ? strike : spot;
  let acc = 0;
  let hits = 0;
  for (const r of sorted) {
    const s = spot * Math.exp(r);
    const loss = direction === 'BuyLow' ? Math.max(0, strike - s) : Math.max(0, s - strike);
    acc += loss;
    if (loss > 0) hits++;
  }
  const mean = acc / sorted.length;
  const p = hits / sorted.length;
  // Выборка отсортирована по возрастанию, поэтому нижний квантиль лежит слева,
  // верхний — справа. Индекс зажимаем: на короткой выборке края вырождаются.
  const idx = clamp(
    Math.floor((direction === 'BuyLow' ? level : 1 - level) * (sorted.length - 1)),
    0,
    sorted.length - 1,
  );
  const sq = spot * Math.exp(sorted[idx]);
  const stress = direction === 'BuyLow' ? Math.max(0, (strike - sq) / base) : Math.max(0, (sq - strike) / base);
  return { expected: mean / base, conditional: p > 1e-9 ? mean / base / p : null, stress };
}

/**
 * Сдвиг, приводящий выборку логарифмических доходностей к мартингалу:
 * после него E[S_T] = F, а не медиана. Без него центрирование на ln(F/S)
 * оставляет в распределении положительный снос: из-за выпуклости экспоненты
 * E[e^r] > e^{E[r]}, и на 236 днях среднее уезжает выше форварда на 5%, то
 * есть в меру риска молча зашивается прогноз роста BTC на 13% годовых.
 */
export function martingaleShift(shifted, targetGross) {
  if (!shifted?.length || !(targetGross > 0)) return 0;
  let acc = 0;
  for (const r of shifted) acc += Math.exp(r);
  const mean = acc / shifted.length;
  return mean > 0 ? Math.log(targetGross / mean) : 0;
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
 *
 * Возвращает `{ p, clamp }` либо null, если сказать нечего.
 *
 * Два места, где раньше выдавалась уверенность на пустом месте:
 *
 * 1. Вырожденный ряд. Если ставка за всё время наблюдений ни разу не сдвинулась,
 *    все квантили равны между собой, и прежнее `x <= values[0]` возвращало
 *    нижний уровень шкалы. То есть «оферта на минимуме за месяц» печаталось
 *    ровно там, где на самом деле «сравнивать не с чем». Замерено на живой
 *    доске: у оферт со ставкой ниже 0.5% годовых так вырождено до 40% корзин —
 *    далёкие страйки стоят на минимальной котировке биржи и не двигаются.
 *    Теперь такой ряд честно даёт null.
 *
 * 2. Упоры шкалы. За краями сетки квантилей вернуть можно только сам край,
 *    и «5» там означает «пятый перцентиль или ниже», а не ранг. Признак
 *    `clamp` доносит это до подписи, чтобы упор не выдавался за измерение.
 */
export function percentileFromQuantiles(levels, values, x) {
  if (!levels?.length || !values?.length || levels.length !== values.length) return null;
  const lo = values[0];
  const hi = values[values.length - 1];
  // Ряд без разброса не задаёт распределения: любое значение в нём и минимум,
  // и максимум одновременно.
  if (!(hi > lo)) return null;
  if (x <= lo) return { p: levels[0], clamp: 'low' };
  if (x >= hi) return { p: levels[levels.length - 1], clamp: 'high' };
  for (let k = 1; k < values.length; k++) {
    if (x <= values[k]) {
      const span = values[k] - values[k - 1];
      const w = span > 0 ? (x - values[k - 1]) / span : 0;
      return { p: levels[k - 1] + w * (levels[k] - levels[k - 1]), clamp: '' };
    }
  }
  return { p: levels[levels.length - 1], clamp: 'high' };
}

// ────────────────────────────────────────────── корзины архива ставок

/** Уровни, по которым считается сводка. */
export const QUANTILE_LEVELS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];

/** Квантили по порядковым статистикам с линейной интерполяцией. */
export function quantiles(sorted, levels = QUANTILE_LEVELS) {
  return levels.map((q) => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}

/**
 * Ключ корзины сводки перцентилей — ОДНА реализация на весь проект.
 *
 * Раньше их было три (web/archive.js, web/model.js, scripts/record.mjs) с
 * припиской «должны совпадать побайтово». Совпадение, которое держится на
 * дисциплине, рано или поздно ломается молча: сводка просто не находится.
 *
 * Срок берётся В СУТКАХ, а не меткой продукта, и это не косметика. Метка
 * `duration` — это дни до ФИКСИРОВАННОЙ даты сеттлмента, а дедлайн подписки
 * общий и сдвигается каждые сутки. Наблюдение на перекате 2026-08-08: из
 * десяти меток семь сменились за один такт (6d→5d, 13d→12d, 20d→19d, 48d→47d,
 * 83d→82d, 139d→138d, 230d→229d). На строковом ключе весь накопленный архив
 * этих продуктов осиротевал ежесуточно и сравнивать было не с чем.
 */
export function bucketKey(tenorDays, isVip, direction, moneyness) {
  const t = Number(tenorDays);
  if (!Number.isFinite(t) || t <= 0) return null;
  const half = Math.max(-60, Math.min(60, Math.round(moneyness * 200)));
  const dir = direction === 'BuyLow' || direction === 'B' ? 'B' : 'S';
  return `${t.toFixed(3)}|${isVip ? 1 : 0}|${dir}|${half}`;
}

/** Срок из ключа корзины — нужен, чтобы собирать соседние сроки вместе. */
export function tenorFromKey(key) {
  const t = Number(String(key).split('|')[0]);
  return Number.isFinite(t) ? t : null;
}

/**
 * Допуск по сроку при сборке корзины, в логарифме отношения.
 *
 * Замерено на живой доске (500 строк, снимок 2026-08-08): при ±15% в корзину
 * не подмешивается НИ ОДНОГО чужого продукта, а при ±20% подмешивание идёт у
 * 36 строк с разбросом ставки до ×2.41. При этом суточный сдвиг метки покрыт
 * с запасом: 20d→19d это 5.1%, 13d→12d 8.0%, 83d→82d 1.2%.
 *
 * Проверялись и более широкие постановки — полосы срока и переход с ставки на
 * σ-премию. Обе отвергнуты замером: полоса 3–7d смешивает 3d/5d/6d с разбросом
 * до ×5.7, а σ-премия внутри такой корзины расходится на 3–22 пункта
 * волатильности при медиане по доске −5.1. Узкая корзина плюс сбор соседних
 * сроков на сводке оказались единственным вариантом, который остаётся
 * однородным.
 */
export const TENOR_TOLERANCE = 0.15;

/**
 * Сводка перцентилей из сырых наблюдений.
 *
 * obs: [{ key, value, day }], где day — номер суток (UTC), чтобы порог считался
 * в РАЗНЫХ днях, а не в наблюдениях. Двадцать наблюдений подряд — это двадцать
 * минут открытой вкладки, и перцентиль по ним меряет не щедрость оферты, а то,
 * куда качнулся спот: замерено, что весь путь от 5-го до 95-го перцентиля на
 * таком архиве составляет 17 базисных пунктов ставки.
 */
export function summarizeBuckets(obs, { levels = QUANTILE_LEVELS, minN = 30, minDays = 3, tol = TENOR_TOLERANCE } = {}) {
  // Группируем по всему, кроме срока: внутри группы сроки соседствуют.
  const groups = new Map();
  for (const o of obs) {
    if (!o?.key || !Number.isFinite(o.value)) continue;
    const t = tenorFromKey(o.key);
    if (t == null) continue;
    const rest = o.key.slice(o.key.indexOf('|'));
    let g = groups.get(rest);
    if (!g) groups.set(rest, (g = []));
    g.push({ t, value: o.value, day: o.day, key: o.key });
  }

  const buckets = {};
  for (const list of groups.values()) {
    for (const key of new Set(list.map((o) => o.key))) {
      const t0 = tenorFromKey(key);
      const values = [];
      const days = new Set();
      for (const o of list) {
        if (Math.abs(Math.log(o.t / t0)) > tol) continue;
        values.push(o.value);
        days.add(o.day);
      }
      if (values.length < minN || days.size < minDays) continue;
      values.sort((a, b) => a - b);
      buckets[key] = { n: values.length, days: days.size, q: quantiles(values, levels) };
    }
  }
  return buckets;
}

/** Номер суток UTC — единица счёта «разных дней» в пороге корзины. */
export function utcDay(ts) {
  return Math.floor(ts / 86_400_000);
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

/**
 * Медиана набора. Рядом со средним она обязательна везде, где считается
 * стоимость по историческим траекториям BTC: распределение годовых исходов
 * настолько скошено, что среднее задаёт правый хвост. На пяти годах среднее
 * годовое удержание биткоина даёт +42%, а медианное — заметно меньше, и
 * показывать только первое значит обещать типичный исход по нетипичному.
 */
export function median(values) {
  if (!values?.length) return null;
  // Копия обязательна: сортировка на месте испортила бы попутевый порядок,
  // из которого стоимость и считалась.
  const copy = Float64Array.from(values);
  copy.sort();
  const mid = copy.length >> 1;
  return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}
