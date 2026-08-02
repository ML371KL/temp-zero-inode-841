// Поверхность волатильности из опционов Bybit.
//
// Опционы BTC у Bybit экспирируются в 08:00 UTC — ровно в момент сеттлмента
// Dual Assets. Для сроков 1d/6d/13d/27d/55d/146d/237d даты совпадают с
// котируемыми экспирациями точно, для 3d/5d интерполируем по полной дисперсии.

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const YEAR_DAYS = 365;
const MS_DAY = 86_400_000;

// BTC-25JUN27-30000-P-USDT
export function parseOptionSymbol(symbol) {
  const parts = String(symbol).split('-');
  if (parts.length < 4) return null;
  const [base, dateStr, strikeStr, kind] = parts;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(dateStr);
  if (!m || !(m[2] in MONTHS)) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2]];
  const year = 2000 + Number(m[3]);
  const expiry = Date.UTC(year, month, day, 8, 0, 0);
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { base, expiry, strike, kind };
}

/**
 * Сборка поверхности из ответа /v5/market/tickers?category=option&baseCoin=BTC.
 * На каждой экспирации: улыбка markIv по страйкам и форвард (underlyingPrice).
 */
export function buildSurface(tickers, now) {
  const byExpiry = new Map();
  let index = null;

  for (const t of tickers) {
    const parsed = parseOptionSymbol(t.symbol);
    if (!parsed) continue;
    const iv = Number(t.markIv);
    if (!Number.isFinite(iv) || iv <= 0) continue;
    if (index == null && Number(t.indexPrice) > 0) index = Number(t.indexPrice);

    let node = byExpiry.get(parsed.expiry);
    if (!node) {
      node = { expiry: parsed.expiry, forward: null, strikes: new Map() };
      byExpiry.set(parsed.expiry, node);
    }
    const und = Number(t.underlyingPrice);
    if (Number.isFinite(und) && und > 0) node.forward = und;

    // Колл и пут на одном страйке должны давать одну IV; усредняем то, что пришло.
    const prev = node.strikes.get(parsed.strike);
    node.strikes.set(parsed.strike, prev ? { sum: prev.sum + iv, n: prev.n + 1 } : { sum: iv, n: 1 });
  }

  const expiries = [...byExpiry.values()]
    .filter((n) => n.expiry > now && n.strikes.size >= 2 && n.forward > 0)
    .map((n) => {
      const smile = [...n.strikes.entries()]
        .map(([K, v]) => ({ K, iv: v.sum / v.n, x: Math.log(K / n.forward) }))
        .sort((a, b) => a.x - b.x);
      return {
        expiry: n.expiry,
        forward: n.forward,
        T: (n.expiry - now) / MS_DAY / YEAR_DAYS,
        smile,
      };
    })
    .sort((a, b) => a.T - b.T);

  return { expiries, index, now };
}

// Линейная интерполяция улыбки по log-moneyness, плоская экстраполяция по краям.
function ivAtMoneyness(expiry, x) {
  const s = expiry.smile;
  if (!s.length) return null;
  if (x <= s[0].x) return s[0].iv;
  if (x >= s[s.length - 1].x) return s[s.length - 1].iv;
  for (let k = 1; k < s.length; k++) {
    if (x <= s[k].x) {
      const a = s[k - 1];
      const b = s[k];
      const w = (x - a.x) / (b.x - a.x);
      return a.iv + w * (b.iv - a.iv);
    }
  }
  return s[s.length - 1].iv;
}

/**
 * Форвард на произвольную дату: ставка ln(F/S)/T интерполируется по сроку.
 * За пределами котируемых экспираций держим ставку ближайшей — это
 * консервативнее, чем экстраполировать её наклон.
 */
export function forwardAt(surface, spot, T) {
  const ex = surface.expiries;
  if (!ex.length || !(T > 0)) return spot;
  const rateOf = (e) => (e.T > 0 ? Math.log(e.forward / spot) / e.T : 0);
  if (T <= ex[0].T) return spot * Math.exp(rateOf(ex[0]) * T);
  if (T >= ex[ex.length - 1].T) return spot * Math.exp(rateOf(ex[ex.length - 1]) * T);
  for (let k = 1; k < ex.length; k++) {
    if (T <= ex[k].T) {
      const a = ex[k - 1];
      const b = ex[k];
      const w = (T - a.T) / (b.T - a.T);
      const r = rateOf(a) + w * (rateOf(b) - rateOf(a));
      return spot * Math.exp(r * T);
    }
  }
  return spot;
}

/**
 * Волатильность для страйка K и срока T.
 * Между экспирациями интерполируем полную дисперсию σ²T (так поверхность
 * остаётся свободной от календарного арбитража), удерживая log-moneyness.
 */
export function volAt(surface, spot, K, T) {
  const ex = surface.expiries;
  if (!ex.length || !(T > 0) || !(K > 0)) return null;

  const ivOn = (e) => {
    const x = Math.log(K / e.forward);
    return ivAtMoneyness(e, x);
  };

  if (T <= ex[0].T) return ivOn(ex[0]);
  if (T >= ex[ex.length - 1].T) return ivOn(ex[ex.length - 1]);

  for (let k = 1; k < ex.length; k++) {
    if (T <= ex[k].T) {
      const a = ex[k - 1];
      const b = ex[k];
      const ivA = ivOn(a);
      const ivB = ivOn(b);
      if (ivA == null || ivB == null) return ivA ?? ivB;
      const wA = ivA * ivA * a.T;
      const wB = ivB * ivB * b.T;
      const u = (T - a.T) / (b.T - a.T);
      const w = wA + u * (wB - wA);
      return Math.sqrt(Math.max(w, 1e-12) / T);
    }
  }
  return null;
}

// Точное совпадение даты сеттлмента с котируемой экспирацией — отдельная
// пометка: там оценка риска опирается на рынок напрямую, без интерполяции.
export function hasExactExpiry(surface, settleMs, toleranceMs = 2 * 3600_000) {
  return surface.expiries.some((e) => Math.abs(e.expiry - settleMs) <= toleranceMs);
}

// ────────────────────────────────────── срочная структура волатильности

/**
 * Кривая накопленной дисперсии «на деньгах»: w(T) = σ_ATM(T)²·T.
 *
 * Зачем именно накопленная дисперсия, а не волатильность. Складывается по
 * срокам именно дисперсия, поэтому только в этих единицах можно спросить
 * «сколько изменчивости рынок ждёт на участке с 30-го по 90-й день» — это
 * разность w(90/365) − w(30/365). Волатильности вычитать нельзя.
 *
 * Монотонность чинится нарастающим максимумом. Провал, при котором на более
 * дальней дате накопленная дисперсия оказалась бы меньше, чем на ближней,
 * означал бы отрицательную форвардную дисперсию — величину, которой не бывает.
 * В котировках такие провалы возникают технически: неликвидная экспирация,
 * устаревшая марк-цена, редкая улыбка. Чинить их обязательно, иначе участок
 * траектории пришлось бы масштабировать корнем из отрицательного числа.
 */
export function atmVarianceCurve(surface) {
  const pts = [];
  for (const e of surface.expiries) {
    const iv = atmIv(e);
    if (!(iv > 0) || !(e.T > 0)) continue;
    pts.push({ T: e.T, iv, w: iv * iv * e.T, raw: iv * iv * e.T });
  }
  pts.sort((a, b) => a.T - b.T);
  let run = 0;
  let repaired = 0;
  for (const p of pts) {
    if (p.w < run - 1e-15) repaired++;
    run = Math.max(run, p.w);
    p.w = run;
  }
  return { points: pts, repaired };
}

/** Волатильность «на деньгах» одной экспирации: улыбка в точке log-moneyness 0. */
function atmIv(expiry) {
  const s = expiry.smile;
  if (!s?.length) return null;
  if (s.length === 1) return s[0].iv;
  if (0 <= s[0].x) return s[0].iv;
  if (0 >= s[s.length - 1].x) return s[s.length - 1].iv;
  for (let k = 1; k < s.length; k++) {
    if (0 <= s[k].x) {
      const a = s[k - 1];
      const b = s[k];
      return a.iv + ((0 - a.x) / (b.x - a.x)) * (b.iv - a.iv);
    }
  }
  return s[s.length - 1].iv;
}

/**
 * Накопленная дисперсия на произвольный срок. Между котируемыми экспирациями
 * линейно по w — так форвардная дисперсия на участке остаётся постоянной и
 * неотрицательной. За правым краем продолжаем с последней волатильностью,
 * за левым — с первой: экстраполировать наклон кривой опаснее, чем держать его.
 */
export function totalVariance(curve, T) {
  const p = curve?.points;
  if (!p?.length || !(T > 0)) return 0;
  if (T <= p[0].T) return (p[0].w * T) / p[0].T;
  if (T >= p[p.length - 1].T) return (p[p.length - 1].w * T) / p[p.length - 1].T;
  for (let k = 1; k < p.length; k++) {
    if (T <= p[k].T) {
      const a = p[k - 1];
      const b = p[k];
      const u = (T - a.T) / (b.T - a.T);
      return a.w + u * (b.w - a.w);
    }
  }
  return p[p.length - 1].w;
}

/**
 * Волатильность, которую рынок ждёт на участке [T0, T1], а не с нуля.
 * Именно ею масштабируется соответствующий кусок исторической траектории.
 */
export function forwardVol(curve, T0, T1) {
  if (!(T1 > T0)) return null;
  const dv = totalVariance(curve, T1) - totalVariance(curve, T0);
  return Math.sqrt(Math.max(dv, 0) / (T1 - T0));
}
