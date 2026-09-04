// Game feel.
//
// Timing follows the pattern that reads best: sound and flash together, then
// particles about 50ms later, then floating text at ~100ms. Staggering them is
// what makes one tap feel like an event instead of a state change.
//
// Kept deliberately restrained. Juice is a amplifier for a mechanic that already
// works - when it becomes the point, it is covering for something.

const layer = () => {
  let l = document.getElementById("fxlayer");
  if (!l) {
    l = document.createElement("div");
    l.id = "fxlayer";
    document.body.appendChild(l);
  }
  return l;
};

const reduced = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function floatText(x, y, text, cls = "") {
  const n = document.createElement("div");
  n.className = "fx-float " + cls;
  n.textContent = text;
  n.style.left = x + "px";
  n.style.top = y + "px";
  layer().appendChild(n);
  setTimeout(() => n.remove(), 1000);
}

export function burst(x, y, color = "var(--good)", count = 12) {
  if (reduced()) return;
  const l = layer();
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.className = "fx-particle";
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 26 + Math.random() * 46;
    p.style.left = x + "px";
    p.style.top = y + "px";
    p.style.background = color;
    p.style.setProperty("--dx", Math.cos(angle) * dist + "px");
    p.style.setProperty("--dy", Math.sin(angle) * dist + "px");
    p.style.animationDelay = Math.random() * 40 + "ms";
    l.appendChild(p);
    setTimeout(() => p.remove(), 700);
  }
}

export function shake(el, strength = 1) {
  if (!el || reduced()) return;
  el.style.setProperty("--shake", strength);
  el.classList.remove("fx-shake");
  void el.offsetWidth; // restart the animation
  el.classList.add("fx-shake");
  setTimeout(() => el.classList.remove("fx-shake"), 340);
}

export function ring(x, y, color = "var(--switch)") {
  if (reduced()) return;
  const n = document.createElement("i");
  n.className = "fx-ring";
  n.style.left = x + "px";
  n.style.top = y + "px";
  n.style.borderColor = color;
  layer().appendChild(n);
  setTimeout(() => n.remove(), 620);
}

export function flashScreen(cls) {
  if (reduced()) return;
  const n = document.createElement("div");
  n.className = "fx-flash " + cls;
  layer().appendChild(n);
  setTimeout(() => n.remove(), 300);
}

export function centerOf(el) {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

export function vibrate(ms) {
  try {
    if (navigator.vibrate && !reduced()) navigator.vibrate(ms);
  } catch {}
}

/**
 * The full correct-answer reaction, staggered.
 * @param {Element} tileEl
 * @param {string} text  floating score text
 * @param {boolean} big  true for catching a rule change
 */
export function celebrate(tileEl, text, big = false) {
  const [x, y] = centerOf(tileEl);
  vibrate(big ? 22 : 8);
  if (big) ring(x, y);
  setTimeout(() => burst(x, y, big ? "var(--switch)" : "var(--good)", big ? 20 : 11), 50);
  setTimeout(() => floatText(x, y - 18, text, big ? "big" : ""), 100);
}

export function punish(tileEl, boardEl) {
  vibrate([12, 40, 12]);
  shake(boardEl, 1);
  flashScreen("bad");
  if (tileEl) {
    const [x, y] = centerOf(tileEl);
    setTimeout(() => floatText(x, y - 14, "✕", "bad"), 90);
  }
}
