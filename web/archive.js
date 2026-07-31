// Локальный архив ставок в браузере.
//
// Зачем он вообще: Bybit блокирует диапазоны дата-центров через CloudFront,
// и раннеры GitHub Actions получают 403 на все эндпоинты и все зеркала.
// Значит, собирать историю ставок на стороне репозитория нечем. Зато сама
// панель работает из вашего браузера, где биржа доступна, — поэтому снимки
// пишутся в IndexedDB прямо здесь, пока страница открыта.
//
// Ограничение, о котором надо помнить: выборка покрывает только те часы, когда
// панель была открыта. Это не непрерывный ряд, и панель честно показывает,
// сколько наблюдений и за какой период набрано.

const DB_NAME = 'dual-assets-archive';
const STORE = 'samples';
const DB_VERSION = 1;

// Как часто класть точку. Котировки живут секунды, но нам нужна не каждая
// из них, а равномерная сетка: иначе активные минуты просмотра перевесят.
export const SAMPLE_INTERVAL_MS = 60_000;
// Глубина хранения.
const KEEP_DAYS = 60;
// Уровни, по которым считаются перцентили.
export const QUANTILE_LEVELS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
// Минимум наблюдений в корзине, ниже которого перцентиль не показывается.
const MIN_BUCKET_N = 20;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Ключ корзины совпадает с тем, что считает scripts/record.mjs:
 * срок, статус VIP, направление и удаление от спота с шагом полпроцента.
 */
export function bucketKey(duration, isVip, direction, moneyness) {
  const half = Math.max(-60, Math.min(60, Math.round(moneyness * 200)));
  return `${duration}|${isVip ? 1 : 0}|${direction === 'BuyLow' ? 'B' : 'S'}|${half}`;
}

export class Archive {
  constructor() {
    this.db = null;
    this.lastSampleAt = 0;
    this.cache = null; // готовая сводка перцентилей
    this.cacheAt = 0;
    this.broken = false;
  }

  async init() {
    try {
      this.db = await openDb();
      await this.prune();
      return true;
    } catch {
      // Приватный режим или запрет хранилища — панель обязана работать и без архива.
      this.broken = true;
      return false;
    }
  }

  /** Записать точку: по одной записи на каждую корзину текущего среза. */
  async sample(rows, now = Date.now()) {
    if (!this.db || this.broken) return false;
    if (now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return false;
    this.lastSampleAt = now;

    const points = rows
      .filter((r) => Number.isFinite(r.apy) && Number.isFinite(r.moneyness))
      .map((r) => ({ ts: now, k: bucketKey(r.duration, r.isVip, r.direction, r.moneyness), a: r.apy }));
    if (!points.length) return false;

    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const p of points) store.add(p);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      this.cache = null; // сводку придётся пересобрать
      return true;
    } catch {
      return false;
    }
  }

  /** Удалить наблюдения глубже KEEP_DAYS. */
  async prune(now = Date.now()) {
    if (!this.db) return;
    const cutoff = now - KEEP_DAYS * 86_400_000;
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('ts');
      const range = IDBKeyRange.upperBound(cutoff);
      await new Promise((resolve, reject) => {
        const req = index.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve();
          cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      /* чистка не критична */
    }
  }

  /**
   * Сводка перцентилей в том же формате, что публикует record.mjs,
   * чтобы страница не различала источники.
   */
  async stats(maxAgeMs = 60_000) {
    if (!this.db || this.broken) return null;
    if (this.cache && Date.now() - this.cacheAt < maxAgeMs) return this.cache;

    let rows;
    try {
      const tx = this.db.transaction(STORE, 'readonly');
      rows = await new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
    if (!rows.length) return null;

    const byKey = new Map();
    let earliest = Infinity;
    const stamps = new Set();
    for (const r of rows) {
      earliest = Math.min(earliest, r.ts);
      stamps.add(r.ts);
      let arr = byKey.get(r.k);
      if (!arr) byKey.set(r.k, (arr = []));
      arr.push(r.a);
    }

    const buckets = {};
    for (const [key, values] of byKey) {
      if (values.length < MIN_BUCKET_N) continue;
      values.sort((a, b) => a - b);
      buckets[key] = { n: values.length, q: quantiles(values, QUANTILE_LEVELS) };
    }

    this.cache = {
      source: 'local',
      updated: Date.now(),
      snapshots: stamps.size,
      spanDays: (Date.now() - earliest) / 86_400_000,
      quantileLevels: QUANTILE_LEVELS,
      buckets,
    };
    this.cacheAt = Date.now();
    return this.cache;
  }

  async clear() {
    if (!this.db) return;
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    this.cache = null;
  }
}

/** Квантили по порядковым статистикам с линейной интерполяцией. */
export function quantiles(sorted, levels) {
  return levels.map((q) => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}
