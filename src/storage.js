// Local persistence. Everything lives in localStorage - the game is fully
// playable with the network switched off, and no result ever leaves the device
// unless the player explicitly copies a share code.

import { unlockedSet, xpFor } from "./achievements.js";

const KEY = "ruledrift.v2";
const OLD_KEY = "ruledrift.v1";

export const AVATARS = ["\u{1F9E0}", "\u{1F441}", "\u{1F52E}", "\u{1F3AF}", "\u{1F9E9}", "\u{26A1}", "\u{1F98A}", "\u{1F989}", "\u{1F31F}", "\u{1F300}"];

const EMPTY = {
  name: "",
  avatar: 0,
  xp: 0,
  unlocked: [],
  ruleStats: {},      // ruleId -> { seen, correct }
  history: [],        // newest last
  bestScore: 0,
  bestBrain: 0,
  streak: 0,
  longestStreak: 0,
  lastDailyDay: null, // "YYYY-MM-DD"
  freezes: 1,         // one missed day forgiven
  dailyResults: {},   // day -> result
  tierUnlocked: 1,
  duels: [],          // { seed, mine, theirs, at }
  createdAt: Date.now(),
};

export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY);
    if (!raw) return { ...EMPTY };
    const p = { ...EMPTY, ...JSON.parse(raw) };
    // Rebuild derived fields for anyone carried over from v1.
    if (!p.ruleStats || !Object.keys(p.ruleStats).length) p.ruleStats = rebuildRuleStats(p.history);
    if (!p.xp) p.xp = p.history.reduce((a, r) => a + xpFor(r), 0);
    return p;
  } catch {
    return { ...EMPTY };
  }
}

function rebuildRuleStats(history) {
  const out = {};
  for (const r of history || []) {
    for (const [id, v] of Object.entries(r.byRule || {})) {
      const s = (out[id] = out[id] || { seen: 0, correct: 0 });
      s.seen += v.seen || 0;
      s.correct += v.correct || 0;
    }
  }
  return out;
}

export function save(profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    /* private mode, quota, whatever - the game still plays, it just forgets */
  }
  return profile;
}

/**
 * Unlock tiers by experience, not by payment. Tier 2 lands on roughly the third
 * session and tier 3 around the eighth - a meta layer arriving on day 3-5 is
 * the single best-supported retention lever there is.
 */
export function tierFor(profile) {
  const n = profile.history.length;
  if (n >= 8 || profile.bestBrain >= 70) return 3;
  if (n >= 3) return 2;
  return 1;
}

/**
 * @returns {{profile: object, newlyUnlocked: string[], xpGained: number, rankUp: boolean}}
 */
export function recordResult(profile, result) {
  const beforeUnlocked = new Set(profile.unlocked || []);
  const beforeXp = profile.xp || 0;

  profile.history.push(result);
  if (profile.history.length > 400) profile.history = profile.history.slice(-400);
  profile.bestScore = Math.max(profile.bestScore, result.score);
  profile.bestBrain = Math.max(profile.bestBrain, result.brainScore);

  for (const [id, v] of Object.entries(result.byRule || {})) {
    const s = (profile.ruleStats[id] = profile.ruleStats[id] || { seen: 0, correct: 0 });
    s.seen += v.seen;
    s.correct += v.correct;
  }

  const gained = xpFor(result);
  profile.xp = beforeXp + gained;

  if (result.mode === "daily") {
    const today = dayKey(new Date(result.playedAt));
    if (!profile.dailyResults[today]) {
      profile.dailyResults[today] = result;
      applyStreak(profile, today);
    }
  }

  profile.tierUnlocked = Math.max(profile.tierUnlocked, tierFor(profile));

  const after = unlockedSet(profile, result);
  profile.unlocked = [...after];
  const newlyUnlocked = [...after].filter((id) => !beforeUnlocked.has(id));

  save(profile);
  return { profile, newlyUnlocked, xpGained: gained };
}

function applyStreak(profile, today) {
  const last = profile.lastDailyDay;
  if (!last) {
    profile.streak = 1;
  } else {
    const gap = daysBetween(last, today);
    if (gap === 0) return;
    if (gap === 1) {
      profile.streak += 1;
    } else if (gap === 2 && profile.freezes > 0) {
      // One skipped day is forgiven, once. Losing a long streak to a single
      // busy day is the fastest way to make someone quit for good.
      profile.freezes -= 1;
      profile.streak += 1;
    } else {
      profile.streak = 1;
      profile.freezes = 1;
    }
  }
  profile.lastDailyDay = today;
  profile.longestStreak = Math.max(profile.longestStreak, profile.streak);
}

export function streakStatus(profile, today = dayKey()) {
  const done = !!profile.dailyResults[today];
  const last = profile.lastDailyDay;
  let live = profile.streak;
  if (last && !done) {
    const gap = daysBetween(last, today);
    if (gap > 2 || (gap === 2 && profile.freezes <= 0)) live = 0;
  }
  return { done, streak: live, freezes: profile.freezes, longest: profile.longestStreak };
}

export function recordDuel(profile, entry) {
  profile.duels.unshift(entry);
  profile.duels = profile.duels.slice(0, 50);
  profile.unlocked = [...unlockedSet(profile)];
  return save(profile);
}

export function setIdentity(profile, { name, avatar }) {
  if (typeof name === "string") profile.name = name.slice(0, 18);
  if (typeof avatar === "number") profile.avatar = avatar;
  return save(profile);
}

export function resetAll() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(OLD_KEY);
  } catch {}
  return { ...EMPTY };
}

export function exportProfile() {
  return JSON.stringify(load(), null, 2);
}
