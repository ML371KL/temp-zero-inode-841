// Запись снимка котировок Dual Assets в архив и пересборка сводки перцентилей.
//
//   node scripts/record.mjs --out <каталог ветки data>
//
// Сырой архив (history/ГГГГ-ММ-ДД.ndjson) нужен для бэктеста: по нему видно,
// какие ставки реально предлагались в каждый момент. Сводка (apr-stats.json)
// компактна и грузится страницей, чтобы отвечать на вопрос «40% — это много
// или мало для такого страйка и срока».

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fetchProducts, fetchQuote, fetchOptionTickers, fetchSpot, fetchRiskFree } from '../web/feeds.js';
import { buildSurface, volAt, forwardAt } from '../web/surface.js';
import { apyFromE8 } from '../web/quant.js';

const argOut = (() => {
  const k = process.argv.indexOf('--out');
  return k >= 0 ? process.argv[k + 1] : 'data-branch';
})();

// Глубина сводки: месяц достаточно, чтобы поймать режим рынка, и не настолько
// много, чтобы ставки полугодовой давности искажали текущую картину.
const STATS_DAYS = 30;
// Сколько суток сырого архива держим на ветке: сводке хватает тридцати,
// запас нужен бэктесту и на случай пропущенных запусков.
const KEEP_DAYS = 45;
// Порог, ниже которого корзина не публикуется: при частоте раз в четверть часа
// он набирается меньше чем за сутки, зато случайные единичные страйки отсеиваются.
const MIN_BUCKET_N = 30;
const QUANTILES = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Ключ корзины: срок, статус VIP, направление и расстояние до спота
 * с шагом половина процента.
 *
 * Нормализовать по расстоянию до спота, а не по самому страйку, обязательно:
 * страйки Bybit стоят на круглых числах, а спот движется, поэтому «62 000»
 * вчера и сегодня — это разные по риску оферты. Шаг в полпроцента выбран как
 * компромисс: ставка резко падает с удалением от спота (на −1% она была 114%,
 * на −4% уже 32%), и слишком широкая корзина мерила бы наклон кривой,
 * а не изменение условий во времени.
 */
export function bucketKey(duration, isVip, direction, moneyness) {
  const half = Math.max(-60, Math.min(60, Math.round(moneyness * 200)));
  return `${duration}|${isVip ? 1 : 0}|${direction === 'BuyLow' ? 'B' : 'S'}|${half}`;
}

async function collect() {
  const now = Date.now();
  const [products, spot, options, riskFree] = await Promise.all([
    fetchProducts(),
    fetchSpot(),
    fetchOptionTickers().catch(() => []),
    fetchRiskFree().catch(() => null),
  ]);
  if (!(spot > 0)) throw new Error('нет спот-цены');

  const available = products.filter((p) => p.status === 'Available');
  const quotes = await Promise.allSettled(available.map((p) => fetchQuote(p.productId)));

  const surface = options.length ? buildSurface(options, now) : null;

  const offers = [];
  for (let k = 0; k < available.length; k++) {
    const res = quotes[k];
    if (res.status !== 'fulfilled' || !res.value) continue;
    const p = available[k];
    for (const [dir, list] of [
      ['BuyLow', res.value.buyLowPrice],
      ['SellHigh', res.value.sellHighPrice],
    ]) {
      for (const lv of list || []) {
        offers.push([p.productId, dir === 'BuyLow' ? 0 : 1, Number(lv.selectPrice), Number(lv.apyE8)]);
      }
    }
  }

  // Срез волатильности на ближайших экспирациях — чтобы в архиве осталась
  // рыночная оценка риска того момента, а не только ставка Bybit.
  const ivSnapshot = surface
    ? surface.expiries.slice(0, 6).map((e) => ({
        e: e.expiry,
        f: Number(forwardAt(surface, spot, e.T).toFixed(2)),
        atm: Number((volAt(surface, spot, spot, e.T) ?? 0).toFixed(4)),
      }))
    : [];

  return {
    t: now,
    s: spot,
    rf: riskFree,
    p: available.map((p) => [
      p.productId,
      p.duration,
      p.isVipProduct ? 1 : 0,
      Number(p.subscribeEndAt),
      Number(p.settlementTime),
      Number(p.expectReceiveAt),
    ]),
    o: offers,
    iv: ivSnapshot,
  };
}

/** Чтение суточного файла архива, сжатого или нет. */
export async function readDay(file) {
  const buf = await readFile(file);
  return file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

async function appendRaw(dir, snapshot) {
  const target = path.join(dir, 'history');
  await mkdir(target, { recursive: true });
  const file = path.join(target, `${dayKey(snapshot.t)}.ndjson.gz`);
  let prev = '';
  try {
    prev = await readDay(file);
  } catch {
    /* первый снимок за сутки */
  }
  // Дописываем целыми строками: обрыв на середине строки сделал бы файл
  // нечитаемым для бэктеста, поэтому недописанный хвост отсекаем.
  if (prev && !prev.endsWith('\n')) prev = prev.slice(0, prev.lastIndexOf('\n') + 1);
  const text = prev + JSON.stringify(snapshot) + '\n';
  await writeFile(file, gzipSync(text, { level: 9 }));
  return { file, lines: text.split('\n').length - 1 };
}

/** Удаление файлов глубже KEEP_DAYS: ветка не должна расти бесконечно. */
async function prune(dir) {
  const histDir = path.join(dir, 'history');
  let files = [];
  try {
    files = await readdir(histDir);
  } catch {
    return 0;
  }
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 86_400_000);
  let removed = 0;
  for (const f of files) {
    const day = f.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
      await rm(path.join(histDir, f));
      removed++;
    }
  }
  return removed;
}

/** Квантили выборки методом линейной интерполяции по порядковым статистикам. */
export function quantiles(sorted, qs = QUANTILES) {
  if (!sorted.length) return null;
  return qs.map((q) => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}

async function rebuildStats(dir) {
  const histDir = path.join(dir, 'history');
  let files = [];
  try {
    files = (await readdir(histDir)).filter((f) => f.includes('.ndjson')).sort();
  } catch {
    return null;
  }
  const cutoff = Date.now() - STATS_DAYS * 86_400_000;
  const buckets = new Map();
  let snapshots = 0;
  let earliest = Infinity;

  for (const f of files.slice(-STATS_DAYS - 2)) {
    const text = await readDay(path.join(histDir, f));
    for (const line of text.split('\n')) {
      if (!line) continue;
      let snap;
      try {
        snap = JSON.parse(line);
      } catch {
        continue; // повреждённая строка не должна ронять пересборку
      }
      if (!snap.t || snap.t < cutoff || !(snap.s > 0)) continue;
      snapshots++;
      earliest = Math.min(earliest, snap.t);
      const meta = new Map((snap.p || []).map((row) => [String(row[0]), { duration: row[1], vip: row[2] }]));
      for (const [pid, dirFlag, strike, apyE8] of snap.o || []) {
        const m = meta.get(String(pid));
        if (!m) continue;
        const key = bucketKey(m.duration, m.vip, dirFlag === 0 ? 'BuyLow' : 'SellHigh', strike / snap.s - 1);
        let arr = buckets.get(key);
        if (!arr) buckets.set(key, (arr = []));
        arr.push(apyFromE8(apyE8));
      }
    }
  }

  const out = {};
  for (const [key, values] of buckets) {
    if (values.length < MIN_BUCKET_N) continue; // на горстке наблюдений перцентиль бессмыслен
    values.sort((a, b) => a - b);
    out[key] = {
      n: values.length,
      q: quantiles(values).map((v) => Number(v.toFixed(6))),
      min: Number(values[0].toFixed(6)),
      max: Number(values[values.length - 1].toFixed(6)),
    };
  }

  return {
    updated: Date.now(),
    windowDays: STATS_DAYS,
    snapshots,
    spanDays: Number.isFinite(earliest) ? (Date.now() - earliest) / 86_400_000 : 0,
    quantileLevels: QUANTILES,
    buckets: out,
  };
}

async function main() {
  const snapshot = await collect();
  const { file, lines } = await appendRaw(argOut, snapshot);
  console.log(
    `снимок записан: ${file} (${lines} за сутки) · оферт ${snapshot.o.length} · ` +
      `продуктов ${snapshot.p.length} · спот ${snapshot.s}`,
  );

  const removed = await prune(argOut);
  if (removed) console.log(`удалено устаревших файлов архива: ${removed}`);

  const stats = await rebuildStats(argOut);
  if (stats) {
    await writeFile(path.join(argOut, 'apr-stats.json'), JSON.stringify(stats));
    console.log(
      `сводка пересобрана: корзин ${Object.keys(stats.buckets).length}, снимков ${stats.snapshots}, ` +
        `глубина ${stats.spanDays.toFixed(1)} сут`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('record.mjs')) {
  main().catch((e) => {
    console.error(`сбой записи: ${e.message}`);
    process.exit(1);
  });
}
