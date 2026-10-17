// Split Clues - "who holds which rune?"
//
// A logic grid puzzle. Every person at the table holds one rune stone; the
// clues say things about who holds what, and pure logic - never a guess - is
// enough to place every stone.
//
// That promise is kept by construction rather than by hope. The solver below
// is a set of small, human-sized deductions (a clue crosses a cell out, a row
// with one choice left gets its check). A puzzle is only ever dealt if those
// deductions alone fill the whole grid from nothing, and every step they take
// is sound, so the planted answer is the only answer there is. The same
// deductions power the Hint button, which is why a hint can always say which
// clue proves it.
//
// Pure logic, like driftrun.js: no DOM, no timers, no randomness that is not
// seeded. The same seed is the same puzzle on every device.

import { makeRng, hashSeed, dailySeedCode } from "./rng.js";

export const NAMES = ["Asha", "Ravi", "Mira", "Kai", "Lena", "Omar", "Nia", "Theo", "Zara", "Ivo", "Esme", "Jun"];

export const CATS = {
  shape: { id: "shape", label: "Rune", values: ["circle", "square", "triangle", "diamond", "hex"] },
  colour: { id: "colour", label: "Colour", values: ["cyan", "amber", "magenta", "lime", "violet"] },
  dots: { id: "dots", label: "Dots", values: [1, 2, 3, 4, 5] },
};

const SHAPE_WORD = { circle: "circle", square: "square", triangle: "triangle", diamond: "diamond", hex: "hexagon" };
const COLOUR_WORD = { cyan: "teal", amber: "amber", magenta: "rose", lime: "green", violet: "violet" };

// Clue weights decide the flavour of each size. "same"/"diff" here mean a
// clue about one named person; "link"/"unlink" join two rune features.
export const PRESETS = {
  easy: {
    id: "easy", label: "Easy", n: 3, cats: ["shape"], base: 300, par: 60, maxDirect: 1,
    w: { same: 1, diff: 3, either: 2 },
  },
  easy4: {
    id: "easy4", label: "Easy+", n: 4, cats: ["shape"], base: 500, par: 120, maxDirect: 1,
    w: { same: 1, diff: 3, either: 2, left: 1.2, next: 1.2 },
  },
  medium: {
    id: "medium", label: "Medium", n: 4, cats: ["shape", "colour"], base: 800, par: 240, maxDirect: 1,
    w: { same: 1, diff: 2, either: 2, link: 2, unlink: 1, left: 1, next: 1 },
  },
  hard: {
    id: "hard", label: "Hard", n: 5, cats: ["shape", "colour"], base: 1200, par: 420, maxDirect: 2,
    w: { same: 0.8, diff: 2, either: 2, link: 2, unlink: 1.5, left: 1.5, next: 1.5, right: 1 },
  },
  expert: {
    id: "expert", label: "Expert", n: 5, cats: ["shape", "colour", "dots"], base: 1800, par: 600, maxDirect: 2,
    w: { same: 0.8, diff: 2, either: 2, link: 2.2, unlink: 1.5, left: 1.5, next: 1.5, right: 1 },
  },
};

export const PRACTICE = ["easy", "medium", "hard", "expert"];

/** "4 x 4 - runes and colours", for labels. */
export function presetBlurb(id) {
  const p = PRESETS[id];
  const words = { shape: "runes", colour: "colours", dots: "dots" };
  const list = p.cats.map((c) => words[c]);
  const tail = list.length === 1 ? list[0] : list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
  return `${p.n} people \u00b7 ${tail}`;
}

// ---------------------------------------------------------------------------
// grid keys: g{category}r{person}c{value}. A plain identifier, so it is also a
// valid Firestore field path with no quoting.
// ---------------------------------------------------------------------------

export const cellKey = (c, p, v) => `g${c}r${p}c${v}`;

export function parseKey(key) {
  const m = /^g(\d+)r(\d+)c(\d+)$/.exec(String(key));
  return m ? { c: +m[1], p: +m[2], v: +m[3] } : null;
}

export function isTrue(puzzle, key) {
  const k = parseKey(key);
  return !!k && puzzle.solution[k.c] && puzzle.solution[k.c][k.p] === k.v;
}

// ---------------------------------------------------------------------------
// words
// ---------------------------------------------------------------------------

function valueOf(puzzle, c, v) {
  return puzzle.cats[c].values[v];
}

/** The word for one value, e.g. "hexagon", "teal", "3". */
export function valueWord(puzzle, c, v) {
  const id = puzzle.cats[c].id;
  const val = valueOf(puzzle, c, v);
  if (id === "shape") return SHAPE_WORD[val];
  if (id === "colour") return COLOUR_WORD[val];
  return `${val} dot${val === 1 ? "" : "s"}`;
}

function noun(puzzle, item) {
  if (item.c < 0) return puzzle.people[item.v];
  const id = puzzle.cats[item.c].id;
  const val = valueOf(puzzle, item.c, item.v);
  if (id === "shape") return `the ${SHAPE_WORD[val]}`;
  if (id === "colour") return `the ${COLOUR_WORD[val]} rune`;
  return `the ${val}-dot rune`;
}

function article(word) {
  return /^[aeiou]/.test(word) ? "an" : "a";
}

/** "is a circle" / "is teal" / "has 3 dots", or the negative. */
function pred(puzzle, item, neg = false) {
  const id = puzzle.cats[item.c].id;
  const val = valueOf(puzzle, item.c, item.v);
  if (id === "shape") return `is ${neg ? "not " : ""}${article(SHAPE_WORD[val])} ${SHAPE_WORD[val]}`;
  if (id === "colour") return `is ${neg ? "not " : ""}${COLOUR_WORD[val]}`;
  return `${neg ? "does not have" : "has"} ${val} dot${val === 1 ? "" : "s"}`;
}

function orPred(puzzle, c, v1, v2) {
  const id = puzzle.cats[c].id;
  const a = valueOf(puzzle, c, v1), b = valueOf(puzzle, c, v2);
  if (id === "shape") return `is ${article(SHAPE_WORD[a])} ${SHAPE_WORD[a]} or ${article(SHAPE_WORD[b])} ${SHAPE_WORD[b]}`;
  if (id === "colour") return `is ${COLOUR_WORD[a]} or ${COLOUR_WORD[b]}`;
  return `has ${a} or ${b} dots`;
}

function subject(puzzle, item) {
  return item.c < 0 ? `${puzzle.people[item.v]}'s rune` : cap(noun(puzzle, item));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A clue as words, split into parts so a screen can draw a rune chip for every
 * value. Each part is {text} or {item: {c, v}} (c = -1 for a person).
 */
export function clueParts(puzzle, clue) {
  const T = (text) => ({ text });
  const I = (item) => ({ item, text: item.c < 0 ? puzzle.people[item.v] : null });
  const { t, a, b } = clue;
  // Every subject is drawn as a chip after its words, so the sentence reads the
  // same with or without the pictures.
  const sub = (item) => (item.c < 0 ? [I(item), T("'s rune ")] : [T(cap(noun(puzzle, item)) + " "), I(item), T(" ")]);
  const obj = (item) => (item.c < 0 ? [I(item)] : [T(noun(puzzle, item) + " "), I(item)]);
  if (t === "same" || t === "diff") return [...sub(a), T(pred(puzzle, b, t === "diff") + " "), I(b), T(".")];
  if (t === "either") return [...sub(a), T(orPred(puzzle, b.c, b.v, clue.b2.v) + " "), I(b), I(clue.b2), T(".")];
  const rel = {
    left: "sits somewhere left of ",
    next: "sits right next to ",
    right: "sits directly right of ",
  }[t];
  const s = a.c < 0 ? [I(a), T(" ")] : [T(cap(noun(puzzle, a)) + " "), I(a), T(" ")];
  return [...s, T(rel), ...obj(b), T(".")];
}

/** The same clue as one plain sentence (share text, tests, screen readers). */
export function clueText(puzzle, clue) {
  const { t, a, b } = clue;
  if (t === "same" || t === "diff") return `${subject(puzzle, a)} ${pred(puzzle, b, t === "diff")}.`;
  if (t === "either") return `${subject(puzzle, a)} ${orPred(puzzle, b.c, b.v, clue.b2.v)}.`;
  const rel = { left: "sits somewhere left of", next: "sits right next to", right: "sits directly right of" }[t];
  return `${cap(noun(puzzle, a))} ${rel} ${noun(puzzle, b)}.`;
}

/** "Asha's rune is not a circle." */
export function cellText(puzzle, c, p, v, yes) {
  return `${puzzle.people[p]}'s rune ${pred(puzzle, { c, v }, !yes)}.`;
}

// ---------------------------------------------------------------------------
// the deduction state: cand[c][p] is a bitmask of the values person p could
// still have in category c.
// ---------------------------------------------------------------------------

const bit = (i) => 1 << i;
const single = (m) => m !== 0 && (m & (m - 1)) === 0;
const low = (m) => 31 - Math.clz32(m & -m);
const high = (m) => 31 - Math.clz32(m);

function freshState(n, k) {
  const full = (1 << n) - 1;
  return { n, k, bad: false, cand: Array.from({ length: k }, () => new Array(n).fill(full)) };
}

function cloneState(s) {
  return { n: s.n, k: s.k, bad: s.bad, cand: s.cand.map((row) => row.slice()) };
}

/** Who could hold this item: a bitmask of people. */
function holders(s, item) {
  if (item.c < 0) return bit(item.v);
  let m = 0;
  const row = s.cand[item.c];
  for (let p = 0; p < s.n; p++) if (row[p] & bit(item.v)) m |= bit(p);
  return m;
}

/** Person p does not hold the item. Returns true if anything changed. */
function cut(s, item, p) {
  if (item.c < 0) {
    if (item.v === p) s.bad = true;
    return false;
  }
  const row = s.cand[item.c];
  if (!(row[p] & bit(item.v))) return false;
  row[p] &= ~bit(item.v);
  if (!row[p]) s.bad = true;
  return true;
}

/** Only the people in `mask` could hold the item. */
function keepOnly(s, item, mask) {
  let ch = false;
  for (let p = 0; p < s.n; p++) if (!(mask & bit(p)) && cut(s, item, p)) ch = true;
  if (!(holders(s, item) & mask)) s.bad = true;
  return ch;
}

/** One application of one clue. Every elimination here follows from the clue alone. */
function applyClue(s, clue) {
  const { t, a, b } = clue;
  const ma = holders(s, a);
  const mb = holders(s, b);
  let ch = false;
  if (t === "same") {
    ch = keepOnly(s, a, ma & mb) || ch;
    ch = keepOnly(s, b, ma & mb) || ch;
    // Once the owner is known, they hold both halves outright.
    const m = holders(s, a) & holders(s, b);
    if (single(m)) {
      const p = low(m);
      for (const it of [a, b]) {
        if (it.c >= 0 && s.cand[it.c][p] !== bit(it.v)) {
          if (!(s.cand[it.c][p] & bit(it.v))) s.bad = true;
          s.cand[it.c][p] = bit(it.v);
          ch = true;
        }
      }
    }
  } else if (t === "diff") {
    if (single(ma)) ch = cut(s, b, low(ma)) || ch;
    if (single(mb)) ch = cut(s, a, low(mb)) || ch;
  } else if (t === "either") {
    const c = b.c;
    const both = bit(b.v) | bit(clue.b2.v);
    for (let p = 0; p < s.n; p++) {
      if ((ma & bit(p)) && !(s.cand[c][p] & both)) ch = cut(s, a, p) || ch;
    }
    const m2 = holders(s, a);
    if (single(m2)) {
      const p = low(m2);
      const before = s.cand[c][p];
      s.cand[c][p] &= both;
      if (!s.cand[c][p]) s.bad = true;
      if (s.cand[c][p] !== before) ch = true;
    }
  } else if (t === "left") {
    if (!ma || !mb) { s.bad = true; return false; }
    const hb = high(mb), la = low(ma);
    for (let p = hb; p < s.n; p++) if (ma & bit(p)) ch = cut(s, a, p) || ch;
    for (let p = 0; p <= la; p++) if (mb & bit(p)) ch = cut(s, b, p) || ch;
  } else if (t === "next") {
    for (let p = 0; p < s.n; p++) {
      const nb = (p > 0 ? bit(p - 1) : 0) | (p + 1 < s.n ? bit(p + 1) : 0);
      if ((ma & bit(p)) && !(mb & nb)) ch = cut(s, a, p) || ch;
      if ((mb & bit(p)) && !(ma & nb)) ch = cut(s, b, p) || ch;
    }
  } else if (t === "right") {
    for (let p = 0; p < s.n; p++) {
      if ((ma & bit(p)) && !(p > 0 && (mb & bit(p - 1)))) ch = cut(s, a, p) || ch;
      if ((mb & bit(p)) && !(p + 1 < s.n && (ma & bit(p + 1)))) ch = cut(s, b, p) || ch;
    }
  }
  return ch;
}

/** Row and column logic: one value per person, one person per value. */
function applyGrid(s) {
  let ch = false;
  const { n } = s;
  for (let c = 0; c < s.k; c++) {
    const row = s.cand[c];
    for (let p = 0; p < n; p++) {
      if (!row[p]) { s.bad = true; return ch; }
      if (single(row[p])) {
        for (let q = 0; q < n; q++) {
          if (q !== p && (row[q] & row[p])) {
            row[q] &= ~row[p];
            if (!row[q]) s.bad = true;
            ch = true;
          }
        }
      }
    }
    for (let v = 0; v < n; v++) {
      let m = 0;
      for (let p = 0; p < n; p++) if (row[p] & bit(v)) m |= bit(p);
      if (!m) { s.bad = true; return ch; }
      if (single(m)) {
        const p = low(m);
        if (row[p] !== bit(v)) { row[p] = bit(v); ch = true; }
      }
    }
  }
  return ch;
}

function propagate(s, clues) {
  let guard = 0;
  let changed = true;
  while (changed && !s.bad && guard++ < 500) {
    changed = applyGrid(s);
    for (const cl of clues) {
      if (s.bad) break;
      if (applyClue(s, cl)) changed = true;
    }
  }
  return s;
}

const solvedState = (s) => !s.bad && s.cand.every((row) => row.every(single));

/**
 * Logic alone, from an empty grid.
 * @returns {{done: boolean, bad: boolean, solution: number[][]|null}}
 */
export function solveLogic(n, k, clues) {
  const s = propagate(freshState(n, k), clues);
  const done = solvedState(s);
  return { done, bad: s.bad, solution: done ? s.cand.map((row) => row.map(low)) : null };
}

/** Does the clue hold for a full answer? (solution[c][p] = value index) */
export function clueHolds(solution, clue) {
  const owner = (item) => (item.c < 0 ? item.v : solution[item.c].indexOf(item.v));
  const pa = owner(clue.a), pb = owner(clue.b);
  switch (clue.t) {
    case "same": return pa === pb;
    case "diff": return pa !== pb;
    case "either": return solution[clue.b.c][pa] === clue.b.v || solution[clue.b.c][pa] === clue.b2.v;
    case "left": return pa < pb;
    case "next": return Math.abs(pa - pb) === 1;
    case "right": return pa === pb + 1;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

function clueKind(cl) {
  if (cl.t === "same") return cl.a.c < 0 ? "same" : "link";
  if (cl.t === "diff") return cl.a.c < 0 ? "diff" : "unlink";
  return cl.t;
}

export { clueKind };

function itemKey(it) {
  return `${it.c}.${it.v}`;
}

function clueKey(cl) {
  const a = itemKey(cl.a), b = itemKey(cl.b);
  if (cl.t === "same" || cl.t === "diff" || cl.t === "next") return `${cl.t}|${[a, b].sort().join("|")}`;
  if (cl.t === "either") return `either|${a}|${[b, itemKey(cl.b2)].sort().join("|")}`;
  return `${cl.t}|${a}|${b}`;
}

/** Every true clue of every allowed kind, for this answer. */
function truePool(n, k, solution, weights) {
  const out = new Map();
  const add = (cl) => {
    const kind = clueKind(cl);
    if (!weights[kind]) return;
    if (!clueHolds(solution, cl)) return;
    const key = clueKey(cl);
    if (!out.has(key)) out.set(key, cl);
  };
  const itemsOf = (p) => [{ c: -1, v: p }, ...Array.from({ length: k }, (_, c) => ({ c, v: solution[c][p] }))];

  for (let p = 0; p < n; p++) {
    const mine = itemsOf(p);
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) add({ t: "same", a: mine[i], b: mine[j] });
    }
    // Not mine: anything someone else holds.
    for (let q = 0; q < n; q++) {
      if (q === p) continue;
      const theirs = itemsOf(q);
      for (const x of mine) for (const y of theirs) {
        if (x.c === y.c || y.c < 0) continue;
        add({ t: "diff", a: x, b: y });
      }
    }
    // Either-or: one true and one false value of another category.
    for (const x of mine) {
      for (let c = 0; c < k; c++) {
        if (c === x.c) continue;
        const truth = solution[c][p];
        for (let v = 0; v < n; v++) {
          if (v === truth) continue;
          add({ t: "either", a: x, b: { c, v: Math.min(truth, v) }, b2: { c, v: Math.max(truth, v) } });
        }
      }
    }
  }
  for (let p = 0; p < n; p++) {
    for (let q = 0; q < n; q++) {
      if (p === q) continue;
      for (const x of itemsOf(p)) for (const y of itemsOf(q)) {
        if (x.c < 0 && y.c < 0) continue;
        if (p < q) add({ t: "left", a: x, b: y });
        if (Math.abs(p - q) === 1) add({ t: "next", a: x, b: y });
        if (p === q + 1) add({ t: "right", a: x, b: y });
      }
    }
  }
  return [...out.values()];
}

/**
 * Deal one puzzle. Same seed and size, same puzzle, everywhere.
 * @returns {{seed, preset, n, k, people: string[], cats: Array<{id, label, values}>, solution: number[][], clues: object[]}}
 */
export function generatePuzzle(seed, presetId = "easy") {
  const P = PRESETS[presetId] || PRESETS.easy;
  const rng = makeRng(hashSeed(`clues:${P.id}:${seed}`));
  const n = P.n, k = P.cats.length;

  const people = rng.shuffle([...NAMES]).slice(0, n);
  const cats = P.cats.map((id) => {
    const all = CATS[id].values;
    const idx = rng.shuffle(all.map((_, i) => i)).slice(0, n).sort((x, y) => x - y);
    return { id, label: CATS[id].label, values: idx.map((i) => all[i]) };
  });
  const solution = cats.map(() => rng.shuffle([...Array(n).keys()]));

  // A weighted shuffle: each clue's place in line depends on its kind's weight.
  const pool = truePool(n, k, solution, P.w).map((cl) => {
    const u = Math.max(1e-9, rng.next());
    return { cl, key: -Math.log(u) / P.w[clueKind(cl)] };
  }).sort((x, y) => x.key - y.key).map((x) => x.cl);

  const build = (maxDirect) => {
    const s = freshState(n, k);
    const chosen = [];
    let direct = 0;
    for (const cl of pool) {
      if (solvedState(s)) break;
      const isDirect = clueKind(cl) === "same";
      if (isDirect && direct >= maxDirect) continue;
      // Only take a clue that teaches something new at this point. The state is
      // already settled for the clues chosen so far, so a clue that changes
      // nothing on its own changes nothing at all.
      const trial = cloneState(s);
      if (!applyClue(trial, cl)) continue;
      propagate(trial, [...chosen, cl]);
      const before = s.cand.flat().reduce((x, m) => x + popcount(m), 0);
      const after = trial.cand.flat().reduce((x, m) => x + popcount(m), 0);
      if (after === before) continue;
      chosen.push(cl);
      if (isDirect) direct++;
      s.cand = trial.cand;
      s.bad = trial.bad;
    }
    return solvedState(s) ? chosen : null;
  };

  let chosen = build(P.maxDirect);
  if (!chosen) chosen = build(n * k);

  // Prune: drop any clue the others can manage without.
  const order = rng.shuffle(chosen.map((_, i) => i));
  const keep = new Set(chosen.map((_, i) => i));
  for (const i of order) {
    keep.delete(i);
    const rest = chosen.filter((_, j) => keep.has(j));
    if (!solveLogic(n, k, rest).done) keep.add(i);
  }
  const clues = rng.shuffle(chosen.filter((_, j) => keep.has(j)));

  return { seed: String(seed), preset: P.id, n, k, people, cats, solution, clues };
}

function popcount(m) {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
}

// ---------------------------------------------------------------------------
// daily
// ---------------------------------------------------------------------------

// Gentle at the start of the week, a proper workout on Sunday.
const WEEKDAY_PRESET = ["expert", "easy", "easy4", "medium", "medium", "hard", "hard"];

export function dailyPreset(date = new Date()) {
  return WEEKDAY_PRESET[date.getDay()];
}

export function dailyClueSeed(date = new Date()) {
  return "CLUES-" + dailySeedCode(date).slice("DAILY-".length);
}

/** Today's finished Daily puzzle, read from history (so it survives any merge). */
export function findDailyClues(history, date = new Date()) {
  const seed = dailyClueSeed(date);
  const hits = (history || []).filter((r) => r && r.mode === "sc-daily" && r.seed === seed);
  return hits.length ? hits[hits.length - 1] : null;
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

/**
 * The next thing logic can prove from the marks on the grid, and why.
 * A wrong mark is fixed first, because no deduction is safe on top of one.
 * @param grid {key: 1 (X) | 2 (check)}
 * @returns {{key, value: 0|1|2, clue: number|null, why: string, fix?: boolean, fallback?: boolean}|null}
 */
export function findHint(puzzle, grid) {
  const { n, k } = puzzle;
  const mark = (c, p, v) => grid[cellKey(c, p, v)] || 0;
  const name = (p) => puzzle.people[p];

  for (const [key, val] of Object.entries(grid)) {
    const kk = parseKey(key);
    if (!kk) continue;
    const truth = isTrue(puzzle, key);
    if (val === 1 && truth) {
      return { key, value: 0, clue: null, fix: true, why: `That X does not belong: ${name(kk.p)}'s rune could still ${predShort(puzzle, kk.c, kk.v)}. It is cleared.` };
    }
    if (val === 2 && !truth) {
      return { key, value: 1, clue: null, fix: true, why: `That check was wrong: ${cellText(puzzle, kk.c, kk.p, kk.v, false)}` };
    }
  }

  // The grid itself first: rows and columns.
  for (let c = 0; c < k; c++) {
    for (let p = 0; p < n; p++) {
      for (let v = 0; v < n; v++) {
        if (mark(c, p, v) !== 2) continue;
        for (let w = 0; w < n; w++) {
          if (w !== v && !mark(c, p, w)) {
            return { key: cellKey(c, p, w), value: 1, clue: null,
              why: `${name(p)}'s rune ${pred(puzzle, { c, v })}, so it cannot also ${predShort(puzzle, c, w)}.` };
          }
        }
        for (let q = 0; q < n; q++) {
          if (q !== p && !mark(c, q, v)) {
            return { key: cellKey(c, q, v), value: 1, clue: null,
              why: `${cap(noun(puzzle, { c, v }))} is ${name(p)}'s, so it is not ${name(q)}'s.` };
          }
        }
      }
    }
    for (let p = 0; p < n; p++) {
      const open = [];
      for (let v = 0; v < n; v++) if (mark(c, p, v) !== 1) open.push(v);
      if (open.length === 1 && mark(c, p, open[0]) === 0) {
        return { key: cellKey(c, p, open[0]), value: 2, clue: null,
          why: `Only one choice is left in ${name(p)}'s row: ${cellText(puzzle, c, p, open[0], true)}` };
      }
    }
    for (let v = 0; v < n; v++) {
      const open = [];
      for (let p = 0; p < n; p++) if (mark(c, p, v) !== 1) open.push(p);
      if (open.length === 1 && mark(c, open[0], v) === 0) {
        return { key: cellKey(c, open[0], v), value: 2, clue: null,
          why: `Nobody else can have ${noun(puzzle, { c, v })}: ${cellText(puzzle, c, open[0], v, true)}` };
      }
    }
  }

  // Then each clue on its own, on top of what the grid already shows.
  const s = freshState(n, k);
  for (let c = 0; c < k; c++) {
    for (let p = 0; p < n; p++) {
      for (let v = 0; v < n; v++) {
        const m = mark(c, p, v);
        if (m === 2) s.cand[c][p] = bit(v);
      }
      for (let v = 0; v < n; v++) if (mark(c, p, v) === 1) s.cand[c][p] &= ~bit(v);
    }
  }
  let best = null;
  puzzle.clues.forEach((cl, i) => {
    if (best && best.value === 2) return;
    const t = cloneState(s);
    applyClue(t, cl);
    if (t.bad) return;
    for (let c = 0; c < k && !(best && best.value === 2); c++) {
      for (let p = 0; p < n; p++) {
        const was = s.cand[c][p], now = t.cand[c][p];
        if (was === now) continue;
        if (single(now) && !mark(c, p, low(now))) {
          best = { key: cellKey(c, p, low(now)), value: 2, clue: i, why: `Clue ${i + 1} proves it: ${cellText(puzzle, c, p, low(now), true)}` };
          break;
        }
        if (!best) {
          for (let v = 0; v < n; v++) {
            if ((was & bit(v)) && !(now & bit(v)) && !mark(c, p, v)) {
              best = { key: cellKey(c, p, v), value: 1, clue: i, why: `Clue ${i + 1} proves it: ${cellText(puzzle, c, p, v, false)}` };
              break;
            }
          }
        }
      }
    }
  });
  if (best) return best;

  // Every dealt puzzle is solvable by the steps above, so this is only reached
  // on a finished grid - but never leave a player stuck.
  for (let c = 0; c < k; c++) {
    for (let p = 0; p < n; p++) {
      const v = puzzle.solution[c][p];
      if (mark(c, p, v) !== 2) {
        return { key: cellKey(c, p, v), value: 2, clue: null, fallback: true, why: `From the answer: ${cellText(puzzle, c, p, v, true)}` };
      }
    }
  }
  return null;
}

function predShort(puzzle, c, v) {
  const id = puzzle.cats[c].id;
  const val = valueOf(puzzle, c, v);
  if (id === "shape") return `be ${article(SHAPE_WORD[val])} ${SHAPE_WORD[val]}`;
  if (id === "colour") return `be ${COLOUR_WORD[val]}`;
  return `have ${val} dot${val === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// one puzzle being played
// ---------------------------------------------------------------------------

export class PuzzlePlay {
  /**
   * @param puzzle    from generatePuzzle
   * @param shields   wrong checks forgiven before they count
   * @param autoX     cross out the rest of the row and column on a check
   */
  constructor(puzzle, { shields = 0, autoX = true } = {}) {
    this.puzzle = puzzle;
    this.grid = {};
    this.mistakes = 0;
    this.forgiven = 0;
    this.hintsUsed = 0;
    this.shields = shields;
    this.autoX = autoX;
  }

  get total() { return this.puzzle.n * this.puzzle.k; }

  /** Checks placed on the right cells. */
  get placed() {
    let c = 0;
    for (const [key, v] of Object.entries(this.grid)) if (v === 2 && isTrue(this.puzzle, key)) c++;
    return c;
  }

  get solved() { return this.placed === this.total; }

  /** Tap a cell: blank, then X, then check, then blank again. */
  tap(key) {
    const cur = this.grid[key] || 0;
    return this.place(key, (cur + 1) % 3);
  }

  /**
   * Put a mark. A wrong check is never left on the grid: it counts as a
   * mistake (unless a shield forgives it) and settles as an X, since the
   * player now knows that cell is false.
   * @returns {{key, value, wrong, shielded, changed: object, solved}|null}
   */
  place(key, value) {
    if (!parseKey(key) || this.solved) return null;
    if (value === 2 && !isTrue(this.puzzle, key)) {
      let shielded = false;
      if (this.shields > 0) { this.shields--; this.forgiven++; shielded = true; } else this.mistakes++;
      this.grid[key] = 1;
      return { key, value: 1, wrong: true, shielded, changed: { [key]: 1 }, solved: false };
    }
    const changed = { [key]: value };
    if (value) this.grid[key] = value;
    else delete this.grid[key];
    if (value === 2 && this.autoX) Object.assign(changed, this._autoX(key));
    return { key, value, wrong: false, shielded: false, changed, solved: this.solved };
  }

  _autoX(key) {
    const { c, p, v } = parseKey(key);
    const out = {};
    for (let i = 0; i < this.puzzle.n; i++) {
      for (const kk of [cellKey(c, p, i), cellKey(c, i, v)]) {
        if (kk !== key && !this.grid[kk]) { this.grid[kk] = 1; out[kk] = 1; }
      }
    }
    return out;
  }

  /** Take marks from elsewhere (a friend in the same room). */
  applyRemote(grid) {
    this.grid = {};
    for (const [k, v] of Object.entries(grid || {})) if (parseKey(k) && (v === 1 || v === 2)) this.grid[k] = v;
  }

  /** Find and apply the next provable cell. */
  hint() {
    if (this.solved) return null;
    const h = findHint(this.puzzle, this.grid);
    if (!h) return null;
    this.hintsUsed++;
    const changed = { [h.key]: h.value };
    if (h.value) this.grid[h.key] = h.value;
    else delete this.grid[h.key];
    if (h.value === 2 && this.autoX) Object.assign(changed, this._autoX(h.key));
    return { ...h, changed, solved: this.solved };
  }
}

/** Points for a solve: the size, a bonus for pace, less for slips and hints. */
export function scorePuzzle(presetId, ms, mistakes = 0, hints = 0) {
  const P = PRESETS[presetId] || PRESETS.easy;
  const secs = Math.max(0, Math.round((ms || 0) / 1000));
  const raw = P.base + Math.max(0, P.par - secs) * 2 - 60 * mistakes - 90 * hints;
  return Math.max(Math.round(P.base * 0.2), Math.round(raw));
}

/** "3:07" */
export function clock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Who reads which clue in a room: dealt round-robin in seat order. */
export function cluesFor(clueCount, order, uid) {
  const seat = (order || []).indexOf(uid);
  if (seat < 0 || !order.length) return [];
  const out = [];
  for (let i = 0; i < clueCount; i++) if (i % order.length === seat) out.push(i);
  return out;
}

/** One history record for a solved puzzle. */
export function puzzleResult(play, { mode, ms, daily = false, playedAt = Date.now(), team = 0 } = {}) {
  const pz = play.puzzle;
  return {
    game: "clues",
    mode,
    seed: pz.seed,
    preset: pz.preset,
    n: pz.n,
    k: pz.k,
    clues: pz.clues.length,
    ms: Math.round(ms || 0),
    mistakes: play.mistakes,
    hints: play.hintsUsed,
    solved: play.solved,
    score: play.solved ? scorePuzzle(pz.preset, ms, play.mistakes, play.hintsUsed) : 0,
    daily,
    team,
    playedAt,
  };
}
