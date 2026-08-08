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

import { QUANTILE_LEVELS, bucketKey, parseDuration, summarizeBuckets, utcDay } from './quant.js';

export { QUANTILE_LEVELS };

const DB_NAME = 'dual-assets-archive';
const STORE = 'samples';
// Версия 2: ключ корзины перешёл со строковой метки срока на срок в сутках.
// Старые записи несовместимы по ключу, поэтому при обновлении стор очищается —
// иначе сводка молча собиралась бы из двух несопоставимых наборов.
const DB_VERSION = 2;

// Как часто класть точку. Котировки живут секунды, но нам нужна не каждая
// из них, а равномерная сетка: иначе активные минуты просмотра перевесят.
export const SAMPLE_INTERVAL_MS = 60_000;
// Глубина хранения.
const KEEP_DAYS = 60;
// Пороги показа перцентиля: и наблюдений достаточно, и они из РАЗНЫХ суток.
// Порог в одних наблюдениях набирался за двадцать минут открытой вкладки, и
// перцентиль по такому архиву мерил дрожание спота внутри одной ячейки,
// а не условия оферты.
const MIN_BUCKET_N = 30;
const MIN_BUCKET_DAYS = 3;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Ключи корзин версии 1 несопоставимы с версией 2, смешивать нельзя.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

    const points = [];
    for (const r of rows) {
      if (!Number.isFinite(r.apy) || !Number.isFinite(r.moneyness)) continue;
      // Срок берётся из окна начисления, а не из метки продукта: метка живёт
      // одни сутки, окно начисления — это и есть сам срок.
      const tenor = Number.isFinite(r.timing?.yieldDays) ? r.timing.yieldDays : parseDuration(r.duration);
      const k = bucketKey(tenor, r.isVip, r.direction, r.moneyness);
      if (!k) continue;
      points.push({ ts: now, k, a: r.apy });
    }
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

    let earliest = Infinity;
    const stamps = new Set();
    const obs = [];
    for (const r of rows) {
      earliest = Math.min(earliest, r.ts);
      stamps.add(r.ts);
      obs.push({ key: r.k, value: r.a, day: utcDay(r.ts) });
    }

    // Сборка соседних сроков в одну корзину живёт в summarizeBuckets: там же,
    // где её видит и scripts/record.mjs, чтобы два источника сводки не разошлись.
    const buckets = summarizeBuckets(obs, {
      levels: QUANTILE_LEVELS,
      minN: MIN_BUCKET_N,
      minDays: MIN_BUCKET_DAYS,
    });

    this.cache = {
      source: 'local',
      updated: Date.now(),
      snapshots: stamps.size,
      spanDays: (Date.now() - earliest) / 86_400_000,
      days: new Set(rows.map((r) => utcDay(r.ts))).size,
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

