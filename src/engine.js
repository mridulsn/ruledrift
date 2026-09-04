// Game state machine + scoring + metrics.
//
// Pure logic: no DOM, no canvas, no timers. The UI drives it by calling
// answer() / timeout() and reading state. That keeps it unit-testable and
// portable if this is ever ported to Flutter for the Play Store build.

import { makeRng, hashSeed } from "./rng.js";
import { RULES, RULE_BY_ID, generateTrial, answerMap, ruleNeedsPrev, rulesUpToTier } from "./rules.js";

export const LIVES = 3;
const BASE_TIME_MS = 5200;
const MIN_TIME_MS = 1700;
const TIME_DECAY_PER_LEVEL = 260;
const TRIALS_PER_LEVEL = 6;

/** Correct answers before the rule silently changes. */
const RUN_MIN = 4;
const RUN_MAX = 7;

export function timeLimitForLevel(level) {
  return Math.max(MIN_TIME_MS, BASE_TIME_MS - (level - 1) * TIME_DECAY_PER_LEVEL);
}

export class Game {
  /**
   * @param {object} opts
   * @param {string} opts.seed      seed code - identical seed means identical game
   * @param {string} opts.mode      "daily" | "duel" | "practice"
   * @param {number} opts.maxTier   highest rule tier unlocked (1..3)
   */
  constructor({ seed, mode = "practice", maxTier = 1 }) {
    this.seed = seed;
    this.mode = mode;
    this.maxTier = Math.max(1, Math.min(3, maxTier));
    this.rng = makeRng(hashSeed(seed));
    this.pool = rulesUpToTier(this.maxTier).map((r) => r.id);

    this.lives = LIVES;
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
    return timeLimitForLevel(this.level);
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
    this.runTarget = this.rng.range(RUN_MIN, RUN_MAX);
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
  markShown(now = performance.now()) {
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

    let gained = 0;
    if (correct) {
      const speedFrac = Math.max(0, 1 - rtMs / this.timeLimitMs);
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
      this.lives--;
    }

    this.trials.push({
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
    meanRt,
    rtSd,
    meanAdaptationLatency: meanLatency,
    perseverativeErrors: persev,
    perseverativeRate: +persevRate.toFixed(4),
    domains,
    brainScore,
    rulesSeen: [...new Set(trials.map((t) => t.rule))],
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
  speed: "How quickly you commit to an answer you believe in.",
  flexibility: "Trials needed to lock on to a rule after it silently changes.",
  inhibition: "How well you stop applying a rule once it stops working.",
  induction: "How fast you form a correct new hypothesis from thin evidence.",
  consistency: "How steady your response time is. Erratic timing means divided attention.",
};

export { RULES, RULE_BY_ID };
