// Tile rendering. Each tile is one SVG: a shape, a colour, and a dot count.
// Three independent attributes is the minimum needed for rule-induction to be
// interesting - with two, every rule is guessable in one trial.

const NS = "http://www.w3.org/2000/svg";

const SHAPE_PATH = {
  circle: "M50 6a44 44 0 1 0 .1 0z",
  square: "M12 12h76v76H12z",
  triangle: "M50 8 94 88H6z",
  diamond: "M50 5 95 50 50 95 5 50z",
  hex: "M50 6 88 28v44L50 94 12 72V28z",
};

// Dice-style dot layouts, in a 0..1 unit box.
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.32, 0.32], [0.68, 0.68]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
};

// Each shape has a different usable interior, so the dots need their own box.
const PIP_BOX = {
  circle: { x: 26, y: 26, w: 48, h: 48 },
  square: { x: 26, y: 26, w: 48, h: 48 },
  triangle: { x: 30, y: 42, w: 40, h: 34 },
  diamond: { x: 30, y: 30, w: 40, h: 40 },
  hex: { x: 28, y: 28, w: 44, h: 44 },
};

export function tileSvg(tile, { size = 96 } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "tile-svg");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", SHAPE_PATH[tile.shape] || SHAPE_PATH.circle);
  path.setAttribute("class", `tile-shape tile-${tile.color}`);
  svg.appendChild(path);

  const box = PIP_BOX[tile.shape] || PIP_BOX.circle;
  const pips = PIPS[tile.count] || PIPS[1];
  const r = tile.count >= 5 ? 5.2 : tile.count >= 4 ? 5.8 : 6.6;

  for (const [ux, uy] of pips) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", (box.x + ux * box.w).toFixed(2));
    c.setAttribute("cy", (box.y + uy * box.h).toFixed(2));
    c.setAttribute("r", r);
    c.setAttribute("class", "tile-pip");
    svg.appendChild(c);
  }
  return svg;
}

/** Accessible description, so the board is playable with a screen reader too. */
export function tileLabel(tile, index) {
  return `Tile ${index + 1}: ${tile.color} ${tile.shape}, ${tile.count} dot${tile.count === 1 ? "" : "s"}`;
}
