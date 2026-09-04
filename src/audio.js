// Sound without assets: short WebAudio blips. Keeps the offline cache tiny and
// avoids shipping any audio file at all.

let ctx = null;
let muted = false;

try {
  muted = localStorage.getItem("ruledrift.muted") === "1";
} catch {}

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function blip(freq, durMs, type = "sine", gain = 0.06) {
  if (muted) return;
  const a = ac();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, a.currentTime);
  g.gain.setValueAtTime(0, a.currentTime);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + durMs / 1000);
  osc.connect(g).connect(a.destination);
  osc.start();
  osc.stop(a.currentTime + durMs / 1000 + 0.02);
}

export const sfx = {
  correct(streak = 0) {
    // Pitch climbs with the streak - a small, cheap dopamine ladder.
    blip(520 + Math.min(streak, 10) * 42, 110, "triangle", 0.05);
  },
  wrong() {
    blip(150, 220, "sawtooth", 0.045);
  },
  adapt() {
    blip(660, 90, "triangle", 0.05);
    setTimeout(() => blip(990, 140, "triangle", 0.045), 90);
  },
  over() {
    blip(300, 180, "sine", 0.05);
    setTimeout(() => blip(200, 320, "sine", 0.045), 160);
  },
  tick() {
    blip(880, 40, "square", 0.02);
  },
};

export function isMuted() {
  return muted;
}

export function toggleMute() {
  muted = !muted;
  try {
    localStorage.setItem("ruledrift.muted", muted ? "1" : "0");
  } catch {}
  return muted;
}
