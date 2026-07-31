// Самопроверка ядра расчётов: аналитические тождества, воспроизведение
// документированного примера Bybit и инварианты на живых данных биржи.
//
//   node scripts/selftest.mjs          — полный прогон
//   node scripts/selftest.mjs --offline — без обращений к бирже

import {
  normCdf,
  black76Put,
  black76Call,
  impliedVol,
  parseDuration,
  productTiming,
  interestRate,
  effectiveApr,
  chainedApr,
  valueOffer,
  logReturns,
  empiricalCdf,
  empiricalShortfall,
  paretoFront,
  basisFromConversion,
  breakevenStrike,
  cyclesToRecover,
  twapEffectiveT,
  apyFromE8,
  truncate,
  MS_DAY,
} from '../web/quant.js';
import { buildSurface, parseOptionSymbol, volAt, forwardAt, hasExactExpiry } from '../web/surface.js';
import { fetchProducts, fetchQuote, fetchOptionTickers, fetchSpot } from '../web/feeds.js';

let failed = 0;
let passed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function near(name, actual, expected, tol, unit = '') {
  const diff = Math.abs(actual - expected);
  ok(name, diff <= tol, `получено ${actual}${unit}, ожидалось ${expected}${unit}, разница ${diff.toExponential(2)}`);
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ────────────────────────────────────────────── 1. Функция распределения

section('Нормальное распределение');
near('N(0)', normCdf(0), 0.5, 1e-15);
near('N(1)', normCdf(1), 0.8413447460685429, 1e-14);
near('N(-3)', normCdf(-3), 0.001349898031630095, 1e-16);
{
  // В дальнем хвосте важна относительная, а не абсолютная точность.
  const got = normCdf(-6);
  const want = 9.865876450376946e-10;
  ok('N(-6) хвост', Math.abs(got / want - 1) < 1e-8, `относительная ошибка ${(got / want - 1).toExponential(2)}`);
}
ok('N монотонна', normCdf(-0.5) < normCdf(0) && normCdf(0) < normCdf(0.5));

// ────────────────────────────────────────────── 2. Блэк-76

section('Блэк-76');
{
  const F = 63000;
  const K = 62000;
  const s = 0.55;
  const T = 3 / 365;
  const call = black76Call(F, K, s, T);
  const put = black76Put(F, K, s, T);
  // Паритет без дисконтирования: C − P = F − K.
  near('паритет колл-пут', call - put, F - K, 1e-8);
  const ivBack = impliedVol(put, F, K, T, false);
  near('обратная задача по волатильности', ivBack, s, 1e-6);
  ok('пут дорожает с волатильностью', black76Put(F, K, 0.9, T) > put);
  ok('пут дорожает со сроком', black76Put(F, K, s, T * 4) > put);
  // Глубоко вне денег цена стремится к нулю, но не становится отрицательной.
  const deep = black76Put(F, 20000, s, T);
  ok('глубокий OTM неотрицателен и мал', deep >= 0 && deep < 1e-6, `${deep}`);
}

// ────────────────────────────────────────────── 3. Поправка на усреднение

section('Усреднение цены сеттлмента');
{
  const T = 1 / 365;
  const eff = twapEffectiveT(T);
  ok('усреднение сокращает срок', eff < T && eff > 0.9 * T, `T=${T.toExponential(3)} → ${eff.toExponential(3)}`);
  const long = 237 / 365;
  ok('на длинных сроках поправка ничтожна', Math.abs(twapEffectiveT(long) / long - 1) < 1e-3);
}

// ────────────────────────────────────────────── 4. Тайминг и проценты

section('Тайминг продукта и начисление');
near('разбор 8h', parseDuration('8h'), 1 / 3, 1e-12);
near('разбор 1d', parseDuration('1d'), 1, 0);
near('разбор 237d', parseDuration('237d'), 237, 0);
ok('мусор не разбирается', parseDuration('1w') === null && parseDuration('') === null);

{
  // Пример из документации Bybit (Get Position Info):
  // 20 USDT, apy 9.027, срок 3d → ожидаемая выплата 21.4838 USDT.
  const i = interestRate(9.027, 3);
  const payout = 20 * (1 + i);
  near('выплата из примера документации', payout, 21.48389, 1e-5, ' USDT');
  // Биржа усекает до точности монеты: 21.48389… → 21.4838, а не 21.4839.
  ok('усечение воспроизводит цифру Bybit', truncate(payout, 4) === 21.4838, `${truncate(payout, 4)}`);
}

{
  // Синтетический продукт: подписка закрывается через сутки, сеттлмент ещё через сутки.
  const now = Date.UTC(2026, 6, 31, 17, 52);
  const p = {
    subscribeStartAt: String(Date.UTC(2026, 6, 31, 8, 0)),
    subscribeEndAt: String(Date.UTC(2026, 7, 1, 8, 0)),
    settlementTime: String(Date.UTC(2026, 7, 2, 8, 0)),
    expectReceiveAt: String(Date.UTC(2026, 7, 2, 8, 20)),
    duration: '1d',
  };
  const t = productTiming(p, now);
  near('окно начисления равно номиналу', t.yieldDays, 1, 1e-12, ' сут');
  ok('метка срока совпадает с окном', t.labelMatches);
  near('реальная блокировка', t.lockDays, 1 + (14 * 60 + 28) / 1440, 1e-9, ' сут');
  near('мёртвое время', t.idleDays, t.lockDays - 1, 1e-12, ' сут');
  ok('подписка открыта', t.open);
  const apy = 0.4;
  const eff = effectiveApr(apy, t.yieldDays, t.lockDays);
  ok('эффективный APR ниже заявленного', eff < apy, `${(eff * 100).toFixed(2)}% против ${(apy * 100).toFixed(0)}%`);
  near('эффективный APR = APY × D / L', eff, (apy * t.yieldDays) / t.lockDays, 1e-15);
  near('разбавление = D / L', t.dilution, t.yieldDays / t.lockDays, 1e-15);

  // Непрерывное повторение: продукт выпускается раз в сутки, поэтому цикл
  // «подписка — сеттлмент — следующая подписка» для суточного продукта равен двум суткам.
  near('цикл суточного продукта', t.cycleDays, 2, 1e-9, ' сут');
  near('APR в цикле вдвое ниже заявленного', chainedApr(0.4, t.yieldDays, t.cycleDays), 0.2, 1e-12);
  ok(
    'APR в цикле не выше эффективного при покупке сейчас',
    chainedApr(0.4, t.yieldDays, t.cycleDays) <= effectiveApr(0.4, t.yieldDays, t.lockDays) + 1e-12,
  );

  // Тот же продукт, купленный в последнюю минуту окна подписки: разбавления почти нет.
  const late = productTiming(p, Date.UTC(2026, 7, 1, 7, 59));
  ok(
    'покупка перед закрытием окна почти не разбавляет',
    late.dilution > t.dilution && late.dilution > 0.98,
    `${t.dilution.toFixed(3)} → ${late.dilution.toFixed(3)}`,
  );
}

// ────────────────────────────────────────────── 5. Оценка оферты

section('Оценка оферты и премия сверх справедливой');
{
  const now = Date.UTC(2026, 6, 31, 8, 0);
  const p = {
    subscribeStartAt: String(now),
    subscribeEndAt: String(now),
    settlementTime: String(now + 7 * MS_DAY),
    expectReceiveAt: String(now + 7 * MS_DAY + 20 * 60_000),
    duration: '7d',
  };
  const timing = productTiming(p, now);
  const F = 63000;
  const K = 60000;
  const sigma = 0.5;
  const T = timing.tauDays / 365;
  const Teff = twapEffectiveT(T);

  // Ставка, при которой оферта ровно справедлива: премия пута равна K·i/(1+i).
  const putFair = black76Put(F, K, sigma, Teff);
  const iFair = putFair / K / (1 - putFair / K);
  const apyFair = (iFair * 365) / timing.yieldDays;

  const fair = valueOffer({ direction: 'BuyLow', strike: K, apy: apyFair, timing, forward: F, sigma });
  near('справедливая оферта стоит номинал', fair.fairValue, 1, 1e-9);
  near('справедливая оферта даёт нулевую премию', fair.edgeApr, 0, 1e-7);
  near('волатильность оферты равна рыночной', fair.offerVol, sigma, 1e-5);
  near('премия по волатильности нулевая', fair.volEdge, 0, 1e-5);

  const rich = valueOffer({ direction: 'BuyLow', strike: K, apy: apyFair * 1.5, timing, forward: F, sigma });
  ok('щедрая оферта даёт положительную премию', rich.edgeApr > 0 && rich.volEdge > 0);
  const poor = valueOffer({ direction: 'BuyLow', strike: K, apy: apyFair * 0.5, timing, forward: F, sigma });
  ok('скупая оферта даёт отрицательную премию', poor.edgeApr < 0 && poor.volEdge < 0);

  // Вероятность срабатывания под мерой Q: у Buy Low растёт вместе со страйком.
  const near_ = valueOffer({ direction: 'BuyLow', strike: 62500, apy: 0.4, timing, forward: F, sigma });
  const far = valueOffer({ direction: 'BuyLow', strike: 55000, apy: 0.4, timing, forward: F, sigma });
  ok(
    'ближний страйк рискованнее дальнего',
    near_.pTriggerRN > far.pTriggerRN,
    `${(near_.pTriggerRN * 100).toFixed(1)}% против ${(far.pTriggerRN * 100).toFixed(1)}%`,
  );

  // Sell High: симметрия. Продажа колла на том же расстоянии сверху.
  const sh = valueOffer({ direction: 'SellHigh', strike: 66000, apy: 0.4, timing, forward: F, sigma });
  ok('Sell High: вероятность продажи в разумных пределах', sh.pTriggerRN > 0 && sh.pTriggerRN < 1);
  const shFairCall = black76Call(F, 66000, sigma, Teff);
  const iFairSh = shFairCall / F / (1 - shFairCall / F);
  const shFair = valueOffer({
    direction: 'SellHigh',
    strike: 66000,
    apy: (iFairSh * 365) / timing.yieldDays,
    timing,
    forward: F,
    sigma,
  });
  near('справедливый Sell High стоит номинал', shFair.fairValue, 1, 1e-9);

  // Дисконтирование по безрисковой ставке снижает ценность, но не переворачивает знак.
  const disc = valueOffer({ direction: 'BuyLow', strike: K, apy: apyFair, timing, forward: F, sigma, riskFree: 0.0166 });
  ok('учёт безрисковой ставки уменьшает премию', disc.edgeApr < fair.edgeApr);
  near('премия падает примерно на безрисковую ставку', fair.edgeApr - disc.edgeApr, 0.0166, 5e-4);
}

// ────────────────────────────────────────────── 6. Эмпирика

section('Эмпирическое распределение');
{
  // Ряд с известным поведением: детерминированный рост на 1% за шаг.
  const closes = Array.from({ length: 200 }, (_, k) => 100 * 1.01 ** k);
  const r5 = logReturns(closes, 5);
  ok('число окон = N − h', r5.length === 195);
  near('доходность окна', r5[0], Math.log(1.01 ** 5), 1e-12);
  near('вероятность падения на растущем ряду', empiricalCdf(r5, -1e-9), 0, 0);
  near('вероятность не превысить рост', empiricalCdf(r5, 1), 1, 0);

  const flat = Array.from({ length: 500 }, (_, k) => 100 * (k % 2 ? 1.02 : 1));
  const r1 = logReturns(flat, 1);
  near('чередующийся ряд: половина окон вниз', empiricalCdf(r1, -1e-9), 0.5, 0.01);

  // Недобор страйка не создаёт убытка, перебор — создаёт.
  const s0 = 100;
  ok('ниже страйка убытка нет', empiricalShortfall(r5, s0, 50, 'BuyLow') === 0);
  ok('выше страйка убыток положителен', empiricalShortfall(r5, s0, 200, 'BuyLow') > 0);
  ok('Sell High: упущенный рост положителен', empiricalShortfall(r5, s0, 100, 'SellHigh') > 0);
}

// ────────────────────────────────────────────── 7. Парето

section('Множество Парето');
{
  const rows = [
    { id: 'a', aprEff: 0.1, pConv: 0.01 },
    { id: 'b', aprEff: 0.2, pConv: 0.05 }, // лучше a по доходности, хуже по риску → на фронте
    { id: 'c', aprEff: 0.15, pConv: 0.08 }, // хуже b по обоим → вне фронта
    { id: 'd', aprEff: 0.05, pConv: 0.02 }, // хуже a по обоим → вне фронта
    { id: 'e', aprEff: 0.4, pConv: 0.3 },
  ];
  const front = paretoFront(rows);
  const ids = rows.filter((r) => front.has(r)).map((r) => r.id).sort();
  ok('фронт найден верно', JSON.stringify(ids) === JSON.stringify(['a', 'b', 'e']), ids.join(','));
  ok('доминируемые исключены', !ids.includes('c') && !ids.includes('d'));
}

// ────────────────────────────────────────────── 8. Себестоимость и Sell High

section('Себестоимость после конвертации');
{
  const K = 62000;
  const apy = 0.4;
  const D = 1;
  const i = interestRate(apy, D);
  const basis = basisFromConversion(K, apy, D);
  ok('себестоимость ниже страйка', basis < K, `${basis.toFixed(2)} против ${K}`);
  // За 1000 USDT приходит 1000(1+i)/K биткоинов; цена = 1000 / это количество.
  const qty = (1000 * (1 + i)) / K;
  near('себестоимость = потрачено / получено', basis, 1000 / qty, 1e-9);

  const be = breakevenStrike(basis, 0.3, 3);
  ok('порог безубытка ниже себестоимости', be < basis, `${be.toFixed(2)} против ${basis.toFixed(2)}`);
  near('порог безубытка = basis/(1+i)', be, basis / (1 + interestRate(0.3, 3)), 1e-12);

  const rec = cyclesToRecover(62000, 60000, 0.4, 1, 1.6);
  ok('циклы до окупаемости считаются', rec.cycles > 0 && rec.days > 0, `${rec.cycles} циклов ≈ ${rec.days.toFixed(1)} сут`);
  const none = cyclesToRecover(60000, 62000, 0.4, 1, 1.6);
  ok('рынок выше себестоимости — циклы не нужны', none.cycles === 0);
}

// ────────────────────────────────────────────── 9. Разбор символов опционов

section('Опционные символы');
{
  const p = parseOptionSymbol('BTC-25JUN27-30000-P-USDT');
  ok('символ разобран', p && p.strike === 30000 && p.kind === 'P');
  ok('экспирация в 08:00 UTC', new Date(p.expiry).toISOString() === '2027-06-25T08:00:00.000Z', new Date(p.expiry).toISOString());
  ok('мусор отсеян', parseOptionSymbol('BTC-XXX-1-P') === null);
}

// ────────────────────────────────────────────── 10. Живые данные

const offline = process.argv.includes('--offline');
if (!offline) {
  section('Живые данные Bybit');
  try {
    const [products, options, spot] = await Promise.all([fetchProducts(), fetchOptionTickers(), fetchSpot()]);
    const now = Date.now();
    ok('продукты BTC/USDT получены', products.length > 0, `${products.length} шт`);
    ok('спот получен', spot > 0, `${spot}`);

    let mismatches = 0;
    let receiveGaps = new Set();
    for (const p of products) {
      const t = productTiming(p, now);
      if (!t.labelMatches) mismatches++;
      receiveGaps.add(Number(p.expectReceiveAt) - Number(p.settlementTime));
    }
    ok('метка срока = окно начисления у всех продуктов', mismatches === 0, `расхождений: ${mismatches}`);
    ok(
      'задержка выдачи после сеттлмента одинакова',
      receiveGaps.size === 1,
      [...receiveGaps].map((g) => `${g / 60000} мин`).join(', '),
    );

    const vip = products.filter((p) => p.isVipProduct).length;
    ok('есть обычные и VIP продукты', vip > 0 && vip < products.length, `VIP: ${vip} из ${products.length}`);

    const surface = buildSurface(options, now);
    ok('поверхность волатильности собрана', surface.expiries.length >= 3, `${surface.expiries.length} экспираций`);
    const nearest = surface.expiries[0];
    ok('улыбка непустая', nearest.smile.length >= 5, `${nearest.smile.length} страйков на ближней дате`);

    // Интерполяция обязана попадать в котируемую точку.
    const mid = nearest.smile[Math.floor(nearest.smile.length / 2)];
    const iv = volAt(surface, spot, mid.K, nearest.T);
    near('интерполяция воспроизводит котируемую IV', iv, mid.iv, 2e-3);

    const fwd = forwardAt(surface, spot, nearest.T);
    ok('форвард рядом со спотом', Math.abs(fwd / spot - 1) < 0.2, `${fwd.toFixed(0)} против ${spot.toFixed(0)}`);

    // Полный расчёт одной оферты на живых котировках.
    const short = products.filter((p) => p.status === 'Available').sort((a, b) => Number(a.settlementTime) - Number(b.settlementTime))[0];
    const quote = await fetchQuote(short.productId);
    ok('лестница страйков получена', quote && quote.buyLowPrice.length > 0, `${quote?.buyLowPrice.length} уровней Buy Low`);
    ok('точное совпадение с экспирацией опционов', hasExactExpiry(surface, Number(short.settlementTime)));

    const timing = productTiming(short, now);
    const level = quote.buyLowPrice[quote.buyLowPrice.length - 1];
    const apy = apyFromE8(level.apyE8);
    const K = Number(level.selectPrice);
    const T = timing.tauDays / 365;
    const sigma = volAt(surface, spot, K, T);
    const F = forwardAt(surface, spot, T);
    const v = valueOffer({ direction: 'BuyLow', strike: K, apy, timing, forward: F, sigma });
    ok('оценка живой оферты посчитана', Number.isFinite(v.edgeApr) && Number.isFinite(v.pTriggerRN));

    // Циклы у живых продуктов: суточный обязан давать ровно двое суток на оборот,
    // восьмичасовой — ровно сутки, иначе модель расписания разошлась с биржей.
    const byDur = new Map();
    for (const p of products) byDur.set(p.duration + (p.isVipProduct ? ':vip' : ''), productTiming(p, now));
    const day1 = byDur.get('1d');
    const h8 = byDur.get('8h');
    if (day1) near('цикл живого 1d', day1.cycleDays, 2, 1e-6, ' сут');
    if (h8) near('цикл живого 8h', h8.cycleDays, 1, 1e-6, ' сут');
    console.log(
      `       ${short.duration} страйк ${K}: APY ${(apy * 100).toFixed(2)}%, ` +
        `эффективный ${(effectiveApr(apy, timing.yieldDays, timing.lockDays) * 100).toFixed(2)}%, ` +
        `P(конв) ${(v.pTriggerRN * 100).toFixed(2)}%, σ рынка ${(sigma * 100).toFixed(1)}%, ` +
        `σ оферты ${v.offerVol ? (v.offerVol * 100).toFixed(1) : '—'}%, премия ${(v.edgeApr * 100).toFixed(2)}%`,
    );
    ok('котировка живёт считанные секунды', Number(level.expiredAt) - now < 120_000, `${((Number(level.expiredAt) - now) / 1000).toFixed(0)} с`);
  } catch (e) {
    failed++;
    console.log(`  FAIL живые данные — ${e.message}`);
  }
}

console.log(`\nИтого: ${passed} успешно, ${failed} провалено`);
process.exit(failed ? 1 : 0);
