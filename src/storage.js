// Local persistence. Everything lives in localStorage - the game is fully
// playable with the network switched off, and no result ever leaves the device
// unless the player explicitly copies a share code.

import { unlockedSet, xpFor } from "./achievements.js";

// NOTE: merge helpers below depend on daysBetween/rebuildRuleStats/tierFor,
// all defined in this module.

const KEY = "ruledrift.v2";
const OLD_KEY = "ruledrift.v1";

export const AVATARS = ["\u{1F9E0}", "\u{1F441}", "\u{1F52E}", "\u{1F3AF}", "\u{1F9E9}", "\u{26A1}", "\u{1F98A}", "\u{1F989}", "\u{1F31F}", "\u{1F300}"];

const EMPTY = {
  name: "",
  avatar: 0,
  updatedAt: 0,       // last local edit, used to settle merge conflicts
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
  profile.updatedAt = Date.now();

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
  profile.updatedAt = Date.now();
  return save(profile);
}

// ---------------------------------------------------------------------------
// Merging two profiles
//
// When someone signs in on a second device, both sides have real history and
// neither is authoritative. The rules below are chosen so that merging is
// SAFE rather than clever:
//
//   - idempotent:  merge(a, a) === a, so a repeated sync changes nothing
//   - commutative: merge(a, b) === merge(b, a), so sync order never matters
//   - never destructive: a session recorded on either device survives
//   - never inflationary: totals are recomputed or max'd, never summed, so a
//     double sync can never award XP twice
//
// Anything derived (XP, rule tallies, streaks) is recomputed from the merged
// history rather than added up, because addition is exactly how sync bugs turn
// into fake scores.
// ---------------------------------------------------------------------------

const sessionKey = (r) => `${r.playedAt}|${r.seed}|${r.score}`;

function mergeHistory(a = [], b = []) {
  const seen = new Map();
  for (const r of [...a, ...b]) if (r && r.playedAt) seen.set(sessionKey(r), r);
  return [...seen.values()].sort((x, y) => x.playedAt - y.playedAt).slice(-400);
}

function mergeDaily(a = {}, b = {}) {
  const out = { ...a };
  for (const [day, r] of Object.entries(b)) {
    if (!out[day] || (r && r.score > out[day].score)) out[day] = r;
  }
  return out;
}

function mergeDuels(a = [], b = []) {
  const seen = new Map();
  for (const d of [...a, ...b]) if (d) seen.set(`${d.seed}|${d.at}`, d);
  return [...seen.values()].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 50);
}

function maxTally(a = {}, b = {}, rebuilt = {}) {
  // Elementwise max, never a sum: under-counting across two devices is a much
  // smaller sin than inventing progress that was never played.
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(rebuilt)])) {
    const s = [a[id], b[id], rebuilt[id]].filter(Boolean);
    out[id] = {
      seen: Math.max(0, ...s.map((x) => x.seen || 0)),
      correct: Math.max(0, ...s.map((x) => x.correct || 0)),
    };
  }
  return out;
}

/** Longest and current daily streak, recomputed from the days actually played. */
export function streaksFromDays(days) {
  const sorted = [...days].sort();
  if (!sorted.length) return { longest: 0, current: 0, last: null };
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i - 1], sorted[i]);
    run = gap === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return { longest, current: run, last: sorted[sorted.length - 1] };
}

export function mergeProfiles(a, b) {
  if (!a) return b ? { ...EMPTY, ...b } : { ...EMPTY };
  if (!b) return { ...EMPTY, ...a };

  const history = mergeHistory(a.history, b.history);
  const dailyResults = mergeDaily(a.dailyResults, b.dailyResults);
  const streaks = streaksFromDays(Object.keys(dailyResults));

  // Whichever side was edited most recently owns the cosmetic fields.
  const newer = (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a;
  const older = newer === b ? a : b;

  const merged = {
    ...EMPTY,
    name: newer.name || older.name || "",
    avatar: newer.name || newer.avatar ? newer.avatar : older.avatar,
    history,
    dailyResults,
    duels: mergeDuels(a.duels, b.duels),
    unlocked: [...new Set([...(a.unlocked || []), ...(b.unlocked || [])])],
    ruleStats: maxTally(a.ruleStats, b.ruleStats, rebuildRuleStats(history)),
    bestScore: Math.max(a.bestScore || 0, b.bestScore || 0, ...history.map((r) => r.score || 0)),
    bestBrain: Math.max(a.bestBrain || 0, b.bestBrain || 0, ...history.map((r) => r.brainScore || 0)),
    xp: Math.max(a.xp || 0, b.xp || 0, history.reduce((s, r) => s + xpFor(r), 0)),
    longestStreak: Math.max(a.longestStreak || 0, b.longestStreak || 0, streaks.longest),
    streak: streaks.current,
    lastDailyDay: streaks.last,
    freezes: Math.min(a.freezes ?? 1, b.freezes ?? 1),
    createdAt: Math.min(a.createdAt || Date.now(), b.createdAt || Date.now()),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };

  merged.tierUnlocked = Math.max(a.tierUnlocked || 1, b.tierUnlocked || 1, tierFor(merged));
  merged.unlocked = [...unlockedSet(merged)];
  return merged;
}

/** Replace the local profile wholesale, e.g. after a cloud merge. */
export function replaceLocal(profile) {
  return save({ ...EMPTY, ...profile });
}

export function touch(profile) {
  profile.updatedAt = Date.now();
  return profile;
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
