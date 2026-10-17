// Sharing. Share text is spoiler-free: it says how the solve went (time,
// slips, hints), never anything about who holds which rune.

import { PRESETS, clock } from "./clues.js";

/** A short text for a solved puzzle or a finished run. */
export function buildShareText(result, { url, dailyNumber } = {}) {
  const lines = [];
  if (result.mode === "sc-run") {
    lines.push(`Ruledrift Drift Run${result.daily ? ` #${dailyNumber}` : ""}`);
    lines.push(result.won
      ? `Cleared all three acts \u00b7 ${Number(result.score || 0).toLocaleString()} points`
      : `Depth ${result.depth}/${result.length || 12} \u00b7 ${Number(result.score || 0).toLocaleString()} points`);
    lines.push(`${result.rooms || 0} puzzles \u00b7 ${result.mistakes || 0} mistakes \u00b7 ${result.hints || 0} hints`);
  } else {
    const p = PRESETS[result.preset] || { label: "", n: result.n };
    const what = result.mode === "sc-daily" ? `Daily #${dailyNumber}` : result.mode === "sc-room" ? "Team puzzle" : "Practice";
    lines.push(`Ruledrift Split Clues \u00b7 ${what} (${p.label} ${result.n}x${result.n})`);
    lines.push(`Solved in ${clock(result.ms)} \u00b7 ${result.mistakes || 0} mistake${result.mistakes === 1 ? "" : "s"} \u00b7 ${result.hints || 0} hint${result.hints === 1 ? "" : "s"}`);
    if (result.team > 1) lines.push(`With ${result.team - 1} friend${result.team === 2 ? "" : "s"}`);
  }
  if (url) lines.push(url);
  return lines.join("\n");
}

/** A link that opens one exact Drift Run (same map, same rooms). */
export function runUrl(seed, base) {
  const root = base || location.origin + location.pathname;
  return `${root}?run=${encodeURIComponent(seed)}`;
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
