// Оркестровка панели: сбор данных, пересчёт раз в секунду, отрисовка.

import {
  fetchProducts,
  fetchQuote,
  fetchOptionTickers,
  fetchSpot,
  fetchRiskFree,
  fetchKlines,
  fetchAprStats,
  fetchTreasuryCurve,
  rateForHorizon,
  OfferStream,
  SpotStream,
  normalizeWsOffer,
} from './feeds.js';
import { buildSurface, atmVarianceCurve, forwardVol } from './surface.js';
import { Archive } from './archive.js';
import {
  History,
  buildRows,
  pickBest,
  pickBestSell,
  analyzeSellHigh,
  exitFrontier,
  frontierWithMargins,
  pickAnchors,
  pickExitAnchors,
  computeStrategy,
  sampleCagr,
  MIN_INDEPENDENT_WINDOWS,
} from './model.js';
import { basisFromConversion, interestRate, cyclesToRecover, rnLossProfile, STRESS_LEVEL, MS_DAY } from './quant.js';
import { scatterChart, ladderChart, durationColor } from './charts.js';

// ───────────────────────────────────────────────────────── состояние

const state = {
  products: [],
  quotes: new Map(),
  spot: null,
  spotDir: 0,
  surface: null,
  history: null,
  // Рабочая альтернативная стоимость доллара. По умолчанию — доходность бумаг
  // казначейства США на срок вашего горизонта, а не то, что платит биржа:
  // гибкий депозит Bybit даёт 1.6% там, где трёхмесячные бумаги дают 3.8%,
  // и сравнивать стратегию надо с тем, что доллар может заработать вообще.
  riskFree: null,
  // Что платит именно биржа — показывается рядом для справки.
  bybitUsdt: null,
  treasury: null,
  // Ставка по BTC нужна отдельно: Sell High запирает монету, и стоимость этого
  // простоя измеряется ставкой по монете, а не по доллару.
  riskFreeBtc: null,
  // Сценарий рынка: рост центральной линии и срочная структура волатильности.
  varCurve: null,
  scenarioInfo: null,
  stats: null,
  archive: null,
  wsStatus: 'connecting',
  lastQuoteAt: 0,
  lastOptionsAt: 0,
  errors: [],
  ladderProduct: null,
};

const PREF_KEY = 'dual-assets-radar-ui';
const ui = {
  vip: false,
  amount: 10000,
  maxP: 0.15,
  measure: 'max',
  // Две постановки задачи, а не одна: «эта покупка сейчас» и «стратегия до даты».
  // Панель обязана всегда показывать, в какой она находится, — ответы у них
  // расходятся почти полностью.
  mode: 'single',
  sort: 'aprEff',
  durations: [],
  tz: 'local',
  theme: null,
  // Пустая строка означает «взять автоматическое значение».
  cagr: '',
  rfOpp: '',
  convPrice: '',
  convQty: '',
  convWasDual: true,
  convApy: '',
  convDuration: '1',
  horizon: '90',
  // Свёрнутые панели и таблицы, показанные целиком. Длинные списки по
  // умолчанию обрезаются: страница про решение, а не про перечисление.
  collapsed: {},
  expanded: {},
};

// Сколько строк показывать в длинной таблице до нажатия «показать все».
const ROW_PREVIEW = 8;

const SORT_KEYS = new Set(['aprEff', 'edgeApr', 'expNet', 'pConv', 'pHorizon', 'settle']);

function loadPrefs() {
  try {
    Object.assign(ui, JSON.parse(localStorage.getItem(PREF_KEY) || '{}'));
  } catch {
    /* повреждённые настройки не должны мешать запуску */
  }
  // Сохранённая сортировка могла остаться от снятого варианта: «APR на единицу
  // риска» делил годовую ставку на вероятность за одну сделку, то есть множил
  // перекос осей, а «ожидаемый чистый APR» переехал на согласованную серию.
  if (!SORT_KEYS.has(ui.sort)) ui.sort = 'aprEff';
  if (ui.mode !== 'single' && ui.mode !== 'strategy') ui.mode = 'single';
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(ui));
  } catch {
    /* приватный режим — просто не сохраняем */
  }
}

// ───────────────────────────────────────────────────────── форматирование

const $ = (id) => document.getElementById(id);

const nf = (digits) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money0 = nf(0);
const money2 = nf(2);

function fmtPct(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtSigned(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = (x * 100).toFixed(digits);
  return `${x > 0 ? '+' : ''}${s}%`;
}

function fmtUsd(x, digits = 0) {
  if (x == null || !Number.isFinite(x)) return '—';
  return (digits ? money2 : money0).format(x);
}

function fmtBtc(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return x.toFixed(8);
}

function fmtSpan(days) {
  if (days == null || !Number.isFinite(days)) return '—';
  const total = Math.max(0, Math.round(days * 1440));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  if (ui.tz === 'utc') {
    return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(
      d.getUTCHours(),
    ).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Сколько циклов процента в BTC закроют разрыв с себестоимостью. */
function fmtRecovery(rec) {
  if (!rec) return '<span class="muted">—</span>';
  if (rec.cycles === 0) return '<span class="pos">не нужно</span>';
  // Отсутствие числа означает не «неизвестно», а «дольше любого разумного срока».
  if (rec.cycles == null) return '<span class="neg">&gt; 400</span>';
  return `${rec.cycles} · ${fmtSpan(rec.days)}`;
}

/**
 * Пометка перекоса лестницы: соседний страйк того же продукта одновременно
 * безопаснее и платит не меньше, значит эта оферта бессмысленна.
 */
function fmtLadderFlag(row) {
  if (!row.laddered) return '';
  return (
    ` <span class="flag" title="страйк ${fmtUsd(row.laddered.strike, 2)} того же продукта ` +
    `платит ${fmtPct(row.laddered.apy, 2)} против ${fmtPct(row.apy, 2)} и при этом безопаснее">⚠</span>`
  );
}

/**
 * Историческая вероятность вместе с весом выборки. Тонкая выборка приглушается
 * и в осторожном режиме вообще не участвует в отборе.
 */
function fmtHist(row) {
  const value = row.pHistScaled ?? row.pHist;
  if (value == null) return '<span class="muted">—</span>';
  const ind = row.histInfo?.independent;
  const thin = ind != null && ind < MIN_INDEPENDENT_WINDOWS;
  const parts = [];
  if (ind != null) parts.push(`независимых окон: ${Math.round(ind)}`);
  if (row.pHistScaled != null && row.pHist != null) {
    parts.push(`без нормировки: ${fmtPct(row.pHist, 2)}`);
  }
  const title = parts.length ? ` title="${parts.join(' · ')}"` : '';
  return `<span class="${thin ? 'muted' : ''}"${title}>${fmtPct(value, 2)}${thin ? '&nbsp;·&nbsp;тонкая' : ''}</span>`;
}

/** Перцентиль текущей ставки относительно собранного архива. */
function fmtPercentile(row) {
  if (row.aprPercentile == null) return '<span class="muted">—</span>';
  const p = Math.round(row.aprPercentile * 100);
  const tone = p >= 75 ? 'pos' : p <= 25 ? 'neg' : '';
  return `<span class="${tone}" title="по ${row.aprBucketN} наблюдениям за месяц">${p}</span>`;
}

const cls = (x) => (x == null || !Number.isFinite(x) ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

/**
 * Глубина конвертации. Вероятность отвечает «как часто», глубина — «сколько»,
 * и без второго числа порог вероятности не ограничивает деньги: при одинаковых
 * 7% восьмичасовая оферта теряет 0.04% капитала, а 236-дневная 1.6%.
 */
function fmtDepth(row, field, digits = 2) {
  const v = row.depth?.[field];
  if (v == null || !Number.isFinite(v)) return '<span class="muted">—</span>';
  return `${(v * 100).toFixed(digits)}%`;
}

/** Лимит на сумму по этому страйку — жёсткое ограничение биржи, не оценка. */
function fmtLimit(row) {
  if (!Number.isFinite(row.maxInvest) || row.maxInvest <= 0) return '<span class="muted">—</span>';
  const amount = Number(ui.amount) || 0;
  const tight = amount > 0 && row.maxInvest < amount;
  return `<span class="${tight ? 'neg' : 'muted'}"${tight ? ' title="введённая сумма больше лимита этой оферты"' : ''}>${fmtUsd(row.maxInvest)}</span>`;
}

/**
 * Сколько живёт котировка. Ставки Bybit протухают за 8–20 секунд, и строка со
 * сработавшим сроком — это уже не то, что подтвердит биржа.
 */
function fmtQuoteAge(row) {
  if (!Number.isFinite(row.quoteExpiresAt) || row.quoteExpiresAt <= 0) return '<span class="muted">—</span>';
  const left = (row.quoteExpiresAt - Date.now()) / 1000;
  if (left < 0) return `<span class="neg" title="биржа пересчитает ставку">истекла</span>`;
  return `<span class="${left < 5 ? 'warn-text' : 'muted'}">${left.toFixed(0)} с</span>`;
}

// ───────────────────────────────────────────────────────── загрузка данных

async function loadProducts() {
  try {
    state.products = await fetchProducts();
    renderDurationChips();
  } catch (e) {
    pushError(`продукты: ${e.message}`);
  }
}

async function bootstrapQuotes() {
  // Первичное заполнение по REST, чтобы таблица не пустовала до первого снимка потока.
  const ids = state.products.map((p) => p.productId);
  const results = await Promise.allSettled(ids.map((id) => fetchQuote(id)));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) state.quotes.set(String(r.value.productId), r.value);
  }
  state.lastQuoteAt = Date.now();
}

async function loadOptions() {
  try {
    const tickers = await fetchOptionTickers();
    state.surface = buildSurface(tickers, Date.now());
    state.lastOptionsAt = Date.now();
  } catch (e) {
    pushError(`опционы: ${e.message}`);
  }
}

async function loadHistory() {
  try {
    // Три сетки разной глубины: часовая покрывает несколько месяцев,
    // четырёхчасовая — больше года, дневная — всю доступную историю пары.
    const [h1, h4, d1] = await Promise.all([fetchKlines('60', 4), fetchKlines('240', 3), fetchKlines('D', 3)]);
    state.history = new History({ 60: h1, 240: h4, D: d1 });
  } catch (e) {
    pushError(`история цен: ${e.message}`);
  }
}

function pushError(msg) {
  state.errors = [msg, ...state.errors.filter((m) => m !== msg)].slice(0, 3);
}

// ───────────────────────────────────────────────────────── расчёт

const horizonDays = () => Number(ui.horizon) || 90;

/**
 * Предпосылки о рынке, которые панель больше не принимает молча.
 *
 * Рост центральной линии и срочная структура волатильности — это взгляд на
 * будущее, а не факт из прошлого. Раньше траекторный слой брал и то и другое
 * из пятилетней выборки: дрейф 13% годовых и волатильность 52.5%, тогда как
 * рынок опционов сегодня оценивает ближайшую неделю в 33%, а год в 42%.
 * Теперь оба параметра явные, с разумными умолчаниями и с полями ввода.
 */
function applyScenario() {
  const H = horizonDays();
  if (!state.history) return null;
  // Горизонта у оценки дрейфа больше нет: она одна на всю историю. Прежде окно
  // усреднения равнялось горизонту, и переключение 90 → 365 меняло предпосылку
  // о рынке (10.2% → 18.9%), а не только срок расчёта.
  const auto = sampleCagr(state.history);
  const typed = ui.cagr === '' ? null : Number(ui.cagr) / 100;
  // Ниже −95% годовых считать нечего: цена обращается в ноль, и весь расчёт
  // вырождается. Сверху ограничиваем десятикратным ростом — дальше это уже не
  // предпосылка, а опечатка.
  const cagr = Number.isFinite(typed) ? Math.min(Math.max(typed, -0.95), 10) : auto;
  state.varCurve = state.surface ? atmVarianceCurve(state.surface) : null;
  // Ключ сценария включает момент пересборки поверхности: кривая живёт минуту,
  // и без этого траектории остались бы на позавчерашней волатильности.
  state.history.useScenario({
    cagr,
    curve: state.varCurve,
    id: `${state.lastOptionsAt}|${state.varCurve?.points.length ?? 0}`,
  });
  state.scenarioInfo = { cagr, auto, typed: Number.isFinite(typed) };
  return state.scenarioInfo;
}

/** Альтернативная стоимость доллара на срок вашего горизонта. */
function opportunityRate() {
  const typed = ui.rfOpp === '' ? null : Number(ui.rfOpp) / 100;
  if (Number.isFinite(typed) && typed >= 0) return typed;
  const t = rateForHorizon(state.treasury, horizonDays());
  return t ? t.rate : (state.bybitUsdt ?? 0);
}

function currentRows(direction) {
  if (!state.spot || !state.products.length) return [];
  const rows = buildRows({
    products: state.products,
    quotes: state.quotes,
    direction,
    now: Date.now(),
    spot: state.spot,
    surface: state.surface,
    history: state.history,
    riskFree: state.riskFree,
    riskFreeBtc: state.riskFreeBtc,
    amount: direction === 'BuyLow' ? Number(ui.amount) || 0 : Number(ui.convQty) || 0,
    vip: ui.vip,
    measure: ui.measure,
    stats: state.stats,
    horizonDays: horizonDays(),
  });
  const allowed = new Set(ui.durations);
  if (!allowed.size) return rows;
  // Фильтр по срокам не должен терять счётчик протухших: он висит свойством на
  // массиве, а filter отдаёт голый новый массив.
  const kept = rows.filter((r) => allowed.has(r.duration));
  kept.staleCount = kept.filter((r) => r.quoteStale).length;
  return kept;
}

function sortRows(rows) {
  const key = ui.sort;
  const copy = [...rows];
  if (key === 'settle') return copy.sort((a, b) => a.timing.settle - b.timing.settle || b.aprEff - a.aprEff);
  // Риск сортируем по возрастанию: сверху самое осторожное.
  if (key === 'pConv' || key === 'pHorizon') return copy.sort((a, b) => (a[key] ?? 9) - (b[key] ?? 9));
  return copy.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
}

/** Себестоимость BTC по введённым параметрам конвертации. */
function conversionBasis() {
  const price = Number(ui.convPrice);
  if (!(price > 0)) return null;
  if (!ui.convWasDual) return { basis: price, note: 'введена как есть' };
  const apy = Number(ui.convApy) / 100;
  const days = Number(ui.convDuration);
  if (!(apy > 0) || !(days > 0)) return { basis: price, note: 'без учёта процента: не задан APR оферты' };
  const basis = basisFromConversion(price, apy, days);
  const i = interestRate(apy, days);
  return {
    basis,
    note: `страйк ${fmtUsd(price)} минус начисленные ${fmtPct(i, 3)} → фактическая цена ${fmtUsd(basis, 2)}`,
  };
}

// ───────────────────────────────────────────────────────── отрисовка

function renderDurationChips() {
  const box = $('durations');
  const list = [...new Set(state.products.map((p) => p.duration))].sort(
    (a, b) => durationDays(a) - durationDays(b),
  );
  box.innerHTML = '';
  for (const d of list) {
    const b = document.createElement('button');
    b.className = 'chip' + (ui.durations.includes(d) ? ' on' : '');
    b.textContent = d;
    b.style.borderColor = ui.durations.includes(d) ? durationColor(d, list) : '';
    b.onclick = () => {
      ui.durations = ui.durations.includes(d) ? ui.durations.filter((x) => x !== d) : [...ui.durations, d];
      savePrefs();
      renderDurationChips();
      render();
    };
    box.append(b);
  }
  if (list.length) {
    const all = document.createElement('button');
    all.className = 'chip' + (ui.durations.length === 0 ? ' on' : '');
    all.textContent = 'все';
    all.onclick = () => {
      ui.durations = [];
      savePrefs();
      renderDurationChips();
      render();
    };
    box.prepend(all);
  }
}

function durationDays(text) {
  const m = /^(\d+(?:\.\d+)?)([hd])$/i.exec(text || '');
  if (!m) return 1e9;
  return m[2].toLowerCase() === 'h' ? Number(m[1]) / 24 : Number(m[1]);
}

function renderHead() {
  const spotEl = $('spot');
  spotEl.textContent = state.spot ? money2.format(state.spot) : '—';
  spotEl.className = 'value' + (state.spotDir > 0 ? ' up' : state.spotDir < 0 ? ' down' : '');

  const dot = $('ws-dot');
  const text = $('ws-text');
  const age = state.lastQuoteAt ? (Date.now() - state.lastQuoteAt) / 1000 : null;
  // Кружок в шапке отвечает не за соединение, а за пригодность цен: поток может
  // быть открыт, а часть ставок уже пересчитана биржей. Оранжевый означает
  // ровно это, и тогда подробности ждут в блоке статуса внизу страницы.
  const stale = state.stale?.count ?? 0;
  if (state.wsStatus === 'open' && age != null && age < 30) {
    dot.className = stale ? 'dot warn' : 'dot live';
    text.textContent = stale
      ? `устарели ${stale} из ${state.stale.total}`
      : `котировки живые · ${age.toFixed(0)} с назад`;
  } else if (state.wsStatus === 'open') {
    dot.className = stale ? 'dot warn' : 'dot';
    text.textContent = stale ? `поток тих · устарели ${stale} из ${state.stale.total}` : 'поток тих';
  } else {
    dot.className = 'dot bad';
    text.textContent = state.wsStatus.startsWith('reconnect')
      ? `переподключение через ${state.wsStatus.split(':')[1]} с`
      : state.wsStatus;
  }
}

function cardFor(row) {
  const t = row.timing;
  const closeIn = (t.subEnd - Date.now()) / MS_DAY;
  const tags = [];
  if (row.isVip) tags.push('<span class="tag vip">VIP</span>');
  // Почему именно эта карточка попала в блок. Раньше все шесть были подряд с
  // верхнего края фронта, и подпись была не нужна — но и осторожных вариантов
  // там не было вовсе.
  if (row.bestTag) tags.push(`<span class="tag pick">${row.bestTag}</span>`);
  if (row.pareto) tags.push('<span class="tag good">Парето</span>');
  if (row.volEdge > 0) tags.push(`<span class="tag good">σ +${(row.volEdge * 100).toFixed(1)}</span>`);
  else if (row.volEdge < 0) tags.push(`<span class="tag warn">σ ${(row.volEdge * 100).toFixed(1)}</span>`);
  if (!row.exactExpiry) tags.push('<span class="tag">σ интерп.</span>');
  if (row.aprPercentile != null) {
    const p = Math.round(row.aprPercentile * 100);
    tags.push(`<span class="tag ${p >= 75 ? 'good' : p <= 25 ? 'warn' : ''}">${p}-й перцентиль</span>`);
  }

  return `
    <article class="card${row.pareto ? ' pareto' : ''}" data-product="${row.productId}">
      <div class="card-top">
        <div class="apr">${fmtPct(row.aprEff, 1)}<small>эффективный · заявлен ${fmtPct(row.apy, 1)}</small></div>
        <div class="tags">${tags.join('')}</div>
      </div>
      <dl class="kv">
        <dt>Страйк</dt><dd>${fmtUsd(row.strike, 2)} <span class="muted">(${fmtSigned(row.moneyness, 2)})</span></dd>
        <dt>Срок / блокировка</dt><dd>${row.duration} → ${fmtSpan(t.lockDays)}</dd>
        <dt>Мёртвое время</dt><dd>${fmtSpan(t.idleDays)}</dd>
        <dt>APR в непрерывном цикле</dt><dd>${fmtPct(row.aprChained, 2)}</dd>
        <dt>P(конвертации)</dt><dd class="${row.pConv > 0.15 ? 'neg' : ''}">${fmtPct(row.pConv, 2)}</dd>
        <dt>Потеря при конвертации</dt><dd>${fmtDepth(row, 'conditional')} <span class="muted">в среднем ${fmtDepth(row, 'expected', 3)}</span></dd>
        <dt>Стресс ${Math.round(STRESS_LEVEL * 100)}%</dt><dd class="${row.depth?.stress > 0 ? 'neg' : ''}">${fmtDepth(row, 'stress')}</dd>
        <dt>Риск за ${ui.horizon} дней</dt><dd>${fmtPct(row.pHorizon, 1)}</dd>
        <dt>Премия к опционам</dt><dd class="${cls(row.edgeApr)}">${fmtSigned(row.edgeApr, 1)}</dd>
        <dt>Доход на сумму</dt><dd>${row.money ? fmtUsd(row.money.interest, 2) : '—'} USDT</dd>
        <dt>Окно закроется</dt><dd>${fmtSpan(closeIn)}</dd>
      </dl>
    </article>`;
}

const BUY_COLUMNS = [
  ['Срок', (r) => `${r.isVip ? '<span class="vip-badge">★</span> ' : ''}${r.duration}`, 'left'],
  ['Страйк', (r) => `${fmtUsd(r.strike, 2)}${fmtLadderFlag(r)}`],
  ['От спота', (r) => `<span class="muted">${fmtSigned(r.moneyness, 2)}</span>`],
  ['APR заявл.', (r) => fmtPct(r.apy, 2)],
  ['APR эфф.', (r) => `<b>${fmtPct(r.aprEff, 2)}</b>`],
  ['APR в цикле', (r) => `<span class="muted">${fmtPct(r.aprChained, 2)}</span>`],
  ['Перцентиль', (r) => fmtPercentile(r)],
  ['Блокировка', (r) => fmtSpan(r.timing.lockDays)],
  ['Мёртвое', (r) => `<span class="muted">${fmtSpan(r.timing.idleDays)}</span>`],
  ['P рын.', (r) => fmtPct(r.pRN, 2)],
  ['P ист. норм.', (r) => fmtHist(r)],
  ['P раб.', (r) => `<b class="${r.pConv > 0.15 ? 'neg' : ''}">${fmtPct(r.pConv, 2)}</b>`],
  ['P за гориз.', (r) => `<span class="muted">${fmtPct(r.pHorizon, 1)}</span>`],
  ['Ожид. потеря', (r) => fmtDepth(r, 'expected', 3)],
  ['Потеря при конв.', (r) => fmtDepth(r, 'conditional')],
  [`Стресс ${Math.round(STRESS_LEVEL * 100)}%`, (r) => `<span class="${r.depth?.stress > 0 ? 'neg' : 'muted'}">${fmtDepth(r, 'stress')}</span>`],
  ['σ рынок', (r) => fmtPct(r.sigma, 1)],
  ['σ оферты', (r) => fmtPct(r.offerVol, 1)],
  ['Премия σ', (r) => `<span class="${cls(r.volEdge)}">${fmtSigned(r.volEdge, 1)}</span>`],
  ['Премия APR', (r) => `<span class="${cls(r.edgeApr)}">${fmtSigned(r.edgeApr, 1)}</span>`],
  ['Ожид. чистый', (r) => `<span class="${cls(r.expNet)}">${fmtSigned(r.expNet, 1)}</span>`],
  ['Доход, USDT', (r) => (r.money ? fmtUsd(r.money.interest, 2) : '—')],
  ['BTC при конв.', (r) => (r.money ? fmtBtc(r.money.btcIfConverted) : '—')],
  ['Лимит, USDT', (r) => fmtLimit(r)],
  ['Котировка', (r) => fmtQuoteAge(r)],
  ['Сеттлмент', (r) => fmtTime(r.timing.settle)],
];

/**
 * Стратегия до выбранной даты: обе оси на одном горизонте и на одних
 * траекториях. Медиана рядом со средним обязательна — распределение годовых
 * исходов BTC скошено, и одно среднее читается как обещание.
 */
const STRATEGY_COLUMNS = [
  ['Срок', (r) => `${r.isVip ? '<span class="vip-badge">★</span> ' : ''}${r.duration}`, 'left'],
  ['Страйк', (r) => `${fmtUsd(r.strike, 2)}${fmtLadderFlag(r)}`],
  ['От спота', (r) => `<span class="muted">${fmtSigned(r.moneyness, 2)}</span>`],
  ['Закончить в BTC', (r) => `<b>${fmtPct(r.stratRisk, 1)}</b>`],
  ['Геометрич. годовых', (r) => `<b class="${cls(r.stratGeo)}">${fmtSigned(r.stratGeo, 1)}</b>`],
  ['Ожид. годовых', (r) => `<span class="${cls(r.stratAnnual)}">${fmtSigned(r.stratAnnual, 1)}</span>`],
  ['Медиана годовых', (r) => `<span class="${cls(r.strategy?.annualMedian)}">${fmtSigned(r.strategy?.annualMedian, 1)}</span>`],
  ['Циклов', (r) => (r.strategy ? String(r.strategy.cycles) : '—')],
  ['Цикл', (r) => fmtSpan(r.timing.cycleDays)],
  ['APR в цикле', (r) => `<span class="muted">${fmtPct(r.aprChained, 2)}</span>`],
  ['P за сделку', (r) => `<span class="muted">${fmtPct(r.pConv, 2)}</span>`],
  ['Ожид. потеря', (r) => fmtDepth(r, 'expected', 3)],
  ['Премия σ', (r) => `<span class="${cls(r.volEdge)}">${fmtSigned(r.volEdge, 1)}</span>`],
  ['Лимит, USDT', (r) => fmtLimit(r)],
];

const FRONTIER_COLUMNS = [
  ['Срок', (r) => `${r.isVip ? '<span class="vip-badge">★</span> ' : ''}${r.duration}`, 'left'],
  ['Страйк', (r) => `${fmtUsd(r.strike, 2)}${fmtLadderFlag(r)}`],
  ['От спота', (r) => `<span class="muted">${fmtSigned(r.moneyness, 2)}</span>`],
  ['P(конв)', (r) => `<b>${fmtPct(r.pConv, 2)}</b>`],
  ['APR эфф.', (r) => `<b>${fmtPct(r.aprEff, 2)}</b>`],
  ['APR в цикле', (r) => `<span class="muted">${fmtPct(r.aprChained, 2)}</span>`],
  ['Прибавка APR', (r) => `<span class="${cls(r.gainApr)}">${fmtSigned(r.gainApr, 2)}</span>`],
  ['Ценой риска', (r) => `<span class="muted">${fmtSigned(r.gainP, 2)}</span>`],
  ['Цена шага', (r) => fmtMarginal(r.marginal)],
  ['Премия σ', (r) => `<span class="${cls(r.volEdge)}">${fmtSigned(r.volEdge, 2)}</span>`],
  ['Доход, USDT', (r) => (r.money ? fmtUsd(r.money.interest, 2) : '—')],
  ['Сеттлмент', (r) => fmtTime(r.timing.settle)],
];

/**
 * Предельная цена риска. Значение выше единицы означает, что шаг добавляет
 * больше процентных пунктов доходности, чем процентных пунктов риска.
 */
function fmtMarginal(x) {
  if (x == null || !Number.isFinite(x)) return '<span class="muted">—</span>';
  const tone = x >= 2 ? 'pos' : x < 0.5 ? 'neg' : '';
  return `<b class="${tone}">${x >= 100 ? '≫' : x.toFixed(2)}</b>`;
}

const EXIT_FRONT_COLUMNS = [
  ['Срок', (r) => `${r.isVip ? '<span class="vip-badge">★</span> ' : ''}${r.duration}`, 'left'],
  ['Страйк', (r) => `${fmtUsd(r.strike, 2)}${fmtLadderFlag(r)}`],
  ['От спота', (r) => `<span class="muted">${fmtSigned(r.moneyness, 2)}</span>`],
  ['Прибыль к выходу', (r) => `<b>${fmtSigned(r.profitAtExit, 2)}</b>`],
  ['за один цикл', (r) => `<span class="muted">${fmtSigned(r.profitPct, 2)}</span>`],
  ['Шанс выйти', (r) => `<b>${fmtPct(r.pExitHorizon, 1)}</b>`],
  ['Циклов', (r) => (r.horizonInfo ? String(r.horizonInfo.cycles) : '—')],
  ['Ждать', (r) => fmtSpan(r.expExitDays)],
  ['Скорость выхода', (r) => `<span class="${cls(r.exitSpeed)}">${fmtPct(r.exitSpeed, 1)}</span>`],
  ['Полное матожид.', (r) => `<b class="${cls(r.fullRate)}">${fmtSigned(r.fullRate, 1)}</b>`],
  ['Медиана', (r) => `<span class="${cls(r.fullMedianRate)}">${fmtSigned(r.fullMedianRate, 1)}</span>`],
  ['P за цикл', (r) => `<span class="muted">${fmtPct(r.pConv, 1)}</span>`],
  ['Цикл', (r) => fmtSpan(r.timing.cycleDays)],
  ['Прибавка', (r) => `<span class="${cls(r.gainProfit)}">${fmtSigned(r.gainProfit, 2)}</span>`],
  ['Ценой шанса', (r) => `<span class="muted">${fmtSigned(r.costP == null ? null : -r.costP, 1)}</span>`],
  ['Цена шага', (r) => fmtMarginal(r.marginal)],
  ['APR в BTC', (r) => `<span class="muted">${fmtPct(r.aprEff, 1)}</span>`],
  ['Сеттлмент', (r) => fmtTime(r.timing.settle)],
];

const SELL_COLUMNS = [
  ['Срок', (r) => `${r.isVip ? '<span class="vip-badge">★</span> ' : ''}${r.duration}`, 'left'],
  ['Страйк', (r) => `${fmtUsd(r.strike, 2)}${fmtLadderFlag(r)}`],
  ['От спота', (r) => `<span class="muted">${fmtSigned(r.moneyness, 2)}</span>`],
  ['APR заявл.', (r) => fmtPct(r.apy, 2)],
  ['APR эфф.', (r) => `<b>${fmtPct(r.aprEff, 2)}</b>`],
  ['APR в цикле', (r) => `<span class="muted">${fmtPct(r.aprChained, 2)}</span>`],
  ['Блокировка', (r) => fmtSpan(r.timing.lockDays)],
  ['P продажи', (r) => fmtPct(r.pConv, 2)],
  ['Порог б/у', (r) => fmtUsd(r.breakeven, 2)],
  ['Запас', (r) => `<span class="${cls(r.cushion)}">${fmtSigned(r.cushion, 2)}</span>`],
  ['Выручка, USDT', (r) => fmtUsd(r.usdtIfSold, 2)],
  ['Прибыль', (r) => `<span class="${cls(r.profitUsdt)}">${r.profitUsdt == null ? '—' : fmtUsd(r.profitUsdt, 2)}</span>`],
  ['Прибыль, %', (r) => `<span class="${cls(r.profitPct)}">${fmtSigned(r.profitPct, 2)}</span>`],
  ['Прибыль к выходу', (r) => `<span class="${cls(r.profitAtExit)}">${fmtSigned(r.profitAtExit, 2)}</span>`],
  ['Шанс выйти', (r) => fmtPct(r.pExitHorizon, 1)],
  ['Ждать', (r) => fmtSpan(r.expExitDays)],
  ['Скорость выхода', (r) => `<span class="${cls(r.exitSpeed)}">${fmtPct(r.exitSpeed, 1)}</span>`],
  ['Полное матожид.', (r) => `<span class="${cls(r.fullRate)}">${fmtSigned(r.fullRate, 1)}</span>`],
  ['Премия σ', (r) => `<span class="${cls(r.volEdge)}">${fmtSigned(r.volEdge, 1)}</span>`],
  ['Циклов до б/у', (r) => fmtRecovery(r.recovery)],
  ['Сеттлмент', (r) => fmtTime(r.timing.settle)],
];

function renderTable(table, columns, rows, rowClass) {
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = `<tr>${columns.map(([name]) => `<th>${name}</th>`).join('')}</tr>`;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${columns.length}" class="muted">нет доступных оферт при текущих фильтрах</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) =>
        `<tr class="${rowClass ? rowClass(r) : ''}" data-product="${r.productId}">${columns
          .map(([, fn]) => `<td>${fn(r)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
}

/** Таблица с обрезкой длинного хвоста и кнопкой «показать все». */
function renderLimitedTable(key, table, columns, rows, rowClass) {
  const expanded = !!ui.expanded[key];
  renderTable(table, columns, expanded ? rows : rows.slice(0, ROW_PREVIEW), rowClass);
  const btn = document.querySelector(`[data-more="${key}"]`);
  if (!btn) return;
  btn.hidden = rows.length <= ROW_PREVIEW;
  btn.textContent = expanded
    ? `свернуть до ${ROW_PREVIEW} строк`
    : `показать все ${rows.length} — сейчас видно ${Math.min(ROW_PREVIEW, rows.length)}`;
}

/**
 * Переключение постановки задачи. Панель обязана всегда показывать, в какой она
 * сейчас: ответы двух режимов на живых данных расходятся почти полностью, и
 * молча выбирать один за пользователя нельзя.
 */
function applyMode() {
  const strategy = ui.mode === 'strategy';
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.classList.toggle('on', btn.dataset.mode === ui.mode);
  }
  $('best-panel').hidden = strategy;
  $('frontier-panel').hidden = strategy;
  $('strategy-panel').hidden = !strategy;
  $('mode-note').innerHTML = strategy
    ? `Считается стратегия целиком: оферта катается до первой конвертации, дальше биткоин держится ` +
      `до конца горизонта. Доходность и риск измерены на одних и тех же <b>${ui.horizon} днях</b>, ` +
      `поэтому сроки сравнимы между собой.`
    : `Считается одна сегодняшняя покупка: годовая ставка на срок её блокировки против вероятности ` +
      `конвертации на её собственном сеттлменте. Внутри одного срока это точный ответ; между сроками ` +
      `помните, что доходность здесь поделена на время, а вероятность нет — соседний режим считает обе ` +
      `оси на общем горизонте.`;
}

/** Синхронизация кнопок сворачивания с сохранённым состоянием. */
function syncCollapse() {
  for (const btn of document.querySelectorAll('[data-collapse]')) {
    const key = btn.dataset.collapse;
    const body = document.querySelector(`[data-body="${key}"]`);
    if (!body) continue;
    const off = !!ui.collapsed[key];
    body.classList.toggle('collapsed', off);
    btn.textContent = off ? 'развернуть' : 'свернуть';
  }
}

function renderBuy(rows) {
  const best = pickBest({ rows, maxP: ui.maxP });
  if (best.length) {
    $('best').innerHTML = best.map(cardFor).join('');
  } else {
    // Пустой блок бесполезен без числа: показываем, какой порог вообще достижим.
    const ps = rows.map((r) => r.pConv).filter(Number.isFinite);
    const min = ps.length ? Math.min(...ps) : null;
    $('best').innerHTML =
      `<div class="empty">При пороге ${fmtPct(ui.maxP, 1)} подходящих оферт нет.` +
      (min == null
        ? ' Данных для оценки риска пока нет.'
        : ` Самая осторожная оферта на рынке сейчас — ${fmtPct(min, 2)}: лестница страйков Bybit по BTC узкая, дальше спота она не уходит.`) +
      '</div>';
  }

  if (!state.ladderProduct && best.length) state.ladderProduct = best[0].productId;

  const sorted = sortRows(rows);
  const laddered = rows.filter((r) => r.laddered).length;
  $('buy-count').innerHTML =
    `${rows.length} оферт · ${new Set(rows.map((r) => r.productId)).size} продуктов` +
    (ui.vip ? ' · VIP включены' : ' · только общедоступные') +
    (laddered
      ? ` · <span class="flag">⚠</span> ${laddered}: у этих оферт в той же лестнице есть страйк дальше от рынка, ` +
        'который платит не меньше — то есть строго безопаснее и не хуже по доходности'
      : '');
  renderLimitedTable('buy', $('buy-table'), BUY_COLUMNS, sorted, (r) =>
    [r.pareto ? 'pareto' : '', r.quoteStale ? 'dim' : ''].filter(Boolean).join(' '),
  );
  renderAnchors(rows);
  renderFrontier(rows);

  const strategy = ui.mode === 'strategy' ? renderStrategy(rows) : null;
  const durations = [...new Set(state.products.map((p) => p.duration))].sort((a, b) => durationDays(a) - durationDays(b));
  if (strategy) {
    $('scatter-title').textContent = 'Геометрическая стоимость стратегии против риска остаться в BTC';
    $('scatter-hint').textContent =
      `обе оси на горизонте ${ui.horizon} дней и на одних траекториях; линией — фронт Парето`;
    // Ось Y обязана быть той же, по которой построен фронт, а это геометрическая
    // стоимость. С арифметической линия фронта шла бы немонотонно, и фоновые
    // точки оказывались бы выше неё — глазами это читалось бы как ошибка отбора,
    // хотя отбор верен, а врал график.
    scatterChart($('scatter'), rows, {
      durations,
      onHover: showTip,
      xKey: 'stratRisk',
      yKey: 'stratGeo',
      frontKey: 'stratPareto',
      xLabel: `шанс закончить ${ui.horizon} дней в биткоине`,
      yLabel: 'геометрическая годовая стоимость',
      showThreshold: false,
    });
  } else {
    $('scatter-title').textContent = 'Доходность против риска на сеттлменте';
    $('scatter-hint').textContent = 'эффективный APR и вероятность конвертации этой покупки; линией — фронт Парето';
    scatterChart($('scatter'), rows, { durations, maxP: ui.maxP, onHover: showTip });
  }

  const ladderRows = rows.filter((r) => r.productId === state.ladderProduct);
  const p = state.products.find((x) => x.productId === state.ladderProduct);
  ladderChart($('ladder'), ladderRows, {
    title: p ? `${p.duration}${p.isVipProduct ? ' · VIP' : ''} · Buy Low` : '',
    onHover: showTip,
  });
}

/**
 * Режим «Стратегия до выбранной даты»: обе оси на одном горизонте.
 *
 * Возвращает результат расчёта, чтобы вызывающий знал, чем рисовать рассеяние.
 */
function renderStrategy(rows) {
  const H = horizonDays();
  const res = computeStrategy({ rows, history: state.history, spot: state.spot, horizonDays: H, riskFree: state.riskFree ?? 0 });
  const note = $('strategy-note');
  const hint = $('strategy-hint');
  hint.innerHTML =
    `капитал катает одну и ту же оферту, пока цена не уйдёт ниже страйка; после конвертации биткоин ` +
    `просто держится до конца горизонта. Обе оси построены на ${H} днях и на одних исторических ` +
    `траекториях, поэтому сроки сравнимы между собой — в отличие от режима одной подписки, где ` +
    `доходность поделена на время, а вероятность нет`;

  if (!res || !res.rows.length) {
    $('strategy-best').innerHTML =
      '<div class="empty">история цен ещё не загрузилась или горизонт короче цикла всех оферт</div>';
    note.textContent = '';
    renderLimitedTable('strategy', $('strategy-table'), STRATEGY_COLUMNS, []);
    return res;
  }

  const sc = res.scenario;
  // Два конца кривой: ближайшая неделя и вторая половина горизонта. Брать
  // фиксированные 90 дней нельзя — на горизонте 90 участок выродился бы в точку.
  const near = state.varCurve ? forwardVol(state.varCurve, 0, Math.min(7, H / 2) / 365) : null;
  const far = state.varCurve ? forwardVol(state.varCurve, H / 2 / 365, H / 365) : null;
  note.innerHTML =
    `<b>Предпосылки.</b> Рост центральной линии BTC <b>${fmtPct(sc?.cagr, 1)}</b>` +
    (state.scenarioInfo?.typed
      ? ' (задан вами)'
      : ` (среднее дневного логарифмического прироста за всю историю ряда — одно и то же число на любом
          горизонте; поле «Рост BTC» пусто)`) +
    `. Волатильность взята не одним числом, а рыночной кривой: рынок опционов оценивает ближайшую неделю в ` +
    `<b>${fmtPct(near, 0)}</b>, а вторую половину горизонта в <b>${fmtPct(far, 0)}</b>, тогда как ` +
    `реализованная за пять лет — ${fmtPct(sc?.histVol, 0)}. Каждый участок траектории масштабируется под ту ` +
    `изменчивость, которую рынок ждёт именно до этой даты, и все оферты считаются на одном наборе траекторий.<br />` +
    `<b>Базы сравнения на тех же траекториях:</b> держать USDT — <b>${fmtPct(res.usdtAnnual, 2)}</b> годовых, ` +
    `держать BTC — <b>${fmtSigned(res.btcAnnualGeo, 1)}</b> геометрических, <b>${fmtSigned(res.btcAnnual, 1)}</b> в среднем, ` +
    `<b>${fmtSigned(res.btcAnnualMedian, 1)}</b> по медиане. Фронт строится по <b>геометрическому</b>: именно оно ` +
    `складывается по периодам, если политику повторять. Среднее отвечает на другой вопрос — сколько даст один ` +
    `эпизод малой долей капитала, — и на скошенном распределении задаётся правым хвостом.` +
    (sc
      ? ` Оценка построена по ${sc.paths} траекториям ряда ${SERIES_NAME[sc.series] || sc.series}, ` +
        `около ${Math.round(sc.independent ?? 0)} независимых наблюдений на горизонт.`
      : '') +
    ` Ставка и лестница страйков приняты неизменными на весь горизонт, а обратная нога Sell High после ` +
    `конвертации консервативно не учитывается.`;

  // Карточки: самый осторожный, самый доходный и лучший по цене риска.
  const byRisk = [...res.rows].sort((a, b) => a.stratRisk - b.stratRisk);
  const picks = [];
  const take = (r, tag) => {
    if (r && !picks.includes(r)) {
      r.bestTag = tag;
      picks.push(r);
    }
  };
  take(byRisk[0], 'минимум риска');
  take(
    byRisk.reduce((a, b) => (b.stratGeo > a.stratGeo ? b : a)),
    'максимум стоимости',
  );
  const priced = byRisk.filter((r) => Number.isFinite(r.volEdge));
  if (priced.length) take(priced.reduce((a, b) => (b.volEdge > a.volEdge ? b : a)), 'лучшая цена риска');
  for (let k = 0; picks.length < 6 && k < byRisk.length; k++) {
    take(byRisk[Math.round((k * (byRisk.length - 1)) / 5)], null);
  }
  $('strategy-best').innerHTML = picks
    .sort((a, b) => a.stratRisk - b.stratRisk)
    .map(strategyCardFor)
    .join('');

  renderLimitedTable('strategy', $('strategy-table'), STRATEGY_COLUMNS, byRisk);
  return res;
}

const SERIES_NAME = { 60: '1ч', 240: '4ч', D: '1д' };

function strategyCardFor(row) {
  const s = row.strategy;
  const tags = [];
  if (row.isVip) tags.push('<span class="tag vip">VIP</span>');
  if (row.bestTag) tags.push(`<span class="tag pick">${row.bestTag}</span>`);
  if (row.volEdge > 0) tags.push(`<span class="tag good">σ +${(row.volEdge * 100).toFixed(1)}</span>`);
  else if (row.volEdge < 0) tags.push(`<span class="tag warn">σ ${(row.volEdge * 100).toFixed(1)}</span>`);

  return `
    <article class="card${row.stratPareto ? ' pareto' : ''}" data-product="${row.productId}">
      <div class="card-top">
        <div class="apr">${fmtSigned(row.stratGeo, 1)}<small>геометрических годовых · ожидаемых ${fmtSigned(row.stratAnnual, 1)} · медиана ${fmtSigned(s?.annualMedian, 1)}</small></div>
        <div class="tags">${tags.join('')}</div>
      </div>
      <dl class="kv">
        <dt>Страйк</dt><dd>${fmtUsd(row.strike, 2)} <span class="muted">(${fmtSigned(row.moneyness, 2)})</span></dd>
        <dt>Закончить в BTC</dt><dd class="${row.stratRisk > 0.5 ? 'neg' : ''}">${fmtPct(row.stratRisk, 1)}</dd>
        <dt>Срок / цикл</dt><dd>${row.duration} → ${fmtSpan(row.timing.cycleDays)}</dd>
        <dt>Циклов за горизонт</dt><dd>${s ? s.cycles : '—'}${s?.tailDays > 0.5 ? ` <span class="muted">+ ${fmtSpan(s.tailDays)} хвоста</span>` : ''}</dd>
        <dt>APR в цикле</dt><dd>${fmtPct(row.aprChained, 2)}</dd>
        <dt>Ожид. потеря на конверсии</dt><dd>${fmtDepth(row, 'expected', 3)}</dd>
        <dt>Премия к опционам</dt><dd class="${cls(row.edgeApr)}">${fmtSigned(row.edgeApr, 1)}</dd>
      </dl>
    </article>`;
}

function sellCardFor(row, mode) {
  const tags = [];
  if (row.isVip) tags.push('<span class="tag vip">VIP</span>');
  // Ярлык называет, на какой именно вопрос отвечает эта карточка. Без него блок
  // с заголовком «Оптимальный выход» показывал шесть чисел без объяснения, какое
  // из них чем лучше, а собственная шапка блока называла седьмое.
  if (row.bestTag) tags.push(`<span class="tag pick">${row.bestTag}</span>`);
  if (row.sellPareto || row.waitPareto) tags.push('<span class="tag good">Парето</span>');
  tags.push(
    row.profitable
      ? `<span class="tag good">запас ${fmtSigned(row.cushion, 2)}</span>`
      : '<span class="tag warn">ниже безубытка</span>',
  );

  return `
    <article class="card${row.sellPareto || row.waitPareto ? ' pareto' : ''}" data-product="${row.productId}">
      <div class="card-top">
        <div class="apr">${
          mode === 'exit'
            ? `${fmtSigned(row.profitAtExit, 2)}<small>прибыль к моменту выхода · за один цикл ${fmtSigned(row.profitPct, 2)}</small>`
            : `${fmtPct(row.aprEff, 1)}<small>эффективный · заявлен ${fmtPct(row.apy, 1)}</small>`
        }</div>
        <div class="tags">${tags.join('')}</div>
      </div>
      <dl class="kv">
        <dt>Страйк</dt><dd>${fmtUsd(row.strike, 2)} <span class="muted">(${fmtSigned(row.moneyness, 2)})</span></dd>
        <dt>Порог безубытка</dt><dd>${fmtUsd(row.breakeven, 2)}</dd>
        <dt>Срок / блокировка</dt><dd>${row.duration} → ${fmtSpan(row.timing.lockDays)}</dd>
        <dt>P(продажи)</dt><dd>${fmtPct(row.pConv, 2)}</dd>
        ${
          mode === 'exit'
            ? `<dt>Шанс выйти</dt><dd>${fmtPct(row.pExitHorizon, 1)} за ${ui.horizon} дней</dd>
               <dt>Ожидание выхода</dt><dd>${fmtSpan(row.expExitDays)}</dd>
               <dt>Скорость выхода</dt><dd class="${cls(row.exitSpeed)}">${fmtPct(row.exitSpeed, 1)} годовых</dd>
               <dt>Полное матожидание</dt><dd class="${cls(row.fullRate)}">${fmtSigned(row.fullRate, 1)} <span class="muted">медиана ${fmtSigned(row.fullMedianRate, 1)}</span></dd>
               <dt>Прибыль</dt><dd class="${cls(row.profitUsdt)}">${row.profitUsdt == null ? '—' : fmtUsd(row.profitUsdt, 2)}</dd>`
            : `<dt>Циклов до безубытка</dt><dd>${fmtRecovery(row.recovery)}</dd>
               <dt>Прирост BTC за срок</dt><dd>${fmtPct(row.i, 3)}</dd>`
        }
      </dl>
    </article>`;
}

const ANCHOR_META = {
  market: {
    title: 'Лучшая цена риска',
    key: 'volEdge',
    hint: 'премия оферты против цены опциона на тот же риск с той же датой экспирации. Единственный критерий, которому не нужны ваши предпочтения',
  },
  money: {
    title: 'Лучшая премия в деньгах',
    key: 'edgeApr',
    hint: 'та же премия, но выраженная в годовой доходности на вложенный капитал, а не в пунктах волатильности. Учитывает, сколько мисприсинг стоит в деньгах и как долго заперты средства',
  },
  expected: {
    title: 'Лучшее матожидание',
    key: 'expNet',
    hint: 'процент минус ожидаемая потеря на конвертации. Считается по той же серии, из которой взята рабочая вероятность: раньше вероятность бралась из нормированного мира, а потеря — из сырого, и одна карточка описывала два разных рынка',
  },
  yield: {
    title: 'Максимум доходности',
    key: 'aprEff',
    hint: 'осмысленно, если конвертация вас устраивает: страйк — цена, по которой вы и так готовы купить BTC',
  },
};

function renderAnchors(rows) {
  const anchors = pickAnchors(rows);
  const box = $('anchors');
  const cards = [];
  for (const [id, meta] of Object.entries(ANCHOR_META)) {
    const a = anchors[id];
    if (!a) continue;
    const r = a.row;
    const d = a.dominator;
    cards.push(`
      <article class="anchor" data-product="${r.productId}">
        <div class="anchor-title"${
          d
            ? ` title="Вне фронта Парето: ${d.duration} со страйком ${fmtUsd(d.strike, 2)} даёт ${fmtPct(d.aprEff, 1)} против ${fmtPct(r.aprEff, 1)} при вероятности ${fmtPct(d.pConv, 2)} против ${fmtPct(r.pConv, 2)}. Якорь всё равно осмыслен: его страйк глубже, и при конвертации BTC достаётся дешевле."`
            : ''
        }>${meta.title}${d ? ' <span class="muted">(вне фронта Парето)</span>' : ''}</div>
        <div class="anchor-value">${
          meta.key === 'volEdge' || meta.key === 'edgeApr' ? fmtSigned(a.value, 2) : fmtPct(a.value, 1)
        }</div>
        <div class="anchor-line">
          ${r.duration}${r.isVip ? ' · VIP' : ''} · страйк <b>${fmtUsd(r.strike, 2)}</b> (${fmtSigned(r.moneyness, 2)})
        </div>
        <div class="anchor-line muted">
          APR эфф. ${fmtPct(r.aprEff, 1)} · в цикле ${fmtPct(r.aprChained, 1)} · P(конв) ${fmtPct(r.pConv, 2)}
        </div>
        <div class="anchor-hint">${meta.hint}</div>
      </article>`);
  }
  box.innerHTML = cards.join('') || '<div class="empty">нет данных для оценки</div>';
}

function renderFrontier(rows) {
  const rf = state.riskFree ?? 0;
  const steps = frontierWithMargins(rows, rf);
  // Оферта ниже безрисковой ставки формально на фронте, но экономически
  // бессмысленна: тот же результат даёт гибкий депозит без всякого риска.
  renderLimitedTable('frontier', $('frontier-table'), FRONTIER_COLUMNS, steps, (r) =>
    [r.aprEff < rf ? 'dim' : '', r.pConv <= ui.maxP ? 'within' : ''].filter(Boolean).join(' '),
  );

  const note = $('frontier-note');
  if (steps.length < 2) {
    note.textContent = '';
    return;
  }
  // Выпуклость фронта — не косметика, а причина, по которой «оптимума вообще»
  // не существует: при растущей отдаче на риск любое линейное предпочтение
  // выбирает край, а не середину.
  // Выпуклость проверяем по половинам фронта, а не по крайним шагам:
  // отдельные шаги сильно скачут, когда на фронт входит продукт другого срока.
  const mid = Math.floor(steps.length / 2);
  const slope = (from, to) => {
    const dP = to.pConv - from.pConv;
    return dP > 1e-9 ? (to.aprEff - from.aprEff) / dP : null;
  };
  const lower = slope(steps[0], steps[mid]);
  const upper = slope(steps[mid], steps[steps.length - 1]);
  const rising = lower != null && upper != null && upper > lower;
  const withinCount = steps.filter((r) => r.pConv <= ui.maxP).length;
  const belowRf = steps.filter((r) => r.aprEff < (state.riskFree ?? 0)).length;
  note.innerHTML =
    `Строк на фронте: <b>${steps.length}</b>, внутри вашего порога ${fmtPct(ui.maxP, 1)} — <b>${withinCount}</b> (подсвечены)` +
    (belowRf
      ? `, из них <b>${belowRf}</b> платят меньше гибкого депозита ${fmtPct(state.riskFree ?? 0, 2)} и приглушены: риск там есть, а смысла нет. `
      : '. ') +
    (rising
      ? 'Фронт сейчас выпуклый: отдача на риск с ростом вероятности не падает, а растёт. ' +
        'Это значит, что «оптимальной середины» не существует — любое постоянное отношение к риску ' +
        'выбирает один из краёв, и порог остаётся честным способом сказать, где ваш край.'
      : 'Отдача на риск убывает с ростом вероятности: шаги в правой части фронта дают всё меньше ' +
        'доходности за тот же прирост риска, и останавливаться разумно там, где «цена шага» падает.');
}

const EXIT_ANCHOR_META = {
  full: {
    title: 'Лучшее полное матожидание',
    hint: 'обе ветви сразу: и продажа, если она состоялась, и остаток в биткоине, если нет. Отвечает на вопрос «стоило ли вообще продавать колл», а не «когда я выйду». Максимум этой величины к осям фронта не монотонен и лежать на нём не обязан',
  },
  median: {
    title: 'Лучший типичный исход',
    hint: 'медиана тех же двух ветвей. Со средним расходится тем сильнее, чем длиннее правый хвост биткоина: среднее задают редкие сильные росты, медиану — то, что случается обычно',
  },
  market: {
    title: 'Лучшая цена риска',
    hint: 'насколько ставка оферты отличается от цены колла с той же датой экспирации, в пунктах волатильности. Единственная величина здесь, которой не нужны ваши предпочтения',
  },
};

/**
 * Якоря блока выхода.
 *
 * Карточки живут по правилу «только фронт», и это правильно: показанная там
 * оферта не должна быть хуже другой показанной сразу по прибыли и по шансу
 * выйти. Но два содержательных ответа этому правилу не подчиняются, потому что
 * считают обе ветви сразу, а фронт — только ветвь выхода. Их место здесь.
 */
function renderExitAnchors(analyzed) {
  const box = $('exit-anchors');
  if (!box) return;
  const anchors = pickExitAnchors(analyzed);
  const H = Number(ui.horizon) || 90;
  const cards = [];
  for (const [id, meta] of Object.entries(EXIT_ANCHOR_META)) {
    const a = anchors[id];
    if (!a) continue;
    const r = a.row;
    const d = a.dominator;
    cards.push(`
      <article class="anchor" data-product="${r.productId}">
        <div class="anchor-title"${
          d
            ? ` title="Вне фронта выхода: ${d.duration} со страйком ${fmtUsd(d.strike, 2)} даёт прибыль ${fmtSigned(d.profitAtExit, 2)} против ${fmtSigned(r.profitAtExit, 2)} при шансе выйти ${fmtPct(d[a.axis], 1)} против ${fmtPct(r[a.axis], 1)}. Якорь всё равно осмыслен: он отвечает на вопрос об обеих ветвях, а фронт считает только ветвь выхода."`
            : ''
        }>${meta.title}${d ? ' <span class="muted">(вне фронта выхода)</span>' : ''}</div>
        <div class="anchor-value ${cls(a.value)}">${fmtSigned(a.value, 1)}</div>
        <div class="anchor-line">
          ${r.duration}${r.isVip ? ' · VIP' : ''} · страйк <b>${fmtUsd(r.strike, 2)}</b> (${fmtSigned(r.moneyness, 2)})
        </div>
        <div class="anchor-line muted">
          прибыль к выходу ${fmtSigned(r.profitAtExit, 2)} · шанс выйти ${fmtPct(r.pExitHorizon, 1)} за ${H} дн · скорость ${fmtPct(r.exitSpeed, 1)}
        </div>
        <div class="anchor-hint">${meta.hint}</div>
      </article>`);
  }
  box.innerHTML = cards.join('') || '<div class="empty">безубыточных оферт нет — якорям не из чего выбирать</div>';
}

/** Полный фронт выхода: все неулучшаемые оферты и цена каждого шага по нему. */
function renderExitFrontier(analyzed) {
  const steps = exitFrontier(analyzed);
  const H = Number(ui.horizon) || 90;
  renderExitAnchors(analyzed);
  renderLimitedTable('exitfront', $('exit-front-table'), EXIT_FRONT_COLUMNS, steps, (r) =>
    r.laddered ? 'dim' : '',
  );

  $('exit-front-hint').innerHTML =
    `все неулучшаемые оферты выхода от самого вероятного к самому дорогому. Ось риска здесь — ` +
    `<b>шанс выйти за ${H} дней</b>, если крутить одну и ту же оферту, а не вероятность за один цикл: ` +
    `47% за 55 дней и 41% за 237 дней — величины несравнимые, и фронт по ним механически вытаскивал бы ` +
    `наверх самые длинные продукты. Частота берётся по историческим траекториям, поэтому зависимость ` +
    `соседних циклов учтена: формула независимых попыток завышает шанс выхода на 10–22 процентных пункта. ` +
    `Ось прибыли — <b>накопленная к фактическому циклу выхода</b>: если продажа случилась на пятом цикле, ` +
    `процент в биткоине начислялся пять раз, а не один. «Скорость выхода» приведена к полному горизонту ` +
    `${H} дней, а не к длине одного цикла, иначе продукт с единственным сеттлментом внутри горизонта ` +
    `делился бы на меньшее число и выглядел быстрее остальных`;

  const note = $('exit-front-note');
  if (!steps.length) {
    note.textContent = '';
    return;
  }
  const info = steps.find((r) => r.horizonInfo)?.horizonInfo;
  const locked = analyzed.filter((r) => r.profitable && r.pExitHorizon === 0).length;
  const base = analyzed.baseline;
  note.innerHTML =
    // База обязана стоять рядом с якорями матожидания: сами по себе «+8.5%» и
    // «+33.4%» ничего не говорят, вопрос всегда в том, лучше ли это бездействия.
    (base
      ? `Отсчёт для двух якорей матожидания — <b>ничего не делать</b>: держать биткоин те же ${H} дней даёт
         <b class="${cls(base.holdRate)}">${fmtSigned(base.holdRate, 1)}</b> в среднем и
         <b class="${cls(base.holdMedianRate)}">${fmtSigned(base.holdMedianRate, 1)}</b> по медиане на тех же траекториях.
         Продажа колла обрезает правый хвост, поэтому по среднему она проигрывает почти всегда, а выигрывает по медиане. `
      : '') +
    `Строк на фронте: <b>${steps.length}</b>.` +
    (locked
      ? ` Ещё <b>${locked}</b> безубыточных оферт не попали в него вовсе: их цикл длиннее ${H} дней,
         то есть за горизонт они не рассчитываются ни разу.`
      : '') +
    (info
      ? ` Оценка построена по ${info.n} историческим траекториям, около ${Math.round(info.independent ?? 0)}
         независимых наблюдений на горизонт.`
      : '') +
    ` Колонка «цена шага» показывает, сколько процентных пунктов прибыли добавляет отказ от одного
      процентного пункта шанса выйти.`;
}

function renderSell(rows) {
  const info = conversionBasis();
  const line = $('basis-line');
  const qty = Number(ui.convQty) || 0;

  if (!info) {
    line.innerHTML =
      'Введите цену покупки BTC — появится себестоимость, порог безубытка и подобранные оферты Sell High.';
    $('best-sell').innerHTML = '';
    $('best-sell-head').innerHTML = '';
    renderLimitedTable('sell', $('sell-table'), SELL_COLUMNS, []);
    return;
  }

  const analyzed = analyzeSellHigh({
    rows,
    basis: info.basis,
    qty,
    spot: state.spot,
    history: state.history,
    measure: ui.measure,
    horizonDays: horizonDays(),
    riskFree: state.riskFree ?? 0,
  });
  const profitable = analyzed.filter((r) => r.profitable);
  // Разрыв считаем относительно себестоимости, а не наоборот: «рынок на 68%
  // ниже себестоимости» — это утверждение о том, сколько недостаёт до выхода,
  // тогда как обратное отношение даёт бессмысленные сотни процентов.
  const gap = state.spot && info.basis > 0 ? state.spot / info.basis - 1 : null;

  // Отбор карточек считается ДО шапки, и шапка берёт свою оферту прямо из него.
  // Раньше оба места искали максимум скорости выхода независимо: шапка по всем
  // безубыточным, карточки — равномерным срезом фронта. Совпадение получалось
  // случайно и на живых данных регулярно не получалось. Теперь расхождение
  // невозможно по построению, а не по рассуждению.
  const best = pickBestSell({ rows: analyzed });
  const headline =
    best.mode === 'exit' ? best.rows.find((r) => (r.bestTag ?? '').includes('быстрее всего')) : null;

  line.innerHTML = `
    Себестоимость: <b>${fmtUsd(info.basis, 2)}</b> USDT за BTC${qty > 0 ? ` · позиция <b>${fmtBtc(qty)}</b> BTC на <b>${fmtUsd(qty * info.basis, 2)}</b> USDT` : ''}.
    <span class="muted">${info.note}</span><br />
    Рынок сейчас <b>${fmtUsd(state.spot, 2)}</b> —
    ${gap == null ? '' : gap < 0 ? `<span class="neg">на ${fmtPct(-gap, 2)} ниже себестоимости</span>` : `<span class="pos">на ${fmtPct(gap, 2)} выше себестоимости</span>`}.
    Безубыточных оферт: <b>${profitable.length}</b> из ${analyzed.length}.
    ${(() => {
      if (!profitable.length) {
        return 'Ни одна оферта не выводит в USDT без убытка — смотрите строку «циклов до безубытка»: процент в BTC постепенно закрывает разрыв.';
      }
      // Сводка обязана называть ту же оферту, что и отбор ниже, — и теперь берёт
      // её оттуда буквально, а не ищет заново по своему критерию.
      if (!headline) return '';
      const base = analyzed.baseline;
      return (
        `Быстрее всех выводит в безубыток страйк <b>${fmtUsd(headline.strike, 2)}</b> — он же первой карточкой ` +
        `с ярлыком «быстрее всего в безубыток»: прибыль ` +
        `<b>${fmtSigned(headline.profitAtExit, 2)}</b> к моменту выхода с шансом <b>${fmtPct(headline.pExitHorizon, 1)}</b> ` +
        `за ${ui.horizon} дней, ожидание <b>${fmtSpan(headline.expExitDays)}</b> — это <b>${fmtPct(headline.exitSpeed, 1)}</b> годовых ` +
        `по ветви выхода.<br />` +
        // Скорость выхода считает только желанную ветвь и потому всегда
        // положительна. Полное матожидание считает обе и отвечает на другой
        // вопрос: стоило ли вообще продавать колл вместо того, чтобы просто ждать.
        `Полное матожидание этой же оферты по обеим ветвям — <b class="${cls(headline.fullRate)}">${fmtSigned(headline.fullRate, 1)}</b> годовых ` +
        `(медиана ${fmtSigned(headline.fullMedianRate, 1)})` +
        (base
          ? `, тогда как просто держать биткоин те же ${ui.horizon} дней дало бы ` +
            `<b class="${cls(base.holdRate)}">${fmtSigned(base.holdRate, 1)}</b> в среднем и ` +
            `<b class="${cls(base.holdMedianRate)}">${fmtSigned(base.holdMedianRate, 1)}</b> по медиане. ` +
            `Разница — цена обрезанного верха: она и есть плата за возможность выйти.`
          : '.')
      );
    })()}`;

  renderExitFrontier(analyzed);

  $('best-sell-head').innerHTML =
    best.mode === 'exit'
      ? '<h3>Оптимальный выход в USDT</h3><div class="hint">единого оптимума здесь не существует: метрики выхода тянут в разные стороны, и максимум скорости выхода ухудшает полное матожидание, а максимум среднего ухудшает медиану. Поэтому каждая карточка подписана тем вопросом, на который отвечает именно она — «вернее всего выйти», «быстрее всего в безубыток», «лучший типичный исход», «дороже всего». Все они лежат на фронте Парето по паре «прибыль к себестоимости — шанс выйти»; ответы, которые на этот фронт не ложатся, вынесены в якоря под таблицей ниже</div>'
      : `<h3>Заработок на ожидании</h3><div class="hint">безубыточного выхода сейчас нет, поэтому срабатывание страйка означало бы принудительную продажу дешевле себестоимости: здесь отобраны оферты с наибольшей ставкой при наименьшем риске такой продажи за ${ui.horizon} дней. Риск считается по тому же горизонту, что и в режиме выхода — вероятности за один цикл у пятидневного и у 237-дневного продукта несравнимы</div>`;
  $('best-sell').innerHTML = best.rows.length
    ? best.rows.map((r) => sellCardFor(r, best.mode)).join('')
    : '<div class="empty">нет доступных оферт Sell High при текущих фильтрах</div>';

  renderLimitedTable('sell', $('sell-table'), SELL_COLUMNS, analyzed, (r) =>
    r.quoteStale ? 'dim' : r.profitable ? (r.sellPareto ? 'pareto' : '') : 'dim',
  );
}

/**
 * Свежесть котировок.
 *
 * Ставка Bybit живёт 2–55 секунд. Пока поток жив, не протухает ничего, и
 * баннера не видно. Когда поток встал, показывать устаревшую цену как
 * рекомендацию нельзя: биржа подтвердит сделку по своей, а не по показанной.
 * Поэтому такие строки выпадают из фронта, карточек и якорей — но остаются в
 * полных таблицах приглушёнными, чтобы картина рынка не исчезала целиком.
 */
function renderStale(buy, sell) {
  const box = $('stale-banner');
  const stale = (buy.staleCount || 0) + (sell.staleCount || 0);
  const total = buy.length + sell.length;
  state.stale = { count: stale, total };

  const age = state.lastQuoteAt ? Math.round((Date.now() - state.lastQuoteAt) / 1000) : null;
  const all = total > 0 && stale >= total;
  box.className = `status-panel ${stale ? 'stale' : 'ok'}`;

  if (!stale) {
    box.innerHTML =
      `<b>Котировки живые: все ${total} оферт участвуют в отборе.</b> ` +
      (age == null ? '' : `Последний снимок ${age} с назад, поток — «${state.wsStatus}». `) +
      `Ставка Bybit живёт от двух до пятидесяти пяти секунд, поэтому панель следит, чтобы в рекомендации ` +
      `не попала цена, которой уже нет: истёкшие уровни выпадают из фронта, карточек и якорей, а в полных ` +
      `таблицах остаются приглушёнными. Колонка «Котировка» показывает, сколько секунд осталось до ` +
      `пересчёта ставки биржей.`;
    return;
  }

  box.innerHTML = all
    ? `<b>Рекомендации приостановлены: все котировки устарели.</b> Последний снимок ` +
      `${age == null ? 'не получен' : `${age} с назад`}, поток — «${state.wsStatus}». Ставка Bybit живёт ` +
      `меньше минуты, поэтому показывать её как совет уже нельзя: биржа подтвердит сделку по своей. ` +
      `Таблицы выше остались, но цены в них уже не действуют. Панель тянет котировки заново каждые 40 секунд.`
    : `<b>Устарели ${stale} котировок из ${total}.</b> Они убраны из фронта, карточек и якорей, но ` +
      `остались в полных таблицах приглушёнными. Колонка «Котировка» показывает, сколько секунд осталось ` +
      `до пересчёта ставки биржей. Это нормальное состояние: ставки пересчитываются постоянно, и часть ` +
      `строк всегда ждёт следующего снимка.`;
}

function renderDiag() {
  const parts = [];
  parts.push(`продуктов: ${state.products.length}`);
  parts.push(`котировок: ${state.quotes.size}`);
  if (state.surface) parts.push(`экспираций опционов: ${state.surface.expiries.length}`);
  if (state.history) {
    const h = state.history.raw;
    const span = (k) => {
      const s = h[k];
      if (!s?.series?.length) return '—';
      return `${((s.series.length * s.stepMs) / MS_DAY).toFixed(0)}д`;
    };
    parts.push(`история: 1ч ${span(60)} · 4ч ${span(240)} · 1д ${span('D')}`);
  } else {
    parts.push('история: загружается');
  }
  const t = rateForHorizon(state.treasury, horizonDays());
  parts.push(
    `альтернативная ставка: ${fmtPct(state.riskFree, 2)}` +
      (ui.rfOpp !== '' ? ' (задана вами)' : t ? ` (Treasury ${t.days} дн, ${state.treasury.date})` : ' (Bybit)'),
  );
  if (state.bybitUsdt != null) parts.push(`гибкий депозит Bybit: USDT ${fmtPct(state.bybitUsdt, 2)}`);
  if (state.riskFreeBtc != null) parts.push(`BTC ${fmtPct(state.riskFreeBtc, 2)}`);
  if (state.scenarioInfo) {
    parts.push(
      `рост BTC: ${fmtPct(state.scenarioInfo.cagr, 1)}` + (state.scenarioInfo.typed ? ' (задан вами)' : ' (по выборке)'),
    );
  }
  if (state.varCurve) {
    parts.push(
      `кривая волатильности: ${state.varCurve.points.length} экспираций` +
        (state.varCurve.repaired ? `, починено провалов ${state.varCurve.repaired}` : ''),
    );
  }
  parts.push(`режим: ${ui.mode === 'strategy' ? `стратегия до ${ui.horizon} дней` : 'текущая подписка'}`);
  if (state.stats) {
    const where = state.stats.source === 'local' ? 'в браузере' : 'на ветке data';
    parts.push(
      `архив ставок ${where}: ${state.stats.spanDays.toFixed(1)} сут, ` +
        `${state.stats.snapshots} снимков, корзин ${Object.keys(state.stats.buckets).length}`,
    );
  } else {
    parts.push(state.archive ? 'архив ставок: копится в браузере' : 'архив ставок: недоступен');
  }
  if (state.lastOptionsAt) parts.push(`опционы обновлены ${fmtTime(state.lastOptionsAt)}`);
  parts.push(ui.tz === 'utc' ? 'время UTC' : 'время местное');
  const diag = $('diag');
  diag.textContent = parts.join(' · ');
  if (state.errors.length) {
    diag.innerHTML += `<br /><span class="neg">${state.errors.join(' · ')}</span>`;
  }
}

let renderScheduled = false;
function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  // Именно setTimeout, а не requestAnimationFrame: в фоновой вкладке кадры не
  // компонуются, и панель переставала бы обновляться, пока на неё не посмотрят.
  setTimeout(() => {
    renderScheduled = false;

    // Каждый блок рисуется в своей защите. Общий try на всю отрисовку означал,
    // что падение любого блока уносило с собой и диагностику: панель молча
    // замирала на последнем удачном кадре, а сообщение об ошибке было негде
    // показать. Теперь падает только пострадавший блок.
    const step = (name, fn) => {
      try {
        return fn();
      } catch (e) {
        pushError(`${name}: ${e.message}`);
        console.error(name, e);
        return null;
      }
    };

    step('предпосылки', () => {
      state.riskFree = opportunityRate();
      applyScenario();
    });
    const buy = step('расчёт Buy Low', () => currentRows('BuyLow')) || [];
    const sell = step('расчёт Sell High', () => currentRows('SellHigh')) || [];
    // Свежесть считается до шапки: кружок в ней показывает именно её.
    step('свежесть котировок', () => renderStale(buy, sell));
    step('шапка', renderHead);
    step('блок Buy Low', () => renderBuy(buy));
    step('блок Sell High', () => renderSell(sell));

    // Архив пополняется тем же срезом, который только что показан.
    // Сама запись не чаще раза в минуту — интервал держит сам архив.
    step('архив', () => {
      if (state.archive && (buy.length || sell.length)) {
        state.archive.sample([...buy, ...sell]).then((written) => {
          if (written) state.archive.stats().then((st) => st && !state.statsRemote && (state.stats = st));
        });
      }
    });

    // Диагностика рисуется последней и всегда: именно она показывает,
    // что где-то упало.
    try {
      renderDiag();
    } catch (e) {
      console.error('диагностика', e);
    }
  }, 0);
}

// ───────────────────────────────────────────────────────── подсказка

const tip = () => $('tip');

function showTip(row, event) {
  const node = tip();
  if (!row) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.innerHTML = `
    <b>${row.duration}${row.isVip ? ' · VIP' : ''}</b> · страйк <b>${fmtUsd(row.strike, 2)}</b><br />
    эффективный APR <b>${fmtPct(row.aprEff, 2)}</b> (заявлен ${fmtPct(row.apy, 2)})<br />
    P рыночная ${fmtPct(row.pRN, 2)} · историческая ${fmtPct(row.pHist, 2)}<br />
    σ рынка ${fmtPct(row.sigma, 1)}${row.exactExpiry ? '' : ' (интерполяция)'} · σ оферты ${fmtPct(row.offerVol, 1)}<br />
    блокировка ${fmtSpan(row.timing.lockDays)}, из них мёртвых ${fmtSpan(row.timing.idleDays)}${
      row.histInfo
        ? `<br />история: ряд ${row.histInfo.series}, ${Math.round(row.histInfo.spanDays)} дней, ` +
          `независимых окон ≈ ${Math.round(row.histInfo.independent)}`
        : ''
    }`;
  const pad = 14;
  const x = Math.min(event.clientX + pad, window.innerWidth - 300);
  const y = Math.min(event.clientY + pad, window.innerHeight - 140);
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
}

// ───────────────────────────────────────────────────────── события интерфейса

function bindControls() {
  $('vip').checked = ui.vip;
  $('vip').onchange = (e) => {
    ui.vip = e.target.checked;
    state.ladderProduct = null;
    savePrefs();
    render();
  };

  $('amount').value = ui.amount;
  $('amount').oninput = (e) => {
    ui.amount = e.target.value;
    savePrefs();
    render();
  };

  $('maxp').value = ui.maxP * 100;
  $('maxp-view').textContent = fmtPct(ui.maxP, 1);
  $('maxp').oninput = (e) => {
    ui.maxP = Number(e.target.value) / 100;
    $('maxp-view').textContent = fmtPct(ui.maxP, 1);
    state.ladderProduct = null;
    savePrefs();
    render();
  };

  $('measure').value = ui.measure;
  $('measure').onchange = (e) => {
    ui.measure = e.target.value;
    savePrefs();
    render();
  };

  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.onclick = () => {
      ui.mode = btn.dataset.mode;
      savePrefs();
      applyMode();
      render();
    };
  }
  applyMode();

  $('sort').value = ui.sort;
  $('sort').onchange = (e) => {
    ui.sort = e.target.value;
    savePrefs();
    render();
  };

  $('tz-toggle').textContent = ui.tz === 'utc' ? 'UTC' : 'местное';
  $('tz-toggle').onclick = () => {
    ui.tz = ui.tz === 'utc' ? 'local' : 'utc';
    $('tz-toggle').textContent = ui.tz === 'utc' ? 'UTC' : 'местное';
    savePrefs();
    render();
  };

  if (ui.theme) document.documentElement.dataset.theme = ui.theme;
  $('theme-toggle').onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    ui.theme = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = ui.theme;
    savePrefs();
    render();
  };

  for (const [id, key] of [
    ['conv-price', 'convPrice'],
    ['conv-qty', 'convQty'],
    ['conv-apy', 'convApy'],
    ['cagr', 'cagr'],
    ['rf-opp', 'rfOpp'],
  ]) {
    $(id).value = ui[key];
    $(id).oninput = (e) => {
      ui[key] = e.target.value;
      savePrefs();
      render();
    };
  }

  $('conv-was-dual').checked = ui.convWasDual;
  $('conv-was-dual').onchange = (e) => {
    ui.convWasDual = e.target.checked;
    savePrefs();
    render();
  };

  $('horizon').value = ui.horizon;
  $('horizon').onchange = (e) => {
    ui.horizon = e.target.value;
    savePrefs();
    render();
  };

  $('conv-duration').value = ui.convDuration;
  $('conv-duration').onchange = (e) => {
    ui.convDuration = e.target.value;
    savePrefs();
    render();
  };

  document.body.addEventListener('click', (e) => {
    const collapse = e.target.closest('[data-collapse]');
    if (collapse) {
      const key = collapse.dataset.collapse;
      ui.collapsed[key] = !ui.collapsed[key];
      savePrefs();
      syncCollapse();
      return;
    }

    const more = e.target.closest('[data-more]');
    if (more) {
      const key = more.dataset.more;
      ui.expanded[key] = !ui.expanded[key];
      savePrefs();
      render();
      return;
    }

    // Клик по строке или карточке переключает лестницу страйков на этот продукт.
    const holder = e.target.closest('[data-product]');
    if (!holder) return;
    state.ladderProduct = holder.dataset.product;
    render();
  });

  syncCollapse();
}

// ───────────────────────────────────────────────────────── запуск

/**
 * Проверка, что модули приехали одной версией.
 *
 * Браузер кэширует каждый файл отдельно, и после выката ничто не мешает ему
 * подставить свежий app.js к старому quant.js. Числа при этом останутся
 * правдоподобными, а формулы — вчерашними, и заметить это по виду страницы
 * невозможно. Поэтому проверяем несколько признаков, которые менялись вместе
 * с формулами, и громко жалуемся, если набор рассогласован.
 */
function checkModuleConsistency() {
  const problems = [];
  // Возврат к безубытку учитывает простой между окнами подписки, поэтому при
  // длинном цикле обязан занимать больше времени, чем при коротком. Проверяем
  // поведением, а не числом аргументов: у функции с умолчаниями length их не
  // считает, и такой признак давал бы ложную тревогу всегда.
  const short = cyclesToRecover(2, 1, 1, 1, 1, 1);
  const long = cyclesToRecover(2, 1, 1, 1, 1, 10);
  if (!(long.days > short.days)) problems.push('quant.js');
  // Профиль глубины появился вместе с новой мерой риска: если его нет, значит
  // quant.js приехал старый, а колонки потерь молча покажут прочерки.
  const probeLoss = rnLossProfile({ direction: 'BuyLow', forward: 100, strike: 90, sigma: 0.5, Teff: 0.1, spot: 100 });
  if (!probeLoss || !(probeLoss.conditional > probeLoss.expected)) problems.push('quant.js');
  // Якоря отдают объект с полями row и dominator, а не голую строку.
  const probe = pickAnchors([
    { volEdge: -0.01, expNetApr: -0.02, aprEff: 0.05, pConv: 0.1, productId: 'x', duration: '6d', strike: 1, moneyness: -0.1 },
  ]);
  if (!probe.market || !('row' in probe.market)) problems.push('model.js');
  // Стратегический режим — новая точка входа: без неё переключатель молча
  // показывал бы пустой блок.
  if (typeof computeStrategy !== 'function') problems.push('model.js');

  if (problems.length) {
    pushError(`несогласованные модули (${problems.join(', ')}) — обновите страницу с очисткой кэша`);
    console.error('Несогласованные модули:', problems);
    return false;
  }
  return true;
}

async function main() {
  loadPrefs();
  bindControls();
  checkModuleConsistency();

  state.spot = await fetchSpot().catch(() => null);
  render();

  await loadProducts();
  render();

  // Опционы и первичные котировки — параллельно, страница уже что-то показывает.
  await Promise.all([
    loadOptions(),
    bootstrapQuotes(),
    fetchRiskFree('USDT').then((r) => (state.bybitUsdt = r)),
    fetchTreasuryCurve().then((c) => (state.treasury = c)),
    // Ставка по монете нужна для Sell High: там заперт биткоин, и стоимость
    // этого простоя измеряется ставкой по биткоину, а не по доллару.
    fetchRiskFree('BTC').then((r) => (state.riskFreeBtc = r)),
    fetchAprStats().then((s) => {
      // Сводка с ветки data появляется только если архив кто-то наполняет
      // извне; с раннеров GitHub биржа недоступна, поэтому обычно её нет.
      if (s) {
        state.stats = s;
        state.statsRemote = true;
      }
    }),
  ]);

  const archive = new Archive();
  if (await archive.init()) {
    state.archive = archive;
    const local = await archive.stats();
    if (local && !state.statsRemote) state.stats = local;
  }
  render();

  loadHistory().then(render);

  const offers = new OfferStream({
    onSnapshot: (data, at) => {
      const wanted = new Set(state.products.map((p) => String(p.productId)));
      for (const row of data) {
        if (!wanted.has(String(row.p))) continue;
        state.quotes.set(String(row.p), normalizeWsOffer(row));
      }
      state.lastQuoteAt = at;
    },
    onStatus: (s) => {
      state.wsStatus = s;
    },
  });
  offers.start();

  new SpotStream((price) => {
    state.spotDir = state.spot ? Math.sign(price - state.spot) : 0;
    state.spot = price;
  }).start();

  // Единый такт пересчёта: раз в секунду хватает, чтобы видеть таяние срока,
  // и не мешает потоку котировок обновлять состояние между кадрами.
  setInterval(render, 1000);
  setInterval(loadOptions, 60_000);
  setInterval(async () => {
    await loadProducts();
    await bootstrapQuotes();
  }, 5 * 60_000);
  // Пока жив поток, котировки приходят каждые несколько секунд и добирать их по
  // REST незачем. Как только поток встал, пятиминутного цикла мало: ставка живёт
  // меньше минуты, и блоки рекомендаций мигали бы — живые полминуты из каждых
  // пяти. Поэтому при тишине в потоке тянем лестницы чаще.
  setInterval(() => {
    const quiet = state.wsStatus !== 'open' || Date.now() - state.lastQuoteAt > 40_000;
    if (quiet) bootstrapQuotes();
  }, 40_000);
  setInterval(loadHistory, 30 * 60_000);
  // Сводка перцентилей меняется раз в четверть часа — чаще её тянуть незачем.
  setInterval(() => fetchAprStats().then((s) => s && (state.stats = s)), 15 * 60_000);
}

main();
