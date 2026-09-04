// The rule engine.
//
// A trial shows 5 tiles. A hidden rule decides which one is correct. The player
// is never told the rule - they infer it from green/red feedback. After a few
// correct answers the rule silently changes, and the player has to notice and
// re-learn.
//
// That combination (rule induction + set-shifting + suppressing the rule that
// just stopped working) is what the Wisconsin Card Sorting Task measures. It is
// a real cognitive-flexibility paradigm, not a reskinned n-back, and it gives us
// honest metrics: perseverative errors and adaptation latency.

export const SHAPES = ["circle", "square", "triangle", "diamond", "hex"];
export const COLORS = ["cyan", "amber", "magenta", "lime", "violet"];
export const MAX_PIPS = 5;
export const TILES_PER_TRIAL = 5;

/** Rules that need the previous target as context (memory load). */
const NEEDS_PREV = new Set(["MATCH_LAST_COLOR", "MATCH_LAST_SHAPE", "SHARES_NOTHING"]);

// Each rule carries two pieces of text with different jobs.
//
//   label  - a short, memorable name. This is what a player mutters to
//            themselves mid-game ("ah, lone colour"), so it has to be quick to
//            say and quick to recognise. Punchy beats descriptive here.
//   reveal - the full teaching explanation, in plain words, spelled out step by
//            step. This is where nothing is assumed and nothing is clever.
export const RULES = [
  {
    id: "MOST_PIPS",
    tier: 1,
    label: "Most dots",
    reveal:
      "Ignore the shapes and the colours completely - they are only there to distract you. Count the dots inside each of the five tiles. The tile holding the highest number of dots is the winner.",
  },
  {
    id: "FEWEST_PIPS",
    tier: 1,
    label: "Fewest dots",
    reveal:
      "The mirror image of Most dots, and easy to mix up with it. Again ignore shape and colour and just count the dots - but this time the winner is the tile with the smallest number of them.",
  },
  {
    id: "UNIQUE_COLOR",
    tier: 1,
    label: "Lone colour",
    reveal:
      "Forget dots and shapes and sort the five tiles into colour groups. Four of them pair up - two of one colour, two of another. Exactly one colour is left over with no partner. That lonely tile is the winner.",
  },
  {
    id: "UNIQUE_SHAPE",
    tier: 1,
    label: "Lone shape",
    reveal:
      "The same idea as Lone colour, but using shapes. Group the five tiles by shape. Four of them form two matching pairs, and one shape appears only once. That single unpaired tile wins.",
  },
  {
    id: "ODD_PARITY",
    tier: 2,
    label: "Odd count out",
    reveal:
      "This one is about even and odd numbers. Usually four tiles hold an even number of dots (2 or 4) and a single tile holds an odd number (1, 3 or 5) - that odd tile wins. It can also run the other way round, with four odd tiles and one even one. Either way, the winner is the tile whose dot count does not match the pattern of the rest.",
  },
  {
    id: "MATCH_LAST_COLOR",
    tier: 2,
    label: "Echo colour",
    reveal:
      "The first rule that asks you to remember something. Think back to the tile that won on the previous board and recall its colour. On this board, exactly one tile carries that same colour, and it is the winner. If you were not paying attention last turn, you are guessing.",
  },
  {
    id: "MATCH_LAST_SHAPE",
    tier: 3,
    label: "Echo shape",
    reveal:
      "Echo colour's twin. Remember the shape of the tile that won on the previous board - circle, square, triangle, diamond or six-sided. Exactly one tile on this board repeats that shape, and it wins.",
  },
  {
    id: "SHARES_NOTHING",
    tier: 3,
    label: "Strange one",
    reveal:
      "The hardest rule in the game, because it asks you to hold two things in mind at once. Remember both the colour and the shape of the previous winner. Four of the tiles in front of you copy at least one of those two - the same colour, or the same shape. Exactly one tile matches neither. That complete stranger is the winner.",
  },
];

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

export function rulesUpToTier(tier) {
  return RULES.filter((r) => r.tier <= tier);
}

export function ruleNeedsPrev(id) {
  return NEEDS_PREV.has(id);
}

// ---------------------------------------------------------------------------
// Evaluation: given a board, which tile does this rule select?
// Returns an index, or -1 if the rule is undefined on this board.
// ---------------------------------------------------------------------------

function soleIndexBy(tiles, keyFn) {
  const counts = new Map();
  tiles.forEach((t) => {
    const k = keyFn(t);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const singles = tiles
    .map((t, i) => i)
    .filter((i) => counts.get(keyFn(tiles[i])) === 1);
  return singles.length === 1 ? singles[0] : -1;
}

function soleExtreme(tiles, cmp) {
  let best = 0;
  for (let i = 1; i < tiles.length; i++) if (cmp(tiles[i].count, tiles[best].count)) best = i;
  const ties = tiles.filter((t) => t.count === tiles[best].count).length;
  return ties === 1 ? best : -1;
}

export function evaluateRule(ruleId, tiles, prev) {
  switch (ruleId) {
    case "MOST_PIPS":
      return soleExtreme(tiles, (a, b) => a > b);
    case "FEWEST_PIPS":
      return soleExtreme(tiles, (a, b) => a < b);
    case "UNIQUE_COLOR":
      return soleIndexBy(tiles, (t) => t.color);
    case "UNIQUE_SHAPE":
      return soleIndexBy(tiles, (t) => t.shape);
    case "ODD_PARITY":
      return soleIndexBy(tiles, (t) => t.count % 2);
    case "MATCH_LAST_COLOR": {
      if (!prev) return -1;
      const hits = tiles.map((t, i) => (t.color === prev.color ? i : -1)).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    }
    case "MATCH_LAST_SHAPE": {
      if (!prev) return -1;
      const hits = tiles.map((t, i) => (t.shape === prev.shape ? i : -1)).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    }
    case "SHARES_NOTHING": {
      if (!prev) return -1;
      const hits = tiles
        .map((t, i) => (t.color !== prev.color && t.shape !== prev.shape ? i : -1))
        .filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    }
    default:
      return -1;
  }
}

// ---------------------------------------------------------------------------
// Board generation.
//
// Rejection sampling: draw a random board, keep it only if the active rule has
// exactly one answer on it. `avoidIndex` lets the caller demand that the new
// rule's answer differs from the old rule's answer - without that, a rule change
// can be invisible, and an undetectable rule change is just an unfair death.
// ---------------------------------------------------------------------------

function randomTile(rng) {
  return {
    shape: rng.pick(SHAPES),
    color: rng.pick(COLORS),
    count: rng.range(1, MAX_PIPS),
  };
}

function randomBoard(rng) {
  return Array.from({ length: TILES_PER_TRIAL }, () => randomTile(rng));
}

/**
 * @param {object} rng
 * @param {string} ruleId          rule in force for this trial
 * @param {object|null} prev       previous correct tile (context for echo rules)
 * @param {string|null} avoidRule  rule whose answer the new answer must differ from
 * @returns {{tiles: array, target: number}}
 */
export function generateTrial(rng, ruleId, prev, avoidRule = null) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const tiles = randomBoard(rng);
    const target = evaluateRule(ruleId, tiles, prev);
    if (target < 0) continue;

    if (avoidRule && avoidRule !== ruleId) {
      const old = evaluateRule(avoidRule, tiles, prev);
      // If the old rule still points at the same tile, the switch is invisible.
      if (old === target) continue;
      // Prefer boards where the old rule is still *defined* - that is what makes
      // a perseverative error possible, and therefore measurable.
      if (old < 0 && attempt < 200) continue;
    }
    return { tiles, target };
  }

  // Constructive fallback so generation can never hang or fail.
  return constructTrial(rng, ruleId, prev);
}

function constructTrial(rng, ruleId, prev) {
  const tiles = randomBoard(rng);
  const t = rng.int(TILES_PER_TRIAL);

  switch (ruleId) {
    case "MOST_PIPS":
      tiles.forEach((x) => (x.count = rng.range(1, MAX_PIPS - 1)));
      tiles[t].count = MAX_PIPS;
      break;
    case "FEWEST_PIPS":
      tiles.forEach((x) => (x.count = rng.range(2, MAX_PIPS)));
      tiles[t].count = 1;
      break;
    case "UNIQUE_COLOR": {
      const pool = rng.shuffle([...COLORS]);
      tiles.forEach((x, i) => (x.color = pool[1 + (i % 2)]));
      tiles[t].color = pool[0];
      break;
    }
    case "UNIQUE_SHAPE": {
      const pool = rng.shuffle([...SHAPES]);
      tiles.forEach((x, i) => (x.shape = pool[1 + (i % 2)]));
      tiles[t].shape = pool[0];
      break;
    }
    case "ODD_PARITY": {
      const even = [2, 4];
      tiles.forEach((x) => (x.count = rng.pick(even)));
      tiles[t].count = rng.pick([1, 3, 5]);
      break;
    }
    case "MATCH_LAST_COLOR": {
      const others = COLORS.filter((c) => c !== (prev && prev.color));
      tiles.forEach((x) => (x.color = rng.pick(others)));
      tiles[t].color = prev ? prev.color : COLORS[0];
      break;
    }
    case "MATCH_LAST_SHAPE": {
      const others = SHAPES.filter((s) => s !== (prev && prev.shape));
      tiles.forEach((x) => (x.shape = rng.pick(others)));
      tiles[t].shape = prev ? prev.shape : SHAPES[0];
      break;
    }
    case "SHARES_NOTHING": {
      const pc = prev ? prev.color : COLORS[0];
      const ps = prev ? prev.shape : SHAPES[0];
      // Every non-target tile shares at least one attribute with prev.
      tiles.forEach((x) => {
        if (rng.next() < 0.5) x.color = pc;
        else x.shape = ps;
      });
      tiles[t].color = rng.pick(COLORS.filter((c) => c !== pc));
      tiles[t].shape = rng.pick(SHAPES.filter((s) => s !== ps));
      break;
    }
  }

  const target = evaluateRule(ruleId, tiles, prev);
  return { tiles, target: target >= 0 ? target : t };
}

/**
 * What every rule would have answered on this board. Used to classify errors:
 * a wrong tap that matches the *previous* rule is a perseverative error - the
 * single most informative mistake in the whole game.
 */
export function answerMap(tiles, prev, ruleIds) {
  const map = {};
  for (const id of ruleIds) map[id] = evaluateRule(id, tiles, prev);
  return map;
}
