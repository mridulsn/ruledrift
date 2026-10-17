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

// Achievements for Split Clues. The old hidden-rule badges are retired; any a
// player already earned stay in their saved profile, untouched.
export const ACHIEVEMENTS = [
  tiered("sc_solved", "Solver", "check", "Puzzles solved",
    [1, 25, 100], (s) => s.solved, ""),
  tiered("sc_clean", "Clean Logic", "sparkle", "Solved with no mistakes and no hints",
    [1, 10, 50], (s) => s.clean, ""),
  tiered("streakdays", "Habit", "flame", "Longest daily streak",
    [3, 7, 30], (s) => s.longestStreak, " days"),

  oneOff("sc_quick", "Quick Mind", "bolt",
    "Solve a Medium or bigger puzzle in under 2 minutes",
    (s, r) => r && r.game === "clues" && r.solved && r.n >= 4 && r.k >= 2 && r.ms > 0 && r.ms < 120000),
  oneOff("sc_expert", "Grandmaster", "gem",
    "Solve an Expert puzzle without a hint",
    (s, r) => r && r.game === "clues" && r.solved && r.preset === "expert" && r.hints === 0),
  oneOff("sc_team", "Many Hands", "swords",
    "Solve a puzzle with friends",
    (s) => s.teamSolves >= 1),
  oneOff("sc_boss", "Bossbreaker", "crown",
    "Beat a boss in Drift Run",
    (s, r) => r && r.mode === "sc-run" && r.bossesBeaten >= 1),
  oneOff("sc_deep", "Out of the Deep", "trophy",
    "Clear all three acts of one Drift Run",
    (s, r) => r && r.mode === "sc-run" && r.won === true),
];

export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

const isClues = (r) => r && r.game === "clues";

/** Lifetime figures the achievements are measured against. Old games count towards XP only. */
export function lifetimeStats(profile) {
  const h = (profile.history || []).filter(isClues);
  const singles = h.filter((r) => r.mode !== "sc-run" && r.solved);
  const runs = h.filter((r) => r.mode === "sc-run");
  const times = singles.filter((r) => r.ms > 0);
  return {
    sessions: (profile.history || []).length,
    games: h.length,
    solved: singles.length + runs.reduce((a, r) => a + (r.rooms || 0), 0),
    clean: singles.filter((r) => !r.mistakes && !r.hints).length + runs.reduce((a, r) => a + (r.cleanRooms || 0), 0),
    teamSolves: singles.filter((r) => r.mode === "sc-room").length,
    runs: runs.length,
    runsWon: runs.filter((r) => r.won).length,
    bestDepth: runs.reduce((a, r) => Math.max(a, r.depth || 0), 0),
    fastest: times.length ? Math.min(...times.map((r) => r.ms)) : 0,
    oldGames: (profile.history || []).filter((r) => r && !isClues(r)).length,
    longestStreak: profile.longestStreak || 0,
    bestScore: profile.bestScore || 0,
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

/** Human label for a flat id, used by the unlock list. The icon is drawn separately. */
export function labelFor(flatId) {
  const [base, step] = flatId.split(".");
  const a = ACH_BY_ID[base];
  if (!a) return flatId;
  if (!step) return a.name;
  return `${a.name} ${"I".repeat(Number(step))}`;
}

/** Icon name for a flat id. */
export function iconFor(flatId) {
  const a = ACH_BY_ID[String(flatId).split(".")[0]];
  return a ? a.icon : "spark";
}

/**
 * XP is just score earned, so the ladder tracks real play. Old hidden-rule
 * games keep the formula they were earned under; every field is guarded, so a
 * record of either shape can never turn the total into NaN.
 */
export function xpFor(result) {
  if (!result) return 0;
  if (result.game === "clues") return Math.round(Number(result.score) || 0);
  return Math.round((Number(result.score) || 0) + (Number(result.adaptations) || 0) * 40 + (Number(result.correct) || 0) * 5);
}
