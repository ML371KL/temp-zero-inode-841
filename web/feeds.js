// Источники данных Bybit. Всё публичное: ключи не нужны, CORS открыт,
// поэтому страница ходит в биржу напрямую из браузера и живёт в реальном времени.

export const REST = 'https://api.bybit.com';
const WS_EARN = 'wss://stream.bybit.com/v5/public/fp';
const WS_SPOT = 'wss://stream.bybit.com/v5/public/spot';

async function get(path, params = {}) {
  const url = new URL(path, REST);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  const body = await res.json();
  if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode}: ${body.retMsg || ''} (${path})`);
  return body.result;
}

// ────────────────────────────────────────────────────────────── REST

/** Продукты Dual Assets по паре BTC/USDT (обе версии — обычная и VIP). */
export async function fetchProducts() {
  const r = await get('/v5/earn/advance/product', { category: 'DualAssets', coin: 'BTC' });
  return (r.list || []).filter((p) => p.baseCoin === 'BTC' && p.quoteCoin === 'USDT');
}

/** Лестница страйков одного продукта — используется для первичного заполнения. */
export async function fetchQuote(productId) {
  const r = await get('/v5/earn/advance/product-extra-info', { category: 'DualAssets', productId });
  return (r.list || [])[0] || null;
}

/** Цепочка опционов BTC: markIv, форварды, дельты. */
export async function fetchOptionTickers() {
  const r = await get('/v5/market/tickers', { category: 'option', baseCoin: 'BTC' });
  return r.list || [];
}

/** Спот-цена BTCUSDT — стартовое значение до подключения потока. */
export async function fetchSpot() {
  const r = await get('/v5/market/tickers', { category: 'spot', symbol: 'BTCUSDT' });
  const t = (r.list || [])[0];
  return t ? Number(t.lastPrice) : null;
}

/**
 * Гибкий депозит — альтернатива, с которой сравниваем.
 * USDT задаёт стоимость денег для Buy Low, BTC — стоимость запертой монеты для
 * Sell High. Ставки разные (по BTC она близка к нулю), и подставлять долларовую
 * в оценку позиции в биткоине нельзя.
 */
export async function fetchRiskFree(coin = 'USDT') {
  try {
    const r = await get('/v5/earn/product', { category: 'FlexibleSaving', coin });
    const p = (r.list || [])[0];
    if (!p) return null;
    // Верхняя ступень лестницы: базовая ставка на крупные суммы, без промо-траншей.
    const tiers = p.tierAprDetails || [];
    const base = tiers.length ? tiers[tiers.length - 1].estimateApr : p.estimateApr;
    return Number(String(base).replace('%', '')) / 100;
  } catch {
    return null;
  }
}

/**
 * Свечи спота BTCUSDT. Bybit отдаёт не более 1000 штук и новые сначала;
 * пагинация идёт назад по времени параметром end.
 */
export async function fetchKlines(interval, pages = 1) {
  const closes = [];
  let end = null;
  let step = null;
  for (let p = 0; p < pages; p++) {
    const r = await get('/v5/market/kline', {
      category: 'spot',
      symbol: 'BTCUSDT',
      interval,
      limit: 1000,
      end,
    });
    const rows = r.list || [];
    if (!rows.length) break;
    // Ответ отсортирован по убыванию времени.
    for (const row of rows) closes.push([Number(row[0]), Number(row[4])]);
    if (step == null && rows.length > 1) step = Number(rows[0][0]) - Number(rows[1][0]);
    end = Number(rows[rows.length - 1][0]) - 1;
    if (rows.length < 1000) break;
  }
  closes.sort((a, b) => a[0] - b[0]);
  return { stepMs: step, series: closes };
}

// ─────────────────────────────────────── альтернативная стоимость денег

/**
 * Кривая доходностей казначейства США.
 *
 * Гибкий депозит Bybit — это не стоимость денег, а то, что платит конкретная
 * биржа: сейчас 1.58% против 3.8% по трёхмесячным бумагам. Сравнивать стратегию
 * надо с тем, что доллар может заработать вообще, а не только здесь.
 *
 * Берём напрямую с сайта казначейства: там открыт CORS, ключа не нужно.
 * У FRED данные те же, но заголовка Access-Control-Allow-Origin нет, поэтому из
 * браузера он недоступен — это проверено, не догадка.
 */
const TENOR_DAYS = { '1 Mo': 30, '2 Mo': 60, '3 Mo': 91, '4 Mo': 121, '6 Mo': 182, '1 Yr': 365, '2 Yr': 730 };

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function treasuryYear(year) {
  const url =
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all` +
    `?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const head = splitCsvLine(lines[0]).map((s) => s.trim().replace(/^"|"$/g, ''));
  // Файл отсортирован по убыванию даты, поэтому свежая строка — первая.
  const row = splitCsvLine(lines[1]).map((s) => s.trim().replace(/^"|"$/g, ''));
  const tenors = {};
  for (let k = 1; k < head.length; k++) {
    const days = TENOR_DAYS[head[k]];
    const v = Number(row[k]);
    if (days && Number.isFinite(v) && v > 0) tenors[head[k]] = { days, rate: v / 100 };
  }
  return Object.keys(tenors).length ? { date: row[0], tenors } : null;
}

export async function fetchTreasuryCurve() {
  const year = new Date().getUTCFullYear();
  try {
    // В первые дни января файл текущего года ещё пуст — берём прошлый.
    return (await treasuryYear(year)) ?? (await treasuryYear(year - 1));
  } catch {
    return null;
  }
}

/** Тенор, ближайший к горизонту: 90 дней → 3 месяца, 365 → год. */
export function rateForHorizon(curve, horizonDays) {
  const list = Object.values(curve?.tenors ?? {});
  if (!list.length || !(horizonDays > 0)) return null;
  return list.reduce((a, b) => (Math.abs(b.days - horizonDays) < Math.abs(a.days - horizonDays) ? b : a));
}

/**
 * Сводка перцентилей ставок, которую собирает scripts/record.mjs на ветке data.
 * Тянется напрямую с raw.githubusercontent.com, поэтому обновляется без
 * пересборки страницы. Отсутствие файла — не ошибка: до первых записей его нет.
 */
export async function fetchAprStats(repo = 'ML371KL/temp-zero-inode-841', branch = 'data') {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/apr-stats.json`, {
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────── WebSocket

/**
 * Живые котировки Dual Assets. Топик отдаёт полный снимок всех продуктов
 * биржи (~115 КБ), поэтому состояние просто заменяется целиком, а фильтрация
 * по нужным productId делается на приёме.
 */
export class OfferStream {
  constructor({ onSnapshot, onStatus } = {}) {
    this.onSnapshot = onSnapshot || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.pingTimer = null;
    this.retry = 0;
    this.closed = false;
    this.lastMessageAt = 0;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }

  _connect() {
    this.onStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(WS_EARN);
    } catch {
      this._reconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      ws.send(JSON.stringify({ op: 'subscribe', args: ['earn.dualassets.offers'] }));
      clearInterval(this.pingTimer);
      // Bybit рвёт соединение без пинга; 20 секунд — их рекомендация.
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20_000);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.op) return; // подтверждения подписки и понги
      if (msg.topic !== 'earn.dualassets.offers' || !Array.isArray(msg.data)) return;
      this.lastMessageAt = Date.now();
      this.onSnapshot(msg.data, this.lastMessageAt);
    };

    ws.onerror = () => this.onStatus('error');
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (!this.closed) this._reconnect();
    };
  }

  _reconnect() {
    this.retry += 1;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
    this.onStatus(`reconnect:${Math.round(wait / 1000)}`);
    setTimeout(() => {
      if (!this.closed) this._connect();
    }, wait);
  }
}

/** Поток спот-цены BTCUSDT для мгновенного пересчёта расстояния до страйков. */
export class SpotStream {
  constructor(onPrice) {
    this.onPrice = onPrice;
    this.ws = null;
    this.pingTimer = null;
    this.closed = false;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }

  _connect() {
    let ws;
    try {
      ws = new WebSocket(WS_SPOT);
    } catch {
      setTimeout(() => !this.closed && this._connect(), 5000);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20_000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const price = Number(msg?.data?.lastPrice);
      if (price > 0) this.onPrice(price);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (!this.closed) setTimeout(() => this._connect(), 3000);
    };
  }
}

/**
 * Приведение сжатого формата WebSocket к виду REST-ответа.
 * p — productId, c — текущая цена, b/s — лестницы Buy Low / Sell High,
 * внутри: s — страйк, a — APY в e8, m — лимит, x — момент протухания котировки.
 */
export function normalizeWsOffer(row) {
  const map = (arr) =>
    (arr || []).map((o) => ({
      selectPrice: o.s,
      apyE8: o.a,
      maxInvestmentAmount: o.m,
      expiredAt: o.x,
    }));
  return {
    productId: String(row.p),
    currentPrice: row.c,
    buyLowPrice: map(row.b),
    sellHighPrice: map(row.s),
  };
}
