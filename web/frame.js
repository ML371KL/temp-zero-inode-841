// Вычисления одного кадра панели — без DOM. app.js зовёт computeFrame раз в
// секунду и рисует результат; тот же код гоняет замер кадра в Node.
//
// Самое дорогое здесь — траекторный слой: прогон каждой оферты по полутора
// тысячам траекторий на весь горизонт. Каждую секунду он не нужен: его входы
// (спот, время до сеттлмента, ставки лестниц) за секунду почти не меняются.
// Поэтому слой хранится в кэше по сторонам и пересчитывается фоновой задачей
// кусками не длиннее PATH_SLICE_MS: раз в PATH_REFRESH_MS или сразу, когда
// сменились входы, от которых он зависит целиком (горизонт, сценарий,
// альтернативная ставка, история, состав строк). Пока задача идёт, кадр
// показывает последний готовый результат; если готового для этих входов нет
// вовсе — кадр помечается неготовым, и панель не перерисовывает блоки, пока
// задача не закончит (без мигания и без чисел от чужого горизонта).
//
// Ключ кэша — строка оферты (продукт, страйк), а не непрерывные величины:
// ключ от времени или спота был бы течью, а не кэшем.

import {
  buildRows,
  pickBest,
  pickAnchors,
  frontierWithMargins,
  computeStrategy,
  analyzeSellHigh,
  pickBestSell,
  exitFrontier,
  pickExitAnchors,
  pickStrategyCards,
  markHorizonRisk,
  sampleCagr,
  laddersFrom,
  runProduct,
  markSubscriptionFront,
} from './model.js';
import { settlementSchedule } from './quant.js';
import { atmVarianceCurve, surfaceAt } from './surface.js';

/** Как часто обновлять траекторный слой при неизменных входах. */
export const PATH_REFRESH_MS = 10_000;
/** Длина одного куска фоновой задачи. */
export const PATH_SLICE_MS = 40;
/** Сколько новых строк досчитывается сразу, а не фоновой задачей. */
const MISSING_SYNC = 24;

const SIDES = ['BuyLow', 'SellHigh'];
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createFrameState() {
  return {
    // По стороне: { sig, at, results: Map(ключ строки → прогон) }.
    sides: { BuyLow: null, SellHigh: null },
    job: null,
    // Замеры: сколько длились куски задачи и сколько раз слой пересчитывался.
    stats: { jobs: 0, slices: 0, maxSliceMs: 0, syncRows: 0 },
  };
}

const rowKey = (r) => `${r.productId}|${r.strike}`;

/** Всё, от чего траекторный слой зависит целиком. */
function signature(ctx) {
  return `${ctx.horizonDays}|${ctx.riskFree}|${ctx.history?.uid ?? ''}:${ctx.history?.scenarioKey ?? ''}`;
}

/**
 * Задача на пересчёт: снимок строк (только поля, нужные прогону), группы
 * «продукт, τ» и лестницы на момент постановки. Считается кусками.
 */
function makeJob(fs, need, ctx, at) {
  const base = ctx.history?.scenarioPaths(ctx.horizonDays) ?? null;
  const tasks = [];
  const sides = {};
  for (const { side, rows } of need) {
    const snap = rows.map((r) => ({
      productId: r.productId,
      direction: r.direction,
      strike: r.strike,
      apy: r.apy,
      timing: r.timing,
    }));
    const ladders = laddersFrom(snap, ctx.spot);
    const groups = new Map();
    for (const r of snap) {
      const gk = `${r.productId}|${r.timing.tauDays}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = []));
      g.push(r);
    }
    for (const list of groups.values()) {
      tasks.push({ side, list, ladder: ladders.get(`${list[0].productId}|${side}`) });
    }
    sides[side] = { sig: signature(ctx), at, results: new Map(), keys: snap.length };
  }
  fs.stats.jobs++;
  return { tasks, next: 0, sides, base, spot: ctx.spot, horizonDays: ctx.horizonDays, riskFree: ctx.riskFree };
}

/**
 * Один кусок фоновой задачи: группы продуктов, пока не вышло время. Возвращает
 * true, когда задача закончена и результат опубликован.
 */
export function runPathSlice(fs, budgetMs = PATH_SLICE_MS) {
  const job = fs.job;
  if (!job) return true;
  const t0 = now();
  while (job.next < job.tasks.length) {
    const t = job.tasks[job.next++];
    const sched = settlementSchedule(t.list[0].timing, job.horizonDays);
    const res = job.base
      ? runProduct({ rows: t.list, base: job.base, sched, ladder: t.ladder, spot: job.spot, horizonDays: job.horizonDays, riskFree: job.riskFree })
      : t.list.map(() => null);
    const out = job.sides[t.side].results;
    t.list.forEach((r, j) => out.set(rowKey(r), res[j]));
    if (now() - t0 >= budgetMs) break;
  }
  const spent = now() - t0;
  fs.stats.slices++;
  fs.stats.maxSliceMs = Math.max(fs.stats.maxSliceMs, spent);
  if (job.next < job.tasks.length) return false;
  // Публикуется целиком и сразу по обеим сторонам: таблицы и карточки не
  // увидят наполовину обновлённый слой.
  for (const side of Object.keys(job.sides)) fs.sides[side] = job.sides[side];
  fs.job = null;
  return true;
}

/**
 * Приложить кэш к строкам стороны. Возвращает 'ok', 'refresh' (результат
 * есть, но пора обновить) или 'missing' (для этих входов результата нет).
 */
function attach(fs, side, rows, ctx, at) {
  const entry = fs.sides[side];
  if (!entry || entry.sig !== signature(ctx)) return 'missing';
  const lost = [];
  for (const r of rows) {
    const hit = entry.results.get(rowKey(r));
    if (hit === undefined) lost.push(r);
    else {
      r.path = hit;
      r.pathPinned = true;
    }
  }
  if (lost.length > MISSING_SYNC) return 'missing';
  if (lost.length) {
    // Новый страйк в лестнице — досчитать его сразу: это несколько строк.
    // Лестница — по всем строкам кадра, как и в фоновом пересчёте.
    const base = ctx.history.scenarioPaths(ctx.horizonDays);
    const ladders = laddersFrom(rows, ctx.spot);
    const groups = new Map();
    for (const r of lost) {
      const gk = `${r.productId}|${r.timing.tauDays}`;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = []));
      g.push(r);
    }
    for (const list of groups.values()) {
      const sched = settlementSchedule(list[0].timing, ctx.horizonDays);
      const res = base
        ? runProduct({ rows: list, base, sched, ladder: ladders.get(`${list[0].productId}|${side}`), spot: ctx.spot, horizonDays: ctx.horizonDays, riskFree: ctx.riskFree })
        : list.map(() => null);
      list.forEach((r, j) => {
        r.path = res[j];
        r.pathPinned = true;
        entry.results.set(rowKey(r), res[j]);
      });
    }
    fs.stats.syncRows += lost.length;
  }
  return at - entry.at >= PATH_REFRESH_MS ? 'refresh' : 'ok';
}

/**
 * Предпосылки о рынке: рост центральной линии (введённый или по выборке) и
 * кривая ATM-дисперсии с опционов. Ключ сценария включает момент загрузки
 * опционов: кривая живёт минуту.
 */
function applyScenario(history, surface, optionsAt, cagrText, at) {
  if (!history) return { scenarioInfo: null, varCurve: null };
  const auto = sampleCagr(history);
  const typed = cagrText === '' || cagrText == null ? null : Number(cagrText) / 100;
  // Ниже −95% годовых считать нечего; сверху — десятикратный рост.
  const cagr = Number.isFinite(typed) ? Math.min(Math.max(typed, -0.95), 10) : auto;
  const varCurve = surface ? atmVarianceCurve(surfaceAt(surface, at)) : null;
  history.useScenario({ cagr, curve: varCurve, id: `${optionsAt}|${varCurve?.points.length ?? 0}` });
  return { scenarioInfo: { cagr, auto, typed: Number.isFinite(typed) }, varCurve };
}

/**
 * Кадр целиком.
 *
 * inp: products, quotes, now (мс), spot, surface, optionsAt, history,
 *      riskFree (альтернативная ставка), riskFreeBtc, stats (сводка перцентилей),
 *      ui: { vip, amount, maxP, measure, mode, horizon, cagr, durations, convQty },
 *      basis — себестоимость BTC (null, если не введена).
 */
export function computeFrame(fs, inp) {
  const { ui } = inp;
  const at = inp.now;
  const horizonDays = Number(ui.horizon) || 90;
  const { scenarioInfo, varCurve } = applyScenario(inp.history, inp.surface, inp.optionsAt, ui.cagr, at);
  const ctx = { history: inp.history, spot: inp.spot, horizonDays, riskFree: inp.riskFree ?? 0 };

  const build = (direction) => {
    if (!inp.spot || !inp.products?.length) return [];
    const rows = buildRows({
      products: inp.products,
      quotes: inp.quotes,
      direction,
      now: at,
      spot: inp.spot,
      surface: inp.surface,
      history: inp.history,
      riskFree: inp.riskFree,
      riskFreeBtc: inp.riskFreeBtc,
      amount: direction === 'BuyLow' ? Number(ui.amount) || 0 : Number(ui.convQty) || 0,
      vip: ui.vip,
      measure: ui.measure,
      stats: inp.stats,
      horizonDays,
      paths: false,
    });
    const allowed = new Set(ui.durations ?? []);
    if (!allowed.size) return rows;
    // Фильтр по срокам не должен терять счётчики: они висят на массиве.
    const kept = rows.filter((r) => allowed.has(r.duration));
    // Фронт подписки — заново среди оставшихся строк: посчитанный до фильтра,
    // он мог не иметь ни одной точки среди них, и таблица фронта, линия на
    // графике и плашки «Парето» пропадали.
    markSubscriptionFront(kept);
    kept.staleCount = kept.filter((r) => r.quoteStale).length;
    kept.optionsStale = rows.optionsStale;
    kept.optionsAgeMs = rows.optionsAgeMs;
    return kept;
  };
  const buy = build('BuyLow');
  const sell = build('SellHigh');
  const basis = inp.basis > 0 ? inp.basis : null;

  // Траекторный слой: Buy Low нужен всегда (риск за горизонт), Sell High — когда
  // введена себестоимость.
  let ready = true;
  const need = [];
  if (inp.history && inp.spot > 0) {
    const wanted = [{ side: 'BuyLow', rows: buy }];
    if (basis) wanted.push({ side: 'SellHigh', rows: sell });
    let refresh = false;
    for (const w of wanted) {
      if (!w.rows.length) continue;
      const state = attach(fs, w.side, w.rows, ctx, at);
      if (state === 'missing') ready = false;
      if (state !== 'ok') refresh = true;
      need.push(w);
    }
    // Задача ставится, если её нет; если входы сменились, а идёт задача на
    // прежние — она заменяется новой.
    const sig = signature(ctx);
    const stale = fs.job && Object.values(fs.job.sides).some((x) => x.sig !== sig);
    if ((refresh && !fs.job) || stale || (!ready && !fs.job)) fs.job = makeJob(fs, need, ctx, at);
  }

  const out = {
    ready,
    buy,
    sell,
    basis,
    horizonDays,
    riskFree: inp.riskFree,
    scenarioInfo,
    varCurve,
    jobPending: Boolean(fs.job),
  };
  if (!ready) return out;

  // Риск за горизонт — из приложенного слоя (pathLayer здесь ничего не считает).
  if (inp.history) markHorizonRisk(buy, inp.history, inp.spot, horizonDays, ctx.riskFree);
  out.best = pickBest({ rows: buy, maxP: ui.maxP });
  out.anchors = pickAnchors(buy, { measure: ui.measure, riskFree: inp.riskFree });
  out.frontier = frontierWithMargins(buy, ctx.riskFree);
  if (ui.mode === 'strategy') {
    out.strategy = computeStrategy({ rows: buy, history: inp.history, spot: inp.spot, horizonDays, riskFree: ctx.riskFree });
    out.strategyCards = out.strategy ? pickStrategyCards(out.strategy.rows) : [];
  }
  if (basis) {
    const analyzed = analyzeSellHigh({
      rows: sell,
      basis,
      qty: Number(ui.convQty) || 0,
      spot: inp.spot,
      history: inp.history,
      measure: ui.measure,
      horizonDays,
      riskFree: ctx.riskFree,
    });
    out.analyzed = analyzed;
    out.bestSell = pickBestSell({ rows: analyzed });
    out.exitFront = exitFrontier(analyzed);
    out.exitAnchors = pickExitAnchors(analyzed);
  }
  return out;
}

export { SIDES };
