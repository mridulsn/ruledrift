// Local persistence. Everything lives in localStorage - the game is fully
// playable with the network switched off, and no result ever leaves the device
// unless the player explicitly copies a share code.

const KEY = "ruledrift.v1";

const EMPTY = {
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
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
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
 * session and tier 3 around the eighth - the meta layer arriving on day 3-5 is
 * the single best-supported retention lever there is.
 */
export function tierFor(profile) {
  const n = profile.history.length;
  if (n >= 8 || profile.bestBrain >= 70) return 3;
  if (n >= 3) return 2;
  return 1;
}

export function recordResult(profile, result) {
  profile.history.push(result);
  if (profile.history.length > 400) profile.history = profile.history.slice(-400);
  profile.bestScore = Math.max(profile.bestScore, result.score);
  profile.bestBrain = Math.max(profile.bestBrain, result.brainScore);

  if (result.mode === "daily") {
    const today = dayKey(new Date(result.playedAt));
    if (!profile.dailyResults[today]) {
      profile.dailyResults[today] = result;
      applyStreak(profile, today);
    }
  }

  profile.tierUnlocked = Math.max(profile.tierUnlocked, tierFor(profile));
  return save(profile);
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
  return save(profile);
}

export function resetAll() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  return { ...EMPTY };
}

export function exportProfile() {
  return JSON.stringify(load(), null, 2);
}
