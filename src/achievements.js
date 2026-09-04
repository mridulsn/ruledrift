// Achievements, XP and rank.
//
// Two deliberate choices, both from the retention research:
//
// 1. Most of these are *sequenced* (I / II / III on the same axis) rather than
//    one-off novelties. Players who complete a stepped achievement on day one
//    retain far better than players who complete none - the ladder is the point,
//    not the badge.
// 2. They reward things a player already wants to do - adapting faster, switching
//    cleanly, showing up. Manufactured goals ("tap 500 times") produce a spike and
//    then nothing.

export const RANKS = [
  { at: 0, name: "Drifter" },
  { at: 2000, name: "Pattern Seeker" },
  { at: 6000, name: "Rule Reader" },
  { at: 14000, name: "Shift Watcher" },
  { at: 28000, name: "Adaptive" },
  { at: 50000, name: "Unstuck" },
  { at: 85000, name: "Flexible Mind" },
  { at: 140000, name: "Ruledrifter" },
];

export function rankFor(xp) {
  let cur = RANKS[0];
  let next = null;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].at) {
      cur = RANKS[i];
      next = RANKS[i + 1] || null;
    }
  }
  const span = next ? next.at - cur.at : 1;
  const into = next ? xp - cur.at : 1;
  return {
    name: cur.name,
    index: RANKS.indexOf(cur) + 1,
    next: next ? next.name : null,
    toNext: next ? next.at - xp : 0,
    progress: next ? Math.max(0, Math.min(1, into / span)) : 1,
  };
}

/**
 * A stepped achievement: one axis, three tiers.
 * `value(stats)` returns the player's lifetime figure on that axis.
 */
function tiered(id, name, icon, axis, tiers, value, unit) {
  return { id, name, icon, axis, tiers, value, unit, stepped: true };
}

function oneOff(id, name, icon, desc, test) {
  return { id, name, icon, desc, test, stepped: false };
}

export const ACHIEVEMENTS = [
  tiered("adapt", "Quick Study", "\u{1F504}", "Rule changes you recovered from",
    [5, 25, 100], (s) => s.adaptations, ""),
  tiered("sessions", "Regular", "\u{1F3AE}", "Sessions played",
    [1, 10, 50], (s) => s.sessions, ""),
  tiered("streakdays", "Habit", "\u{1F525}", "Longest daily streak",
    [3, 7, 30], (s) => s.longestStreak, " days"),
  tiered("runstreak", "On A Roll", "\u{26A1}", "Best answer streak in one run",
    [8, 20, 40], (s) => s.bestRunStreak, ""),
  tiered("brain", "Sharp", "\u{1F9E0}", "Best brain score",
    [50, 70, 85], (s) => s.bestBrain, ""),

  oneOff("clean", "Clean Switch", "\u{2728}",
    "Finish a run with at least 3 rule changes and zero perseverative errors",
    (s, r) => r && r.ruleChanges >= 3 && r.perseverativeErrors === 0),
  oneOff("flying", "Flying Start", "\u{1F680}",
    "Get your first 10 answers right in one run",
    (s, r) => r && r.log && r.log.length >= 10 && r.log.slice(0, 10).every((t) => t.c === 1)),
  oneOff("instant", "Instant Read", "\u{1F440}",
    "Average under 1.2 seconds across a run of 15 or more",
    (s, r) => r && r.trials >= 15 && r.meanRt > 0 && r.meanRt < 1200),
  oneOff("zen", "Unhurried", "\u{1F9D8}",
    "Finish a Zen run at 90% accuracy or better",
    (s, r) => r && r.mode === "zen" && r.trials >= 12 && r.accuracy >= 0.9),
  oneOff("blitz", "Under Pressure", "\u{1F3C1}",
    "Score 2,500 or more in Blitz",
    (s, r) => r && r.mode === "blitz" && r.score >= 2500),
  oneOff("gauntlet", "Whiplash", "\u{1F300}",
    "Survive 8 rule changes in one Gauntlet run",
    (s, r) => r && r.mode === "gauntlet" && r.ruleChanges >= 8),
  oneOff("duelist", "Duelist", "\u{2694}",
    "Compare results with a friend",
    (s) => s.duels >= 1),
  oneOff("codex", "Completionist", "\u{1F4DA}",
    "Encounter all eight rules",
    (s) => s.rulesSeen >= 8),
  oneOff("comeback", "Second Wind", "\u{1F4AA}",
    "Reach a streak of 10 after already losing two lives",
    (s, r) => r && r.comeback === true),
];

export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Lifetime figures the achievements are measured against. */
export function lifetimeStats(profile) {
  const h = profile.history || [];
  return {
    sessions: h.length,
    adaptations: h.reduce((a, r) => a + (r.adaptations || 0), 0),
    longestStreak: profile.longestStreak || 0,
    bestRunStreak: h.reduce((a, r) => Math.max(a, r.maxStreak || 0), 0),
    bestBrain: profile.bestBrain || 0,
    bestScore: profile.bestScore || 0,
    duels: (profile.duels || []).length,
    rulesSeen: Object.keys(profile.ruleStats || {}).length,
    totalTrials: h.reduce((a, r) => a + (r.trials || 0), 0),
    totalCorrect: h.reduce((a, r) => a + (r.correct || 0), 0),
    xp: profile.xp || 0,
  };
}

/** Every unlocked step, as flat ids like "adapt.2". */
export function unlockedSet(profile, result = null) {
  const stats = lifetimeStats(profile);
  const out = new Set(profile.unlocked || []);

  for (const a of ACHIEVEMENTS) {
    if (a.stepped) {
      const v = a.value(stats) || 0;
      a.tiers.forEach((need, i) => {
        if (v >= need) out.add(`${a.id}.${i + 1}`);
      });
    } else if (a.test(stats, result)) {
      out.add(a.id);
    }
  }
  return out;
}

/** Progress rows for the achievements screen. */
export function achievementRows(profile) {
  const stats = lifetimeStats(profile);
  const have = new Set(profile.unlocked || []);
  const rows = [];

  for (const a of ACHIEVEMENTS) {
    if (a.stepped) {
      const v = a.value(stats) || 0;
      let tier = 0;
      a.tiers.forEach((need, i) => {
        if (have.has(`${a.id}.${i + 1}`) || v >= need) tier = i + 1;
      });
      const nextNeed = tier < a.tiers.length ? a.tiers[tier] : null;
      const prevNeed = tier > 0 ? a.tiers[tier - 1] : 0;
      rows.push({
        id: a.id,
        icon: a.icon,
        name: a.name + (tier ? " " + "I".repeat(Math.min(tier, 3)) : ""),
        desc: a.axis,
        tier,
        maxTier: a.tiers.length,
        value: v,
        need: nextNeed,
        unit: a.unit || "",
        progress: nextNeed ? Math.max(0, Math.min(1, (v - prevNeed) / (nextNeed - prevNeed))) : 1,
        done: tier >= a.tiers.length,
      });
    } else {
      rows.push({
        id: a.id,
        icon: a.icon,
        name: a.name,
        desc: a.desc,
        tier: have.has(a.id) ? 1 : 0,
        maxTier: 1,
        progress: have.has(a.id) ? 1 : 0,
        done: have.has(a.id),
      });
    }
  }
  return rows;
}

/** Human label for a flat id, used by the unlock toast. */
export function labelFor(flatId) {
  const [base, step] = flatId.split(".");
  const a = ACH_BY_ID[base];
  if (!a) return flatId;
  if (!step) return `${a.icon} ${a.name}`;
  return `${a.icon} ${a.name} ${"I".repeat(Number(step))}`;
}

/** XP is just score earned, so the ladder tracks real play. */
export function xpFor(result) {
  return Math.round(result.score + result.adaptations * 40 + result.correct * 5);
}
