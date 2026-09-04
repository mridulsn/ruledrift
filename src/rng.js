// Seeded deterministic RNG.
// Everything in the game derives from a seed, so two players who share a seed
// play a byte-identical round. That is what makes offline multiplayer possible:
// no server ever has to send anyone a board.

/** FNV-1a: turn any string into a 32-bit seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 - small, fast, good enough, and identical across engines. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    /** integer in [0, n) */
    int: (n) => Math.floor(next() * n),
    /** integer in [lo, hi] inclusive */
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Fisher-Yates, in place */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

const SEED_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

/** Human-typeable 6-char seed code, e.g. "K7F2QM". */
export function randomSeedCode() {
  let s = "";
  const buf = new Uint32Array(6);
  (globalThis.crypto || {}).getRandomValues
    ? crypto.getRandomValues(buf)
    : buf.forEach((_, i) => (buf[i] = Math.floor(Math.random() * 4294967296)));
  for (let i = 0; i < 6; i++) s += SEED_ALPHABET[buf[i] % SEED_ALPHABET.length];
  return s;
}

export function normalizeSeedCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IO]/g, (c) => (c === "I" ? "1" : "0"))
    .slice(0, 12);
}

/** The daily seed: same board for everyone, worldwide, changes at local midnight. */
export function dailySeedCode(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `DAILY-${y}${m}${d}`;
}

export function dailyNumber(date = new Date()) {
  const epoch = Date.UTC(2026, 0, 1);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.max(1, Math.floor((today - epoch) / 86400000) + 1);
}
