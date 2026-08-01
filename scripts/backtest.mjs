// Бэктест «колеса» Dual Assets на исторических ценах BTC.
//
//   node scripts/backtest.mjs [--years 5] [--vip] [--durations 1d,3d,6d,27d]
//
// Что моделируется: капитал в USDT непрерывно крутится в Buy Low на выбранном
// удалении от спота. Если сеттлмент ушёл ниже страйка, капитал превращается в
// BTC и дальше крутится в Sell High, пока не продастся обратно в USDT.
// Учитываются реальные окна подписки: продукт каждого срока выпускается раз в
// сутки, поэтому между сеттлментом и следующим входом капитал простаивает.
//
// Главное допущение, которое нельзя забывать при чтении результатов: ставки
// берутся сегодняшние и считаются постоянными на всю историю. Реальная ставка
// зависит от волатильности момента и в 2021 году была другой. Поэтому вывод
// бэктеста — не «столько заработали бы», а «так стратегия ведёт себя на
// исторических траекториях цены при сегодняшнем уровне вознаграждения».

import { fetchProducts, fetchQuote, fetchKlines } from '../web/feeds.js';
import { productTiming, interestRate, apyFromE8, YEAR_DAYS, MS_DAY } from '../web/quant.js';

const arg = (name, fallback) => {
  const k = process.argv.indexOf(`--${name}`);
  return k >= 0 ? process.argv[k + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const YEARS = Number(arg('years', 5));
const WANT_VIP = flag('vip');
const WANT_DURATIONS = String(arg('durations', '1d,3d,6d,13d,27d')).split(',');
// Удаления страйка от спота, по которым строится сетка результатов.
const BUY_LEVELS = [-0.01, -0.02, -0.03, -0.05, -0.08];
const SELL_LEVEL = 0.02;
// Политики выхода из BTC после конвертации:
//   hold      — подписываться на Sell High только со страйком не ниже порога
//               безубытка; если такого нет, BTC просто лежит. Убыток никогда
//               не реализуется. Это стратегия «купится BTC — не страшно».
//   breakeven — то же, но при отсутствии безубыточного страйка берётся самый
//               дальний из лестницы: процент капает, но продажа в убыток возможна.
//   fixed     — продавать всегда на фиксированном удалении от текущей цены.
const POLICY = arg('policy', 'hold');

/** Часовой ряд как можно глубже: он даёт цену ровно в 08:00 UTC. */
async function loadHourly(years) {
  const need = Math.ceil((years * 365 * 24) / 1000) + 1;
  const { series, stepMs } = await fetchKlines('60', Math.min(need, 60));
  if (stepMs !== 3600_000) throw new Error(`неожиданный шаг ряда: ${stepMs}`);
  const map = new Map();
  for (const [ts, close] of series) map.set(ts, close);
  return { map, first: series[0][0], last: series[series.length - 1][0] };
}

/**
 * Кривая ставок по удалению от спота: интерполируем логарифм APY,
 * потому что ставка падает от страйка почти экспоненциально и линейная
 * интерполяция занижала бы её в разы на промежуточных уровнях.
 */
function buildCurve(levels, spot) {
  const pts = levels
    .map((lv) => ({ m: Number(lv.selectPrice) / spot - 1, apy: apyFromE8(lv.apyE8) }))
    .filter((p) => p.apy > 0)
    .sort((a, b) => a.m - b.m);
  if (!pts.length) return null;

  // За пределы котируемой лестницы не выходим. Экстраполяция здесь дала бы
  // самый опасный вид ошибки: страйк, которого биржа не предлагает, выглядел бы
  // безрисковым источником дохода, потому что до него цена никогда не доходит.
  const fn = (m) => {
    if (m < pts[0].m - 1e-9 || m > pts[pts.length - 1].m + 1e-9) return null;
    if (pts.length === 1) return pts[0].apy;
    for (let k = 1; k < pts.length; k++) {
      if (m <= pts[k].m) {
        const a = pts[k - 1];
        const b = pts[k];
        const w = b.m > a.m ? (m - a.m) / (b.m - a.m) : 0;
        return Math.exp(Math.log(a.apy) + w * (Math.log(b.apy) - Math.log(a.apy)));
      }
    }
    return pts[pts.length - 1].apy;
  };
  fn.min = pts[0].m;
  fn.max = pts[pts.length - 1].m;
  return fn;
}

/** Ближайшая доступная цена в часовом ряду (допуск — несколько часов). */
function priceAt(hourly, ts) {
  for (let k = 0; k <= 4; k++) {
    const hit = hourly.map.get(ts - k * 3600_000);
    if (hit > 0) return hit;
  }
  return null;
}

/**
 * Прогон одной конфигурации по всей истории.
 * windowCloseUtcHour — час закрытия окна подписки (8 для суточных и длиннее,
 * 0 для восьмичасового), yieldDays — окно начисления, cycleDays — период
 * повторения с учётом простоя.
 */
function simulate({
  hourly,
  windowHour,
  yieldDays,
  cycleDays,
  buyApy,
  sellCurve,
  buyM,
  sellM,
  policy,
  startTs,
  endTs,
}) {
  const iBuy = interestRate(buyApy, yieldDays);

  let usdt = 1;
  let btc = 0;
  let basis = null; // себестоимость BTC в USDT за штуку
  let conversions = 0;
  let sales = 0;
  let cycles = 0;
  let idleCycles = 0; // циклы, в которых безубыточного страйка не нашлось
  let stuckSince = null;
  let maxStuckDays = 0;
  let btcIdleMs = 0;
  let usdtMs = 0;
  let btcMs = 0;
  // Множитель роста только по ноге USDT: он показывает ставку, реально
  // полученную в долларах, отдельно от переоценки биткоина.
  let usdtGrowth = 1;
  // То же самое для ноги BTC: во сколько раз выросло количество монет за счёт
  // процентов. Отвечает на вопрос, спасает ли обратная нога после конвертации.
  let btcGrowth = 1;
  let realizedLoss = 0;

  // Первое закрытие окна подписки не раньше начала истории.
  let t = Date.UTC(
    new Date(startTs).getUTCFullYear(),
    new Date(startTs).getUTCMonth(),
    new Date(startTs).getUTCDate(),
    windowHour,
  );
  while (t < startTs) t += MS_DAY;

  const firstPrice = priceAt(hourly, t);
  const cycleMs = Math.round(cycleDays * MS_DAY);
  const yieldMs = Math.round(yieldDays * MS_DAY);

  while (t + yieldMs <= endTs) {
    const s0 = priceAt(hourly, t);
    const sT = priceAt(hourly, t + yieldMs);
    if (!(s0 > 0) || !(sT > 0)) {
      t += cycleMs;
      continue;
    }
    cycles++;

    if (usdt > 0) {
      const K = s0 * (1 + buyM);
      const payout = usdt * (1 + iBuy);
      if (sT <= K) {
        // Конвертация: тело вместе с процентом покупает BTC по страйку,
        // поэтому фактическая себестоимость ниже страйка на величину процента.
        btc = payout / K;
        basis = usdt / btc;
        usdt = 0;
        conversions++;
        stuckSince = t + yieldMs;
      } else {
        usdt = payout;
        usdtGrowth *= 1 + iBuy;
      }
      usdtMs += cycleMs;
    } else {
      btcMs += cycleMs;
      // Выбор страйка Sell High.
      //
      // Политика fixed продаёт на фиксированном удалении от текущей цены —
      // это ровно та ошибка, из-за которой «колесо» фиксирует убыток: после
      // падения BTC продаётся на 2% выше уже упавшей цены.
      // Политика breakeven (по умолчанию) требует, чтобы выручка покрывала
      // себестоимость; если такой страйк за пределами лестницы, продажи в этом
      // цикле не происходит, и BTC просто накапливает процент.
      const wanted = s0 * (1 + sellM);
      let K = wanted;
      if (policy !== 'fixed' && basis != null) {
        // Порог безубытка зависит от ставки, а ставка — от страйка, поэтому
        // точку ищем итеративно: оценили ставку, сдвинули страйк, пересчитали.
        // Одной оценкой по соседнему уровню обойтись нельзя — дальний страйк
        // платит меньше, порог из-за этого уезжает вверх, и продажа уходит в минус.
        for (let k = 0; k < 4; k++) {
          const m0 = Math.min(Math.max(K / s0 - 1, sellCurve.min), sellCurve.max);
          const be = basis / (1 + interestRate(sellCurve(m0) ?? 0, yieldDays));
          const next = Math.max(wanted, be);
          if (Math.abs(next - K) < 1e-6) break;
          K = next;
        }
      }
      const m = K / s0 - 1;
      let apy = m >= sellCurve.min && m <= sellCurve.max ? sellCurve(m) : null;

      // Итоговая проверка на самой выбранной ставке: выручка обязана покрыть
      // затраты. Итерация могла не сойтись на изломе кривой.
      if (apy != null && policy === 'hold' && basis != null && (1 + interestRate(apy, yieldDays)) * K < basis) {
        apy = null;
      }

      if (apy == null) {
        idleCycles++;
        if (policy === 'hold') {
          // Безубыточного страйка нет — не подписываемся вовсе. BTC лежит без
          // начисления, но и продать его себе в убыток никто не заставит.
          btcIdleMs += cycleMs;
          t += cycleMs;
          continue;
        }
        // Иначе берём самый дальний страйк лестницы: процент капает, но
        // срабатывание зафиксирует убыток.
        K = s0 * (1 + sellCurve.max);
        apy = sellCurve(sellCurve.max);
      }
      {
        const iCycle = interestRate(apy, yieldDays);
        const payoutBtc = btc * (1 + iCycle);
        btcGrowth *= 1 + iCycle;
        if (sT >= K) {
          usdt = payoutBtc * K;
          // Убыток считается по выручке против затрат, а не по страйку против
          // себестоимости: начисленный процент делает часть продаж ниже
          // себестоимости всё равно прибыльными.
          if (basis != null && payoutBtc * K < btc * basis) realizedLoss += 1;
          btc = 0;
          basis = null;
          sales++;
          if (stuckSince != null) {
            maxStuckDays = Math.max(maxStuckDays, (t + yieldMs - stuckSince) / MS_DAY);
            stuckSince = null;
          }
        } else {
          btc = payoutBtc;
          // Тот же USDT распределён на большее число монет: себестоимость падает.
          basis /= 1 + iCycle;
        }
      }
    }
    t += cycleMs;
  }

  const lastPrice = priceAt(hourly, Math.min(t, endTs)) ?? firstPrice;
  const finalUsdt = usdt > 0 ? usdt : btc * lastPrice;
  const spanYears = (endTs - startTs) / MS_DAY / YEAR_DAYS;
  if (stuckSince != null) maxStuckDays = Math.max(maxStuckDays, (endTs - stuckSince) / MS_DAY);

  return {
    cycles,
    conversions,
    sales,
    idleCycles,
    realizedLoss,
    shareInBtc: usdtMs + btcMs > 0 ? btcMs / (usdtMs + btcMs) : 0,
    idleShare: btcMs > 0 ? btcIdleMs / btcMs : 0,
    // Годовая ставка, полученная в USDT, приведённая ко времени в USDT.
    usdtApr: usdtMs > 0 ? usdtGrowth ** ((YEAR_DAYS * MS_DAY) / usdtMs) - 1 : null,
    // Годовая ставка в монетах, приведённая ко времени, проведённому в BTC.
    btcApr: btcMs > 0 ? btcGrowth ** ((YEAR_DAYS * MS_DAY) / btcMs) - 1 : null,
    btcGrowth,
    endedInBtc: btc > 0,
    maxStuckDays,
    finalUsdt,
    cagr: spanYears > 0 ? finalUsdt ** (1 / spanYears) - 1 : null,
    holdBtcCagr: spanYears > 0 ? (lastPrice / firstPrice) ** (1 / spanYears) - 1 : null,
    spanYears,
  };
}

async function main() {
  console.log('Загрузка истории цен и текущих ставок…');
  const [hourly, products] = await Promise.all([loadHourly(YEARS), fetchProducts()]);
  const spanDays = (hourly.last - hourly.first) / MS_DAY;
  console.log(`История: ${spanDays.toFixed(0)} сут (${(spanDays / 365).toFixed(2)} года), часовой ряд.`);

  const now = Date.now();
  const chosen = products.filter(
    (p) => p.status === 'Available' && !!p.isVipProduct === WANT_VIP && WANT_DURATIONS.includes(p.duration),
  );
  if (!chosen.length) {
    console.log('Нет продуктов под заданный фильтр.');
    return;
  }

  const rows = [];
  for (const product of chosen) {
    const quote = await fetchQuote(product.productId);
    if (!quote) continue;
    const spot = Number(quote.currentPrice);
    const timing = productTiming(product, now);
    const buyCurve = buildCurve(quote.buyLowPrice, spot);
    const sellCurve = buildCurve(quote.sellHighPrice, spot);
    if (!buyCurve || !sellCurve) continue;

    const windowHour = new Date(timing.subEnd).getUTCHours() === 23 ? 0 : new Date(timing.subEnd).getUTCHours();

    for (const buyM of BUY_LEVELS) {
      // Уровни за пределами котируемой лестницы просто отсутствуют на бирже.
      const buyApy = buyCurve(buyM);
      if (buyApy == null) continue;
      const res = simulate({
        hourly,
        windowHour,
        yieldDays: timing.yieldDays,
        cycleDays: timing.cycleDays,
        buyApy,
        sellCurve,
        buyM,
        sellM: SELL_LEVEL,
        policy: POLICY,
        startTs: hourly.first,
        endTs: hourly.last,
      });
      rows.push({
        duration: product.duration,
        buyM,
        apy: buyCurve(buyM),
        cycleDays: timing.cycleDays,
        ...res,
      });
    }
  }

  const pct = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
  console.log(
    `\nКонфигурация: ${WANT_VIP ? 'VIP' : 'общедоступные'} продукты, Sell High на +${(SELL_LEVEL * 100).toFixed(0)}%, ` +
      `политика — ${
        POLICY === 'hold'
          ? 'никогда не продавать BTC дешевле себестоимости'
          : POLICY === 'breakeven'
            ? 'не ниже себестоимости, иначе самый дальний страйк'
            : 'фиксированное удаление от цены'
      }.`,
  );
  console.log('Ставки взяты сегодняшние и приняты постоянными на всю историю — см. оговорку в шапке файла.\n');
  console.log(
    [
      'срок',
      'страйк',
      'ставка USDT',
      'доля в BTC',
      'ставка BTC',
      'из BTC-времени простой',
      'монет накоплено',
      'итог',
      'CAGR',
    ].join('\t'),
  );
  for (const r of rows) {
    console.log(
      [
        r.duration,
        pct(r.buyM, 0),
        pct(r.usdtApr),
        pct(r.shareInBtc, 0),
        pct(r.btcApr),
        pct(r.idleShare, 0),
        `×${r.btcGrowth.toFixed(3)}`,
        r.endedInBtc ? 'в BTC' : 'в USDT',
        pct(r.cagr),
      ].join('\t'),
    );
  }

  const any = rows[0];
  if (any) {
    console.log(
      `\nДля сравнения: удержание BTC за тот же период — ${pct(any.holdBtcCagr)} годовых, ` +
        `удержание USDT — 0%.`,
    );
  }
}

main().catch((e) => {
  console.error(`сбой бэктеста: ${e.message}`);
  process.exit(1);
});
