// Tile rendering. Each tile is a rune carved into a stone: a shape, a colour,
// and a dot count. Three independent attributes is the minimum needed for
// rule-induction to be interesting - with two, every rule is guessable in one
// trial.
//
// The shape and the dot count are drawn so they read without any colour at all
// (bright outline, bright countable dots), so a colour-blind player loses only
// the colour rules' colour, never the shape or the count.

const NS = "http://www.w3.org/2000/svg";

const SHAPE_PATH = {
  circle: "M50 8a42 42 0 1 0 .1 0z",
  square: "M14 14h72v72H14z",
  triangle: "M50 9 92 87H8z",
  diamond: "M50 6 94 50 50 94 6 50z",
  hex: "M50 7 87 28.5v43L50 93 13 71.5v-43z",
};

// Dice-style dot layouts, in a 0..1 unit box.
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.32, 0.32], [0.68, 0.68]],
  3: [[0.2, 0.2], [0.5, 0.5], [0.8, 0.8]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
};

// Each shape has a different usable interior, so the dots need their own box.
const PIP_BOX = {
  circle: { x: 27, y: 27, w: 46, h: 46 },
  square: { x: 27, y: 27, w: 46, h: 46 },
  triangle: { x: 30, y: 46, w: 40, h: 32 },
  diamond: { x: 31, y: 31, w: 38, h: 38 },
  hex: { x: 29, y: 29, w: 42, h: 42 },
};

function el(name, attrs) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export function tileSvg(tile, { size = 96 } = {}) {
  const color = tile.color;
  const svg = el("svg", {
    viewBox: "0 0 100 100", width: size, height: size,
    class: `tile-svg rune-${color}`, "aria-hidden": "true",
  });
  const d = SHAPE_PATH[tile.shape] || SHAPE_PATH.circle;

  // The carved groove: a dark copy just below the glowing line.
  svg.appendChild(el("path", { d, class: "tile-groove", transform: "translate(0 2.2)" }));
  svg.appendChild(el("path", { d, class: `tile-shape tile-${color}` }));

  const box = PIP_BOX[tile.shape] || PIP_BOX.circle;
  const pips = tile.count === 0 ? [] : PIPS[tile.count] || PIPS[1];
  // Smaller dots where they would crowd, so every count stays easy to read.
  const r = (tile.count >= 5 ? 5 : tile.count >= 3 ? 5.6 : 6.6) * (tile.shape === "triangle" ? 0.84 : 1);
  for (const [ux, uy] of pips) {
    svg.appendChild(el("circle", {
      cx: (box.x + ux * box.w).toFixed(2),
      cy: (box.y + uy * box.h).toFixed(2),
      r, class: "tile-pip",
    }));
  }
  return svg;
}

/**
 * One feature on its own, for grid headers and clue chips: a shape outline in
 * gold, a colour as a glowing gem, or a dot count as dice pips.
 */
export function glyphSvg(catId, value, { size = 28 } = {}) {
  const svg = el("svg", { viewBox: "0 0 100 100", width: size, height: size, class: "glyph", "aria-hidden": "true" });
  if (catId === "shape") {
    svg.setAttribute("class", "glyph tile-svg rune-gold");
    svg.appendChild(el("path", { d: SHAPE_PATH[value] || SHAPE_PATH.circle, class: "tile-shape" }));
  } else if (catId === "colour") {
    svg.setAttribute("class", `glyph tile-svg rune-${value}`);
    svg.appendChild(el("path", { d: "M50 10 84 34 72 84H28L16 34z", class: "tile-shape gem" }));
  } else {
    svg.setAttribute("class", "glyph tile-svg rune-gold");
    svg.appendChild(el("rect", { x: 8, y: 8, width: 84, height: 84, rx: 18, class: "tile-shape faint" }));
    const r = value >= 5 ? 8 : value >= 3 ? 9 : 10.5;
    for (const [ux, uy] of PIPS[value] || PIPS[1]) {
      svg.appendChild(el("circle", { cx: (12 + ux * 76).toFixed(1), cy: (12 + uy * 76).toFixed(1), r, class: "tile-pip" }));
    }
  }
  return svg;
}

// Hand-drawn crack patterns for a wrong answer, in the tile's 0..100 box.
const CRACKS = [
  "M18 8 L34 30 L28 44 L46 58 L40 74 L56 96 M34 30 L52 26 M46 58 L66 54 L74 70",
  "M84 10 L66 30 L72 46 L52 56 L58 72 L44 94 M66 30 L50 22 M52 56 L32 50 L24 66",
  "M8 46 L28 50 L40 36 L58 46 L72 34 L94 42 M40 36 L36 18 M58 46 L60 66 L48 84",
];

/** A crack overlay, drawn in on a wrong answer. */
export function crackSvg(variant = 0) {
  const svg = el("svg", { viewBox: "0 0 100 100", class: "crack", "aria-hidden": "true", preserveAspectRatio: "none" });
  const d = CRACKS[Math.abs(variant) % CRACKS.length];
  svg.appendChild(el("path", { d, class: "crack-dark", pathLength: 100 }));
  svg.appendChild(el("path", { d, class: "crack-lit", pathLength: 100 }));
  return svg;
}

/** Accessible description, so the board is playable with a screen reader too. */
export function tileLabel(tile, index) {
  return `Tile ${index + 1}: ${tile.color} ${tile.shape}, ${tile.count} dot${tile.count === 1 ? "" : "s"}`;
}
