// Drift Run - a short roguelite descent through Split Clues puzzles.
//
// A run is a seeded map of three acts. Each act is three steps of "left or
// right" (an ordinary chamber, a timed elite chamber, or a campfire) and then
// a boss: the biggest grid of the act. Hearts carry across the whole run and a
// wrong check costs one; perks are picked after elites, bosses and at
// campfires.
//
// Pure logic, like clues.js: no DOM, no timers. Every room is its own puzzle,
// seeded by the run seed plus the room's id, so the choice of path can never
// change what any other room deals you - and the same seed is the same run for
// everyone, which is what makes the Daily Run fair. Time is passed in by the
// caller, so tests can play a run with a fake clock.

import { makeRng, hashSeed, dailySeedCode } from "./rng.js";
import { generatePuzzle, PuzzlePlay, PRESETS, scorePuzzle } from "./clues.js";

export const STEPS_PER_ACT = 3;
export const START_HEARTS = 3;
export const MAX_HEARTS = 5;
export const START_HINTS = 1;

// Which puzzle each kind of room deals, act by act.
export const ACTS = [
  { name: "The Shallows", room: "easy", elite: "easy4", boss: "medium" },
  { name: "The Undertow", room: "easy4", elite: "medium", boss: "hard" },
  { name: "The Deep", room: "medium", elite: "hard", boss: "expert" },
];

// Elite clocks, by puzzle size.
export const ELITE_MS = { easy: 75000, easy4: 150000, medium: 240000, hard: 360000, expert: 540000 };

export const NODE_TYPES = {
  room: { label: "Chamber", blurb: "A puzzle. Solve it to go on.", bonus: 150 },
  elite: { label: "Elite", blurb: "A bigger puzzle against the clock. A perk if you pass.", bonus: 300 },
  rest: { label: "Campfire", blurb: "Rest and choose a perk.", bonus: 0 },
  boss: { label: "Boss", blurb: "The biggest grid of the act.", bonus: 600 },
};

export const PERKS = {
  heart: { label: "Extra heart", blurb: "One more heart, and it starts full." },
  mend: { label: "Mend", blurb: "Restore two lost hearts." },
  slow: { label: "Slow clock", blurb: "Elite clocks give you half as long again." },
  lantern: { label: "Lantern", blurb: "Two more hints for this run." },
  shield: { label: "Shield", blurb: "Forgives one wrong check." },
  hoard: { label: "Ember hoard", blurb: "Bank 400 points for every act you have reached." },
};

/** Same for everyone on the same local day, like the Daily. */
export function dailyRunSeed(date = new Date()) {
  return "RUN-" + dailySeedCode(date).slice("DAILY-".length);
}

export function isDailyRunSeed(seed) {
  return /^RUN-\d{8}$/.test(String(seed || ""));
}

/** Today's finished Daily Run, read from history (so it survives any merge). */
export function findDailyRun(history, date = new Date()) {
  const seed = dailyRunSeed(date);
  const hits = (history || []).filter((r) => r && r.mode === "sc-run" && r.seed === seed);
  return hits.length ? hits[hits.length - 1] : null;
}

/** The puzzle size a node deals. */
export function presetFor(node) {
  if (node.type === "rest") return null;
  return ACTS[node.act][node.type];
}

/**
 * The map. Only the run seed decides it.
 * @returns {{seed: string, length: number, acts: Array<{index:number, name:string, steps:Array<Array<object>>, boss:object}>}}
 */
export function buildRunMap(seed) {
  const rng = makeRng(hashSeed(seed + ":map"));
  const acts = ACTS.map((a, ai) => {
    let restUsed = false;
    const steps = [];
    for (let si = 0; si < STEPS_PER_ACT; si++) {
      let pair;
      if (ai === 0 && si === 0) pair = ["room", "elite"];
      else if (si === STEPS_PER_ACT - 1 && !restUsed) pair = rng.pick([["room", "rest"], ["elite", "rest"]]);
      else if (restUsed) pair = ["room", "elite"];
      else pair = rng.pick([["room", "elite"], ["room", "rest"], ["elite", "rest"], ["room", "elite"]]);
      if (pair.includes("rest")) restUsed = true;
      if (rng.next() < 0.5) pair = [pair[1], pair[0]];
      steps.push(pair.map((type, lane) => ({ id: `a${ai}s${si}l${lane}`, act: ai, step: si, lane, type })));
    }
    return {
      index: ai, name: a.name, steps,
      boss: { id: `a${ai}b`, act: ai, step: STEPS_PER_ACT, lane: 0, type: "boss" },
    };
  });
  return { seed, acts, length: ACTS.length * (STEPS_PER_ACT + 1) };
}

export class DriftRun {
  constructor({ seed, daily = false }) {
    this.seed = seed;
    this.daily = daily;
    this.mode = "sc-run";
    this.map = buildRunMap(seed);
    this.act = 0;
    this.step = 0;
    this.hearts = START_HEARTS;
    this.maxHearts = START_HEARTS;
    this.hints = START_HINTS;
    this.shields = 0;
    this.slow = false;
    this.taken = [];
    this.score = 0;
    this.cleared = 0;
    this.rooms = 0;
    this.cleanRooms = 0;
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.ms = 0;
    this.path = [];
    this.node = null;
    this.play = null;
    this.timeLimitMs = Infinity;
    this.timedOut = false;
    this.roomStart = 0;
    this.perkOffer = null;
    this.lastBonus = 0;
    this.bossesBeaten = 0;
    this.won = false;
    this.over = false;
    this.phase = "map"; // map | room | perk | over | won
  }

  get length() { return this.map.length; }
  get depth() { return this.cleared; }

  /** The nodes you can step onto right now. */
  options() {
    if (this.phase !== "map") return [];
    const a = this.map.acts[this.act];
    return this.step < STEPS_PER_ACT ? a.steps[this.step] : [a.boss];
  }

  enter(nodeId, now = 0) {
    const node = this.options().find((n) => n.id === nodeId);
    if (!node) return null;
    this.node = node;
    this.path.push(node.id);
    if (node.type === "rest") {
      this.phase = "perk";
      this.perkOffer = this._offer(node, true);
      return node;
    }
    const preset = presetFor(node);
    this.play = new PuzzlePlay(generatePuzzle(`${this.seed}:${node.id}`, preset), { shields: this.shields });
    this.timeLimitMs = node.type === "elite" ? Math.round(ELITE_MS[preset] * (this.slow ? 1.5 : 1)) : Infinity;
    this.timedOut = false;
    this.roomStart = now;
    this.phase = "room";
    return node;
  }

  /** Is the room's clock still running? */
  get timed() {
    return this.phase === "room" && isFinite(this.timeLimitMs) && !this.timedOut;
  }

  /** Tap a cell in the current room. A wrong check costs a heart unless a shield takes it. */
  tap(key, now = 0) {
    if (this.phase !== "room" || !this.play) return null;
    const rec = this.play.tap(key);
    if (!rec) return null;
    this.shields = this.play.shields;
    if (rec.wrong && !rec.shielded) this.hearts--;
    this._settle(now);
    return rec;
  }

  /** Spend a hint, if there is one to spend. */
  hint(now = 0) {
    if (this.phase !== "room" || !this.play || this.hints <= 0) return null;
    const h = this.play.hint();
    if (!h) return null;
    this.hints--;
    this.hintsUsed++;
    this._settle(now);
    return h;
  }

  /** The elite clock ran out: one heart, and the room goes on without a clock. */
  timeout(now = 0) {
    if (!this.timed) return false;
    this.timedOut = true;
    this.hearts--;
    this._settle(now);
    return true;
  }

  _settle(now) {
    if (this.hearts <= 0) {
      this.hearts = 0;
      this._finishNode(now, false);
    } else if (this.play && this.play.solved) {
      this._finishNode(now, true);
    }
  }

  _finishNode(now, cleared) {
    const p = this.play;
    const ms = Math.max(0, now - this.roomStart);
    this.ms += ms;
    this.mistakes += p.mistakes;
    this.lastBonus = 0;
    if (!cleared) {
      this.over = true;
      this.phase = "over";
      return;
    }
    this.cleared++;
    this.rooms++;
    if (!p.mistakes && !p.hintsUsed) this.cleanRooms++;
    const node = this.node;
    const elitePaid = node.type !== "elite" || !this.timedOut;
    this.lastBonus = (elitePaid ? NODE_TYPES[node.type].bonus : Math.round(NODE_TYPES[node.type].bonus / 2)) * (node.act + 1)
      + scorePuzzle(p.puzzle.preset, ms, p.mistakes, p.hintsUsed);
    this.score += this.lastBonus;
    if (node.type === "boss") {
      this.bossesBeaten++;
      this.hearts = Math.min(this.maxHearts, this.hearts + 1);
      if (this.act === ACTS.length - 1) {
        const winBonus = 1000 + this.hearts * 250;
        this.lastBonus += winBonus;
        this.score += winBonus;
        this.won = true;
        this.over = true;
        this.phase = "won";
        return;
      }
      this.phase = "perk";
      this.perkOffer = this._offer(node, false);
    } else if (node.type === "elite") {
      this.phase = "perk";
      this.perkOffer = this._offer(node, false);
    } else {
      this._advance();
    }
  }

  _offer(node, rest) {
    const rng = makeRng(hashSeed(`${this.seed}:${node.id}:perk`));
    const hurt = this.hearts < this.maxHearts;
    const pool = ["lantern", "shield", "hoard"];
    if (this.maxHearts < MAX_HEARTS) pool.push("heart");
    if (!this.slow) pool.push("slow");
    if (hurt) pool.push("mend");
    const picks = rng.shuffle(pool).slice(0, 3);
    // A campfire always lets a hurt player heal.
    if (rest && hurt && !picks.includes("mend")) picks[picks.length - 1] = "mend";
    return picks;
  }

  pickPerk(id) {
    if (this.phase !== "perk" || !this.perkOffer || !this.perkOffer.includes(id)) return false;
    if (id === "heart") {
      this.maxHearts = Math.min(MAX_HEARTS, this.maxHearts + 1);
      this.hearts = Math.min(this.maxHearts, this.hearts + 1);
    } else if (id === "mend") {
      this.hearts = Math.min(this.maxHearts, this.hearts + 2);
    } else if (id === "slow") {
      this.slow = true;
    } else if (id === "lantern") {
      this.hints += 2;
    } else if (id === "shield") {
      this.shields++;
    } else if (id === "hoard") {
      this.score += 400 * (this.act + 1);
    }
    this.taken.push(id);
    if (this.node && this.node.type === "rest") this.cleared++;
    this._advance();
    return true;
  }

  _advance() {
    this.perkOffer = null;
    this.node = null;
    this.play = null;
    this.timeLimitMs = Infinity;
    this.timedOut = false;
    if (this.step < STEPS_PER_ACT) this.step++;
    else {
      this.act++;
      this.step = 0;
    }
    this.phase = "map";
  }

  /** One history record for the whole run. */
  result(playedAt = Date.now()) {
    return {
      game: "clues",
      mode: "sc-run",
      seed: this.seed,
      score: this.score,
      depth: this.cleared,
      length: this.map.length,
      actReached: Math.min(ACTS.length, this.act + 1),
      won: this.won,
      bossesBeaten: this.bossesBeaten,
      rooms: this.rooms,
      cleanRooms: this.cleanRooms,
      mistakes: this.mistakes,
      hints: this.hintsUsed,
      ms: Math.round(this.ms),
      perks: [...this.taken],
      daily: this.daily,
      path: [...this.path],
      hearts: this.hearts,
      solved: this.won,
      playedAt,
    };
  }
}

export { PRESETS };
