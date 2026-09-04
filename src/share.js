// Share codes.
//
// This is the whole multiplayer system. A share code is a block of text that is
// readable by a human, spoiler-free, and carries a machine-readable payload on
// the last line. Paste it into WhatsApp; your friend pastes it back into the
// game and gets a head-to-head. No server, no account, no network - two players
// on the same seed play a byte-identical board, so the comparison is exact.

const TAG = "#RD1:";

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Compact payload - short keys keep the pasted code from wrapping badly. */
export function encodePayload(result, name) {
  return (
    TAG +
    b64urlEncode(
      JSON.stringify({
        s: result.seed,
        m: result.mode,
        p: result.score,
        l: result.level,
        a: Math.round(result.accuracy * 100),
        b: result.brainScore,
        k: result.maxStreak,
        t: result.trials,
        r: result.meanRt,
        n: (name || "").slice(0, 18),
      })
    )
  );
}

export function decodePayload(text) {
  const m = String(text || "").match(/#RD1:([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  try {
    const o = JSON.parse(b64urlDecode(m[1]));
    return {
      seed: o.s,
      mode: o.m,
      score: o.p,
      level: o.l,
      accuracy: o.a / 100,
      brainScore: o.b,
      maxStreak: o.k,
      trials: o.t,
      meanRt: o.r,
      name: o.n || "Your friend",
    };
  } catch {
    return null;
  }
}

/**
 * Spoiler-free result strip. Shows the shape of the run without revealing a
 * single rule - the same restraint that made Wordle's grid shareable.
 *   green  correct
 *   blue   correct on the trial where the rule silently changed (the hard ones)
 *   orange perseverative error - stuck on the old rule
 *   red    wrong
 */
export function resultStrip(result, maxLen = 40) {
  const log = result.log || [];
  const trimmed = log.length > maxLen ? log.slice(-maxLen) : log;
  return trimmed
    .map((t) => (t.c ? (t.s ? "\u{1F7E6}" : "\u{1F7E9}") : t.p ? "\u{1F7E7}" : "\u{1F7E5}"))
    .join("");
}

function chunk(str, n) {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out;
}

export function buildShareText(result, { name, url, dailyNumber } = {}) {
  const title =
    result.mode === "daily" && dailyNumber
      ? `RULEDRIFT Daily #${dailyNumber}`
      : `RULEDRIFT · seed ${result.seed}`;

  const lines = [
    title,
    `${result.score.toLocaleString()} pts · L${result.level} · ${Math.round(
      result.accuracy * 100
    )}% · Brain ${result.brainScore}`,
    "",
    ...chunk(resultStrip(result), 10),
    "",
  ];

  if (result.mode !== "daily") lines.push(`Beat me on this exact board:`);
  if (url) lines.push(url);
  lines.push(encodePayload(result, name));

  return lines.join("\n");
}

export function challengeUrl(seed, base) {
  const root = base || location.origin + location.pathname;
  return `${root}?s=${encodeURIComponent(seed)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the old trick.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Head-to-head verdict. Only meaningful when both players used the same seed. */
export function compare(mine, theirs) {
  const sameBoard = mine.seed === theirs.seed;
  const diff = mine.score - theirs.score;
  return {
    sameBoard,
    diff,
    verdict: diff > 0 ? "win" : diff < 0 ? "loss" : "tie",
    rows: [
      { label: "Score", mine: mine.score.toLocaleString(), theirs: theirs.score.toLocaleString(), better: Math.sign(diff) },
      { label: "Level", mine: mine.level, theirs: theirs.level, better: Math.sign(mine.level - theirs.level) },
      {
        label: "Accuracy",
        mine: Math.round(mine.accuracy * 100) + "%",
        theirs: Math.round(theirs.accuracy * 100) + "%",
        better: Math.sign(mine.accuracy - theirs.accuracy),
      },
      { label: "Brain score", mine: mine.brainScore, theirs: theirs.brainScore, better: Math.sign(mine.brainScore - theirs.brainScore) },
      { label: "Best streak", mine: mine.maxStreak, theirs: theirs.maxStreak, better: Math.sign(mine.maxStreak - theirs.maxStreak) },
      {
        label: "Avg reaction",
        mine: mine.meanRt + "ms",
        theirs: theirs.meanRt + "ms",
        better: Math.sign(theirs.meanRt - mine.meanRt),
      },
    ],
  };
}
