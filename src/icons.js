// Inline SVG icons. One stroke style for the whole game (24px grid, 1.8px
// round strokes, currentColor), so every icon belongs to the same carved-rune
// world - no emoji, which render differently on every device.

const NS = "http://www.w3.org/2000/svg";

function gearPath() {
  // Eight teeth around a ring, generated so it stays symmetrical.
  const pts = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 9 : 7;
    pts.push([12 + r * Math.cos(a0 + 0.06), 12 + r * Math.sin(a0 + 0.06)]);
    pts.push([12 + r * Math.cos(a1 - 0.06), 12 + r * Math.sin(a1 - 0.06)]);
  }
  return "M" + pts.map(([x, y]) => x.toFixed(2) + " " + y.toFixed(2)).join("L") + "z";
}

// d strings; "F:" prefix = filled instead of stroked.
const P = {
  back: ["M15 5l-7 7 7 7"],
  chevron: ["M9 5l7 7-7 7"],
  close: ["M6 6l12 12M18 6L6 18"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  play: ["F:M8.5 5.5v13l10-6.5z"],
  gear: [gearPath(), "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 1 0 0-5.6z"],
  book: ["M3.5 6c3-1.3 5.8-1.2 8.5.6v13c-2.7-1.8-5.5-1.9-8.5-.6z", "M20.5 6c-3-1.3-5.8-1.2-8.5.6v13c2.7-1.8 5.5-1.9 8.5-.6z"],
  chart: ["M4 20h16", "M7 16.5v-5", "M12 16.5V7", "M17 16.5v-8"],
  trophy: ["M8 4h8v5.5a4 4 0 0 1-8 0z", "M8 6H5v1.2A3 3 0 0 0 8 10.2", "M16 6h3v1.2a3 3 0 0 1-3 3", "M12 13.5V17", "M8.5 20.5h7", "M10 17h4"],
  codex: ["M6 4.5h10.5a2 2 0 0 1 2 2v13h-12a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z", "M4.5 17.5a2 2 0 0 1 2-2h12", "M9 8.5h6", "M9 11.5h4"],
  calendar: ["M5 6.5h14v13H5z", "M5 10.5h14", "M9 4v4", "M15 4v4", "F:M11 13.5h2v2h-2z"],
  target: ["M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16z", "M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8z", "F:M12 10.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4z"],
  lotus: ["M12 19.5c-4.2 0-7.3-2.5-8.3-6.2 3.1 0 5.8 1.4 8.3 4.2 2.5-2.8 5.2-4.2 8.3-4.2-1 3.7-4.1 6.2-8.3 6.2z", "M12 17.2c-2.3-2.6-2.9-5.8 0-10.7 2.9 4.9 2.3 8.1 0 10.7z"],
  bolt: ["M13.5 3L5.5 13.5h6L10.5 21 18.5 10.5h-6z"],
  spiral: ["M12 12.2a1.4 1.4 0 0 1 1.4 1.4 2.8 2.8 0 0 1-2.8 2.8 4.2 4.2 0 0 1-4.2-4.2 5.6 5.6 0 0 1 5.6-5.6 7 7 0 0 1 7 7"],
  swords: ["M5 4.5l11 11", "M19 4.5L8 15.5", "M5 4.5h2.5L17.5 14.5", "M19 4.5h-2.5L6.5 14.5", "M14.5 17l3-3M6.5 14l3 3", "M17 16.5l2.5 2.5M7 16.5L4.5 19"],
  flame: ["M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.5 3.7-8.3.5 2 1.6 3.1 2.8 3.6.3-2.5 1.5-4.7 3.7-6.6-.3 3.4 1.8 5.3 2.6 7.8.8 2.5.2 4-.3 5.2C17 19.6 14.9 21 12 21z", "M12 21c-1.6 0-2.7-1.1-2.7-2.6 0-1.6 1.4-2.5 2.2-4 .5 1.1 1 1.6 1.6 1.9.7.4 1.6 1.2 1.6 2.3 0 1.4-1.1 2.4-2.7 2.4z"],
  spark: ["M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"],
  sparkle: ["M10 4l1.6 5L16.5 10.5l-4.9 1.6L10 17l-1.6-4.9L3.5 10.5l4.9-1.5z", "M18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z"],
  rocket: ["M12 3c3.2 2.1 4.6 5.6 4.3 9.8L14 16h-4l-2.3-3.2C7.4 8.6 8.8 5.1 12 3z", "M10 16l-1.2 4 3.2-2 3.2 2L14 16", "M12 8.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z"],
  eye: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z"],
  flag: ["M6 21V4", "M6 4.5h11l-2.2 4 2.2 4H6"],
  wind: ["M3 9h10.5a3 3 0 1 0-3-3", "M3 15h14.5a3 3 0 1 1-3 3", "M3 12h7"],
  crown: ["M4 18.5h16", "M4.5 18.5L3.5 7.5l5 4 3.5-6 3.5 6 5-4-1 11"],
  gem: ["M7 4.5h10l4 5L12 20.5 3 9.5z", "M3 9.5h18", "M9.5 4.5L8 9.5l4 11 4-11-1.5-5"],
  adapt: ["M19.5 10.5A7.5 7.5 0 0 0 6 7.2L4.5 9", "M4.5 4.8V9h4.2", "M4.5 13.5A7.5 7.5 0 0 0 18 16.8l1.5-1.8", "M19.5 19.2V15h-4.2"],
  stone: ["M7.5 4h9l3.5 5.5-2.3 10.5H6.3L4 9.5z", "M12 8v8.5", "M9.3 10.5l2.7 2.2 2.7-2.2"],
  heart: ["F:M12 20.2s-7.6-4.6-7.6-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.6 2.6c0 5.6-7.6 10.2-7.6 10.2z"],
  heartOutline: ["M12 20.2s-7.6-4.6-7.6-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.6 2.6c0 5.6-7.6 10.2-7.6 10.2z"],
  shield: ["M12 3l7.5 3v5.5c0 4.4-3.1 8.1-7.5 9.5-4.4-1.4-7.5-5.1-7.5-9.5V6z", "M9 12l2.2 2.2L15.2 10"],
  hourglass: ["M7 3.5h10", "M7 20.5h10", "M8 3.5V7c0 2.2 4 3.3 4 5s-4 2.8-4 5v3.5", "M16 3.5V7c0 2.2-4 3.3-4 5s4 2.8 4 5v3.5", "F:M9.6 18.5c.5-1.3 2.4-2 2.4-2s1.9.7 2.4 2z"],
  campfire: ["M4.5 20.5l15-4", "M4.5 16.5l15 4", "M12 15.5c-2.6 0-4.1-1.6-4.1-3.8 0-2.4 2-3.7 2.6-5.9.9 1.1 1.1 2.3 1.5 2.9.6-1.5 1.6-2.6 2.7-3.4-.2 2.1.9 3.4 1.3 4.7.7 2.7-1 5.5-4 5.5z"],
  skull: ["M6 10.5a6 6 0 0 1 12 0V14l-1.8 1.8V19.5H7.8v-3.7L6 14z", "F:M8.6 10.6a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0zM12.4 10.6a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z", "M10.5 19.5v-2M13.5 19.5v-2"],
  lock: ["M7.5 11V8a4.5 4.5 0 0 1 9 0v3", "M5.5 11h13v9.5h-13z", "M12 14.5v2.5"],
  clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16z", "M12 8v4.3l3 1.9"],
  warn: ["M12 4l9 16H3z", "M12 10v4.5", "F:M11 16.6h2v2h-2z"],
  dice: ["M5 5h14v14H5z", "F:M8 7.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM16 7.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM12 10.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM8 14.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM16 14.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4z"],
  share: ["M12 4v11", "M8 7.5L12 3.5l4 4", "M5.5 12.5v7h13v-7"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  map: ["M4 6.5l5-2 6 2 5-2v13l-5 2-6-2-5 2z", "M9 4.5v13", "M15 6.5v13"],
  home: ["M4 11l8-6.5 8 6.5", "M6.5 9.5v10h11v-10"],
  sound: ["M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5z", "M15.5 9a4 4 0 0 1 0 6", "M18 6.5a7.5 7.5 0 0 1 0 11"],
  user: ["M12 4.5a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 1 0 0-7.6z", "M4.5 20c1-3.8 4-5.6 7.5-5.6s6.5 1.8 7.5 5.6"],
  // Ten rune sigils (Elder Futhark shapes) for player avatars, in the same
  // order as the old emoji avatars so a saved choice keeps its slot.
  rune0: ["M9 4v16", "M9 8.5l6.5-3", "M9 13l6.5-3"],
  rune1: ["M8 20V4l8 4v12"],
  rune2: ["M9 4v16", "M9 8l6 4-6 4"],
  rune3: ["M9 4v16", "M9 6.5l6.5 4", "M9 11.5l6.5 4"],
  rune4: ["M8.5 20V4h4.5a3.5 3.5 0 0 1 0 7H8.5l7 9"],
  rune5: ["M15.5 4L8.5 12l7 8"],
  rune6: ["M6.5 4l11 16", "M17.5 4l-11 16"],
  rune7: ["M9 20V4l6 4.5L9 13"],
  rune8: ["M8.5 4v16", "M15.5 4v16", "M8.5 9.5l7 5"],
  rune9: ["M12 4v16", "M12 11.5L7 5", "M12 11.5L17 5"],
};

export const AVATAR_ICONS = ["rune0", "rune1", "rune2", "rune3", "rune4", "rune5", "rune6", "rune7", "rune8", "rune9"];

/**
 * @param {string} name  icon key
 * @param {object} [opts]
 * @param {number} [opts.size=20]
 * @param {string} [opts.cls]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 20, cls = "" } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "ico" + (cls ? " " + cls : ""));
  for (const raw of P[name] || P.spark) {
    const p = document.createElementNS(NS, "path");
    const filled = raw.startsWith("F:");
    p.setAttribute("d", filled ? raw.slice(2) : raw);
    if (filled) {
      p.setAttribute("fill", "currentColor");
      p.setAttribute("stroke", "none");
    } else {
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "1.8");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(p);
  }
  return svg;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(P, name);
}
