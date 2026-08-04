// Самопроверка ядра расчётов: аналитические тождества, воспроизведение
// документированного примера Bybit и инварианты на живых данных биржи.
//
//   node scripts/selftest.mjs          — полный прогон
//   node scripts/selftest.mjs --offline — без обращений к бирже

import {
  normCdf,
  normInv,
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
  empiricalLossProfile,
  rnLossProfile,
  martingaleShift,
  median,
  paretoFront,
  basisFromConversion,
  breakevenStrike,
  cyclesToRecover,
  twapEffectiveT,
  apyFromE8,
  truncate,
  MS_DAY,
} from '../web/quant.js';
import { History, annualize, computeStrategy, analyzeSellHigh, pickBest, pickAnchors, buildRows, sampleCagr } from '../web/model.js';
import { buildSurface, parseOptionSymbol, volAt, forwardAt, hasExactExpiry, atmVarianceCurve, totalVariance, forwardVol } from '../web/surface.js';
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

{
  // Обратная функция нужна для стресс-квантиля: «куда уйдёт цена в худших 5%».
  // Проверяем не саму формулу, а тождество N(N⁻¹(p)) = p, в том числе в хвостах.
  let worst = 0;
  let worstP = null;
  for (let p = 1e-7; p < 1; p *= 1.3) {
    const err = Math.abs(normCdf(normInv(p)) / p - 1);
    if (err > worst) {
      worst = err;
      worstP = p;
    }
  }
  ok('N(N⁻¹(p)) = p во всём диапазоне', worst < 1e-10, `максимум ${worst.toExponential(2)} при p=${worstP.toExponential(1)}`);
  near('N⁻¹(0.5) = 0', normInv(0.5), 0, 1e-12);
  near('N⁻¹(0.05)', normInv(0.05), -1.6448536269514729, 1e-9);
  ok('N⁻¹ монотонна', normInv(0.01) < normInv(0.5) && normInv(0.5) < normInv(0.99));
}

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

  // Дисконтирование у направлений разное, и это принципиально.
  //
  // Sell High вложен в биткоин, а его выплата уже нормирована на форвард —
  // деление на F само по себе содержит долларовый дисконт. Умножать сверху ещё
  // и на долларовую ставку значит применить её дважды. Здесь проверяется, что
  // ставка USDT на Sell High больше не влияет вовсе, а влияет ставка по монете.
  const shArgs = { direction: 'SellHigh', strike: 66000, apy: 0.4, timing, forward: F, sigma };
  const shPlain = valueOffer({ ...shArgs });
  const shUsdt = valueOffer({ ...shArgs, riskFree: 0.05 });
  const shBtc = valueOffer({ ...shArgs, riskFreeBtc: 0.05 });
  near('ставка USDT не входит в оценку Sell High', shUsdt.fairValue, shPlain.fairValue, 1e-15);
  ok('ставка по биткоину входит и снижает оценку', shBtc.fairValue < shPlain.fairValue);
  near(
    'её вклад равен простою монеты под этой ставкой',
    shBtc.fairValue / shPlain.fairValue,
    Math.exp((-0.05 * timing.lockDays) / 365),
    1e-12,
  );
  // А у Buy Low всё наоборот: долларовая ставка входит, ставка по монете — нет.
  const blBtc = valueOffer({ direction: 'BuyLow', strike: K, apy: apyFair, timing, forward: F, sigma, riskFreeBtc: 0.05 });
  near('ставка по биткоину не входит в оценку Buy Low', blBtc.fairValue, fair.fairValue, 1e-15);
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

  // Между циклами капитал простаивает, поэтому длительность считается по
  // полному обороту, а не по сроку блокировки первой оферты.
  const chained = cyclesToRecover(62000, 60000, 0.4, 1, 1.6, 2);
  ok('простой между циклами удлиняет возврат', chained.days > rec.days, `${chained.days.toFixed(1)} против ${rec.days.toFixed(1)} сут`);
  near('длительность = первая блокировка плюс остальные обороты', chained.days, 1.6 + (chained.cycles - 1) * 2, 1e-12, ' сут');
  const none = cyclesToRecover(60000, 62000, 0.4, 1, 1.6);
  ok('рынок выше себестоимости — циклы не нужны', none.cycles === 0);
}

// ────────────────────────────────────────────── 8a. Глубина конвертации

section('Глубина конвертации');
{
  const F = 63000;
  const K = 58000;
  const sigma = 0.5;
  const T = 30 / 365;
  const p = rnLossProfile({ direction: 'BuyLow', forward: F, strike: K, sigma, Teff: T, spot: 62000 });
  // Безусловная потеря — это цена пута в долях страйка, условная — она же,
  // делённая на вероятность конвертации. Тождество обязано выполняться точно.
  const put = black76Put(F, K, sigma, T);
  const v = sigma * Math.sqrt(T);
  const d2 = (Math.log(F / K) + (v * v) / 2) / v - v;
  near('безусловная потеря = Put/K', p.expected, put / K, 1e-15);
  near('условная потеря = безусловная / P(конв)', p.conditional, put / K / normCdf(-d2), 1e-12);
  ok('условная потеря больше безусловной', p.conditional > p.expected);
  ok('стресс-потеря не меньше условной', p.stress >= p.conditional, `${(p.stress * 100).toFixed(2)}% против ${(p.conditional * 100).toFixed(2)}%`);

  // Далёкий страйк: в худших 5% исходов цена до него всё равно не доходит.
  const far = rnLossProfile({ direction: 'BuyLow', forward: F, strike: 30000, sigma, Teff: T, spot: 62000 });
  ok('на далёком страйке стресс-потери нет', far.stress === 0, `${far.stress}`);

  // Чем ближе страйк к рынку, тем больше теряется в среднем.
  const near_ = rnLossProfile({ direction: 'BuyLow', forward: F, strike: 62000, sigma, Teff: T, spot: 62000 });
  ok('ближний страйк теряет больше дальнего', near_.expected > p.expected);

  // Sell High: потеря считается от стоимости монеты, а не от страйка.
  const sh = rnLossProfile({ direction: 'SellHigh', forward: F, strike: 66000, sigma, Teff: T, spot: 62000 });
  near('Sell High: безусловная потеря = Call/spot', sh.expected, black76Call(F, 66000, sigma, T) / 62000, 1e-15);

  // Эмпирический профиль на ряде с известным поведением.
  const closes = Array.from({ length: 400 }, (_, k) => 100 * 1.01 ** k);
  const r5 = logReturns(closes, 5);
  const emp = empiricalLossProfile(r5, 100, 90, 'BuyLow');
  ok('на растущем ряду ниже страйка потерь нет', emp.expected === 0 && emp.stress === 0);
  const emp2 = empiricalLossProfile(r5, 100, 200, 'BuyLow');
  ok('выше страйка потери есть и условная больше безусловной', emp2.expected > 0 && emp2.conditional >= emp2.expected);
}

// ────────────────────────────────────────────── 8b. Мартингальное центрирование

section('Приведение истории к рынку');
{
  // Выпуклость экспоненты: если центрировать логарифмы на ln(F/S), то среднее
  // самой цены окажется выше форварда, и в меру риска попадёт скрытый прогноз
  // роста. Поправка обязана убирать это ровно.
  const raw = Array.from({ length: 2001 }, (_, k) => (k - 1000) / 1000);
  const target = 1.03;
  const shifted = raw.map((r) => r + Math.log(target));
  const meanBefore = shifted.reduce((a, x) => a + Math.exp(x), 0) / shifted.length;
  ok('без поправки среднее цены выше форварда', meanBefore > target, `${meanBefore.toFixed(5)} против ${target}`);
  const fix = martingaleShift(shifted, target);
  const after = shifted.map((r) => r + fix);
  const meanAfter = after.reduce((a, x) => a + Math.exp(x), 0) / after.length;
  near('после поправки E[S_T] = F', meanAfter, target, 1e-12);
  ok('поправка отрицательна', fix < 0, `${fix.toFixed(6)}`);
  ok('порядок выборки сохранён', after.every((x, k) => k === 0 || x >= after[k - 1]));
}

// ────────────────────────────────────────────── 8c. Приведение к году

section('Приведение стоимости к году');
{
  near('удвоение за полгода', annualize(2, 182.5), 3, 1e-9);
  near('горизонт в год не меняет число', annualize(1.25, 365), 0.25, 1e-12);
  ok('падение даёт отрицательную ставку', annualize(0.9, 90) < 0);
  ok('нулевая стоимость не считается', annualize(0, 90) === null && annualize(1.1, 0) === null);
  near('медиана нечётного набора', median([3, 1, 2]), 2, 0);
  near('медиана чётного набора', median([4, 1, 2, 3]), 2.5, 0);
}

// ────────────────────────────────────────────── 8d. Траектории и стратегия

section('Траектории, накопление процента и стратегия');
{
  // Детерминированный ряд: 0.1% в сутки. На нём известен каждый ответ.
  const step = MS_DAY;
  const series = Array.from({ length: 400 }, (_, k) => [k * step, 100 * 1.001 ** k]);
  const hist = new History({ D: { stepMs: step, series } });

  // Первая контрольная точка — на τ, дальше через цикл. Здесь τ = 2 = цикл,
  // то есть классическая сетка как частный случай.
  const paths = hist.pathSeries(2, 2, 20);
  ok('циклов внутри горизонта', paths.cycles === 10, `${paths.cycles}`);
  ok('хвост горизонта пуст при кратном цикле', paths.tailDays === 0);
  near('терминальная цена берётся на горизонте, а не на последнем цикле', paths.terminal[0], 1.001 ** 20, 1e-12);
  near('нарастающий минимум растущего ряда — первая контрольная точка', paths.runMin[9], 1.001 ** 2, 1e-12);
  near('нарастающий максимум — последняя', paths.runMax[9], 1.001 ** 20, 1e-12);

  const ext = hist.pathExtremes(2, 2, 20);
  ok('сортированные ряды согласованы с попутевыми', ext.paths === paths.paths && ext.cycles === paths.cycles);
  near('вероятность уйти ниже первой точки равна нулю', empiricalCdf(ext.minima, 1.001 ** 2 - 1e-9), 0, 0);
  near('вероятность дойти до последней точки равна единице', 1 - empiricalCdf(ext.maxima, 1.001 ** 20 - 1e-9), 1, 0);

  // Хвост: горизонт 21 день при цикле 2 оставляет один день незакрытым.
  const odd = hist.pathSeries(2, 2, 21);
  ok('хвост горизонта посчитан', odd.cycles === 10 && odd.tailDays === 1, `циклов ${odd.cycles}, хвост ${odd.tailDays}`);

  // ── Главное: сетка начинается с τ, а не с цикла.
  //
  // Проверяется не согласованность реализации с самой собой, а попадание
  // первой контрольной точки в дату сеттлмента. Прежний тест сверял модель с
  // перебором по ТОЙ ЖЕ сетке и такую ошибку поймать не мог в принципе.
  {
    const tau = 1; // сеттлмент через сутки, а полный оборот — через двое
    const cycle = 2;
    const p = hist.pathSeries(tau, cycle, 20);
    ok('первая точка отстоит на τ, а не на цикл', p != null);
    near('первая контрольная точка — цена через τ', p.runMin[0], 1.001 ** tau, 1e-12);
    const naive = hist.pathSeries(cycle, cycle, 20);
    ok(
      'сетка от τ отличается от сетки от цикла',
      Math.abs(p.runMin[0] - naive.runMin[0]) > 1e-9,
      `${p.runMin[0].toFixed(6)} против ${naive.runMin[0].toFixed(6)}`,
    );
    // Число сеттлментов: первый через τ, остальные через цикл.
    ok('число сеттлментов = 1 + ⌊(H − τ)/цикл⌋', p.cycles === 1 + Math.floor((20 - tau) / cycle), `${p.cycles}`);
    near('последний сеттлмент = τ + (n−1)·цикл', p.modeledDays, tau + (p.cycles - 1) * cycle, 1e-12);
    // Оферта, которая не успевает рассчитаться ни разу.
    ok('горизонт короче τ означает отсутствие сеттлментов', hist.pathSeries(30, 2, 20) === null);
    // Сдвиг сетки не должен ломать соответствие сортированных рядов попутевым.
    const e2 = hist.pathExtremes(tau, cycle, 20);
    near('сортированный ряд согласован со сдвинутой сеткой', e2.minima[0], p.runMin[(p.cycles - 1)], 1e-12);
  }

  // Продукт «1d», купленный за 0.483 суток до закрытия окна: сеттлмент через
  // 1.483 суток, а полный оборот — через двое. Контрольные точки на дневном
  // ряду ложатся на бары 1, 3, 5, …
  const TAU = 1.483;
  const CYC = 2;
  const FIRST = Math.max(1, Math.round(TAU)); // бар первой контрольной точки
  const timing = { tauDays: TAU, cycleDays: CYC, yieldDays: 1, lockDays: TAU + 20 / 1440 };
  const mkRow = (strike, i) => ({ strike, i, apy: (i * 365) / 1, aprEff: 0.1, duration: '1d', productId: 'x', timing });
  const N = 1 + Math.floor((20 - TAU) / CYC);
  // Первый цикл, на котором ряд с шагом g достигает цели — считается из
  // определения ряда, а не из проверяемой функции.
  const hitAt = (g, target, down) => {
    for (let k = 0; k < N; k++) {
      const v = g ** (FIRST + k * CYC);
      if (down ? v <= target : v >= target) return k;
    }
    return -1;
  };

  // Стратегия: страйк ниже любой контрольной точки — конвертации нет никогда.
  const safe = mkRow(90, 0.001);
  computeStrategy({ rows: [safe], history: hist, spot: 100, horizonDays: 20, riskFree: 0 });
  ok('без конвертации риск нулевой', safe.strategy.pEndBtc === 0);
  near('без конвертации стоимость = (1+i)^n', safe.strategy.value, 1.001 ** N, 1e-12);
  near('среднее и медиана совпадают на детерминированном ряду', safe.strategy.valueMedian, safe.strategy.value, 1e-12);

  // Для конвертации цена обязана уйти ВНИЗ, поэтому падающий ряд: 0.1% в сутки.
  const down = Array.from({ length: 400 }, (_, k) => [k * step, 100 * 0.999 ** k]);
  const histDown = new History({ D: { stepMs: step, series: down } });
  const hot = mkRow(99.95, 0.001);
  computeStrategy({ rows: [hot], history: histDown, spot: 100, horizonDays: 20, riskFree: 0 });
  const kHot = hitAt(0.999, 99.95 / 100, true);
  ok('конвертация случается на каждой траектории', hot.strategy.pEndBtc === 1);
  ok('конвертация приходится на первый же сеттлмент', kHot === 0);
  near(
    'после конвертации капитал равен (1+i)^k·S_H/K',
    hot.strategy.value,
    (1.001 ** (kHot + 1) * (0.999 ** 20 * 100)) / 99.95,
    1e-12,
  );
  // Более глубокий страйк пробивается позже, значит процент успевает начислиться
  // больше раз — но и монета достаётся дешевле.
  const deep = mkRow(99.0, 0.001);
  computeStrategy({ rows: [deep], history: histDown, spot: 100, horizonDays: 20, riskFree: 0 });
  const kDeep = hitAt(0.999, 0.99, true);
  ok('глубокий страйк пробивается позже ближнего', kDeep > kHot, `цикл ${kDeep + 1} против ${kHot + 1}`);
  near(
    'конвертация на более глубоком страйке считает больше циклов процента',
    deep.strategy.value,
    (1.001 ** (kDeep + 1) * (0.999 ** 20 * 100)) / 99.0,
    1e-12,
  );

  // Хвост горизонта приносит безрисковый процент только если конвертации не было.
  const withTail = mkRow(90, 0.001);
  computeStrategy({ rows: [withTail], history: hist, spot: 100, horizonDays: 21, riskFree: 0.365 });
  const nTail = 1 + Math.floor((21 - TAU) / CYC);
  const tailDays = 21 - (TAU + (nTail - 1) * CYC);
  near(
    'хвост горизонта оплачен по безрисковой ставке',
    withTail.strategy.value,
    1.001 ** nTail * (1 + (0.365 * tailDays) / 365),
    1e-12,
  );

  // Sell High: процент накапливается по числу циклов до выхода.
  const sellRow = {
    strike: 100.3,
    i: 0.001,
    apy: 0.365,
    aprEff: 0.1,
    duration: '1d',
    productId: 's',
    timing,
    shortfall: null,
    pRN: 0.5,
    pHist: 0.5,
    histInfo: { independent: 999 },
  };
  const an = analyzeSellHigh({ rows: [sellRow], basis: 100, qty: 1, spot: 100, history: hist, horizonDays: 20, riskFree: 0 });
  const s = an[0];
  const kSell = hitAt(1.001, 1.003, false);
  ok('выход состоялся на всех траекториях', s.pExitHorizon === 1);
  ok('выход приходится не на первый сеттлмент', kSell > 0, `цикл ${kSell + 1}`);
  near('прибыль за один цикл считает один процент', s.profitPct, (1.001 * 100.3) / 100 - 1, 1e-12);
  near('прибыль к выходу считает процент за все циклы до него', s.profitAtExit, (1.001 ** (kSell + 1) * 100.3) / 100 - 1, 1e-12);
  ok('накопление увеличивает прибыль', s.profitAtExit > s.profitPct);
  near('скорость выхода = прибыль × шанс × 365 / H', s.exitSpeed, (s.profitAtExit * s.pExitHorizon * 365) / 20, 1e-12);
  near('ожидание выхода = τ + (циклов−1)·цикл', s.expExitDays, TAU + kSell * CYC, 1e-12);
  ok('полное матожидание посчитано по обеим ветвям', Number.isFinite(s.fullRate) && Number.isFinite(s.fullMedianRate));
  ok('база сравнения приложена к результату', an.baseline != null && Number.isFinite(an.baseline.holdRate));
}

// ────────────────────────────────────────────── 8e. Отбор в блок «оптимальные»

section('Отбор карточек');
{
  const mk = (id, aprEff, pConv, volEdge) => ({
    productId: id,
    duration: '1d',
    strike: 1,
    aprEff,
    pConv,
    volEdge,
    moneyness: -0.01,
  });
  // Фронт из семи точек: доходность растёт вместе с риском.
  const rows = Array.from({ length: 7 }, (_, k) => mk(`p${k}`, 0.02 * (k + 1), 0.02 * (k + 1), -0.1 + 0.01 * (k === 2 ? 9 : k)));
  const best = pickBest({ rows, maxP: 0.5 });
  ok('карточек не больше лимита', best.length <= 6, `${best.length}`);
  ok('максимум доходности показан и подписан', best.some((r) => (r.bestTag ?? '').includes('максимум доходности') && r.aprEff === 0.14));
  ok('лучшая цена риска показана и подписана', best.some((r) => (r.bestTag ?? '').includes('лучшая цена риска') && r.productId === 'p2'));
  // Главное: блок больше не состоит из одного края фронта.
  const span = Math.max(...best.map((r) => r.pConv)) - Math.min(...best.map((r) => r.pConv));
  const full = Math.max(...rows.map((r) => r.pConv)) - Math.min(...rows.map((r) => r.pConv));
  ok('срез покрывает размах фронта, а не его край', span >= full * 0.9, `${(span * 100).toFixed(1)} из ${(full * 100).toFixed(1)} п.п.`);
  ok('карточки упорядочены от осторожных к доходным', best.every((r, k) => k === 0 || r.pConv >= best[k - 1].pConv));
}

// ────────────────────────────────────────────── 8e2. Сценарный слой

section('Срочная структура волатильности и сценарные траектории');
{
  // Кривая с техническим провалом: на 0.2 года накопленная дисперсия ниже, чем
  // на 0.1. Такого не бывает — форвардная дисперсия была бы отрицательной.
  const fake = {
    expiries: [
      { T: 0.1, smile: [{ x: -0.1, iv: 0.5 }, { x: 0.1, iv: 0.5 }] },
      { T: 0.2, smile: [{ x: -0.1, iv: 0.2 }, { x: 0.1, iv: 0.2 }] },
      { T: 0.5, smile: [{ x: -0.1, iv: 0.4 }, { x: 0.1, iv: 0.4 }] },
    ],
  };
  const curve = atmVarianceCurve(fake);
  ok('провал монотонности найден и починен', curve.repaired === 1, `починено ${curve.repaired}`);
  near('дисперсия на первой экспирации', curve.points[0].w, 0.25 * 0.1, 1e-15);
  near('провал подтянут до предыдущего уровня', curve.points[1].w, 0.25 * 0.1, 1e-15);
  ok('после починки кривая не убывает', curve.points.every((p, k) => k === 0 || p.w >= curve.points[k - 1].w - 1e-15));
  ok('форвардная волатильность неотрицательна на почищенном участке', forwardVol(curve, 0.1, 0.2) === 0);
  near('форвардная волатильность участка', forwardVol(curve, 0.2, 0.5), Math.sqrt((0.08 - 0.025) / 0.3), 1e-12);
  near('накопленная дисперсия линейна внутри участка', totalVariance(curve, 0.35), 0.025 + 0.5 * (0.08 - 0.025), 1e-12);

  // Ряд со случайным блужданием: детерминированный генератор ради повторяемости.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  const step = MS_DAY;
  const series = [];
  let px = 60000;
  for (let k = 0; k < 900; k++) {
    px *= Math.exp(0.0004 + 0.03 * rnd());
    series.push([k * step, px]);
  }
  const hist = new History({ D: { stepMs: step, series } });
  const H = 90;

  // Для проверки накопленной изменчивости нужна кривая БЕЗ починенных участков:
  // на плоском участке рынок как бы обещает ноль дополнительной дисперсии, а
  // ноль на десятках дней BTC физически невозможен, поэтому такой участок
  // намеренно остаётся историческим — и равенство с кривой там не выполняется.
  const clean = atmVarianceCurve({
    expiries: [
      { T: 0.1, smile: [{ x: -0.1, iv: 0.4 }, { x: 0.1, iv: 0.4 }] },
      { T: 0.3, smile: [{ x: -0.1, iv: 0.45 }, { x: 0.1, iv: 0.45 }] },
      { T: 0.6, smile: [{ x: -0.1, iv: 0.5 }, { x: 0.1, iv: 0.5 }] },
    ],
  });
  ok('чистая кривая не требует починки', clean.repaired === 0);

  hist.useScenario({ cagr: 0.11, curve: clean, id: 'clean' });
  const sp = hist.scenarioPaths(H);
  ok('сценарные траектории построены', sp != null && sp.paths > 100, `${sp?.paths} траекторий`);

  // Геометрическое среднее конечных значений обязано в точности равняться цели.
  let accLog = 0;
  for (let p = 0; p < sp.paths; p++) accLog += Math.log(sp.ratio[p * sp.width + sp.bars]);
  const geo = Math.exp(accLog / sp.paths) ** (365 / H) - 1;
  near('геометрический рост траекторий равен заданному CAGR', geo, 0.11, 1e-9);

  // Накопленная изменчивость пути обязана совпасть с рыночной кривой.
  let accVar = 0;
  for (let j = 1; j <= sp.bars; j++) {
    let s = 0;
    for (let p = 0; p < sp.paths; p++) {
      s += (Math.log(sp.ratio[p * sp.width + j]) - Math.log(sp.ratio[p * sp.width + j - 1])) ** 2;
    }
    accVar += s / sp.paths;
  }
  const want = totalVariance(clean, H / 365);
  ok(
    'накопленная дисперсия траекторий равна рыночной w(H)',
    Math.abs(accVar / want - 1) < 0.05,
    `получено ${accVar.toFixed(5)}, рынок ${want.toFixed(5)}, отклонение ${((accVar / want - 1) * 100).toFixed(2)}%`,
  );

  // А на кривой с починенным участком изменчивость обязана быть НЕ МЕНЬШЕ
  // рыночной: плоский участок остаётся историческим, а не нулевым.
  hist.useScenario({ cagr: 0.11, curve, id: 'repaired' });
  const spR = hist.scenarioPaths(H);
  let varR = 0;
  for (let j = 1; j <= spR.bars; j++) {
    let s2 = 0;
    for (let p = 0; p < spR.paths; p++) {
      s2 += (Math.log(spR.ratio[p * spR.width + j]) - Math.log(spR.ratio[p * spR.width + j - 1])) ** 2;
    }
    varR += s2 / spR.paths;
  }
  const wantR = totalVariance(curve, H / 365);
  ok(
    'на починенном участке изменчивость не обнуляется',
    varR > wantR * 1.01,
    `${varR.toFixed(5)} против рыночных ${wantR.toFixed(5)} — плоский участок взят историческим`,
  );
  hist.useScenario({ cagr: 0.11, curve: clean, id: 'clean' });

  // Все оферты обязаны считаться на ОДНОМ наборе траекторий.
  const a = hist.pathSeries(1.5, 2, H);
  const b = hist.pathSeries(26.5, 27, H);
  ok('разные оферты берут одинаковое число траекторий', a.paths === b.paths, `${a.paths} и ${b.paths}`);
  let sameTerminal = true;
  for (let p = 0; p < a.paths; p += 37) if (Math.abs(a.terminal[p] - b.terminal[p]) > 1e-15) sameTerminal = false;
  ok('и одинаковые конечные цены: набор траекторий общий', sameTerminal);
  ok('контрольные точки при этом свои у каждой', a.cycles !== b.cycles, `${a.cycles} против ${b.cycles}`);

  // Смена сценария обязана сбрасывать кэш.
  const before = sp.ratio[sp.bars];
  hist.useScenario({ cagr: 0.4, curve: clean, id: 'clean' });
  const sp2 = hist.scenarioPaths(H);
  ok('смена сценария меняет траектории', Math.abs(sp2.ratio[sp2.bars] - before) > 1e-9);
  hist.useScenario({ cagr: 0.11, curve: clean, id: 'clean' });
  near('возврат к прежнему сценарию воспроизводит траектории', hist.scenarioPaths(H).ratio[sp.bars], before, 1e-15);

  // Без сценария ряд обязан остаться ровно тем, что пришло с биржи.
  const raw = new History({ D: { stepMs: step, series } });
  const rp = raw.scenarioPaths(H);
  near('без сценария траектория повторяет исходный ряд', rp.ratio[rp.width + 10], series[10 + 1][1] / series[1][1], 1e-12);

  // Рост центральной линии выборки считается геометрически и БЕЗ горизонта.
  const auto = sampleCagr(raw);
  ok('рост выборки посчитан', Number.isFinite(auto), `${(auto * 100).toFixed(2)}% годовых`);

  // Главное свойство новой оценки: она не зависит от горизонта. Прежняя версия
  // усредняла по окнам длиной H и на одном и том же ряду давала 8% при H=180 и
  // 29% при H=500, из-за чего переключение горизонта меняло предпосылку о рынке.
  ok(
    'оценка роста не принимает горизонт вовсе',
    sampleCagr.length === 1,
    `аргументов у функции: ${sampleCagr.length}`,
  );

  // И сходится с тем, что даёт сам траекторный слой без сценария: там дрейф —
  // это среднее логарифмического прироста того же ряда. Раньше «авто» и «без
  // сценария» были двумя разными мирами.
  const drift = Math.log(series[series.length - 1][1] / series[0][1]) / (series.length - 1);
  near('рост выборки равен росту от края до края', Math.log(1 + auto) / 365, drift, 1e-12);
}

// ────────────────────────────────────────────── 8e3. Кэш и вырожденный ввод

section('Кэш не растёт, вырожденный ввод не выдаётся за ответ');
{
  // Регрессия, которую прежние тесты поймать не могли: они считали один кадр,
  // а течь проявляется только на череде кадров с непрерывно меняющимися
  // временем до сеттлмента и спотом. Замер до починки: 8059 записей за 60
  // кадров и девять гигабайт за час работы вкладки.
  const step = MS_DAY;
  let seed = 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  const series = [];
  let px = 60000;
  for (let k = 0; k < 700; k++) {
    px *= Math.exp(0.0003 + 0.02 * rnd());
    series.push([k * step, px]);
  }
  const hist = new History({ D: { stepMs: step, series } });
  const curve = atmVarianceCurve({
    expiries: [
      { T: 0.1, smile: [{ x: -0.1, iv: 0.4 }, { x: 0.1, iv: 0.4 }] },
      { T: 0.5, smile: [{ x: -0.1, iv: 0.5 }, { x: 0.1, iv: 0.5 }] },
    ],
  });
  hist.useScenario({ cagr: 0.1, curve, id: 'cache' });

  const H = 90;
  // Сорок кадров: τ убывает посекундно, как в проде.
  for (let f = 0; f < 40; f++) {
    const tau = 5.4 - f * 0.00002;
    hist.pathSeries(tau, 6, H);
    hist.pathExtremes(tau, 6, H);
    hist.scaled(5.4, 0.4 + f * 1e-6, 0.0147, 1.001 + f * 1e-7);
  }
  ok(
    'кэш не растёт от кадра к кадру',
    hist.cache.size < 20,
    `записей ${hist.cache.size} после 40 кадров — ключи привязаны к барам, а не к суткам`,
  );
  const heavy = [...hist.cache.keys()].filter((k) => k.startsWith('paths:') || k.startsWith('sorted:'));
  ok('тяжёлых сеток ровно по одной на конфигурацию', heavy.length <= 2, `${heavy.join(', ')}`);
  ok('нормированные серии не кэшируются вовсе', ![...hist.cache.keys()].some((k) => k.startsWith('scaled:')));

  // Вырожденная поверхность обязана отдаваться как отсутствие данных.
  ok('пустая поверхность → null, а не нулевая волатильность', atmVarianceCurve({ expiries: [] }) === null);
  ok(
    'одной экспирации мало для кривой',
    atmVarianceCurve({ expiries: [{ T: 0.1, smile: [{ x: 0, iv: 0.4 }] }] }) === null,
  );
  {
    // Без кривой участок остаётся историческим, а не нулевым: риск не обнуляется.
    const h2 = new History({ D: { stepMs: step, series } });
    h2.useScenario({ cagr: 0.1, curve: null, id: 'nocurve' });
    const sp = h2.scenarioPaths(H);
    const t = [];
    for (let p = 0; p < sp.paths; p++) t.push(sp.ratio[p * sp.width + sp.bars]);
    ok('без кривой траектории всё равно расходятся', Math.max(...t) - Math.min(...t) > 0.05, `размах ${(Math.max(...t) - Math.min(...t)).toFixed(3)}`);
  }

  // Невозможный сценарий роста не должен рождать нечисла.
  for (const bad of [-1, -1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const h3 = new History({ D: { stepMs: step, series } });
    h3.useScenario({ cagr: bad, curve, id: `bad${bad}` });
    const sp = h3.scenarioPaths(H);
    const finite = sp && [...sp.ratio.slice(0, 500)].every(Number.isFinite);
    ok(`рост ${bad} не рождает нечисел`, finite === true);
  }
}

// ────────────────────────────────────────────── 8f. Свежесть котировок

section('Свежесть котировок');
{
  const now = Date.UTC(2026, 6, 31, 12, 0);
  const product = {
    productId: '1',
    duration: '1d',
    status: 'Available',
    isVipProduct: false,
    subscribeStartAt: String(now - 3600_000),
    subscribeEndAt: String(now + 6 * 3600_000),
    settlementTime: String(now + 30 * 3600_000),
    expectReceiveAt: String(now + 30 * 3600_000 + 20 * 60_000),
  };
  const level = (strike, apyE8, expiredAt) => ({ selectPrice: String(strike), apyE8: String(apyE8), maxInvestmentAmount: '1000000', expiredAt: String(expiredAt) });
  // Минимальная поверхность волатильности: без неё у строк нет вероятности, и
  // фронт оказался бы пуст по причине, не имеющей отношения к свежести.
  const tickers = [];
  for (const [d, m, y] of [
    [2, 7, 26],
    [10, 7, 26],
  ]) {
    for (const K of [55000, 58000, 61000, 64000, 67000]) {
      tickers.push({
        symbol: `BTC-${d}AUG${y}-${K}-P-USDT`,
        markIv: '0.45',
        underlyingPrice: '61100',
        indexPrice: '61000',
      });
    }
  }
  const surface = buildSurface(tickers, now);
  const quotes = new Map([
    [
      '1',
      {
        productId: '1',
        buyLowPrice: [
          level(60000, 40e8, now + 30_000), // живая, ставка выше
          level(58000, 10e8, now + 30_000), // живая, осторожная
          level(62000, 90e8, now - 5_000), // ПРОТУХШАЯ и самая заманчивая
        ],
        sellHighPrice: [],
      },
    ],
  ]);
  const rows = buildRows({
    products: [product],
    quotes,
    direction: 'BuyLow',
    now,
    spot: 61000,
    surface,
    history: null,
    riskFree: 0.02,
    amount: 1000,
    vip: false,
    measure: 'rn',
  });
  ok('строки построены', rows.length === 3, `${rows.length}`);
  ok('вероятность посчитана по синтетической поверхности', rows.every((r) => Number.isFinite(r.pConv)));
  const stale = rows.filter((r) => r.quoteStale);
  ok('протухшая котировка помечена', stale.length === 1 && stale[0].strike === 62000);
  ok('счётчик протухших приложен к набору', rows.staleCount === 1, `${rows.staleCount}`);
  ok('протухшая строка не попадает на фронт Парето', stale[0].pareto === false);
  ok('живые строки на фронт попадают', rows.filter((r) => r.pareto).length > 0);

  // Самая доходная оферта здесь протухшая: она обязана быть исключена из
  // рекомендаций, иначе панель советует цену, которой больше нет.
  const best = pickBest({ rows, maxP: 0.99 });
  ok('протухшая оферта не попадает в карточки', !best.some((r) => r.quoteStale), `карточек ${best.length}`);
  ok('карточки не пусты, пока есть живые оферты', best.length > 0);
  const anchors = pickAnchors(rows);
  ok(
    'протухшая оферта не становится якорем',
    Object.values(anchors).every((a) => !a || !a.row.quoteStale),
  );

  // Когда протухло всё, рекомендаций не остаётся вовсе — это и есть пауза.
  const allStale = buildRows({
    products: [product],
    quotes: new Map([['1', { productId: '1', buyLowPrice: [level(60000, 40e8, now - 1)], sellHighPrice: [] }]]),
    direction: 'BuyLow',
    now,
    spot: 61000,
    surface,
    history: null,
    riskFree: 0.02,
    amount: 1000,
    vip: false,
    measure: 'rn',
  });
  ok('при полностью устаревшем снимке фронт пуст', allStale.every((r) => !r.pareto));
  ok('и карточек нет', pickBest({ rows: allStale, maxP: 0.99 }).length === 0);
  ok('счётчик показывает, что устарело всё', allStale.staleCount === allStale.length);

  // Отсутствие поля не наказываем: у уровня без expiredAt котировка живая.
  const noField = buildRows({
    products: [product],
    quotes: new Map([['1', { productId: '1', buyLowPrice: [{ selectPrice: '60000', apyE8: '4000000000', maxInvestmentAmount: '1' }], sellHighPrice: [] }]]),
    direction: 'BuyLow',
    now,
    spot: 61000,
    surface,
    history: null,
    riskFree: 0.02,
    amount: 1000,
    vip: false,
    measure: 'rn',
  });
  ok('уровень без срока истечения считается живым', noField.every((r) => !r.quoteStale));
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
