// Графики на голом SVG: без зависимостей, цвета берутся из переменных темы.

const NS = 'http://www.w3.org/2000/svg';

// Общее полотно для всех графиков панели и общий кегль подписей.
export const CHART_W = 760;
export const CHART_H = 400;
const FONT_TICK = 11;
const FONT_LABEL = 10;
const FONT_AXIS = 12;

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

  // Оба графика панели используют одну систему координат: SVG растягивается по
  // ширине, поэтому при разных полотнах одинаковый font-size давал бы разный
  // размер текста на экране. Раньше рассеяние было 960 единиц шириной, а
  // лестница 560, и подписи рассеяния выглядели вдвое мельче соседних.
  const W = CHART_W;
  const H = CHART_H;
  const M = { top: 18, right: 22, bottom: 44, left: 58 };
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
    const lb = el('text', { x: -10, y: y(t) + 4, 'text-anchor': 'end', 'font-size': FONT_TICK }, pct(t));
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  }
  for (const t of niceTicks(0, xMax, 5)) {
    g.append(el('line', { class: 'grid-line', x1: x(t), x2: x(t), y1: 0, y2: ih }));
    const label = el('text', { x: x(t), y: ih + 18, 'text-anchor': 'middle', 'font-size': FONT_TICK }, pct(t));
    label.setAttribute('fill', 'var(--ink-3)');
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
    const t = el('text', { x: x(maxP) + 5, y: 12, 'font-size': FONT_LABEL }, `порог ${(maxP * 100).toFixed(1)}%`);
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

  // Доминируемые оферты — это фон: они нужны, чтобы видеть облако целиком, но
  // не должны конкурировать за внимание с фронтом. Раньше 130 одинаково ярких
  // кружков делали график нечитаемым, а сам фронт в них терялся.
  for (const r of usable) {
    if (r.pareto) continue;
    const node = el('circle', {
      class: 'pt',
      cx: x(r.pConv),
      cy: y(r.aprEff),
      r: 3,
      fill: 'var(--ink-3)',
      'fill-opacity': 0.25,
      stroke: 'none',
    });
    if (onHover) {
      node.addEventListener('mouseenter', (e) => onHover(r, e));
      node.addEventListener('mouseleave', () => onHover(null));
    }
    g.append(node);
  }

  // Точки фронта: цвет по сроку, обводка потолще у VIP, подпись со страйком.
  for (const r of front) {
    const c = durationColor(r.duration, durations);
    const node = el('circle', {
      class: 'pt',
      cx: x(r.pConv),
      cy: y(r.aprEff),
      r: 4,
      fill: c,
      stroke: 'var(--panel)',
      'stroke-width': r.isVip ? 1.6 : 0.8,
    });
    if (onHover) {
      node.addEventListener('mouseenter', (e) => onHover(r, e));
      node.addEventListener('mouseleave', () => onHover(null));
    }
    g.append(node);
  }

  // Подписи чередуются сверху и снизу от точки: на плотных участках фронта
  // односторонние подписи налезали друг на друга и на сами кружки.
  const placed = [];
  let above = true;
  for (const r of front) {
    const px = x(r.pConv);
    const py = y(r.aprEff);
    const collides = placed.some((p) => Math.abs(p.x - px) < 54 && Math.abs(p.y - py) < 13);
    if (collides) continue;
    const dy = above ? -9 : 15;
    above = !above;
    placed.push({ x: px, y: py + dy });
    const label = el(
      'text',
      { x: px + 7, y: py + dy, 'font-size': FONT_LABEL, 'font-family': 'ui-monospace, monospace' },
      `${Math.round(r.strike / 100) / 10}k·${r.duration}`,
    );
    label.setAttribute('fill', 'var(--ink-2)');
    g.append(label);
  }

  const xl = el('text', { x: iw / 2, y: ih + 38, 'text-anchor': 'middle', 'font-size': FONT_AXIS }, 'вероятность конвертации');
  xl.setAttribute('fill', 'var(--ink-2)');
  g.append(xl);
  const yl = el(
    'text',
    { x: -ih / 2, y: -42, 'text-anchor': 'middle', 'font-size': FONT_AXIS, transform: `rotate(-90)` },
    'эффективный APR',
  );
  yl.setAttribute('fill', 'var(--ink-2)');
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

  const W = CHART_W;
  const H = CHART_H;
  const M = { top: 16, right: 18, bottom: 58, left: 58 };
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
    const lb = el('text', { x: -10, y: y(t) + 4, 'text-anchor': 'end', 'font-size': FONT_TICK }, pct(t));
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  }

  // Подписывать каждый страйк нельзя: у длинных сроков их два десятка, и на
  // сгущениях лестницы числа наезжали друг на друга в сплошную кашу.
  // Оставляем те, что не ближе кегля, обязательно сохраняя крайние.
  let lastX = -1e9;
  pts.forEach((p, k) => {
    const px = x(p.strike);
    const isEdge = k === 0 || k === pts.length - 1;
    if (!isEdge && px - lastX < 52) return;
    lastX = px;
    const lb = el(
      'text',
      { x: px, y: ih + 20, 'text-anchor': 'middle', 'font-size': FONT_TICK, 'font-family': 'ui-monospace, monospace' },
      (p.strike / 1000).toFixed(p.strike % 1000 === 0 ? 0 : 1) + 'k',
    );
    lb.setAttribute('fill', 'var(--ink-3)');
    g.append(lb);
  });

  // Текущая цена — вертикальная отсечка.
  const spot = pts[0].spot;
  if (spot >= xMin && spot <= xMax) {
    g.append(el('line', { x1: x(spot), x2: x(spot), y1: 0, y2: ih, stroke: 'var(--ink-3)', 'stroke-width': 1 }));
    const lb = el('text', { x: x(spot) + 5, y: 12, 'font-size': FONT_LABEL }, 'спот');
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
    // Перекошенные точки выделяем цветом предупреждения: именно здесь видно,
    // что провалы кривой Bybit — не артефакт графика, а её реальная форма,
    // и рядом есть страйк дальше от рынка с более высокой ставкой.
    const bad = Boolean(p.laddered);
    const node = el('circle', {
      class: 'pt',
      cx: x(p.strike),
      cy: y(p.aprEff),
      r: bad ? 5 : 4,
      fill: bad ? 'var(--warn)' : 'var(--accent)',
      stroke: bad ? 'var(--panel)' : 'none',
      'stroke-width': bad ? 1.5 : 0,
    });
    if (onHover) {
      node.addEventListener('mouseenter', (e) => onHover(p, e));
      node.addEventListener('mouseleave', () => onHover(null));
    }
    g.append(node);
  }

  const legend = el('g', { class: 'legend', transform: `translate(0,${ih + 44})` });
  legend.append(el('line', { x1: 0, x2: 22, y1: -4, y2: -4, stroke: 'var(--accent)', 'stroke-width': 2 }));
  legend.append(el('text', { x: 28, y: 0, 'font-size': FONT_LABEL }, 'ставка Bybit'));
  legend.append(
    el('line', { x1: 132, x2: 154, y1: -4, y2: -4, stroke: 'var(--ink-3)', 'stroke-width': 1.6, 'stroke-dasharray': '5 4' }),
  );
  legend.append(el('text', { x: 160, y: 0, 'font-size': FONT_LABEL }, 'эквивалент цены опциона'));
  const flagged = pts.filter((p) => p.laddered).length;
  if (flagged) {
    legend.append(el('circle', { cx: 340, cy: -4, r: 4, fill: 'var(--warn)' }));
    const w = el('text', { x: 350, y: 0, 'font-size': FONT_LABEL }, `перекос лестницы (${flagged})`);
    w.setAttribute('fill', 'var(--warn)');
    legend.append(w);
  }
  if (title) {
    const t = el('text', { x: iw, y: 0, 'text-anchor': 'end', 'font-size': FONT_LABEL }, title);
    t.setAttribute('fill', 'var(--ink-2)');
    legend.append(t);
  }
  g.append(legend);

  const xl = el('text', { x: iw / 2, y: ih + 38, 'text-anchor': 'middle', 'font-size': FONT_AXIS }, 'страйк');
  xl.setAttribute('fill', 'var(--ink-2)');
  g.append(xl);

  container.append(svg);
}
