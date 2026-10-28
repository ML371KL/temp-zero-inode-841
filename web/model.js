// Сборка строк таблицы: из сырых котировок, опционной поверхности и истории
// цен получаются готовые к показу оферты со всеми метриками риска и доходности.
// Модуль без DOM — его же используют скрипты записи истории.

import {
  productTiming,
  interestRate,
  effectiveApr,
  chainedApr,
  valueOffer,
  fairAprEffective,
  moneynessZ,
  twapEffectiveT,
  logReturns,
  empiricalCdf,
  empiricalShortfall,
  empiricalMeanGross,
  empiricalLossProfile,
  rnLossProfile,
  martingaleShift,
  prepareSample,
  sampleCdf,
  sampleLossProfile,
  percentileFromQuantiles,
  bucketKey,
  paretoFront,
  settlementSchedule,
  geoMean,
  apyFromE8,
  basisFromConversion,
  breakevenStrike,
  cyclesToRecover,
  median,
  STRESS_LEVEL,
  YEAR_DAYS,
} from './quant.js';
import { volAt, volSlopeAt, forwardAt, hasExactExpiry, forwardVol, surfaceAt } from './surface.js';

/**
 * Снимок опционов старше этого — такие же протухшие данные, как истёкшая
 * котировка: σ, форвард и вероятность стоят на рынке момента загрузки. Опционы
 * перезагружаются раз в минуту, три минуты — это два пропущенных обновления.
 */
export const OPTIONS_MAX_AGE_MS = 180_000;

/**
 * Оферта хуже бездействия: её эффективный APR ниже альтернативной ставки, или
 * за свой срок она платит меньше этой ставки с учётом начисления (σ оферты
 * нет). Второе — то же сравнение со сложным процентом за срок блокировки; оба
 * признака берутся, чтобы строка не оказалась на фронте с пометкой «ниже альт.
 * ставки».
 */
export function belowAltRate(r, riskFree) {
  return Boolean(r?.belowRiskFree) || (Number.isFinite(riskFree) && Number.isFinite(r?.aprEff) && r.aprEff < riskFree);
}

/**
 * Строка непригодна для рекомендаций: истекла её котировка или устарел снимок
 * опционов, на котором она посчитана. Одна проверка на все места отбора.
 */
export function isStale(r) {
  return Boolean(r?.quoteStale || r?.optionsStale);
}

/**
 * Первый цикл, на котором нарастающий максимум траектории дотянулся до цели.
 * Ряд не убывает по k, поэтому двоичный поиск. Возвращает 0-индекс цикла или −1.
 */
function firstHitUp(runMax, base, n, target) {
  if (!(runMax[base + n - 1] >= target)) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runMax[base + mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Стоимость за горизонт, приведённая к году. Геометрически, а не умножением на
 * 365/H: сравниваются именно множители капитала, и на длинных горизонтах разница
 * между двумя способами доходит до десятков процентных пунктов.
 */
export function annualize(value, horizonDays) {
  if (!(value > 0) || !(horizonDays > 0)) return null;
  return value ** (YEAR_DAYS / horizonDays) - 1;
}

/** То же для нарастающего минимума: ряд не возрастает, цель снизу. */
function firstHitDown(runMin, base, n, target) {
  if (!(runMin[base + n - 1] <= target)) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runMin[base + mid] <= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

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
let historySerial = 0;

export class History {
  constructor(series) {
    // Номер экземпляра: по нему траекторный слой отличает одну историю от
    // другой (после перезагрузки свечей ключ сценария может совпасть).
    this.uid = ++historySerial;
    // series: { '60': {stepMs, series:[[ts,close]]}, '240': {...}, 'D': {...} }
    this.raw = series;
    // Ключи здесь приведены к дискретным величинам — номерам баров и срокам, —
    // поэтому карта не растёт: она меняется, только когда меняется сам бар.
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
   * Попутевые ряды: для каждого исторического старта — нарастающие минимум и
   * максимум отношения цены к стартовой по контрольным точкам внутри горизонта
   * и цена в конце горизонта.
   *
   * Контрольные точки — моменты сеттлмента: τ, τ + c, τ + 2c, … пока
   * укладываются в H. Первая отстоит не на цикл, а на τ — время до сеттлмента
   * ИМЕННО ЭТОЙ оферты, которое короче цикла на остаток окна подписки. Ставить
   * первую точку на полный цикл значило бы пропускать реальный первый
   * сеттлмент и сдвигать по фазе все последующие; ошибка растёт к закрытию
   * окна, то есть ровно к тому моменту, когда панель и советует покупать.
   * Замер: до 1.5 п.п. по риску за горизонт и до 1.9 п.п. по годовой стоимости
   * стратегии, две фронтовые строки из двадцати.
   *
   * Тот же порядок уже соблюдается в cyclesToRecover, где первый оборот идёт по
   * сроку блокировки, а последующие по циклу.
   *
   * Оговорка: на дневном ряду τ округляется до целых суток, поэтому у
   * восьмичасового продукта (τ ≈ 0.5 суток) поправка вырождается — первая точка
   * и так приходится на первый бар.
   *
   * Считать вероятность как 1 − (1 − p)^n нельзя: соседние циклы сильно
   * зависимы, и если рынок ушёл вниз и там остался, промахи идут подряд. Замер
   * на пяти годах BTC: формула независимости завышает шанс на 10–22 процентных
   * пункта. Поэтому всё берётся прямо по траекториям.
   *
   * Хранение попутевое, а не отсортированное: сортированные ряды отвечают на
   * «какова вероятность», а для стоимости стратегии нужно другое — на каком
   * именно цикле сработал страйк у этой траектории и чего стоила монета в
   * конце. Обе формы строятся из одного прохода и кэшируются.
   */
  /**
   * Сценарий рынка: во что мы верим про будущее, вместо «прошлое повторится».
   *
   * История даёт форму движений — кластеры, толстые хвосты, асимметрию. Но её
   * дрейф и её размах относятся к прожитому режиму, а не к сегодняшнему. Здесь
   * задаются оба параметра явно:
   *
   *   cagr  — рост центральной линии, к которому приводится снос выборки;
   *   curve — срочная структура ATM-волатильности с рынка опционов.
   *
   * Смена сценария сбрасывает траекторные кэши: они целиком от него зависят.
   */
  useScenario({ cagr = null, curve = null, id = '' } = {}) {
    const key = `${cagr == null ? 'raw' : cagr.toFixed(6)}|${id}`;
    if (this.scenarioKey === key) return this;
    this.scenarioKey = key;
    this.scenario = { cagr, curve };
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith('scen:') || k.startsWith('paths:') || k.startsWith('sorted:') || k.startsWith('hold:')) {
        this.cache.delete(k);
      }
    }
    return this;
  }

  /**
   * Общий набор траекторий на горизонт — один на все оферты сразу.
   *
   * Это принципиально. Раньше каждый продукт получал собственную сетку, а
   * волатильность в оценке риска бралась из улыбки его собственного страйка.
   * Тогда две оферты сравнивались на разных мирах: у одной рынок «тише», у
   * другой «громче», и разница в отборе оказывалась артефактом улыбки, а не
   * свойством оферты. Здесь строится одна матрица цен, и каждая оферта лишь
   * снимает с неё свои контрольные точки.
   *
   * Как строится. Берутся исторические логарифмические приращения, у них
   * убирается собственный снос, и каждое приращение масштабируется под ту
   * волатильность, которую рынок опционов ждёт ИМЕННО НА ЭТОМ УЧАСТКЕ пути:
   *
   *   λ(j) = σ_форв(рынок, от (j−1)-го бара до j-го) / σ_истории
   *
   * Одного числа на весь горизонт мало: сегодня рынок оценивает первую неделю
   * в 33% годовых, а участок от 90 до 365 дней — в 44%. Масштабировать всё
   * одним множителем значило бы завысить ближний риск и занизить дальний.
   * Накопленная дисперсия пути к любой контрольной точке после этого равна
   * ровно рыночной w(T) — это проверяется тестом.
   *
   * Снос ставится равным заданному CAGR, и в конце делается точная нормировка:
   * из-за неравномерных весов λ остаточный снос выборки не уходит в ноль сам,
   * поэтому геометрическое среднее конечных значений досаживается на цель
   * ровно. Без этого просили 10.4% годовых, а получали 8.2%.
   */
  scenarioPaths(horizonDays) {
    if (!(horizonDays > 0)) return null;
    const id = `scen:${horizonDays}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;

    // Самый глубокий ряд, в который горизонт помещается целиком.
    let best = null;
    for (const key of ['60', '240', 'D']) {
      const s = this.raw[key];
      if (!s?.series?.length || !s.stepMs) continue;
      const bars = Math.round((horizonDays * 86_400_000) / s.stepMs);
      if (bars < 1 || s.series.length <= bars + 1) continue;
      const spanDays = (s.series.length * s.stepMs) / 86_400_000;
      if (!best || spanDays > best.spanDays) best = { key, bars, spanDays, series: s.series, stepMs: s.stepMs };
    }
    if (!best) {
      this.cache.set(id, null);
      return null;
    }

    const closes = best.series.map((r) => r[1]);
    const lr = [];
    for (let i = 1; i < closes.length; i++) {
      lr.push(closes[i] > 0 && closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
    }
    const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
    const varBar = lr.reduce((a, b) => a + (b - mean) ** 2, 0) / (lr.length - 1);
    const barYears = best.stepMs / 86_400_000 / YEAR_DAYS;
    const histVol = Math.sqrt(varBar / barYears);
    const hb = best.bars;
    const curve = this.scenario?.curve ?? null;
    // Падение на сто процентов и глубже — не сценарий, а неверный ввод:
    // логарифм ушёл бы в минус бесконечность и все траектории стали бы NaN.
    // Такой сценарий отбрасывается целиком, ряд остаётся историческим.
    const asked = this.scenario?.cagr ?? null;
    const cagr = asked != null && asked > -1 && Number.isFinite(asked) ? asked : null;

    // Множители по участкам пути: чем дальше точка, тем свою форвардную
    // волатильность рынок ей и приписывает.
    const lam = new Float64Array(hb + 1);
    for (let j = 1; j <= hb; j++) {
      const fv = curve ? forwardVol(curve, (j - 1) * barYears, j * barYears) : null;
      // Нулевой или неопределённый множитель означает отсутствие данных, а не
      // отсутствие риска. В таком случае участок остаётся историческим.
      lam[j] = fv > 0 && histVol > 0 ? fv / histVol : 1;
    }
    const drift = cagr == null ? mean : Math.log(1 + cagr) * barYears;

    const starts = [];
    for (let i = 0; i + hb < closes.length; i++) if (closes[i] > 0) starts.push(i);
    const paths = starts.length;
    if (!paths) {
      this.cache.set(id, null);
      return null;
    }

    const width = hb + 1;
    const logs = new Float64Array(paths * width);
    for (let p = 0; p < paths; p++) {
      const i0 = starts[p];
      let cum = 0;
      for (let j = 1; j <= hb; j++) {
        cum += (lr[i0 + j - 1] - mean) * lam[j] + drift;
        logs[p * width + j] = cum;
      }
    }
    // Точная посадка геометрического среднего на цель. Только когда цель
    // задана: без сценария ряд должен оставаться ровно тем, что пришло с биржи,
    // иначе «сырой» режим перестал бы быть сырым.
    let resid = 0;
    if (cagr != null) {
      let acc = 0;
      for (let p = 0; p < paths; p++) acc += logs[p * width + hb];
      resid = hb * drift - acc / paths;
    }
    const ratio = new Float64Array(paths * width);
    for (let p = 0; p < paths; p++) {
      ratio[p * width] = 1;
      for (let j = 1; j <= hb; j++) ratio[p * width + j] = Math.exp(logs[p * width + j] + (resid * j) / hb);
    }

    const hit = {
      ratio,
      width,
      paths,
      bars: hb,
      barDays: best.stepMs / 86_400_000,
      horizonDays,
      spanDays: best.spanDays,
      series: best.key,
      histVol,
      scenarioVol: curve ? forwardVol(curve, 0, horizonDays / YEAR_DAYS) : histVol,
      cagr,
      independent: best.spanDays / horizonDays,
    };
    this.cache.set(id, hit);
    return hit;
  }

  pathSeries(firstDays, cycleDays, horizonDays) {
    if (!(cycleDays > 0) || !(firstDays > 0)) return null;
    // Сколько сеттлментов помещается в горизонт: первый через τ, дальше через
    // цикл. Если до первого дальше, чем весь горизонт, оферта не рассчитается
    // ни разу.
    const n = horizonDays < firstDays ? 0 : 1 + Math.floor((horizonDays - firstDays) / cycleDays);
    if (!(n >= 1)) return null;

    // Траектории общие для всех оферт: здесь мы только снимаем с них свои
    // контрольные точки. Первая — на τ, дальше через цикл; всё округляется до
    // баров ряда, потому что доли своего шага ряд не разрешает.
    const base = this.scenarioPaths(horizonDays);
    if (!base) return null;
    const paths = base.paths;
    const cycleBars = Math.max(1, Math.round(cycleDays / base.barDays));
    const firstBars = Math.max(1, Math.round(firstDays / base.barDays));
    if (firstBars > base.bars) return null;

    // Ключ кэша строится по УЖЕ ОКРУГЛЁННЫМ барам, а не по сырым суткам.
    // τ убывает непрерывно, и ключ вида firstDays.toFixed(4) менялся каждые
    // восемь секунд: за час набегали сотни матриц по несколько мегабайт, и все
    // оставались в памяти. По барам ключ стабилен целые сутки.
    const id = `paths:${horizonDays}:${firstBars}:${cycleBars}:${n}`;
    let heavy = this.cache.get(id);
    if (heavy === undefined) {
      const runMin = new Float64Array(paths * n);
      const runMax = new Float64Array(paths * n);
      const terminal = new Float64Array(paths);
      for (let p = 0; p < paths; p++) {
        const row = p * base.width;
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < n; k++) {
          const v = base.ratio[row + Math.min(base.bars, firstBars + k * cycleBars)];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          runMin[p * n + k] = lo;
          runMax[p * n + k] = hi;
        }
        terminal[p] = base.ratio[row + base.bars];
      }
      heavy = { runMin, runMax, terminal };
      this.cache.set(id, heavy);
    }

    // Тяжёлые массивы кэшируются по барам, а точные в сутках величины считаются
    // на каждый вызов: они дёшевы, а округлять их до бара было бы враньём.
    return {
      runMin: heavy.runMin,
      runMax: heavy.runMax,
      terminal: heavy.terminal,
      paths,
      cycles: n,
      firstDays,
      cycleDays,
      horizonDays,
      // Когда случается последний смоделированный сеттлмент и сколько после
      // него остаётся незакрытого хвоста горизонта.
      modeledDays: firstDays + (n - 1) * cycleDays,
      tailDays: Math.max(0, horizonDays - (firstDays + (n - 1) * cycleDays)),
      // Куда контрольные точки легли после округления до баров ряда. Рядом с
      // firstDays это показывает, какое разрешение реально доступно: на дневном
      // ряду τ = 1.2 суток и τ = 0.8 суток дают одну и ту же первую точку.
      firstCheckpointDays: firstBars * base.barDays,
      cycleCheckpointDays: cycleBars * base.barDays,
      barDays: base.barDays,
      // Вес выборки меряется горизонтом, а не длиной цикла: наблюдение здесь —
      // это целое окно длиной H, и непересекающихся окон в истории ровно
      // столько, сколько горизонтов в неё помещается.
      independent: base.independent,
      spanDays: base.spanDays,
      series: base.series,
    };
  }

  /**
   * Те же контрольные точки, но отсортированные: running[k] — распределение
   * нарастающего максимума за первые k+1 циклов, runningDown[k] — минимума.
   * Вероятность для любого страйка после этого — один двоичный поиск.
   */
  pathExtremes(firstDays, cycleDays, horizonDays) {
    const base = this.pathSeries(firstDays, cycleDays, horizonDays);
    if (!base) return null;
    // Ключ, как и у попутевых рядов, по округлённым барам: сортированные ряды
    // выводятся из них однозначно.
    const id = `sorted:${horizonDays}:${Math.round(base.firstCheckpointDays / base.barDays)}:${Math.round(
      base.cycleCheckpointDays / base.barDays,
    )}:${base.cycles}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const n = base.cycles;
    const running = [];
    const runningDown = [];
    for (let k = 0; k < n; k++) {
      const up = new Float64Array(base.paths);
      const down = new Float64Array(base.paths);
      for (let p = 0; p < base.paths; p++) {
        up[p] = base.runMax[p * n + k];
        down[p] = base.runMin[p * n + k];
      }
      up.sort();
      down.sort();
      running.push(up);
      runningDown.push(down);
    }
    const hit = {
      running,
      runningDown,
      maxima: running[n - 1],
      minima: runningDown[n - 1],
      cycles: n,
      firstDays,
      cycleDays,
      paths: base.paths,
      spanDays: base.spanDays,
      series: base.series,
      independent: base.independent,
    };
    this.cache.set(id, hit);
    return hit;
  }

  /**
   * Множитель цены за горизонт при простом удержании BTC — база сравнения,
   * без которой стоимость любой стратегии нечитаема: на пятилетней выборке
   * биткоин сам по себе рос, и часть результата любой конфигурации это просто
   * он. Считается по самому глубокому ряду.
   */
  holdGross(horizonDays) {
    const id = `hold:${horizonDays}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    // База считается по ТЕМ ЖЕ траекториям, что и стратегии, иначе сравнение
    // велось бы с другим рынком: у баз был бы прожитый режим, а у стратегий —
    // сценарный.
    const base = this.scenarioPaths(horizonDays);
    if (!base) {
      this.cache.set(id, null);
      return null;
    }
    const all = new Float64Array(base.paths);
    let acc = 0;
    let accLog = 0;
    for (let p = 0; p < base.paths; p++) {
      const v = base.ratio[p * base.width + base.bars];
      all[p] = v;
      acc += v;
      accLog += Math.log(v);
    }
    const hit = {
      gross: acc / base.paths,
      grossMedian: median(all),
      // Геометрическое — то, во что превратится капитал при удержании, а не
      // среднее по эпизодам. Именно оно сопоставимо с геометрическим стратегий.
      grossGeo: Math.exp(accLog / base.paths),
      n: base.paths,
      series: base.series,
      spanDays: base.spanDays,
    };
    this.cache.set(id, hit);
    return hit;
  }

  /**
   * Историческая выборка, приведённая к сегодняшнему рынку и центрированная
   * мартингально. Кэшируется: внутри одного продукта строки отличаются только
   * волатильностью улыбки, а сама выборка одна на весь горизонт.
   */
  scaled(tauDays, sigma, Teff, gross) {
    const hist = this.returns(tauDays);
    if (!hist?.sorted.length || !(sigma > 0) || !(hist.sigma > 0) || !(Teff > 0) || !(gross > 0)) return null;
    // Намеренно без кэша.
    //
    // Результат зависит от масштаба и сноса, а те — от времени до сеттлмента и
    // от спота, то есть от величин непрерывных. Ключ был бы новым на каждом
    // кадре, и карта росла бы неограниченно: замер показал девять гигабайт за
    // час работы вкладки. Округление ключа снимало бы рост, но ломало точное
    // тождество E[S_T] = F — а выигрыш от кэша всего 2.5 мс на кадр из 35.
    // Точность формулы дороже.
    const k = (sigma * Math.sqrt(Teff)) / hist.sigma;
    const drift = Math.log(gross);
    // Масштаб — к сегодняшней волатильности, снос — к сегодняшнему форварду.
    // Аффинное преобразование монотонно, поэтому порядок сохраняется и
    // пересортировывать ряд не нужно.
    const shifted = hist.sorted.map((r) => (r - hist.mean) * k + drift);
    // Мартингальная поправка: без неё E[S_T] уезжает выше форварда из-за
    // выпуклости экспоненты, и в меру риска попадает молчаливый прогноз роста.
    const fix = martingaleShift(shifted, gross);
    return fix === 0 ? shifted : shifted.map((r) => r + fix);
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
        // Та же выборка, подготовленная к ответам за O(log n) на строку.
        prep: prepareSample(sorted),
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
 * Рост центральной линии выборки: среднее логарифмического прироста за бар,
 * приведённое к году. Одно число на всю историю, одинаковое на любом горизонте.
 *
 * Именно логарифмическое среднее, а не арифметическое и не наклон регрессии.
 * Арифметическое на скошенном распределении завышено на всю волатильность: на
 * живых данных оно даёт 29.6% годовых там, где логарифмическое даёт 13.5%.
 * Лог-регрессия на пятилетнем окне непригодна — 31% при R² около 0.5 и линия на
 * 36% выше сегодняшней цены. Наклон Тейла — Сена на этих данных даёт 33%: медиана
 * попарных наклонов ловит короткие отрезки внутри роста 2024–26, потому что
 * выборка начинается в медвежьей фазе, а кончается в бычьей.
 *
 * ПОЧЕМУ БОЛЬШЕ НЕ ПО ОКНАМ ДЛИНОЙ С ГОРИЗОНТ. Прежняя версия усредняла прирост
 * по перекрывающимся окнам длиной H. В замкнутой форме это
 *
 *     (Σ последних H логов цены − Σ первых H логов) / (N − H),
 *
 * то есть наклон между средним лог-уровнем первых H дней и последних H дней,
 * делённый на расстояние между центрами окон, — двухточечная оценка со
 * сглаженными концами, а вовсе не среднее по многим наблюдениям. Отсюда
 * зависимость от H, и она оказалась разрушительной: на одном и том же ряду
 * 13.0% при H=30, 8.1% при 180, 18.9% при 365, 29.0% при 500. Переключение
 * горизонта меняло не срок расчёта, а предпосылку о рынке, и числа блока
 * стратегии прыгали 21.7 → 17.6 → 27.1 без всякого содержательного повода.
 *
 * Замена не точнее: стандартная ошибка ЛЮБОЙ оценки дрейфа на этой выборке
 * равна σ/√T = 52.5%/√5.09 = 23.3% годовых, и весь прежний разброс укладывался
 * в 0.9 этой ошибки. Смысл замены в другом: величина не должна меняться, когда
 * пользователь двигает посторонний регулятор. Побочно ушёл и свободный параметр —
 * длина окна сглаживания, выбор которой был произволен (30 дней дают 13.0%,
 * 60 дней — 9.7%).
 *
 * Считается по сырой истории, без сценария: это отправная точка, от которой
 * пользователь задаёт свой взгляд, а не результат его же взгляда.
 */
export function sampleCagr(history) {
  // Самый глубокий доступный ряд: оценке дрейфа нужна длина выборки, а не
  // разрешение. Часовой ряд покрывает считанные месяцы и описал бы последний
  // режим рынка, а не пятилетний.
  let best = null;
  for (const key of ['60', '240', 'D']) {
    const s = history?.raw?.[key];
    if (!s?.series?.length || s.series.length < 3 || !s.stepMs) continue;
    const spanDays = (s.series.length * s.stepMs) / 86_400_000;
    if (!best || spanDays > best.spanDays) best = { spanDays, series: s.series, stepMs: s.stepMs };
  }
  if (!best) return null;
  let acc = 0;
  let n = 0;
  for (let i = 1; i < best.series.length; i++) {
    const a = best.series[i - 1][1];
    const b = best.series[i][1];
    if (a > 0 && b > 0) {
      acc += Math.log(b / a);
      n++;
    }
  }
  if (!n) return null;
  const barYears = best.stepMs / 86_400_000 / YEAR_DAYS;
  return Math.exp(acc / n / barYears) - 1;
}

// Ключ корзины сводки перцентилей теперь один на весь проект — bucketKey из
// quant.js. Три независимые копии «которые обязаны совпадать побайтово» жили
// в этом файле, в web/archive.js и в scripts/record.mjs.
export { bucketKey as statsBucketKey };

/**
 * То, что у всех строк одного продукта общее: форвард на дату сеттлмента,
 * σ «на деньгах» срока и две исторические выборки — сырая (кэш History, по
 * барам) и нормированная под σ ATM и форвард (только на этот вызов: она зависит
 * от непрерывных величин, и долгоживущий кэш по ним был бы течью).
 */
function productSide({ memo, product, timing, surface, spot, history, T, Teff }) {
  const key = `${product.productId}|${timing.tauDays}`;
  const hit = memo?.get(key);
  if (hit) return hit;
  const forward = surface ? forwardAt(surface, spot, T) : spot;
  const sigmaAtm = surface ? volAt(surface, spot, forward, T) : null;
  const hist = history ? history.returns(timing.tauDays) : null;
  const scaled = hist && sigmaAtm > 0 && spot > 0 ? history.scaled(timing.tauDays, sigmaAtm, Teff, forward / spot) : null;
  const out = { forward, sigmaAtm, hist, scaledPrep: scaled?.length ? prepareSample(scaled) : null };
  memo?.set(key, out);
  return out;
}

/**
 * Полный расчёт одной оферты (страйк + направление внутри продукта).
 */
export function buildRow({ product, level, direction, now, spot, surface, history, riskFree, riskFreeBtc, amount, stats, memo = null }) {
  const timing = productTiming(product, now);
  const strike = Number(level.selectPrice);
  const apy = apyFromE8(level.apyE8);
  const i = interestRate(apy, timing.yieldDays);
  const aprEff = effectiveApr(apy, timing.yieldDays, timing.lockDays);
  // APR в цикле — по первому следующему циклу: у недельных и календарных серий
  // его начисление короче срока самой оферты.
  const aprChained = chainedApr(apy, timing.nextYieldDays, timing.cycleDays);

  const T = Math.max(timing.tauDays, 0) / YEAR_DAYS;
  const Teff = twapEffectiveT(T);
  const sigma = surface ? volAt(surface, spot, strike, T) : null;
  // Наклон улыбки в точке страйка: без него вероятность — логнормальная N(∓d₂).
  const skew = surface && sigma > 0 ? volSlopeAt(surface, spot, strike, T) : null;

  // Всё, что одно на продукт, считается один раз: форвард, σ «на деньгах» и
  // нормированная историческая выборка. Память живёт один вызов buildRows.
  const perProduct = productSide({ memo, product, timing, surface, spot, history, T, Teff });
  const { forward, hist, scaledPrep } = perProduct;

  // Оценка зовётся и без волатильности: признак «ниже альтернативной ставки»
  // от σ не зависит, а цены и премии без неё просто остаются пустыми.
  const valued = valueOffer({ direction, strike, apy, timing, forward, sigma, riskFree, riskFreeBtc, skew });

  // Глубина конвертации под мерой рынка опционов. Это та же цена опциона, но
  // выраженная не как вероятность события, а как доля капитала: сколько теряется
  // в среднем, сколько теряется в самих случаях конвертации и насколько глубоко
  // уходит цена в худших пяти процентах исходов. Условная потеря делится на
  // вероятность из улыбки — ту же, что показана в «P рын.».
  const lossRN = sigma > 0 ? rnLossProfile({ direction, forward, strike, sigma, Teff, spot, p: valued.pTriggerRN }) : null;

  // Историческая частота срабатывания на том же горизонте.
  //
  // Сырая частота описывает мир, в котором BTC ходил с волатильностью около 52%
  // годовых и рос на 12% в год. Сегодня рынок опционов оценивает ближайшие дни
  // в 17–25%. Подставлять в решение о завтрашней оферте распределение
  // пятилетней давности — значит мерить не сегодняшний риск, а средний за пять
  // лет. Поэтому рядом всегда живёт вторая серия: та же выборка, приведённая к
  // сегодняшней волатильности и центрированная на сегодняшний форвард. От
  // истории в ней остаётся то, ради чего её и берут, — форма распределения,
  // толстые хвосты и асимметрия, которых нет у логнормального приближения.
  //
  // Важно, что серии именно две и целиком: вероятность, ожидаемая потеря и
  // ожидаемая доходность внутри одной серии считаются по одному распределению.
  // Раньше вероятность бралась из нормированного мира, а потеря — из сырого, и
  // одна карточка описывала два разных рынка сразу.
  //
  // Нормированная серия одна на срок: выборка растягивается под σ «на деньгах»
  // этого срока, а не под σ своего страйка. Улыбка уже несёт рыночную надбавку
  // за толстый хвост, история — свой; растягивать историю под σ дальнего страйка
  // значило учесть хвост дважды. Тот же принцип уже работает в траекторном слое.
  let pHist = null;
  let pHistScaled = null;
  let shortfall = null;
  let shortfallScaled = null;
  let lossHist = null;
  let lossHistScaled = null;
  if (hist?.prep) {
    const x = Math.log(strike / spot);
    const below = sampleCdf(hist.prep, x);
    pHist = direction === 'BuyLow' ? below : 1 - below;
    lossHist = sampleLossProfile(hist.prep, spot, strike, direction);
    shortfall = lossHist?.expected ?? null;
    if (scaledPrep) {
      const belowScaled = sampleCdf(scaledPrep, x);
      pHistScaled = direction === 'BuyLow' ? belowScaled : 1 - belowScaled;
      lossHistScaled = sampleLossProfile(scaledPrep, spot, strike, direction);
      shortfallScaled = lossHistScaled?.expected ?? null;
    }
  }

  // Ставка, которую платил бы рынок опционов за тот же риск, в тех же единицах
  // (эффективный APR). Разница с фактической офертой — это и есть премия Bybit.
  // Со стоимостью денег: деньги за срок блокировки заработали бы и без риска.
  const fairAprEff = fairAprEffective({
    direction,
    optionPrice: valued.optionPrice,
    strike,
    forward,
    df: valued.df,
    lockDays: timing.lockDays,
  });

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
  const expNetFrom = (sf, prep) => {
    if (sf == null || !(timing.lockDays > 0)) return null;
    let value = null;
    if (direction === 'BuyLow') {
      value = (1 + i) * (1 - sf);
    } else if (prep) {
      value = (1 + i) * (prep.meanGross - sf);
    }
    return value == null ? null : ((value - 1) * YEAR_DAYS) / timing.lockDays;
  };
  const expNetApr = expNetFrom(shortfall, hist?.prep);
  const expNetAprScaled = expNetFrom(shortfallScaled, scaledPrep);

  // Где текущая ставка стоит относительно того, что предлагалось раньше на
  // таком же сроке и таком же расстоянии от спота. Величина справочная: в отбор
  // оптимальных она не входит ни одной строкой.
  const moneyness = strike / spot - 1;
  let aprPercentile = null;
  let aprPercentileClamp = '';
  let aprBucketN = null;
  let aprBucketDays = null;
  if (stats?.buckets) {
    const key = bucketKey(timing.yieldDays, product.isVipProduct, direction, moneyness);
    const bucket = key ? stats.buckets[key] : null;
    if (bucket) {
      const at = percentileFromQuantiles(stats.quantileLevels, bucket.q, apy);
      // null здесь означает «сравнивать не с чем» — ряд без разброса. Раньше
      // такой случай молча печатался как нижний край шкалы.
      if (at) {
        aprPercentile = at.p;
        aprPercentileClamp = at.clamp;
        aprBucketN = bucket.n;
        aprBucketDays = bucket.days ?? null;
      }
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
    // Ставка живёт 2–55 секунд, дальше биржа пересчитает её по-своему. Пока
    // поток жив, не протухает ничего; когда он встал, рекомендовать цену,
    // которой больше нет, нельзя — такую строку показываем, но из отбора
    // исключаем. Отсутствие поля не наказываем.
    quoteStale: Number.isFinite(Number(level.expiredAt)) && Number(level.expiredAt) > 0 && Number(level.expiredAt) < now,
    spot,
    forward,
    sigma,
    sigmaAtm: perProduct.sigmaAtm,
    skew,
    Teff,
    exactExpiry: surface ? hasExactExpiry(surface, timing.settle) : false,
    pRN: valued.pTriggerRN,
    // Логнормальная вероятность без наклона улыбки — для справки и проверок.
    pLognormal: valued.pLognormal,
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
    aprPercentileClamp,
    aprBucketN,
    aprBucketDays,
    offerVol: valued.offerVol,
    // Оферта платит меньше альтернативной ставки за свой срок: σ оферты нет.
    belowRiskFree: valued.belowRiskFree,
    volEdge: valued.volEdge,
    edgeApr: valued.edgeApr,
    fairValue: valued.fairValue,
    fairAprEff,
    shortfall,
    shortfallScaled,
    expNetApr,
    expNetAprScaled,
    // Глубина конвертации тремя числами в каждой из мер: средняя потеря,
    // потеря в случаях конвертации и потеря в худших STRESS_LEVEL исходов.
    lossRN,
    lossHist,
    lossHistScaled,
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

/**
 * Мера задаёт не одно число, а целую серию: вероятность, глубина потери и
 * ожидаемая доходность обязаны считаться по одному распределению. Здесь
 * решается, какая историческая серия работает и есть ли под ней выборка.
 */
function histSide(row, measure) {
  const raw = measure === 'hist';
  // На длинных сроках выборки нет: 237-дневных окон в пяти годах помещается
  // восемь штук, и «худшая из двух» превращалась бы в «случайная из двух».
  const thin = row.histInfo != null && row.histInfo.independent < MIN_INDEPENDENT_WINDOWS;
  return { raw, thin };
}

/**
 * Какая серия рабочая: рынок опционов ('rn') или историческая выборка ('hist').
 *
 * В мере «худшая из двух» серия выбирается по вероятности, и из неё же берутся
 * все три числа глубины. Прежде глубина собиралась покомпонентным максимумом из
 * двух распределений и описывала мир, которого нет ни в одной из мер.
 *
 * cautious — в какую сторону осторожно: 'max' (конвертация — риск) или 'min'
 * (срабатывание желанно: безубыточный выход Sell High).
 */
export function pickSeries(row, measure, cautious = 'max') {
  if (measure === 'rn') return 'rn';
  if (measure === 'hist' || measure === 'hist-scaled') return 'hist';
  const { raw, thin } = histSide(row, measure);
  const a = row.pRN;
  const b = raw ? row.pHist : (row.pHistScaled ?? row.pHist);
  if (a == null) return b == null ? 'rn' : 'hist';
  if (b == null || thin) return 'rn';
  return (cautious === 'min' ? b < a : b > a) ? 'hist' : 'rn';
}

/** Какую вероятность считать рабочей. */
export function pickProbability(row, measure, cautious = 'max') {
  const { raw } = histSide(row, measure);
  return pickSeries(row, measure, cautious) === 'rn' ? row.pRN : raw ? row.pHist : (row.pHistScaled ?? row.pHist);
}

/**
 * Глубина конвертации в той же мере и той же серии, что и рабочая вероятность.
 *
 * Без неё порог вероятности не ограничивает деньги: при одной и той же
 * вероятности около 7% суточная оферта теряет 0.11% капитала, а 236-дневная —
 * 1.57%, то есть в пятнадцать раз больше. Частота говорит «как часто», глубина —
 * «сколько», и решение требует обеих.
 */
export function pickDepth(row, measure, cautious = 'max') {
  const { raw } = histSide(row, measure);
  const h = raw ? row.lossHist : (row.lossHistScaled ?? row.lossHist);
  return pickSeries(row, measure, cautious) === 'rn' ? row.lossRN : h;
}

/**
 * Ожидаемая чистая доходность. Величина по своей природе живёт под реальной
 * мерой, у рынка опционов аналога нет: под Q ожидание любой оферты равно её
 * справедливой цене, и весь ответ уже сидит в премии. Поэтому во всех режимах,
 * кроме «историческая как есть», берётся нормированная серия — та же, из
 * которой считается вероятность в этих режимах.
 */
export function pickExpNet(row, measure) {
  const { raw } = histSide(row, measure);
  return raw ? row.expNetApr : (row.expNetAprScaled ?? row.expNetApr);
}

// ──────────────────────────────────────── прогон оферты по траекториям

/**
 * Сегодняшние лестницы ставок — форма «ставка как функция удаления страйка от
 * цены», по одной на продукт и направление.
 *
 * Лестница Bybit привязана к цене: страйки котируются на заданных удалениях от
 * спота, и неизменная лестница означает неизменную ставку ПО УДАЛЕНИЮ, а не за
 * абсолютным страйком. Прежде траекторный слой начислял сегодняшнюю ставку
 * страйка на каждом цикле, куда бы ни ушла цена: 1d «на деньгах» под 246%
 * продолжал получать 246%, оказавшись на −9% от цены, где лестницы нет вовсе.
 * Строится по всем строкам продукта текущего кадра: это форма, а не котировка.
 */
export function laddersFrom(rows, spot) {
  const groups = new Map();
  for (const r of rows) {
    if (!(r.strike > 0) || !Number.isFinite(r.apy) || !(spot > 0)) continue;
    const key = `${r.productId}|${r.direction}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push([r.strike / spot, r.apy]);
  }
  const out = new Map();
  for (const [key, list] of groups) {
    // Направление по ключу: всё, что не Sell High, — лестница Buy Low.
    list.sort((a, b) => a[0] - b[0]);
    const m = new Float64Array(list.length);
    const apy = new Float64Array(list.length);
    list.forEach(([x, y], j) => {
      m[j] = x;
      apy[j] = y;
    });
    out.set(key, { m, apy, buy: !key.endsWith('|SellHigh') });
  }
  return out;
}

/**
 * Ставка следующего цикла для удаления m = K/S от цены прошлого сеттлмента.
 *   между страйками лестницы — линейно по m;
 *   ближе к цене, чем ближний страйк (но вне денег), — ставка ближнего края;
 *   дальше от цены, чем дальний страйк, — −1: такой подписки нет;
 *   страйк «в деньгах» (Buy Low: m ≥ 1, Sell High: m ≤ 1) — −1: Bybit таких
 *   страйков не предлагает.
 */
export function ladderRate(L, m) {
  const n = L.m.length;
  if (!n) return -1;
  if (L.buy) {
    if (m >= 1 || m < L.m[0]) return -1;
    if (m >= L.m[n - 1]) return L.apy[n - 1];
  } else {
    if (m <= 1 || m > L.m[n - 1]) return -1;
    if (m <= L.m[0]) return L.apy[0];
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (L.m[mid] <= m) lo = mid;
    else hi = mid;
  }
  const w = (m - L.m[lo]) / (L.m[hi] - L.m[lo]);
  return L.apy[lo] + w * (L.apy[hi] - L.apy[lo]);
}

/**
 * Одна оферта, повторяемая на всём горизонте, на каждой траектории сценария.
 *
 *  Цикл 0 — сама оферта: её ставка, её срок, её сеттлмент через τ.
 *  Цикл k ≥ 1 — подписка на тот же страйк того же продукта. Ставка — из
 *    сегодняшней лестницы по удалению K/S, где S — цена прошлого сеттлмента
 *    (ladderRate). Если страйк ушёл за дальний край лестницы или оказался «в
 *    деньгах» (после цикла без подписки цена прошла за страйк), подписки в этом
 *    цикле нет: у Buy Low деньги лежат под альтернативную ставку весь цикл и
 *    конвертироваться не могут, у Sell High монета лежит без процента и продана
 *    быть не может.
 *  Сеттлменты — по расписанию серии (settlementSchedule), процент цикла —
 *    ставка × дни его начисления / 365.
 *
 * Buy Low: конвертация на сеттлменте k, если S_k ≤ K; дальше монета держится до
 *   конца горизонта. Без конвертации — капитал плюс процент по остатку горизонта.
 * Sell High: выход на сеттлменте k, если S_k ≥ K; выручка лежит под
 *   альтернативную ставку до конца горизонта. Без выхода — монеты по цене конца.
 *   Величины Sell High считаются без себестоимости (w = стоимость в USDT), она
 *   входит делением: так один прогон годится для любой введённой цены покупки.
 */
export function runOffer({ row, base, sched, ladder, spot, horizonDays, riskFree = 0 }) {
  return runProduct({ rows: [row], base, sched, ladder, spot, horizonDays, riskFree })[0];
}

/**
 * Тот же прогон для всех строк одного продукта и направления сразу.
 *
 * Порядок циклов важен для скорости, а не для ответа: внешний цикл — по
 * траекториям, внутренний — по строкам продукта. Цены на сеттлментах одной
 * траектории читаются из матрицы один раз на продукт, а не один раз на строку:
 * матрица на горизонте 365 занимает ~4.6 МБ, и прежний порядок «строка снаружи»
 * прогонял её через память шестьсот девяносто раз за кадр.
 */
export function runProduct({ rows, base, sched, ladder, spot, horizonDays, riskFree = 0 }) {
  const n = sched?.n ?? 0;
  const R = rows.length;
  const out = new Array(R).fill(null);
  if (!n || !base || !(spot > 0)) return out;
  const { ratio, width, paths, bars, barDays } = base;
  const firstBars = Math.max(1, Math.round(sched.days[0] / barDays));
  if (firstBars > bars) return out;
  const bar = new Int32Array(n);
  const accr = new Float64Array(n);
  const idle = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    bar[k] = Math.min(bars, Math.max(1, firstBars + Math.round((sched.days[k] - sched.days[0]) / barDays)));
    accr[k] = sched.accrual[k] / YEAR_DAYS;
    // Цикл без подписки: деньги Buy Low весь цикл лежат под альтернативную ставку.
    idle[k] = 1 + (riskFree * sched.cycle[k]) / YEAR_DAYS;
  }
  const tail = 1 + (riskFree * sched.tailDays) / YEAR_DAYS;
  const last = n - 1;
  const days = Float64Array.from(sched.days);
  // Простой выручки Sell High после выхода на сеттлменте k — под альт. ставку.
  const afterExit = new Float64Array(n);
  for (let k = 0; k < n; k++) afterExit[k] = 1 + (riskFree * Math.max(0, horizonDays - days[k])) / YEAR_DAYS;

  // Лестница в координатах цены прошлого сеттлмента x = S/S₀: удаление
  // m = K/S = target/x, поэтому границы m_j переходят в xs_j = target/m_j
  // (по убыванию). Две проверки отсекают «за краем» и «ближе края», и только
  // внутри лестницы нужны двоичный поиск и одно деление. Ответ тот же, что у
  // ladderRate (проверяется тестом против отдельного перебора).
  const nl = ladder ? ladder.m.length : 0;
  const lm = ladder ? ladder.m : null;
  const la = ladder ? ladder.apy : null;
  const slope = new Float64Array(nl);
  for (let j = 0; j + 1 < nl; j++) slope[j] = (la[j + 1] - la[j]) / (lm[j + 1] - lm[j]);
  const spec = rows.map((row) => {
    const ok = row.strike > 0 && Number.isFinite(row.apy);
    const target = row.strike / spot;
    const xs = new Float64Array(nl);
    for (let j = 0; j < nl; j++) xs[j] = target / lm[j];
    const buy = row.direction !== 'SellHigh';
    return {
      ok,
      buy,
      target,
      strike: row.strike,
      apy: row.apy,
      g0: 1 + row.apy * accr[0],
      xs,
      // Buy Low: за краем — x > xs[0]; ближе края — x ≤ xs[nl−1].
      // Sell High: за краем — x < xs[nl−1]; ближе края — x ≥ xs[0].
      xFirst: nl ? xs[0] : 0,
      xLast: nl ? xs[nl - 1] : 0,
      nearRate: nl ? (buy ? la[nl - 1] : la[0]) : row.apy,
      hits: 0,
      acc: 0,
      accExitG: 0,
      accDays: 0,
    };
  });
  const values = new Float64Array(R * paths);
  const xk = new Float64Array(n);
  // Нарастающие с конца минимум и максимум цен сеттлментов и произведения
  // множителей простоя: если до конца горизонта цена уже ни разу не вернётся к
  // лестнице, оставшиеся циклы без подписки сворачиваются в одно умножение.
  // Таких «хвостов» больше половины всех серий без подписки.
  const sufMin = new Float64Array(n);
  const sufMax = new Float64Array(n);
  const idleTo = new Float64Array(n); // ∏ idle[1..k]
  idleTo[0] = 1;
  for (let k = 1; k < n; k++) idleTo[k] = idleTo[k - 1] * idle[k];

  for (let p = 0; p < paths; p++) {
    const o = p * width;
    for (let k = 0; k < n; k++) xk[k] = ratio[o + bar[k]];
    // Шаг k опирается на цену прошлого сеттлмента x[k−1], поэтому хвосты — по
    // индексам 0…n−2.
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = n - 2; k >= 0; k--) {
      if (xk[k] < lo) lo = xk[k];
      if (xk[k] > hi) hi = xk[k];
      sufMin[k] = lo;
      sufMax[k] = hi;
    }
    const term = ratio[o + bars];
    for (let r = 0; r < R; r++) {
      const c = spec[r];
      if (!c.ok) continue;
      const { buy, target, xs, xFirst, xLast, nearRate } = c;
      let g = c.g0;
      let x = xk[0];
      let hit = -1;
      // Направления разведены по двум циклам: в горячем месте не должно быть
      // ветвлений на направление. Три четверти шагов — циклы без подписки
      // (страйк за краем лестницы), поэтому они вынесены в самую короткую ветку.
      if (!nl) {
        // Без лестницы — прежняя модель: ставка оферты на каждом цикле.
        if (buy ? x <= target : x >= target) hit = 0;
        for (let k = 1; hit < 0 && k < n; k++) {
          g *= 1 + c.apy * accr[k];
          x = xk[k];
          if (buy ? x <= target : x >= target) hit = k;
        }
      } else if (buy) {
        if (x <= target) hit = 0;
        for (let k = 1; hit < 0 && k < n; k++) {
          if (x > xFirst) {
            // До конца горизонта цена выше дальнего края: подписок больше нет,
            // деньги лежат под альтернативную ставку.
            if (sufMin[k - 1] > xFirst) {
              g *= idleTo[n - 1] / idleTo[k - 1];
              break;
            }
            g *= idle[k];
            x = xk[k];
            continue;
          }
          if (x <= target) {
            // Страйк «в деньгах» (K ≥ S): после цикла без подписки цена прошла
            // под страйк, а такого Buy Low Bybit не предлагает — подписки нет.
            g *= idle[k];
            x = xk[k];
            continue;
          }
          let rate = nearRate;
          if (x > xLast) {
            let lo = 0;
            let hi = nl - 1;
            while (hi - lo > 1) {
              const mid = (lo + hi) >> 1;
              if (xs[mid] >= x) lo = mid;
              else hi = mid;
            }
            rate = la[lo] + (target / x - lm[lo]) * slope[lo];
          }
          g *= 1 + rate * accr[k];
          x = xk[k];
          if (x <= target) hit = k;
        }
      } else {
        if (x >= target) hit = 0;
        for (let k = 1; hit < 0 && k < n; k++) {
          if (x < xLast) {
            // До конца горизонта цена ниже дальнего края: продаж больше нет.
            if (sufMax[k - 1] < xLast) break;
            x = xk[k];
            continue;
          }
          if (x >= target) {
            // Страйк «в деньгах» (K ≤ S): такого Sell High нет — подписки нет.
            x = xk[k];
            continue;
          }
          let rate = nearRate;
          if (x < xFirst) {
            let lo = 0;
            let hi = nl - 1;
            while (hi - lo > 1) {
              const mid = (lo + hi) >> 1;
              if (xs[mid] >= x) lo = mid;
              else hi = mid;
            }
            rate = la[lo] + (target / x - lm[lo]) * slope[lo];
          }
          g *= 1 + rate * accr[k];
          x = xk[k];
          if (x >= target) hit = k;
        }
      }
      let v;
      if (buy) {
        v = hit >= 0 ? (g * term) / target : g * tail;
      } else if (hit >= 0) {
        v = g * c.strike * afterExit[hit];
        c.accExitG += g;
        c.accDays += days[hit];
      } else {
        v = g * term * spot;
        c.accDays += days[last];
      }
      if (hit >= 0) c.hits++;
      values[r * paths + p] = v;
      c.acc += v;
    }
  }

  const scratch = new Float64Array(paths);
  for (let r = 0; r < R; r++) {
    const c = spec[r];
    if (!c.ok) continue;
    const own = values.subarray(r * paths, (r + 1) * paths);
    const common = {
      cycles: n,
      pHit: c.hits / paths,
      paths,
      modeledDays: days[last],
      tailDays: sched.tailDays,
      independent: base.independent,
      series: base.series,
    };
    out[r] = c.buy
      ? { ...common, value: c.acc / paths, valueMedian: median(own, scratch), valueGeo: geoMean(own) }
      : {
          ...common,
          // Ожидание времени до выхода, ограниченное последним сеттлментом горизонта.
          expExitDays: c.accDays / paths,
          // Средний множитель монет к моменту выхода — по траекториям, где выход был.
          exitGrossMean: c.hits ? c.accExitG / c.hits : null,
          wMean: c.acc / paths,
          wMedian: median(own, scratch),
        };
  }
  return out;
}

/**
 * Траекторный слой для набора строк — один прогон на строку, общий для риска за
 * горизонт, стоимости стратегии и блока выхода. Результат кладётся на строку
 * (r.path) с ключом входов: строки пересобираются каждый кадр, так что живёт он
 * один кадр, а внутри кадра второй вызов с теми же входами ничего не считает.
 */
export function pathLayer(rows, { history, spot, horizonDays, riskFree = 0 }) {
  const base = history && horizonDays > 0 ? history.scenarioPaths(horizonDays) : null;
  const key = `${horizonDays}|${riskFree}|${history?.uid ?? ''}:${history?.scenarioKey ?? ''}|${spot}`;
  // Строки, которым прогон нужен, — по группам «продукт, направление, τ»:
  // у группы общие сеттлменты и лестница.
  const groups = new Map();
  for (const r of rows) {
    // Ключ строки — входы слоя и сама оферта: копия строки с другим страйком не
    // должна унаследовать чужой прогон.
    const rowKey = `${key}|${r.productId}|${r.direction}|${r.strike}|${r.apy}|${r.timing?.tauDays}`;
    // Прогон, приложенный панелью из своего кэша (frame.js), не пересчитывается:
    // там он обновляется не каждый кадр, а раз в несколько секунд.
    if (r.pathPinned && r.path !== undefined) continue;
    if (r.pathKey === rowKey && r.path !== undefined) continue;
    r.pathKey = rowKey;
    r.path = null;
    if (!base) continue;
    const gk = `${r.productId}|${r.direction}|${r.timing.tauDays}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = []));
    g.push(r);
  }
  if (!groups.size) return rows;
  const ladders = laddersFrom(rows, spot);
  for (const list of groups.values()) {
    const r0 = list[0];
    const sched = settlementSchedule(r0.timing, horizonDays);
    const res = runProduct({ rows: list, base, sched, ladder: ladders.get(`${r0.productId}|${r0.direction}`), spot, horizonDays, riskFree });
    list.forEach((r, j) => (r.path = res[j]));
  }
  return rows;
}

/**
 * Риск, приведённый к общему горизонту: вероятность того, что при непрерывном
 * повторении этой же оферты страйк сработает хотя бы раз за H дней.
 *
 * Вероятность за одну покупку несравнима между сроками: 7% за 1.6 суток и 7% за
 * 237 суток — это разные вещи, и первая при непрерывном катании означает почти
 * гарантированную конвертацию в течение месяца. Частота берётся по траекториям
 * сценария, поэтому зависимость соседних циклов учтена; циклы без подписки
 * (страйк за краем лестницы) сработать не могут.
 */
export function markHorizonRisk(rows, history, spot, horizonDays, riskFree = 0) {
  pathLayer(rows, { history, spot, horizonDays, riskFree });
  for (const r of rows) {
    if (!r.path) {
      // До сеттлмента дальше, чем весь горизонт: оферта не рассчитается ни разу.
      // Риск у неё наступает после горизонта, и «0% за H дней» читался бы как
      // безопасность, поэтому числа нет.
      r.pHorizon = null;
      r.horizonInfo = { cycles: 0, n: 0, independent: 0, series: null };
      continue;
    }
    r.pHorizon = r.path.pHit;
    r.horizonInfo = { cycles: r.path.cycles, n: r.path.paths, independent: r.path.independent, series: r.path.series };
  }
  return rows;
}

/**
 * Сборка всех строк по направлению с учётом фильтров интерфейса.
 */
export function buildRows({
  products,
  quotes,
  direction,
  now,
  spot,
  surface,
  history,
  riskFree,
  riskFreeBtc,
  amount,
  vip,
  measure,
  stats,
  horizonDays = 0,
  // Траекторный слой можно не считать здесь: панель считает его отдельно и не
  // каждый кадр (frame.js), скрипты — сразу.
  paths = true,
}) {
  const rows = [];
  // Поверхность на текущий момент: время до экспираций — от now, а не от
  // момента загрузки. Снимок старше трёх минут (или его отсутствие) делает
  // непригодными все строки сразу — так же, как истёкшая котировка.
  const surf = surface ? surfaceAt(surface, now) : null;
  const optionsAge = surface ? now - (surface.builtAt ?? surface.now) : Infinity;
  const optionsStale = !(optionsAge <= OPTIONS_MAX_AGE_MS);
  // Общее на продукт считается один раз за вызов (см. productSide).
  const memo = new Map();
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
      const row = buildRow({ product, level, direction, now, spot, surface: surf, history, riskFree, riskFreeBtc, amount, stats, memo });
      row.optionsStale = optionsStale;
      row.pConv = pickProbability(row, measure);
      row.depth = pickDepth(row, measure);
      row.expNet = pickExpNet(row, measure);
      row.excess = row.aprEff != null && riskFree != null ? row.aprEff - riskFree : null;
      rows.push(row);
    }
  }
  // Риск за горизонт нужен обеим сторонам, но на стороне Sell High его считает
  // analyzeSellHigh вместе с остальной механикой выхода — здесь не дублируем.
  if (horizonDays > 0 && history && direction === 'BuyLow' && paths) markHorizonRisk(rows, history, spot, horizonDays, riskFree ?? 0);
  // Альтернативная ставка — точка фронта при нулевом риске: оферту, которая
  // платит меньше неё, доминирует простое «держать USDT». Такая строка не идёт
  // ни на фронт, ни в карточки, а в полной таблице приглушена.
  for (const r of rows) r.belowAlt = belowAltRate(r, riskFree);
  markSubscriptionFront(rows);
  markLadderInversions(rows);
  // Счётчик — по котировкам: устаревшие опционы показываются отдельной строкой.
  rows.staleCount = rows.filter((r) => r.quoteStale).length;
  rows.optionsStale = optionsStale;
  rows.optionsAgeMs = optionsAge;
  return rows;
}

/**
 * Фронт подписки: (эффективный APR ↑, P(конв) ↓) среди живых строк не ниже
 * альт. ставки (r.belowAlt проставляет buildRows). Отдельной функцией, потому
 * что панель зовёт её второй раз после фильтра сроков: фронт, посчитанный до
 * фильтра, среди оставшихся строк мог не найти ни одной своей точки.
 *
 * Фронт строится только по живым котировкам: он питает и карточки, и якоря,
 * и график, поэтому протухшая строка, попав на него, расползлась бы по всем
 * рекомендательным блокам сразу. В полных таблицах она остаётся, приглушённая.
 */
export function markSubscriptionFront(rows) {
  const fresh = rows.filter((r) => !isStale(r) && !r.belowAlt);
  const front = paretoFront(fresh, 'aprEff', 'pConv');
  for (const r of rows) r.pareto = front.has(r);
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
 * Ярлык лучшей σ-премии. Когда отрицательна даже лучшая, «лучшая цена риска»
 * вводит в заблуждение: это не выгода, а самая малая недоплата.
 */
export function priceTag(value, money = false) {
  if (value < 0) return money ? 'наименьшая недоплата в деньгах' : 'наименьшая недоплата';
  return money ? 'лучшая премия в деньгах' : 'лучшая цена риска';
}

/**
 * Отбор в блок «оптимальные варианты».
 * Порог риска задаёт пользователь; внутри порога берём фронт Парето —
 * набор, который нельзя улучшить по доходности, не увеличив риск.
 */
export function pickBest({ rows, maxP, limit = 6 }) {
  const eligible = rows.filter((r) => !isStale(r) && !r.belowAlt && r.pConv != null && r.pConv <= maxP && r.aprEff != null);
  const front = paretoFront(eligible, 'aprEff', 'pConv');
  // Только фронт и ничего кроме фронта. Добор доминируемых оферт «для полноты»
  // противоречил самому назначению блока: показанная там оферта заведомо хуже
  // другой показанной оферты сразу по доходности и по риску.
  const list = eligible.filter((r) => front.has(r)).sort((a, b) => a.pConv - b.pConv);
  // Сбрасываем подписи на всём наборе, а не только на фронте: при повторном
  // вызове с другим порогом строка может выпасть из списка и унести с собой
  // подпись от прошлого расчёта.
  for (const r of rows) r.bestTag = null;
  if (!list.length) return [];

  // Шесть карточек подряд с верхнего края фронта — это шесть самых рискованных
  // точек разрешённого диапазона, и при подъёме порога блок терял из вида все
  // осторожные варианты. Поэтому берём два содержательных ответа и равномерный
  // срез между ними: та же логика уже работает в блоке Sell High.
  const out = [];
  const take = (r, tag) => {
    if (!r) return;
    // Одна и та же оферта бывает и самой доходной, и лучшей по цене риска.
    // Тогда карточка одна, но обе причины на ней должны быть названы — иначе
    // вторая молча пропадает и выглядит, будто её не нашли.
    if (out.includes(r)) {
      if (tag && r.bestTag && !r.bestTag.includes(tag)) r.bestTag += ` · ${tag}`;
      else if (tag && !r.bestTag) r.bestTag = tag;
      return;
    }
    r.bestTag = tag;
    out.push(r);
  };
  take(
    list.reduce((a, b) => (b.aprEff > a.aprEff ? b : a)),
    'максимум доходности',
  );
  const priced = list.filter((r) => Number.isFinite(r.volEdge));
  if (priced.length) {
    const top = priced.reduce((a, b) => (b.volEdge > a.volEdge ? b : a));
    take(top, priceTag(top.volEdge));
  }
  // Равномерный срез по фронту от осторожного к доходному; уже взятые точки
  // пропускаем, поэтому срез не вырождается в дубликаты.
  const need = limit - out.length;
  if (need > 0) {
    for (let k = 0; k < need; k++) {
      const idx = need === 1 ? 0 : Math.round((k * (list.length - 1)) / (need - 1));
      take(list[idx], null);
    }
    for (const r of list) {
      if (out.length >= limit) break;
      take(r, null);
    }
  }
  return out.sort((a, b) => a.pConv - b.pConv).slice(0, limit);
}

/**
 * Карточки режима стратегии: самый осторожный, самый доходный, наименьшая
 * недоплата (или лучшая цена риска) и равномерный срез фронта. Одна оферта
 * может отвечать на два вопроса — тогда карточка одна, а ярлыки склеиваются.
 * Берутся только строки фронта: строки дешевле USDT на него не попадают.
 */
export function pickStrategyCards(frontRows, limit = 6) {
  const byRisk = [...frontRows].sort((a, b) => a.stratRisk - b.stratRisk);
  for (const r of byRisk) r.bestTag = null;
  const picks = [];
  const take = (r, tag) => {
    if (!r) return;
    if (picks.includes(r)) {
      if (tag && r.bestTag && !r.bestTag.includes(tag)) r.bestTag += ` · ${tag}`;
      else if (tag && !r.bestTag) r.bestTag = tag;
      return;
    }
    r.bestTag = tag;
    picks.push(r);
  };
  if (!byRisk.length) return [];
  take(byRisk[0], 'минимум риска');
  take(
    byRisk.reduce((a, b) => (b.stratGeo > a.stratGeo ? b : a)),
    'максимум стоимости',
  );
  const priced = byRisk.filter((r) => Number.isFinite(r.volEdge));
  if (priced.length) {
    const top = priced.reduce((a, b) => (b.volEdge > a.volEdge ? b : a));
    take(top, priceTag(top.volEdge));
  }
  for (let k = 0; picks.length < limit && k < byRisk.length; k++) {
    take(byRisk[Math.round((k * (byRisk.length - 1)) / (limit - 1))], null);
  }
  return picks.sort((a, b) => a.stratRisk - b.stratRisk);
}

/**
 * Посчитан ли у строк Sell High траекторный слой: тогда у каждой есть
 * horizonInfo (у не рассчитывающихся за горизонт — с нулём циклов).
 */
function hasHorizonLayer(rows) {
  return rows.some((r) => r.horizonInfo != null);
}

/**
 * Подбор Sell High под конкретную позицию в BTC.
 * basis — фактическая цена, по которой BTC попал на баланс. Порог безубытка
 * ниже себестоимости на величину начисляемого процента.
 */
export function analyzeSellHigh({ rows, basis, qty, spot, history, measure = 'max', horizonDays = 90, riskFree = 0 }) {
  // Траекторный слой — один прогон на строку; если панель уже приложила его к
  // строкам с теми же входами, здесь ничего не пересчитывается.
  if (history && basis > 0) pathLayer(rows, { history, spot, horizonDays, riskFree });
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
      400,
      r.timing.nextYieldDays,
    );

    // Шанс выйти за общий горизонт, если крутить именно эту оферту.
    //
    // Без приведения к общему горизонту вероятности несравнимы: 47% за цикл в
    // 55 дней и 41% за цикл в 237 дней — это совершенно разные вещи, а фронт,
    // построенный по такой оси, механически вытаскивает наверх самые длинные
    // продукты. Всё берётся из одного прогона по траекториям сценария
    // (runOffer): зависимость соседних циклов учтена, ставка следующих циклов —
    // по удалению страйка от цены, а циклы за краем лестницы продажи не дают.
    let pExitHorizon = null;
    let horizonInfo = null;
    let expExitDays = null;
    let profitAtExit = null;
    let exitSpeed = null;
    let fullValue = null;
    let fullRate = null;
    let fullMedian = null;
    let fullMedianRate = null;
    if (history && basis > 0) {
      const path = r.path;
      if (path) {
        pExitHorizon = path.pHit;
        horizonInfo = { cycles: path.cycles, n: path.paths, independent: path.independent, series: path.series };
        // Ожидаемое время до выхода, ограниченное горизонтом: первый выход
        // наступает через τ, дальше — по расписанию сеттлментов серии.
        expExitDays = path.expExitDays;
        // Если выход случился на цикле k, процент в биткоине накопился за все
        // циклы до него. Ветка «выход не состоялся» тоже стоит денег: на руках
        // монеты по цене конца горизонта. Себестоимость входит делением.
        profitAtExit = path.exitGrossMean == null ? null : (path.exitGrossMean * r.strike) / basis - 1;
        fullValue = path.wMean / basis;
        fullMedian = path.wMedian / basis;
        // Стоимость за горизонт приводится к году геометрически — так же, как в
        // режиме стратегии и у баз сравнения.
        fullRate = annualize(fullValue, horizonDays);
        fullMedianRate = annualize(fullMedian, horizonDays);
        // Скорость безубыточного выхода: прибыль, которую выход реально
        // приносит, взвешенная шансом его дождаться и приведённая к полному
        // горизонту. Знаменатель именно H, а не n·цикл.
        exitSpeed = ((profitAtExit ?? 0) * pExitHorizon * YEAR_DAYS) / horizonDays;
      } else {
        // До первого сеттлмента дальше, чем весь горизонт: оферта не успевает
        // рассчитаться ни разу. Числа за горизонт у неё нет — ни шанса выйти, ни
        // риска продажи: всё это наступает после горизонта.
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
      // Прибыль, накопленная к фактическому циклу выхода, — она же ось фронта.
      profitAtExit,
      // Скорость безубыточного выхода. Это НЕ ожидаемая доходность стратегии:
      // считается только ветвь, ради которой всё и затевается.
      exitSpeed,
      // А это — полное матожидание обеих ветвей, для честного сравнения.
      fullValue,
      fullRate,
      fullMedian,
      fullMedianRate,
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
    };
  });

  // Режим определяется по живым офертам: если безубыточный выход есть только в
  // протухшей котировке, его на самом деле нет.
  const profitable = out.filter((r) => r.profitable && !isStale(r));

  // Осторожная оценка вероятности меняет направление вместе со смыслом
  // срабатывания — у каждой строки свой. Безубыточная строка (страйк не ниже
  // порога): продажа — желанный исход, осторожно брать меньшую из двух
  // вероятностей. Убыточная: срабатывание — продажа в убыток, осторожно брать
  // большую. Прежде знак был один на весь блок (есть ли где-то безубыток), и
  // убыточные строки рядом с безубыточными получали оптимистичную оценку.
  // Глубина берётся из той же серии, что и вероятность.
  if (measure === 'max') {
    for (const r of out) {
      const cautious = r.profitable ? 'min' : 'max';
      r.pConv = pickProbability(r, measure, cautious);
      r.depth = pickDepth(r, measure, cautious);
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
  // Есть траекторный слой — ось за горизонт; по одной вероятности за цикл
  // только пока истории нет.
  const axis = hasHorizonLayer(out) ? 'pExitHorizon' : 'pConv';
  // Ось прибыли — накопленная к фактическому циклу выхода, а не за один цикл.
  for (const r of out) r.profitAxis = r.profitAtExit ?? r.profitPct;
  // Оферты с нулевым шансом выйти за горизонт исключаются до построения фронта.
  // Формально самая прибыльная из них недоминируема — по прибыли её никто не
  // превосходит, — и она садилась на край фронта с обещанием +36% при шансе
  // получить их, равном нулю. Недоминируемость здесь вырождена: реализовать
  // такую прибыль за горизонт нельзя ни при каком исходе.
  const reachable = axis === 'pExitHorizon' ? profitable.filter((r) => r.pExitHorizon > 0) : profitable;
  const front = paretoFront(reachable, 'profitAxis', axis, false);
  for (const r of out) r.sellPareto = front.has(r);

  // База сравнения: во что превратится та же позиция, если не делать ничего.
  // Без неё полное матожидание нечитаемо — оно почти всегда отрицательно просто
  // потому, что рынок ушёл ниже себестоимости, и вопрос не в знаке, а в том,
  // лучше ли это бездействия.
  const hold = history?.holdGross(horizonDays);
  const holdValue = hold && basis > 0 ? (hold.gross * spot) / basis : null;
  const holdMedian = hold?.grossMedian > 0 && basis > 0 ? (hold.grossMedian * spot) / basis : null;
  // Убыточные уходят вниз: они не решают задачу выхода, даже если ставка выше.
  const sorted = out.sort(
    (a, b) => Number(b.profitable) - Number(a.profitable) || (b.aprEff ?? -1) - (a.aprEff ?? -1),
  );
  sorted.baseline =
    holdValue == null
      ? null
      : {
          horizonDays,
          holdValue,
          holdRate: annualize(holdValue, horizonDays),
          holdMedian,
          holdMedianRate: annualize(holdMedian, horizonDays),
          gross: hold.gross,
          n: hold.n,
          series: hold.series,
        };
  return sorted;
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
export function pickAnchors(allRows) {
  // Якорь — это рекомендация, поэтому протухшие котировки сюда не допускаются.
  // Не допускаются и оферты ниже альтернативной ставки: их доминирует простое
  // «держать деньги под эту ставку», и называть такую оферту лучшей по какому
  // угодно критерию нельзя.
  const rows = allRows.filter((r) => !isStale(r) && !r.belowRiskFree);
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
    ['expected', 'expNet'],
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
  const front = rows.filter((r) => r.profitable && r.sellPareto && Number.isFinite(r.profitAxis));
  const key = front.some((r) => Number.isFinite(r.pExitHorizon)) ? 'pExitHorizon' : 'pConv';
  const sorted = [...front].sort((a, b) => b[key] - a[key]);
  let prev = null;
  const out = sorted.map((r) => {
    const dP = prev ? prev[key] - r[key] : null;
    const dProfit = prev ? r.profitAxis - prev.profitAxis : null;
    const step = { ...r, exitAxis: key, gainProfit: dProfit, costP: dP, marginal: dP > 1e-9 ? dProfit / dP : null };
    prev = r;
    return step;
  });
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Именованные ответы блока выхода, не привязанные к паре осей фронта.
 *
 * Фронт выхода строится по паре «прибыль к моменту выхода — шанс выйти», и
 * максимум любой величины, монотонно растущей по обеим осям, гарантированно
 * лежит на нём. Скорость выхода — как раз такая: это произведение осей. А вот
 * полное матожидание и его медиана к осям не монотонны, и их максимумы регулярно
 * оказываются вне фронта: сегодня лучшая медиана у страйка, который побит по
 * паре осей соседней строкой, но отвечает на другой вопрос — не «когда я выйду»,
 * а «сколько у меня останется, если выход не состоится».
 *
 * Поэтому такие ответы место не на карточках (там правило «только фронт»), а
 * рядом с полным фронтом — ровно как якоря на стороне Buy Low, с пометкой, чем
 * именно якорь побит.
 */
export function pickExitAnchors(rows) {
  const pool = rows.filter((r) => r.profitable && !isStale(r));
  const top = (key) => {
    const p = pool.filter((r) => Number.isFinite(r[key]));
    return p.length ? p.reduce((a, b) => (b[key] > a[key] ? b : a)) : null;
  };

  // Доминирование считается по той же паре, что и фронт: здесь обе величины
  // максимизируются, поэтому «побит» означает «есть оферта не хуже по прибыли и
  // не хуже по шансу выйти, и хотя бы по одной строго лучше».
  const axis = hasHorizonLayer(rows) ? 'pExitHorizon' : 'pConv';
  const usable = pool.filter((r) => Number.isFinite(r.profitAxis) && Number.isFinite(r[axis]));
  const dominatorOf = (r) => {
    if (!r || !Number.isFinite(r.profitAxis) || !Number.isFinite(r[axis])) return null;
    const better = usable.filter(
      (b) =>
        b !== r &&
        b.profitAxis >= r.profitAxis &&
        b[axis] >= r[axis] &&
        (b.profitAxis > r.profitAxis || b[axis] > r[axis]),
    );
    return better.length ? better.reduce((a, b) => (b.profitAxis > a.profitAxis ? b : a)) : null;
  };

  const out = {};
  for (const [id, key] of [
    ['full', 'fullRate'],
    ['median', 'fullMedianRate'],
    ['market', 'volEdge'],
  ]) {
    const row = top(key);
    out[id] = row ? { row, key, value: row[key], axis, dominator: dominatorOf(row) } : null;
  }
  return out;
}

/**
 * Отбор в блок «оптимальные Sell High».
 *
 * Если безубыточные оферты есть — берём их фронт Парето: там срабатывание
 * желанно, значит максимизируем и ставку, и вероятность продажи.
 *
 * Внутри фронта сначала берутся ИМЕНОВАННЫЕ ответы и только потом равномерный
 * срез. Порядок здесь не косметика. Срез по номеру строки не знает ни об одной
 * метрике: он берёт точки 0, len/5, 2·len/5 и так далее, а чемпион по скорости
 * выхода и лучший типичный исход лежат в середине фронта, куда эти номера
 * попадают только случайно. На живых данных из-за этого блок «Оптимальный выход»
 * не показывал ни оферту, которую называла собственная шапка блока (максимум
 * скорости выхода, 19-я строка фронта из 27), ни лучший типичный исход (13-я).
 * Та же схема уже работает в pickBest на стороне Buy Low.
 *
 * Если рынок ушёл ниже себестоимости и безубыточного выхода за горизонт нет,
 * знак риска переворачивается обратно: сработавший страйк означает
 * принудительную продажу BTC дешевле, чем он был куплен. Поэтому здесь нужен
 * фронт по максимуму ставки при минимуме вероятности срабатывания — заработок в
 * BTC без фиксации убытка.
 */
export function pickBestSell({ rows, limit = 6 }) {
  // Подписи сбрасываем на всём наборе, а не только на отобранных: при повторном
  // вызове строка может выпасть из отбора и унести с собой ярлык прошлого расчёта.
  for (const r of rows) {
    r.bestTag = null;
    r.waitPareto = false;
  }
  // С траекторным слоем обе оси считаются за горизонт, и в отбор идут только
  // оферты, которые рассчитаются внутри него хотя бы раз. Без этого оферта с
  // первым сеттлментом за горизонтом получала «0% риска» и становилась
  // «минимумом риска», хотя на своём сеттлменте продаётся в убыток с
  // вероятностью около половины.
  const layered = hasHorizonLayer(rows);
  const settles = (r) => !layered || r.horizonInfo?.cycles > 0;

  const out = [];
  const take = (r, tag) => {
    if (!r) return;
    // Одна и та же оферта бывает и самой вероятной, и самой быстрой. Тогда
    // карточка одна, но обе причины на ней должны быть названы.
    if (out.includes(r)) {
      if (tag && r.bestTag && !r.bestTag.includes(tag)) r.bestTag += ` · ${tag}`;
      else if (tag && !r.bestTag) r.bestTag = tag;
      return;
    }
    r.bestTag = tag;
    out.push(r);
  };
  // Добор идёт равномерно ПО ЗНАЧЕНИЮ оси, а не по номеру строки.
  //
  // Именованные ответы уже занимают оба края фронта, поэтому прежний срез по
  // номерам 0, len/5, 2·len/5 … сажал бы оставшиеся карточки вплотную к уже
  // занятым краям. Замер на живых данных: три карточки из шести приходились на
  // один и тот же страйк 65 000, а вся середина фронта снова пропадала — то
  // есть ровно тот дефект, ради которого блок и переделывался.
  const fill = (pool, key) => {
    const vals = pool.map((r) => r[key]).filter(Number.isFinite);
    if (!vals.length) return;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const need = limit - out.length;
    for (let k = 1; k <= need; k++) {
      const rest = pool.filter((r) => !out.includes(r) && Number.isFinite(r[key]));
      if (!rest.length) break;
      const target = lo + ((hi - lo) * k) / (need + 1);
      take(
        rest.reduce((a, b) => (Math.abs(b[key] - target) < Math.abs(a[key] - target) ? b : a)),
        null,
      );
    }
    // Вырожденный случай: у всех строк ось одинаковая, ближайшая всегда одна и
    // та же. Тогда просто добираем подряд, лишь бы блок не оказался полупустым.
    for (const r of pool) {
      if (out.length >= limit) break;
      take(r, null);
    }
  };

  // Режим выхода — только когда безубыточная оферта может вывести в USDT за
  // горизонт (шанс выйти больше нуля). Безубыточная 239d при горизонте 90
  // включала режим выхода с пустым блоком, и режим ожидания не показывался.
  const profitable = rows.filter(
    (r) => r.profitable && !isStale(r) && Number.isFinite(r.profitAxis) && (!layered || r.pExitHorizon > 0),
  );
  // Сортируем по вероятности продажи от большей к меньшей: сверху самый
  // реалистичный выход, ниже — всё более дорогие, но всё менее вероятные.
  const key = layered ? 'pExitHorizon' : 'pConv';
  const front = profitable.filter((r) => r.sellPareto).sort((a, b) => b[key] - a[key]);
  if (front.length) {
    const maxBy = (k) => {
      const p = front.filter((r) => Number.isFinite(r[k]));
      return p.length ? p.reduce((a, b) => (b[k] > a[k] ? b : a)) : null;
    };
    take(front[0], 'вернее всего выйти');
    take(maxBy('exitSpeed'), 'быстрее всего в безубыток');
    take(maxBy('fullMedianRate'), 'лучший типичный исход');
    take(maxBy('profitAxis'), 'дороже всего');
    fill(front, key);
    return { mode: 'exit', axis: key, rows: out.sort((a, b) => b[key] - a[key]).slice(0, limit) };
  }

  // Режим ожидания меряет риск тем же горизонтом, что и режим выхода: иначе
  // вероятности за цикл у пятидневного и у 237-дневного продукта сравнивались бы
  // напрямую, а это величины разной размерности. Здесь срабатывание страйка —
  // принудительная продажа ниже себестоимости, поэтому шанс минимизируется.
  const axis = key;
  const usable = rows.filter((r) => !isStale(r) && settles(r) && Number.isFinite(r.aprEff) && Number.isFinite(r[axis]));
  const waitFront = paretoFront(usable, 'aprEff', axis, true);
  const ranked = usable.filter((r) => waitFront.has(r)).sort((a, b) => a[axis] - b[axis]);
  for (const r of ranked) r.waitPareto = true;
  // Тот же дефект жил и здесь, только в другом виде: прежний отбор брал шесть
  // первых строк от самого осторожного края, и оферта с максимальной ставкой в
  // блок не попадала никогда.
  const pool = ranked.length ? ranked : [...usable].sort((a, b) => a[axis] - b[axis]);
  if (!pool.length) return { mode: 'wait', axis, rows: [] };
  take(pool[0], 'минимум риска');
  const rated = pool.filter((r) => Number.isFinite(r.aprEff));
  if (rated.length) take(rated.reduce((a, b) => (b.aprEff > a.aprEff ? b : a)), 'максимум ставки');
  fill(pool, axis);
  return { mode: 'wait', axis, rows: out.sort((a, b) => a[axis] - b[axis]).slice(0, limit) };
}

/**
 * Вторая постановка: стратегия до выбранной даты.
 *
 * Блок «Текущая подписка» отвечает на вопрос про одну сделку: сколько даёт
 * именно эта покупка и с какой вероятностью именно она конвертируется. Вопрос
 * законный, но его две оси устроены по-разному. Эффективный APR осмыслен как
 * доходность только если капитал переразмещается после разблокировки — иначе
 * восьмичасовая сделка на 0.2% не даёт 123% годовых. А вероятность относится
 * ровно к одной сделке. То есть ось доходности неявно предполагает сотни
 * повторений, а ось риска — одно, и из-за деления только одной оси на срок
 * фронт механически тянет к самым коротким продуктам.
 *
 * Здесь обе оси построены на одном горизонте H и на одних траекториях:
 *
 *   капитал катает эту же оферту, пока цена не уйдёт ниже страйка;
 *   после конвертации биткоин просто держится до конца горизонта;
 *   если конвертации не было — на руках (1+i)^n USDT плюс процент по остатку.
 *
 * Политика после конвертации — `hold` из бэктеста: обратная нога Sell High
 * консервативно считается нулевой. Основание в docs/БЭКТЕСТ.md: безубыточного
 * страйка нет от 69% до 91% времени, проведённого в биткоине, а когда он есть,
 * то добавляет 3–9% годовых в монетах. То есть модель занижает ценность
 * конвертации, и это осознанный запас в сторону осторожности, а не пропуск.
 *
 * Что модель принимает на веру: лестница ставок — сегодняшняя, как функция
 * удаления страйка от цены (ставка следующих циклов берётся по удалению страйка
 * от цены прошлого сеттлмента; за краем лестницы подписки нет), а траектории
 * цены — сценарные. Поэтому рядом всегда показываются две базы сравнения:
 * удержание USDT и удержание BTC на тех же самых траекториях.
 */
export function computeStrategy({ rows, history, spot, horizonDays, riskFree = 0 }) {
  if (!history || !(spot > 0) || !(horizonDays > 0)) return null;

  pathLayer(rows, { history, spot, horizonDays, riskFree });
  for (const r of rows) {
    r.strategy = null;
    r.stratAnnual = null;
    r.stratGeo = null;
    r.stratRisk = null;
    r.stratPareto = false;
    const path = r.path;
    if (!path || !Number.isFinite(path.value)) continue;
    // Три статистики, и они отвечают на разные вопросы.
    //
    // Среднее арифметическое — ожидание ОДНОГО эпизода. На скошенном вправо
    // распределении оно задаётся правым хвостом.
    // Геометрическое — во что превратится капитал, если политику ПОВТОРЯТЬ.
    // Именно оно складывается по периодам, и именно по нему строится фронт.
    // Медиана — типичный исход. Разрыв со средним и есть мера скошенности.
    r.strategy = {
      value: path.value,
      annual: annualize(path.value, horizonDays),
      valueMedian: path.valueMedian,
      annualMedian: annualize(path.valueMedian, horizonDays),
      valueGeo: path.valueGeo,
      annualGeo: annualize(path.valueGeo, horizonDays),
      pEndBtc: path.pHit,
      cycles: path.cycles,
      modeledDays: path.modeledDays,
      tailDays: path.tailDays,
      paths: path.paths,
      independent: path.independent,
      series: path.series,
    };
    r.stratAnnual = r.strategy.annual;
    r.stratGeo = r.strategy.annualGeo;
    r.stratRisk = r.strategy.pEndBtc;
  }

  // Фронт стратегии — рекомендация, поэтому строится только по живым котировкам.
  // Ось доходности — геометрическая: капитал складывается по периодам, а не
  // усредняется по эпизодам.
  // Держать USDT — точка фронта при нулевом риске: та же альтернативная ставка
  // в геометрическом эквиваленте за горизонт. Строка дешевле неё доминирована
  // бездействием и на фронт и в карточки не идёт; «минимум риска» поэтому не
  // может оказаться хуже USDT.
  const usdtGeo = annualize(1 + (riskFree * horizonDays) / YEAR_DAYS, horizonDays);
  for (const r of rows) r.stratBelowUsdt = Number.isFinite(r.stratGeo) && usdtGeo != null && r.stratGeo < usdtGeo;
  const usable = rows.filter(
    (r) => !isStale(r) && !r.stratBelowUsdt && Number.isFinite(r.stratGeo) && Number.isFinite(r.stratRisk),
  );
  const front = paretoFront(usable, 'stratGeo', 'stratRisk');
  for (const r of usable) r.stratPareto = front.has(r);

  const hold = history.holdGross(horizonDays);
  const scen = history.scenarioPaths(horizonDays);
  return {
    horizonDays,
    rows: usable.filter((r) => front.has(r)).sort((a, b) => a.stratRisk - b.stratRisk),
    usdtAnnual: riskFree,
    usdtGeo,
    btcAnnual: hold ? annualize(hold.gross, horizonDays) : null,
    btcAnnualMedian: hold ? annualize(hold.grossMedian, horizonDays) : null,
    btcAnnualGeo: hold ? annualize(hold.grossGeo, horizonDays) : null,
    scenario: scen
      ? {
          cagr: scen.cagr,
          histVol: scen.histVol,
          scenarioVol: scen.scenarioVol,
          series: scen.series,
          paths: scen.paths,
          independent: scen.independent,
        }
      : null,
    btcInfo: hold ? { n: hold.n, series: hold.series, spanDays: hold.spanDays } : null,
    counted: usable.length,
    stale: rows.filter((r) => isStale(r)).length,
  };
}
