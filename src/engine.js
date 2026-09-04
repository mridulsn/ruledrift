// Game state machine + scoring + metrics.
//
// Pure logic: no DOM, no canvas, no timers. The UI drives it by calling
// answer() / timeout() and reading state. That keeps it unit-testable and
// portable if this is ever ported to Flutter for a store build.

import { makeRng, hashSeed } from "./rng.js";
import { RULES, RULE_BY_ID, generateTrial, answerMap, ruleNeedsPrev, rulesUpToTier } from "./rules.js";

const TRIALS_PER_LEVEL = 6;

// The clock does not exist until the player has clearly understood the game.
// Time pressure while you are still forming a hypothesis is the wrong kind of
// difficulty - it stops being a thinking game and becomes a reaction game, and
// a beginner learns nothing under it. So: no clock at all for the first nine
// levels, then it arrives generously and tightens from there.
export const TIMER_START_LEVEL = 10;
export const TIMER_START_MS = 20000;
const TIME_FALLOFF = 0.86;   // per level after it appears
const MIN_TIME_MS = 1700;

/**
 * Modes. Each is a different answer to "what is uncomfortable here?" - the clock,
 * the rule changes, or nothing at all. Zen exists because a timer turns a thinking
 * game into a reaction game, and some people want to actually think.
 */
export const MODES = {
  daily: {
    id: "daily", label: "Daily", blurb: "One board a day. Same for everyone.",
    lives: 3, timed: true, runMin: 4, runMax: 7,
  },
  quick: {
    id: "quick", label: "Quick play", blurb: "A fresh random board. No clock until level 10.",
    lives: 3, timed: true, runMin: 4, runMax: 7,
  },
  zen: {
    id: "zen", label: "Zen", blurb: "No clock, ever. Think as long as you like.",
    lives: 5, timed: false, runMin: 4, runMax: 7,
  },
  blitz: {
    id: "blitz", label: "Blitz", blurb: "Clock from the very first board.",
    lives: 3, timed: true, runMin: 4, runMax: 7,
    timerStartLevel: 1, timerStartMs: 6500,
  },
  gauntlet: {
    id: "gauntlet", label: "Gauntlet", blurb: "The rule changes every three.",
    lives: 3, timed: true, runMin: 3, runMax: 3,
  },
  duel: {
    id: "duel", label: "Duel", blurb: "The exact board your friend played.",
    lives: 3, timed: true, runMin: 4, runMax: 7,
  },
};

export function modeConfig(id) {
  return MODES[id] || MODES.quick;
}

/** The level at which this mode's clock first appears. */
export function timerStartLevel(mode = "quick") {
  const cfg = modeConfig(mode);
  if (!cfg.timed) return Infinity;
  return cfg.timerStartLevel || TIMER_START_LEVEL;
}

/**
 * Infinity means "no clock on this board".
 *
 * Once the clock does arrive it starts at a deliberately generous 20 seconds and
 * then falls off proportionally, so it tightens quickly enough to stay exciting
 * without ever snapping from comfortable to impossible.
 */
export function timeLimitForLevel(level, mode = "quick") {
  const cfg = modeConfig(mode);
  const start = timerStartLevel(mode);
  if (!isFinite(start) || level < start) return Infinity;
  const startMs = cfg.timerStartMs || TIMER_START_MS;
  const ms = startMs * Math.pow(TIME_FALLOFF, level - start);
  return Math.round(Math.max(MIN_TIME_MS, ms));
}

export class Game {
  /**
   * @param {object} opts
   * @param {string} opts.seed      seed code - identical seed means identical game
   * @param {string} opts.mode      key of MODES
   * @param {number} opts.maxTier   highest rule tier unlocked (1..3)
   */
  constructor({ seed, mode = "quick", maxTier = 1 }) {
    this.seed = seed;
    this.mode = mode;
    this.cfg = modeConfig(mode);
    this.maxLives = this.cfg.lives;
    this.maxTier = Math.max(1, Math.min(3, maxTier));
    this.rng = makeRng(hashSeed(seed));
    this.pool = rulesUpToTier(this.maxTier).map((r) => r.id);

    this.lives = this.maxLives;
    this.score = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.correctCount = 0;
    this.trials = [];
    this.over = false;

    this.prevTarget = null;      // previous correct tile, context for echo rules
    this.currentRule = null;
    this.previousRule = null;
    this.correctSinceSwitch = 0;
    this.runTarget = 0;
    this.trialsSinceSwitch = 0;
    this.ruleChanges = 0;

    this._pickRule(true);
    this.trial = this._nextTrial();
  }

  get level() {
    return Math.floor(this.correctCount / TRIALS_PER_LEVEL) + 1;
  }

  get timeLimitMs() {
    return timeLimitForLevel(this.level, this.mode);
  }

  /** Whether THIS board has a clock - it depends on the level, not just the mode. */
  get timed() {
    return isFinite(this.timeLimitMs);
  }

  /** True on the board where the clock first appears, so the UI can announce it. */
  get clockJustStarted() {
    return this.timed && this.level === timerStartLevel(this.mode) &&
      this.correctCount % TRIALS_PER_LEVEL === 0;
  }

  _eligibleRules() {
    // Echo rules need a previous correct tile to refer to.
    return this.pool.filter((id) => !ruleNeedsPrev(id) || this.prevTarget);
  }

  _pickRule(first = false) {
    const eligible = this._eligibleRules().filter((id) => id !== this.currentRule);
    const choices = eligible.length ? eligible : this._eligibleRules();
    this.previousRule = first ? null : this.currentRule;
    this.currentRule = this.rng.pick(choices);
    this.correctSinceSwitch = 0;
    this.trialsSinceSwitch = 0;
    this.runTarget = this.rng.range(this.cfg.runMin, this.cfg.runMax);
    if (!first) this.ruleChanges++;
  }

  _nextTrial() {
    const isSwitchTrial = this.trialsSinceSwitch === 0 && this.previousRule !== null;
    const avoid = isSwitchTrial ? this.previousRule : null;
    const { tiles, target } = generateTrial(this.rng, this.currentRule, this.prevTarget, avoid);
    return {
      tiles,
      target,
      rule: this.currentRule,
      isSwitchTrial,
      answers: answerMap(tiles, this.prevTarget, this.pool),
      startedAt: null,
    };
  }

  /** Called by the UI the moment the board becomes visible. */
  markShown(now) {
    if (this.trial) this.trial.startedAt = now;
  }

  /**
   * @param {number} index  tile tapped, or -1 for a timeout
   * @param {number} rtMs   reaction time in ms
   */
  answer(index, rtMs) {
    if (this.over || !this.trial) return null;

    const t = this.trial;
    const timedOut = index < 0;
    const correct = !timedOut && index === t.target;

    // A perseverative error is a wrong tap that would have been *right* under
    // the rule that just stopped applying. It is the signature of a player whose
    // attention is stuck on the old rule - the thing this game actually trains.
    const perseverative =
      !correct &&
      !timedOut &&
      this.previousRule != null &&
      t.answers[this.previousRule] === index &&
      t.answers[this.previousRule] >= 0;

    // You cannot possibly know a rule you have never seen, so the very first
    // board after a silent change is a free look: it breaks your streak and it
    // still counts in your adaptation score, but it does not cost a life.
    // Without this, every rule change costs a life, three lives cap a run at
    // roughly level 3, and everything built for later levels is dead content.
    const freeLook = !correct && t.isSwitchTrial && !timedOut;

    let gained = 0;
    if (correct) {
      const limit = this.timed ? this.timeLimitMs : 6000;
      const speedFrac = Math.max(0, 1 - rtMs / limit);
      const speedBonus = Math.round(120 * speedFrac);
      const mult = Math.min(3, 1 + this.streak * 0.1);
      // Getting the first one right straight after a silent rule change is the
      // hardest thing in the game, so it pays the most.
      const adaptBonus = t.isSwitchTrial ? 250 : 0;
      gained = Math.round((100 + speedBonus + adaptBonus) * mult);

      this.score += gained;
      this.streak++;
      this.maxStreak = Math.max(this.maxStreak, this.streak);
      this.correctCount++;
      this.correctSinceSwitch++;
      this.prevTarget = { ...t.tiles[t.target] };
    } else {
      this.streak = 0;
      if (!freeLook) this.lives--;
    }

    this.trials.push({
      freeLook,
      n: this.trials.length + 1,
      rule: t.rule,
      previousRule: this.previousRule,
      isSwitchTrial: t.isSwitchTrial,
      trialsSinceSwitch: this.trialsSinceSwitch,
      chosen: index,
      target: t.target,
      correct,
      timedOut,
      perseverative,
      rtMs: Math.round(rtMs),
      gained,
      level: this.level,
    });

    this.trialsSinceSwitch++;

    if (this.lives <= 0) {
      this.over = true;
      this.trial = null;
      return this.trials[this.trials.length - 1];
    }

    if (this.correctSinceSwitch >= this.runTarget) this._pickRule();

    this.trial = this._nextTrial();
    return this.trials[this.trials.length - 1];
  }

  timeout() {
    return this.answer(-1, this.timeLimitMs);
  }

  result() {
    return buildResult(this);
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/**
 * Adaptation latency: after each silent rule change, how many trials until the
 * player locks onto the new rule (first correct answer). Lower is sharper.
 */
function adaptationLatencies(trials) {
  const out = [];
  let pending = null;
  for (const t of trials) {
    if (t.isSwitchTrial) pending = 0;
    if (pending !== null) {
      pending++;
      if (t.correct) {
        out.push(pending);
        pending = null;
      }
    }
  }
  return out;
}

function scale(value, best, worst) {
  // Map a raw value onto 0..100 where `best` scores 100 and `worst` scores 0.
  if (best === worst) return 50;
  const f = (worst - value) / (worst - best);
  return Math.round(Math.max(0, Math.min(1, f)) * 100);
}

export function buildResult(game) {
  const trials = game.trials;
  const correct = trials.filter((t) => t.correct);
  const wrong = trials.filter((t) => !t.correct && !t.timedOut);
  const rts = correct.map((t) => t.rtMs);
  const lat = adaptationLatencies(trials);
  const persev = trials.filter((t) => t.perseverative).length;

  const accuracy = trials.length ? correct.length / trials.length : 0;
  const meanRt = Math.round(mean(rts));
  const rtSd = Math.round(stdev(rts));
  const meanLatency = lat.length ? +mean(lat).toFixed(2) : null;
  const persevRate = wrong.length ? persev / wrong.length : 0;

  // Accuracy on the three trials immediately after each silent change - how fast
  // the player forms a new hypothesis rather than guessing.
  const postSwitch = trials.filter((t) => t.trialsSinceSwitch < 3 && game.ruleChanges > 0);
  const induction = postSwitch.length
    ? postSwitch.filter((t) => t.correct).length / postSwitch.length
    : accuracy;

  const cv = meanRt ? rtSd / meanRt : 0;

  // Per-rule tallies, so the codex can show real accuracy per rule rather than
  // smearing the session average across every rule that appeared.
  const byRule = {};
  for (const t of trials) {
    const r = (byRule[t.rule] = byRule[t.rule] || { seen: 0, correct: 0 });
    r.seen++;
    if (t.correct) r.correct++;
  }

  const domains = {
    speed: scale(meanRt || 4000, 900, 3800),
    flexibility: meanLatency === null ? null : scale(meanLatency, 1, 6),
    inhibition: scale(persevRate, 0, 0.7),
    induction: scale(1 - induction, 0, 0.85),
    consistency: scale(cv, 0.12, 0.75),
  };

  const scored = Object.values(domains).filter((v) => v !== null);
  const brainScore = scored.length ? Math.round(mean(scored)) : 0;

  return {
    seed: game.seed,
    mode: game.mode,
    playedAt: Date.now(),
    score: game.score,
    level: game.level,
    trials: trials.length,
    correct: correct.length,
    accuracy: +accuracy.toFixed(4),
    maxStreak: game.maxStreak,
    ruleChanges: game.ruleChanges,
    adaptations: lat.length,
    meanRt,
    rtSd,
    meanAdaptationLatency: meanLatency,
    perseverativeErrors: persev,
    perseverativeRate: +persevRate.toFixed(4),
    domains,
    brainScore,
    byRule,
    rulesSeen: Object.keys(byRule),
    log: trials.map((t) => ({
      c: t.correct ? 1 : 0,
      s: t.isSwitchTrial ? 1 : 0,
      p: t.perseverative ? 1 : 0,
      r: t.rtMs,
    })),
  };
}

export const DOMAIN_LABELS = {
  speed: "Speed",
  flexibility: "Flexibility",
  inhibition: "Inhibition",
  induction: "Induction",
  consistency: "Consistency",
};

export const DOMAIN_BLURBS = {
  speed: "How fast you tap once you think you know the answer.",
  flexibility: "How many turns it takes you to find the new secret after it changes.",
  inhibition: "How quickly you stop using an old idea once it has started failing.",
  induction: "How good you are at working out a new secret from only one or two clues.",
  consistency: "How even your timing is. Very up-and-down timing usually means you were distracted.",
};

export { RULES, RULE_BY_ID };
