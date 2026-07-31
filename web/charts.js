// Графики на голом SVG: без зависимостей, цвета берутся из переменных темы.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) out.push(t);
  return out;
}

const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

// Палитра по срокам: короткие сроки холоднее, длинные теплее.
const DURATION_COLORS = ['#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1'];

export function durationColor(duration, allDurations) {
  const idx = allDurations.indexOf(duration);
  return DURATION_COLORS[(idx < 0 ? 0 : idx) % DURATION_COLORS.length];
}

/**
 * Доходность против риска. Ось X — вероятность конвертации, ось Y — эффективный APR.
 * Точки на фронте Парето соединены линией: всё, что лежит ниже и правее неё,
 * заведомо проигрывает какой-то оферте на самой линии.
 */
export function scatterChart(container, rows, { durations, onHover, maxP } = {}) {
  container.innerHTML = '';
  const usable = rows.filter((r) => Number.isFinite(r.pConv) && Number.isFinite(r.aprEff));
  if (!usable.length) {
    container.innerHTML = '<div class="empty">нет данных для графика</div>';
    return;
  }

  const W = 560;
  const H = 300;
  const M = { top: 12, right: 14, bottom: 34, left: 48 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const xMax = Math.max(...usable.map((r) => r.pConv)) * 1.05 || 0.1;
  const yVals = usable.map((r) => r.aprEff);
  const yMax = Math.max(...yVals) * 1.08;
  const yMin = Math.min(0, Math.min(...yVals));

  const x = (v) => (v / xMax) * iw;
  const y = (v) => ih - ((v - yMin) / (yMax - yMin)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const g = el('g', { transform: `translate(${M.left},${M.top})` });
  svg.append(g);

  for (const t of niceTicks(yMin, yMax, 5)) {
    g.append(el('line', { class: 'grid-line', x1: 0, x2: iw, y1: y(t), y2: y(t) }));
    const lb = el('text', { x: -8, y: y(t) + 3.5, 'text-anchor': 'end', 'font-size': 10 }, pct(t));
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  }
  for (const t of niceTicks(0, xMax, 5)) {
    g.append(el('line', { class: 'grid-line', x1: x(t), x2: x(t), y1: 0, y2: ih }));
    const label = el('text', { x: x(t), y: ih + 16, 'text-anchor': 'middle' }, pct(t));
    label.setAttribute('fill', 'var(--ink-3)');
    label.setAttribute('font-size', '10');
    g.append(label);
  }

  // Порог риска пользователя.
  if (maxP != null && maxP <= xMax) {
    g.append(
      el('line', {
        x1: x(maxP),
        x2: x(maxP),
        y1: 0,
        y2: ih,
        stroke: 'var(--warn)',
        'stroke-width': 1.2,
        'stroke-dasharray': '3 3',
      }),
    );
    const t = el('text', { x: x(maxP) + 4, y: 11, 'font-size': 10 }, 'порог');
    t.setAttribute('fill', 'var(--warn)');
    g.append(t);
  }

  const front = usable.filter((r) => r.pareto).sort((a, b) => a.pConv - b.pConv);
  if (front.length > 1) {
    g.append(
      el('path', {
        class: 'front-line',
        d: front.map((r, k) => `${k ? 'L' : 'M'}${x(r.pConv).toFixed(1)},${y(r.aprEff).toFixed(1)}`).join(' '),
      }),
    );
  }

  for (const r of usable) {
    const c = durationColor(r.duration, durations);
    const node = el('circle', {
      class: 'pt',
      cx: x(r.pConv),
      cy: y(r.aprEff),
      r: r.pareto ? 5.5 : 3.6,
      fill: r.pareto ? c : 'transparent',
      stroke: c,
      'stroke-width': r.isVip ? 2.2 : 1.3,
      'fill-opacity': 0.85,
    });
    if (onHover) {
      node.addEventListener('mouseenter', (e) => onHover(r, e));
      node.addEventListener('mouseleave', () => onHover(null));
    }
    g.append(node);
  }

  const xl = el('text', { x: iw / 2, y: ih + 31, 'text-anchor': 'middle', 'font-size': 11 }, 'вероятность конвертации');
  xl.setAttribute('fill', 'var(--ink-2)');
  g.append(xl);
  const yl = el(
    'text',
    { x: -ih / 2, y: -36, 'text-anchor': 'middle', 'font-size': 11, transform: `rotate(-90)` },
    'эффективный APR',
  );
  yl.setAttribute('fill', 'var(--ink-2)');
  yl.setAttribute('x', -ih / 2);
  yl.setAttribute('y', -34);
  g.append(yl);

  container.append(svg);
}

/**
 * Лестница страйков одного срока: ставка Bybit против ставки, эквивалентной
 * рыночной цене опциона. Расстояние между линиями — это премия, которую
 * биржа платит (или недоплачивает) за тот же самый риск.
 */
export function ladderChart(container, rows, { title, onHover } = {}) {
  container.innerHTML = '';
  const pts = rows
    .filter((r) => Number.isFinite(r.strike) && Number.isFinite(r.aprEff))
    .sort((a, b) => a.strike - b.strike);
  if (pts.length < 2) {
    container.innerHTML = '<div class="empty">для выбранного среза мало точек</div>';
    return;
  }

  const W = 560;
  const H = 300;
  const M = { top: 16, right: 14, bottom: 46, left: 52 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const xs = pts.map((p) => p.strike);
  const ysAll = [...pts.map((p) => p.aprEff), ...pts.map((p) => p.fairAprEff).filter(Number.isFinite)];
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ysAll) * 1.1;
  const yMin = Math.min(0, ...ysAll);

  const x = (v) => (xMax === xMin ? iw / 2 : ((v - xMin) / (xMax - xMin)) * iw);
  const y = (v) => ih - ((v - yMin) / (yMax - yMin)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
  const g = el('g', { transform: `translate(${M.left},${M.top})` });
  svg.append(g);

  for (const t of niceTicks(yMin, yMax, 5)) {
    g.append(el('line', { class: 'grid-line', x1: 0, x2: iw, y1: y(t), y2: y(t) }));
    const lb = el('text', { x: -8, y: y(t) + 3.5, 'text-anchor': 'end', 'font-size': 10 }, pct(t));
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  }
  for (const p of pts) {
    const lb = el('text', { x: x(p.strike), y: ih + 16, 'text-anchor': 'middle', 'font-size': 10 }, Math.round(p.strike));
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  }

  // Текущая цена — вертикальная отсечка.
  const spot = pts[0].spot;
  if (spot >= xMin && spot <= xMax) {
    g.append(el('line', { x1: x(spot), x2: x(spot), y1: 0, y2: ih, stroke: 'var(--ink-3)', 'stroke-width': 1 }));
    const lb = el('text', { x: x(spot) + 4, y: 10, 'font-size': 10 }, 'спот');
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  }

  const line = (key, cls) => {
    const seq = pts.filter((p) => Number.isFinite(p[key]));
    if (seq.length < 2) return;
    g.append(
      el('path', {
        class: cls,
        d: seq.map((p, k) => `${k ? 'L' : 'M'}${x(p.strike).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' '),
      }),
    );
  };
  line('fairAprEff', 'series-fair');
  line('aprEff', 'series-offer');

  for (const p of pts) {
    const node = el('circle', {
      class: 'pt',
      cx: x(p.strike),
      cy: y(p.aprEff),
      r: 4,
      fill: 'var(--accent)',
    });
    if (onHover) {
      node.addEventListener('mouseenter', (e) => onHover(p, e));
      node.addEventListener('mouseleave', () => onHover(null));
    }
    g.append(node);
  }

  const legend = el('g', { class: 'legend', transform: `translate(0,${ih + 34})` });
  legend.append(el('line', { x1: 0, x2: 22, y1: -4, y2: -4, stroke: 'var(--accent)', 'stroke-width': 2 }));
  legend.append(el('text', { x: 28, y: 0 }, 'ставка Bybit'));
  legend.append(
    el('line', { x1: 130, x2: 152, y1: -4, y2: -4, stroke: 'var(--ink-3)', 'stroke-width': 1.6, 'stroke-dasharray': '5 4' }),
  );
  legend.append(el('text', { x: 158, y: 0 }, 'эквивалент цены опциона'));
  if (title) {
    const t = el('text', { x: iw, y: 0, 'text-anchor': 'end', 'font-size': 11 }, title);
    t.setAttribute('fill', 'var(--ink-2)');
    legend.append(t);
  }
  g.append(legend);

  container.append(svg);
}
