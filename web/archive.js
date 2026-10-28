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
//
// Хранение — агрегатами «корзина, сутки»: одна запись на корзину в сутки со
// всеми её значениями за эти сутки. Раньше каждая точка была отдельной записью
// (~350 в минуту без VIP и ~700 с VIP), и после каждой записи сводка
// пересобиралась из всего архива: неделя открытой вкладки — 2,4 с и 0,6 ГБ на
// пересборку. Теперь снимок — не чаще раза в 10 минут, сводка — по таймеру раз
// в 15 минут и вне отрисовки, чистка старше 60 дней — и пока вкладка открыта.

import { QUANTILE_LEVELS, bucketKey, parseDuration, summarizeAggregates, tenorFromKey, utcDay } from './quant.js';

export { QUANTILE_LEVELS };

const DB_NAME = 'dual-assets-archive';
// Версия 3: агрегаты «корзина, сутки» вместо сырых точек. Записи версии 2
// переносятся при обновлении (migrateSamples), а не стираются.
const DB_VERSION = 3;
const OLD_STORE = 'samples';
const AGG_STORE = 'aggs';
const DAY_STORE = 'days';

// Как часто класть точку. Котировки живут секунды, но нам нужна не каждая
// из них, а равномерная сетка: иначе активные минуты просмотра перевесят.
export const SAMPLE_INTERVAL_MS = 10 * 60_000;
// Как часто пересобирать сводку и как часто чистить старое.
export const STATS_INTERVAL_MS = 15 * 60_000;
export const PRUNE_INTERVAL_MS = 24 * 3600_000;
// Глубина хранения.
export const KEEP_DAYS = 60;
// Пороги показа перцентиля: и наблюдений достаточно, и они из РАЗНЫХ суток.
// Порог в одних наблюдениях набирался за двадцать минут открытой вкладки, и
// перцентиль по такому архиву мерил дрожание спота внутри одной ячейки,
// а не условия оферты.
const MIN_BUCKET_N = 30;
const MIN_BUCKET_DAYS = 3;
// Ставка хранится целым числом ×1e8 — ровно как её отдаёт биржа (apyE8): без
// потерь и вдвое компактнее числа с плавающей точкой.
export const APY_SCALE = 1e8;

/** Точки снимка: по одной на корзину, ключ записи — сутки и корзина. */
export function samplePoints(rows, now) {
  const day = utcDay(now);
  const seen = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.apy) || !Number.isFinite(r.moneyness)) continue;
    // Срок берётся из окна начисления, а не из метки продукта: метка живёт
    // одни сутки, окно начисления — это и есть сам срок.
    const tenor = Number.isFinite(r.timing?.yieldDays) ? r.timing.yieldDays : parseDuration(r.duration);
    const k = bucketKey(tenor, r.isVip, r.direction, r.moneyness);
    if (!k) continue;
    const id = `${day}|${k}`;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(Math.round(r.apy * APY_SCALE));
  }
  return [...seen].map(([id, e8]) => ({ id, day, k: id.slice(id.indexOf('|') + 1), e8 }));
}

/**
 * Перенос сырых точек версии 2 в агрегаты. Точки прореживаются до сетки новых
 * снимков: из каждых SAMPLE_INTERVAL_MS берётся первый снимок. Иначе старые дни
 * (снимок раз в минуту) весили бы вдесятеро больше новых и тянули перцентиль к
 * себе; охват по дням при этом сохраняется целиком.
 */
export function migrateSamples(old) {
  const stamps = [...new Set(old.map((r) => r.ts))].sort((a, b) => a - b);
  const keep = new Set();
  let last = -Infinity;
  for (const ts of stamps) {
    if (ts - last >= SAMPLE_INTERVAL_MS) {
      keep.add(ts);
      last = ts;
    }
  }
  const aggs = new Map();
  const days = new Map();
  for (const r of old) {
    if (!keep.has(r.ts) || !r.k || !Number.isFinite(r.a)) continue;
    const day = utcDay(r.ts);
    const id = `${day}|${r.k}`;
    let a = aggs.get(id);
    if (!a) aggs.set(id, (a = { id, day, k: r.k, list: [] }));
    a.list.push(Math.round(r.a * APY_SCALE));
  }
  for (const ts of keep) {
    const day = utcDay(ts);
    const d = days.get(day) ?? { day, samples: 0, first: ts };
    d.samples++;
    d.first = Math.min(d.first, ts);
    days.set(day, d);
  }
  return {
    aggs: [...aggs.values()].map((a) => ({ id: a.id, day: a.day, k: a.k, v: Int32Array.from(a.list) })),
    days: [...days.values()],
  };
}

/**
 * Для каких корзин нужна сводка: все, что встречались за последние двое суток,
 * и те же корзины на сутки короче — у календарных продуктов срок в сутках
 * сокращается на перекате, и сводка для завтрашнего срока должна быть готова
 * до первого снимка после него. Старые сроки никто не запрашивает.
 */
export function wantedKeys(aggs, today) {
  const out = new Set();
  for (const a of aggs) {
    if (a.day < today - 1) continue;
    out.add(a.k);
    // Скользящие сроки (до 5 суток) на перекате не меняются.
    const t = tenorFromKey(a.k);
    if (t > 5) out.add(`${(t - 1).toFixed(3)}${a.k.slice(a.k.indexOf('|'))}`);
  }
  return out;
}

/** Сводка в формате record.mjs из агрегатов и записей по суткам. */
export function buildStats(aggs, dayRecs, now) {
  if (!aggs.length) return null;
  const buckets = summarizeAggregates(aggs, {
    levels: QUANTILE_LEVELS,
    minN: MIN_BUCKET_N,
    minDays: MIN_BUCKET_DAYS,
    keys: wantedKeys(aggs, utcDay(now)),
    scale: APY_SCALE,
  });
  let earliest = Infinity;
  let snapshots = 0;
  for (const d of dayRecs) {
    earliest = Math.min(earliest, d.first);
    snapshots += d.samples;
  }
  return {
    source: 'local',
    updated: now,
    snapshots,
    spanDays: Number.isFinite(earliest) ? (now - earliest) / 86_400_000 : 0,
    days: new Set(aggs.map((a) => a.day)).size,
    quantileLevels: QUANTILE_LEVELS,
    buckets,
  };
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function openDb(onBlocked) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Вкладка со старой версией панели держит базу прежней версии и сама её не
    // отпускает: обновление схемы ждёт, пока ту вкладку закроют или обновят.
    // Запрос при этом не теряется и завершится сам; здесь только сообщаем,
    // почему архива пока нет (панель работает и без него — main не ждёт init).
    req.onblocked = () => onBlocked?.();
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      const aggs = db.objectStoreNames.contains(AGG_STORE)
        ? tx.objectStore(AGG_STORE)
        : db.createObjectStore(AGG_STORE, { keyPath: 'id' });
      if (!aggs.indexNames.contains('day')) aggs.createIndex('day', 'day');
      const days = db.objectStoreNames.contains(DAY_STORE) ? tx.objectStore(DAY_STORE) : db.createObjectStore(DAY_STORE, { keyPath: 'day' });
      // Версия 2 хранила сырые точки: переносим их в агрегаты в той же
      // транзакции обновления, и только потом удаляем старое хранилище.
      // Версию 1 (другой ключ корзины) версия 2 уже стёрла.
      if (ev.oldVersion === 2 && db.objectStoreNames.contains(OLD_STORE)) {
        const old = tx.objectStore(OLD_STORE);
        const all = [];
        // Читаем порциями по первичному ключу: старый архив бывает большим.
        const batch = (lower) => {
          const range = lower == null ? null : IDBKeyRange.lowerBound(lower, true);
          const r = old.getAll(range, 50_000);
          r.onsuccess = () => {
            const part = r.result || [];
            for (const x of part) all.push({ ts: x.ts, k: x.k, a: x.a });
            if (part.length === 50_000) batch(part[part.length - 1].id);
            else {
              const moved = migrateSamples(all);
              for (const a of moved.aggs) aggs.put(a);
              for (const d of moved.days) days.put(d);
              db.deleteObjectStore(OLD_STORE);
            }
          };
        };
        batch(null);
      } else if (db.objectStoreNames.contains(OLD_STORE)) {
        db.deleteObjectStore(OLD_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Другая вкладка с новой версией схемы не должна ждать, пока закроют эту.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

export class Archive {
  constructor() {
    this.db = null;
    this.lastSampleAt = 0;
    this.broken = false;
  }

  async init({ onBlocked } = {}) {
    try {
      this.db = await openDb(onBlocked);
      await this.prune();
      return true;
    } catch {
      // Приватный режим или запрет хранилища — панель обязана работать и без архива.
      this.broken = true;
      return false;
    }
  }

  /**
   * Записать снимок: значение каждой корзины дописывается в агрегат этих
   * суток. Не чаще раза в SAMPLE_INTERVAL_MS; сводка здесь не пересобирается.
   */
  async sample(rows, now = Date.now()) {
    if (!this.db || this.broken) return false;
    if (now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return false;
    const points = samplePoints(rows, now);
    if (!points.length) return false;
    this.lastSampleAt = now;
    try {
      const tx = this.db.transaction([AGG_STORE, DAY_STORE], 'readwrite');
      const aggs = tx.objectStore(AGG_STORE);
      const days = tx.objectStore(DAY_STORE);
      for (const p of points) {
        const get = aggs.get(p.id);
        get.onsuccess = () => {
          const prev = get.result;
          const v = new Int32Array((prev?.v.length ?? 0) + p.e8.length);
          if (prev) v.set(prev.v);
          v.set(p.e8, prev?.v.length ?? 0);
          aggs.put({ id: p.id, day: p.day, k: p.k, v });
        };
      }
      const day = points[0].day;
      const getDay = days.get(day);
      getDay.onsuccess = () => {
        const d = getDay.result ?? { day, samples: 0, first: now };
        d.samples++;
        days.put(d);
      };
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Удалить сутки глубже KEEP_DAYS. */
  async prune(now = Date.now()) {
    if (!this.db) return;
    const cutoff = utcDay(now) - KEEP_DAYS;
    try {
      const tx = this.db.transaction([AGG_STORE, DAY_STORE], 'readwrite');
      const index = tx.objectStore(AGG_STORE).index('day');
      await new Promise((resolve, reject) => {
        const req = index.openCursor(IDBKeyRange.upperBound(cutoff, true));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve();
          cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
      tx.objectStore(DAY_STORE).delete(IDBKeyRange.upperBound(cutoff, true));
    } catch {
      /* чистка не критична */
    }
  }

  /**
   * Сводка перцентилей в том же формате, что публикует record.mjs, чтобы
   * страница не различала источники. Зовётся по таймеру, а не из отрисовки.
   */
  async stats(now = Date.now()) {
    if (!this.db || this.broken) return null;
    let aggs;
    let dayRecs;
    try {
      const tx = this.db.transaction([AGG_STORE, DAY_STORE], 'readonly');
      [aggs, dayRecs] = await Promise.all([done(tx.objectStore(AGG_STORE).getAll()), done(tx.objectStore(DAY_STORE).getAll())]);
    } catch {
      return null;
    }
    return buildStats(aggs || [], dayRecs || [], now);
  }

  async clear() {
    if (!this.db) return;
    const tx = this.db.transaction([AGG_STORE, DAY_STORE], 'readwrite');
    tx.objectStore(AGG_STORE).clear();
    tx.objectStore(DAY_STORE).clear();
  }
}
