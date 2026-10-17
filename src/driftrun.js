// Drift Run - a short roguelite descent.
//
// A run is a seeded map of three acts. Each act is three steps of "left or
// right" (an ordinary chamber, a faster elite chamber, or a campfire) and then
// a boss whose rules need two attributes at once. Hearts carry across the whole
// run; perks are picked after elites, bosses and at campfires.
//
// Pure logic, like engine.js: no DOM, no timers. Every room is its own Game,
// seeded by the run seed plus the room's id, so the choice of path can never
// change what any other room deals you - and the same seed is the same run for
// everyone, which is what makes the Daily Run fair.

import { Game, buildResult } from "./engine.js";
import { makeRng, hashSeed, dailySeedCode } from "./rng.js";
import { rulesUpToTier, ruleFamilies } from "./rules.js";

export const STEPS_PER_ACT = 3;
export const START_HEARTS = 3;
export const MAX_HEARTS = 5;

export const ACTS = [
  { name: "The Shallows", tier: 1, timeMs: Infinity, boss: ["BOSS_DOUBLE_LONER"] },
  { name: "The Undertow", tier: 2, timeMs: 15000, boss: ["BOSS_RICH_TWIN", "BOSS_DOUBLE_LONER"] },
  { name: "The Deep", tier: 3, timeMs: 10000, boss: ["BOSS_HUMBLE_LONER", "BOSS_RICH_TWIN", "BOSS_DOUBLE_LONER"] },
];

export const NODE_TYPES = {
  room: { label: "Chamber", blurb: "Four right answers to pass.", goal: 4, runMin: 3, runMax: 5, bonus: 150 },
  elite: { label: "Elite", blurb: "The rule turns every two or three. A perk if you pass.", goal: 5, runMin: 2, runMax: 3, bonus: 300, timeScale: 0.75 },
  rest: { label: "Campfire", blurb: "Rest and choose a perk.", bonus: 0 },
  boss: { label: "Boss", blurb: "Rules that need two things at once.", goal: 6, runMin: 3, runMax: 4, bonus: 600 },
};

export const PERKS = {
  heart: { label: "Extra heart", blurb: "One more heart, and it starts full." },
  mend: { label: "Mend", blurb: "Restore two lost hearts." },
  slow: { label: "Slow clock", blurb: "Every clock in this run runs half as fast again." },
  peek: { label: "Peek", blurb: "Once, see what the secret looks at - dots, colour or shape." },
  shield: { label: "Shield", blurb: "Forgives one mistake made by sticking to the old rule." },
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
  const hits = (history || []).filter((r) => r && r.mode === "run" && r.seed === seed);
  return hits.length ? hits[hits.length - 1] : null;
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
    this.mode = "run";
    this.map = buildRunMap(seed);
    this.act = 0;
    this.step = 0;
    this.hearts = START_HEARTS;
    this.maxHearts = START_HEARTS;
    this.perks = { slow: false, peek: 0, shield: 0 };
    this.taken = [];
    this.peeksUsed = 0;
    this.score = 0;
    this.cleared = 0;
    this.path = [];
    this.games = [];
    this.node = null;
    this.game = null;
    this.perkOffer = null;
    this.lastBonus = 0;
    this.bossesBeaten = 0;
    this.won = false;
    this.over = false;
    this.phase = "map"; // map | room | perk | over | won
  }

  get length() { return this.map.length; }
  get depth() { return this.cleared; }
  get trial() { return this.game ? this.game.trial : null; }

  /** The nodes you can step onto right now. */
  options() {
    if (this.phase !== "map") return [];
    const a = this.map.acts[this.act];
    return this.step < STEPS_PER_ACT ? a.steps[this.step] : [a.boss];
  }

  enter(nodeId) {
    const node = this.options().find((n) => n.id === nodeId);
    if (!node) return null;
    this.node = node;
    this.path.push(node.id);
    if (node.type === "rest") {
      this.phase = "perk";
      this.perkOffer = this._offer(node, true);
      return node;
    }
    const act = ACTS[node.act];
    const kind = NODE_TYPES[node.type];
    const base = rulesUpToTier(act.tier).map((r) => r.id);
    const bossIds = node.type === "boss" ? act.boss : null;
    const raw = act.timeMs * (kind.timeScale || 1) * (this.perks.slow ? 1.5 : 1);
    this.game = new Game({
      seed: `${this.seed}:${node.id}`,
      mode: "run",
      pool: bossIds ? [...base, ...bossIds] : base,
      runMin: kind.runMin,
      runMax: kind.runMax,
      lives: this.hearts,
      maxLives: this.maxHearts,
      timeLimitMs: isFinite(raw) ? Math.round(raw) : Infinity,
      shields: this.perks.shield,
      goal: kind.goal,
      freeFirst: true,
      firstRule: bossIds ? bossIds[0] : null,
      alternate: bossIds,
    });
    this.phase = "room";
    return node;
  }

  /** Correct answers still needed to clear the current room. */
  get roomLeft() {
    return this.game ? Math.max(0, this.game.goal - this.game.correctCount) : 0;
  }

  answer(index, rtMs) {
    if (this.phase !== "room" || !this.game) return null;
    const g = this.game;
    const before = g.score;
    const rec = g.answer(index, rtMs);
    if (!rec) return null;
    this.score += g.score - before;
    this.hearts = g.lives;
    this.perks.shield = g.shields;
    if (g.over) this._finishNode();
    return rec;
  }

  timeout() {
    return this.game ? this.answer(-1, this.game.timeLimitMs) : null;
  }

  /** Spend a peek: which attributes the current secret looks at. Never the rule. */
  usePeek() {
    if (this.phase !== "room" || !this.game || this.perks.peek <= 0) return null;
    this.perks.peek--;
    this.peeksUsed++;
    return ruleFamilies(this.game.currentRule);
  }

  _finishNode() {
    const g = this.game;
    this.games.push(g);
    this.lastBonus = 0;
    if (!g.cleared) {
      this.over = true;
      this.phase = "over";
      return;
    }
    this.cleared++;
    const node = this.node;
    this.lastBonus = NODE_TYPES[node.type].bonus * (node.act + 1);
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
    const pool = ["peek", "shield", "hoard"];
    if (this.maxHearts < MAX_HEARTS) pool.push("heart");
    if (!this.perks.slow) pool.push("slow");
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
      this.perks.slow = true;
    } else if (id === "peek") {
      this.perks.peek++;
    } else if (id === "shield") {
      this.perks.shield++;
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
    this.game = null;
    if (this.step < STEPS_PER_ACT) this.step++;
    else {
      this.act++;
      this.step = 0;
    }
    this.phase = "map";
  }

  /** One history record for the whole run, in the same shape as every other mode. */
  result() {
    const trials = [];
    for (const g of this.games) for (const t of g.trials) trials.push({ ...t, n: trials.length + 1 });
    const pseudo = {
      trials,
      seed: this.seed,
      mode: "run",
      score: this.score,
      level: this.cleared,
      maxStreak: this.games.reduce((m, g) => Math.max(m, g.maxStreak), 0),
      ruleChanges: this.games.reduce((s, g) => s + g.ruleChanges, 0),
    };
    const r = buildResult(pseudo);
    return {
      ...r,
      depth: this.cleared,
      length: this.map.length,
      actReached: Math.min(ACTS.length, this.act + 1),
      won: this.won,
      bossesBeaten: this.bossesBeaten,
      perks: [...this.taken],
      peeksUsed: this.peeksUsed,
      daily: this.daily,
      path: [...this.path],
      hearts: this.hearts,
    };
  }
}
