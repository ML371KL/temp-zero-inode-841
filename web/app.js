// Оркестровка панели: сбор данных, пересчёт раз в секунду, отрисовка.

import {
  fetchProducts,
  fetchQuote,
  fetchOptionTickers,
  fetchSpot,
  fetchRiskFree,
  fetchKlines,
  fetchAprStats,
  OfferStream,
  SpotStream,
  normalizeWsOffer,
} from './feeds.js';
import { buildSurface } from './surface.js';
import { Archive } from './archive.js';
import {
  History,
  buildRows,
  pickBest,
  pickBestSell,
  analyzeSellHigh,
  frontierWithMargins,
  pickAnchors,
} from './model.js';
import { basisFromConversion, interestRate, MS_DAY } from './quant.js';
import { scatterChart, ladderChart, durationColor } from './charts.js';

// ───────────────────────────────────────────────────────── состояние

const state = {
  products: [],
  quotes: new Map(),
  spot: null,
  spotDir: 0,
  surface: null,
  history: null,
  riskFree: null,
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
  sort: 'aprEff',
  durations: [],
  tz: 'local',
  theme: null,
  convPrice: '',
  convQty: '',
  convWasDual: true,
  convApy: '',
  convDuration: '1',
  // Свёрнутые панели и таблицы, показанные целиком. Длинные списки по
  // умолчанию обрезаются: страница про решение, а не про перечисление.
  collapsed: {},
  expanded: {},
};

// Сколько строк показывать в длинной таблице до нажатия «показать все».
const ROW_PREVIEW = 8;

function loadPrefs() {
  try {
    Object.assign(ui, JSON.parse(localStorage.getItem(PREF_KEY) || '{}'));
  } catch {
    /* повреждённые настройки не должны мешать запуску */
  }
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

/** Перцентиль текущей ставки относительно собранного архива. */
function fmtPercentile(row) {
  if (row.aprPercentile == null) return '<span class="muted">—</span>';
  const p = Math.round(row.aprPercentile * 100);
  const tone = p >= 75 ? 'pos' : p <= 25 ? 'neg' : '';
  return `<span class="${tone}" title="по ${row.aprBucketN} наблюдениям за месяц">${p}</span>`;
}

const cls = (x) => (x == null || !Number.isFinite(x) ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');

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
    amount: direction === 'BuyLow' ? Number(ui.amount) || 0 : Number(ui.convQty) || 0,
    vip: ui.vip,
    measure: ui.measure,
    stats: state.stats,
  });
  const allowed = new Set(ui.durations);
  return allowed.size ? rows.filter((r) => allowed.has(r.duration)) : rows;
}

function sortRows(rows) {
  const key = ui.sort;
  const copy = [...rows];
  if (key === 'settle') return copy.sort((a, b) => a.timing.settle - b.timing.settle || b.aprEff - a.aprEff);
  if (key === 'pConv') return copy.sort((a, b) => (a.pConv ?? 9) - (b.pConv ?? 9));
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
  if (state.wsStatus === 'open' && age != null && age < 30) {
    dot.className = 'dot live';
    text.textContent = `котировки живые · ${age.toFixed(0)} с назад`;
  } else if (state.wsStatus === 'open') {
    dot.className = 'dot';
    text.textContent = 'поток тих';
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
  ['P ист.', (r) => fmtPct(r.pHist, 2)],
  ['P раб.', (r) => `<b class="${r.pConv > 0.15 ? 'neg' : ''}">${fmtPct(r.pConv, 2)}</b>`],
  ['σ рынок', (r) => fmtPct(r.sigma, 1)],
  ['σ оферты', (r) => fmtPct(r.offerVol, 1)],
  ['Премия σ', (r) => `<span class="${cls(r.volEdge)}">${fmtSigned(r.volEdge, 1)}</span>`],
  ['Премия APR', (r) => `<span class="${cls(r.edgeApr)}">${fmtSigned(r.edgeApr, 1)}</span>`],
  ['Ожид. чистый', (r) => `<span class="${cls(r.expNetApr)}">${fmtSigned(r.expNetApr, 1)}</span>`],
  ['Доход, USDT', (r) => (r.money ? fmtUsd(r.money.interest, 2) : '—')],
  ['BTC при конв.', (r) => (r.money ? fmtBtc(r.money.btcIfConverted) : '—')],
  ['Сеттлмент', (r) => fmtTime(r.timing.settle)],
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
  renderLimitedTable('buy', $('buy-table'), BUY_COLUMNS, sorted, (r) => (r.pareto ? 'pareto' : ''));
  renderAnchors(rows);
  renderFrontier(rows);

  scatterChart($('scatter'), rows, {
    durations: [...new Set(state.products.map((p) => p.duration))].sort((a, b) => durationDays(a) - durationDays(b)),
    maxP: ui.maxP,
    onHover: showTip,
  });

  const ladderRows = rows.filter((r) => r.productId === state.ladderProduct);
  const p = state.products.find((x) => x.productId === state.ladderProduct);
  ladderChart($('ladder'), ladderRows, {
    title: p ? `${p.duration}${p.isVipProduct ? ' · VIP' : ''} · Buy Low` : '',
    onHover: showTip,
  });
}

function sellCardFor(row, mode) {
  const tags = [];
  if (row.isVip) tags.push('<span class="tag vip">VIP</span>');
  if (row.sellPareto || row.waitPareto) tags.push('<span class="tag good">Парето</span>');
  tags.push(
    row.profitable
      ? `<span class="tag good">запас ${fmtSigned(row.cushion, 2)}</span>`
      : '<span class="tag warn">ниже безубытка</span>',
  );

  return `
    <article class="card${row.sellPareto || row.waitPareto ? ' pareto' : ''}" data-product="${row.productId}">
      <div class="card-top">
        <div class="apr">${fmtPct(row.aprEff, 1)}<small>эффективный · заявлен ${fmtPct(row.apy, 1)}</small></div>
        <div class="tags">${tags.join('')}</div>
      </div>
      <dl class="kv">
        <dt>Страйк</dt><dd>${fmtUsd(row.strike, 2)} <span class="muted">(${fmtSigned(row.moneyness, 2)})</span></dd>
        <dt>Порог безубытка</dt><dd>${fmtUsd(row.breakeven, 2)}</dd>
        <dt>Срок / блокировка</dt><dd>${row.duration} → ${fmtSpan(row.timing.lockDays)}</dd>
        <dt>P(продажи)</dt><dd>${fmtPct(row.pConv, 2)}</dd>
        ${
          mode === 'exit'
            ? `<dt>Выручка</dt><dd>${fmtUsd(row.usdtIfSold, 2)} USDT</dd>
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
  expected: {
    title: 'Лучшее матожидание',
    key: 'expNetApr',
    hint: 'процент минус ожидаемая потеря на конвертации по историческому распределению цены',
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
        <div class="anchor-title">${meta.title}</div>
        <div class="anchor-value">${meta.key === 'volEdge' ? fmtSigned(a.value, 2) : fmtPct(a.value, 1)}</div>
        <div class="anchor-line">
          ${r.duration}${r.isVip ? ' · VIP' : ''} · страйк <b>${fmtUsd(r.strike, 2)}</b> (${fmtSigned(r.moneyness, 2)})
        </div>
        <div class="anchor-line muted">
          APR эфф. ${fmtPct(r.aprEff, 1)} · в цикле ${fmtPct(r.aprChained, 1)} · P(конв) ${fmtPct(r.pConv, 2)}
        </div>
        <div class="anchor-hint">${meta.hint}</div>
        ${
          d
            ? `<div class="anchor-warn">Вне фронта Парето: ${d.duration} со страйком ${fmtUsd(d.strike, 2)}
               даёт больше доходности (${fmtPct(d.aprEff, 1)} против ${fmtPct(r.aprEff, 1)}) при меньшем риске
               (${fmtPct(d.pConv, 2)} против ${fmtPct(r.pConv, 2)}). Этот якорь всё равно осмыслен: его страйк глубже,
               и при конвертации BTC достаётся дешевле — пара «доходность и вероятность» глубину не измеряет.</div>`
            : ''
        }
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

  const analyzed = analyzeSellHigh({ rows, basis: info.basis, qty, spot: state.spot, history: state.history });
  const profitable = analyzed.filter((r) => r.profitable);
  // Разрыв считаем относительно себестоимости, а не наоборот: «рынок на 68%
  // ниже себестоимости» — это утверждение о том, сколько недостаёт до выхода,
  // тогда как обратное отношение даёт бессмысленные сотни процентов.
  const gap = state.spot && info.basis > 0 ? state.spot / info.basis - 1 : null;

  line.innerHTML = `
    Себестоимость: <b>${fmtUsd(info.basis, 2)}</b> USDT за BTC${qty > 0 ? ` · позиция <b>${fmtBtc(qty)}</b> BTC на <b>${fmtUsd(qty * info.basis, 2)}</b> USDT` : ''}.
    <span class="muted">${info.note}</span><br />
    Рынок сейчас <b>${fmtUsd(state.spot, 2)}</b> —
    ${gap == null ? '' : gap < 0 ? `<span class="neg">на ${fmtPct(-gap, 2)} ниже себестоимости</span>` : `<span class="pos">на ${fmtPct(gap, 2)} выше себестоимости</span>`}.
    Безубыточных оферт: <b>${profitable.length}</b> из ${analyzed.length}.
    ${
      profitable.length
        ? `Лучшая по доходности: <b>${fmtPct(profitable[0].aprEff, 2)}</b> эффективных при страйке <b>${fmtUsd(profitable[0].strike, 2)}</b> и вероятности продажи <b>${fmtPct(profitable[0].pConv, 1)}</b>.`
        : 'Ни одна оферта не выводит в USDT без убытка — смотрите строку «циклов до безубытка»: процент в BTC постепенно закрывает разрыв.'
    }`;

  const best = pickBestSell({ rows: analyzed });
  $('best-sell-head').innerHTML =
    best.mode === 'exit'
      ? '<h3>Оптимальный выход в USDT</h3><div class="hint">фронт Парето среди безубыточных оферт: здесь срабатывание страйка — желанный исход, поэтому максимизируются обе величины сразу — ставка и вероятность продажи</div>'
      : '<h3>Заработок на ожидании</h3><div class="hint">безубыточного выхода сейчас нет, поэтому срабатывание страйка означало бы принудительную продажу дешевле себестоимости: здесь отобраны оферты с наибольшей ставкой при наименьшем риске такой продажи</div>';
  $('best-sell').innerHTML = best.rows.length
    ? best.rows.map((r) => sellCardFor(r, best.mode)).join('')
    : '<div class="empty">нет доступных оферт Sell High при текущих фильтрах</div>';

  renderLimitedTable('sell', $('sell-table'), SELL_COLUMNS, analyzed, (r) =>
    r.profitable ? (r.sellPareto ? 'pareto' : '') : 'dim',
  );
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
  if (state.riskFree != null) parts.push(`безрисковая USDT: ${fmtPct(state.riskFree, 2)}`);
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

    step('шапка', renderHead);
    const buy = step('расчёт Buy Low', () => currentRows('BuyLow')) || [];
    const sell = step('расчёт Sell High', () => currentRows('SellHigh')) || [];
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

async function main() {
  loadPrefs();
  bindControls();

  state.spot = await fetchSpot().catch(() => null);
  render();

  await loadProducts();
  render();

  // Опционы и первичные котировки — параллельно, страница уже что-то показывает.
  await Promise.all([
    loadOptions(),
    bootstrapQuotes(),
    fetchRiskFree().then((r) => (state.riskFree = r)),
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
  setInterval(loadHistory, 30 * 60_000);
  // Сводка перцентилей меняется раз в четверть часа — чаще её тянуть незачем.
  setInterval(() => fetchAprStats().then((s) => s && (state.stats = s)), 15 * 60_000);
}

main();
