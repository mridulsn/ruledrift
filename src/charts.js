// Hand-rolled SVG charts. No chart library: the whole app has to work offline
// from a service-worker cache, and a dependency-free build is also a smaller,
// faster first paint - which matters for a game shared by link.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent = null) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

function svgRoot(w, h) {
  const s = el("svg", {
    viewBox: `0 0 ${w} ${h}`,
    width: "100%",
    height: "100%",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
  });
  return s;
}

/**
 * Line chart of a metric across sessions.
 * @param {number[]} values
 */
export function lineChart(values, { label = "", color = "var(--accent)", height = 170, format = (v) => v } = {}) {
  const W = 520;
  const H = height;
  const pad = { l: 40, r: 12, t: 14, b: 24 };
  const svg = svgRoot(W, H);
  svg.setAttribute("aria-label", `${label} across your last ${values.length} sessions`);

  if (values.length < 2) {
    el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "ch-empty" }, svg).textContent =
      "Play two sessions to see a trend.";
    return svg;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lo = min - span * 0.15;
  const hi = max + span * 0.15;
  const x = (i) => pad.l + (i / (values.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  // gridlines
  for (let g = 0; g <= 3; g++) {
    const v = lo + ((hi - lo) * g) / 3;
    const yy = y(v);
    el("line", { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: "ch-grid" }, svg);
    el("text", { x: pad.l - 6, y: yy + 3.5, "text-anchor": "end", class: "ch-tick" }, svg).textContent =
      format(Math.round(v));
  }

  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  el("polyline", {
    points: `${pad.l},${H - pad.b} ${pts.join(" ")} ${W - pad.r},${H - pad.b}`,
    class: "ch-area",
    fill: color,
  }, svg);
  el("polyline", { points: pts.join(" "), fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);

  values.forEach((v, i) => {
    if (values.length <= 30 || i === values.length - 1) {
      el("circle", { cx: x(i), cy: y(v), r: i === values.length - 1 ? 4.5 : 2.5, fill: color }, svg);
    }
  });

  const last = values[values.length - 1];
  el("text", { x: W - pad.r, y: y(last) - 10, "text-anchor": "end", class: "ch-last" }, svg).textContent =
    format(last);

  return svg;
}

/**
 * Radar of the five cognitive domains. Nulls (a domain with no data yet) are
 * drawn at the centre rather than silently treated as zero.
 */
export function radarChart(domains, labels, { size = 300, compare = null } = {}) {
  const keys = Object.keys(labels).filter((k) => k in domains);
  const svg = svgRoot(size, size);
  svg.setAttribute("aria-label", "Cognitive profile radar");
  const cx = size / 2;
  const cy = size / 2 + 4;
  const R = size * 0.33;
  const n = keys.length;
  const angle = (i) => (i / n) * Math.PI * 2 - Math.PI / 2;
  const pt = (i, frac) => [cx + Math.cos(angle(i)) * R * frac, cy + Math.sin(angle(i)) * R * frac];

  for (let ring = 1; ring <= 4; ring++) {
    const pts = keys.map((_, i) => pt(i, ring / 4).map((v) => v.toFixed(1)).join(",")).join(" ");
    el("polygon", { points: pts, class: "ch-web" }, svg);
  }
  keys.forEach((_, i) => {
    const [px, py] = pt(i, 1);
    el("line", { x1: cx, y1: cy, x2: px, y2: py, class: "ch-web" }, svg);
  });

  const poly = (vals, cls) =>
    el("polygon", {
      points: keys
        .map((k, i) => pt(i, Math.max(0.02, (vals[k] ?? 0) / 100)).map((v) => v.toFixed(1)).join(","))
        .join(" "),
      class: cls,
    }, svg);

  if (compare) poly(compare, "ch-radar-compare");
  poly(domains, "ch-radar");

  keys.forEach((k, i) => {
    const [px, py] = pt(i, 1.26);
    const t = el("text", {
      x: px,
      y: py,
      "text-anchor": px < cx - 4 ? "end" : px > cx + 4 ? "start" : "middle",
      "dominant-baseline": "middle",
      class: "ch-axis",
    }, svg);
    t.textContent = labels[k];
    const v = el("text", {
      x: px,
      y: py + 13,
      "text-anchor": px < cx - 4 ? "end" : px > cx + 4 ? "start" : "middle",
      "dominant-baseline": "middle",
      class: "ch-axis-val",
    }, svg);
    v.textContent = domains[k] === null || domains[k] === undefined ? "--" : domains[k];
  });

  return svg;
}

/** GitHub-style calendar of daily play, last `weeks` weeks. */
export function streakCalendar(dailyResults, { weeks = 14 } = {}) {
  const cell = 13;
  const gap = 3;
  const W = weeks * (cell + gap) + 30;
  const H = 7 * (cell + gap) + 22;
  const svg = svgRoot(W, H);
  svg.setAttribute("aria-label", "Daily play calendar");

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  const days = ["S", "M", "T", "W", "T", "F", "S"];
  days.forEach((d, i) => {
    if (i % 2 === 1) {
      el("text", { x: 0, y: 16 + i * (cell + gap) + cell * 0.75, class: "ch-cal-day" }, svg).textContent = d;
    }
  });

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      if (date > today) continue;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`;
      const res = dailyResults[key];
      const level = !res ? 0 : res.brainScore >= 75 ? 4 : res.brainScore >= 55 ? 3 : res.brainScore >= 35 ? 2 : 1;
      const r = el("rect", {
        x: 22 + w * (cell + gap),
        y: 16 + d * (cell + gap),
        width: cell,
        height: cell,
        rx: 3,
        class: `ch-cal ch-cal-${level}`,
      }, svg);
      el("title", {}, r).textContent = res
        ? `${key} - Brain ${res.brainScore}, ${res.score.toLocaleString()} pts`
        : `${key} - not played`;
    }
  }
  return svg;
}

/** Small inline bar showing accuracy split per rule. */
export function ruleBars(rows) {
  const W = 520;
  const rowH = 26;
  const H = rows.length * rowH + 8;
  const svg = svgRoot(W, H);
  const labelW = 150;
  rows.forEach((r, i) => {
    const y = i * rowH + 6;
    el("text", { x: 0, y: y + 12, class: "ch-rule-label" }, svg).textContent = r.label;
    el("rect", { x: labelW, y, width: W - labelW - 46, height: 15, rx: 7, class: "ch-rule-bg" }, svg);
    el("rect", {
      x: labelW,
      y,
      width: Math.max(3, (W - labelW - 46) * r.value),
      height: 15,
      rx: 7,
      class: "ch-rule-fill",
    }, svg);
    el("text", { x: W, y: y + 12, "text-anchor": "end", class: "ch-rule-val" }, svg).textContent =
      Math.round(r.value * 100) + "%";
  });
  return svg;
}
