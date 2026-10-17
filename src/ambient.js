// The world behind the game: an obsidian table under drifting fog, slow embers
// rising, and on a desktop a soft lamp that follows the pointer.
//
// The light can shift hue. The game only asks it to AFTER the player has
// answered the first board of a new rule, so it is felt as "something moved"
// once the feedback is already on screen - it never announces a change early,
// and the hue is drawn at random, so it can never hint at which rule is next.

const reduced = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const HUES = [196, 168, 256, 288, 214, 150, 232];
let hueIndex = 0;
let started = false;

export function startAmbient() {
  if (started) return;
  started = true;
  const root = document.documentElement;
  root.style.setProperty("--amb", String(HUES[0]));

  const world = document.createElement("div");
  world.className = "world";
  world.setAttribute("aria-hidden", "true");
  world.innerHTML = '<div class="fog fog-a"></div><div class="fog fog-b"></div><canvas class="embers"></canvas><div class="lamp"></div><div class="vignette"></div>';
  document.body.prepend(world);

  // Lamp: only with a real pointer, and only when motion is welcome.
  if (window.matchMedia && window.matchMedia("(pointer: fine)").matches && !reduced()) {
    let raf = 0;
    let mx = 50, my = 30;
    window.addEventListener("pointermove", (e) => {
      mx = (e.clientX / window.innerWidth) * 100;
      my = (e.clientY / window.innerHeight) * 100;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        root.style.setProperty("--mx", mx.toFixed(1) + "%");
        root.style.setProperty("--my", my.toFixed(1) + "%");
      });
    }, { passive: true });
    root.classList.add("has-lamp");
  }

  embers(world.querySelector(".embers"));
}

/** A new mood for the room. Random, never tied to the rule. */
export function shiftAmbient() {
  hueIndex = (hueIndex + 1 + Math.floor(Math.random() * (HUES.length - 1))) % HUES.length;
  document.documentElement.style.setProperty("--amb", String(HUES[hueIndex]));
}

function embers(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  let w = 0, h = 0;
  const resize = () => {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const N = Math.round(Math.min(46, Math.max(22, (w * h) / 26000)));
  const spawn = (anywhere) => ({
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : h + 10,
    r: 0.6 + Math.random() * 1.8,
    vy: 0.12 + Math.random() * 0.38,
    sway: 0.4 + Math.random() * 1.2,
    phase: Math.random() * Math.PI * 2,
    hue: 22 + Math.random() * 22,
    life: 0.35 + Math.random() * 0.65,
  });
  const ps = Array.from({ length: N }, () => spawn(true));

  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const p of ps) {
      const flicker = 0.55 + 0.45 * Math.sin(t / 380 + p.phase * 3);
      const fade = Math.min(1, p.y / (h * 0.35));
      const a = p.life * flicker * fade;
      ctx.fillStyle = `hsla(${p.hue}, 95%, 62%, ${(a * 0.16).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsla(${p.hue + 8}, 100%, 78%, ${(a * 0.9).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  if (reduced()) {
    draw(0);
    return;
  }

  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(48, now - last) / 16.7;
    last = now;
    if (!document.hidden) {
      for (const p of ps) {
        p.y -= p.vy * dt;
        p.x += Math.sin(now / 1400 + p.phase) * 0.12 * p.sway * dt;
        if (p.y < -12) Object.assign(p, spawn(false));
      }
      draw(now);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
