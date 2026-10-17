// Ruledrift - app shell and screens. The game is Split Clues: a logic grid
// puzzle about who holds which rune. Every rule and number lives in the pure
// modules (clues.js, driftrun.js, rooms.js); these screens draw them and pass
// taps through.

import { DriftRun, ACTS, NODE_TYPES, PERKS, STEPS_PER_ACT, dailyRunSeed, findDailyRun, isDailyRunSeed, presetFor } from "./driftrun.js";
import {
  generatePuzzle, PuzzlePlay, PRESETS, PRACTICE, presetBlurb, cellKey, clueParts, clueText, valueWord,
  dailyPreset, dailyClueSeed, findDailyClues, puzzleResult, clock, cluesFor,
} from "./clues.js";
import * as rooms from "./rooms.js";
import { icon, AVATAR_ICONS } from "./icons.js";
import { startAmbient, shiftAmbient } from "./ambient.js";
import { randomSeedCode, dailyNumber } from "./rng.js";
import * as store from "./storage.js";
import { tileSvg, glyphSvg } from "./tiles.js";
import { buildShareText, copyText, runUrl } from "./share.js";
import { sfx, isMuted, toggleMute } from "./audio.js";
import * as juice from "./juice.js";
import { TUTORIAL_PUZZLE, STEPS as TUT_STEPS, tutorialDone, markTutorialDone, resetTutorial } from "./tutorial.js";
import { achievementRows, rankFor, lifetimeStats, labelFor, iconFor } from "./achievements.js";
import * as cloud from "./cloud.js";

const app = document.getElementById("app");
let profile = store.load();
let play = null;      // the puzzle on screen (solo, run room, or a friends' room)
let run = null;
let room = null;      // the friends' room on screen
let loopHandle = null;
let onLeave = null;   // per-screen cleanup (e.g. a resize listener, a poll)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
  }
  return n;
}

function toast(msg, ms = 2200) {
  const t = h("div", { class: "toast" }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const num = (n) => Number(n || 0).toLocaleString();

function header(title, onBack) {
  return h(
    "div",
    { class: "top" },
    onBack
      ? h("button", { class: "icon-btn", onclick: onBack, "aria-label": "Back" }, icon("back"))
      : brandMark(),
    title ? h("h2", {}, title) : null,
    h("div", { class: "spacer" })
  );
}

/** The player's face in the top bar: their cloud photo if signed in, else their chosen glyph. */
function avatarGlyph(size = 26) {
  const user = cloud.currentUser();
  if (user && user.avatarUrl) {
    return h("img", {
      src: user.avatarUrl, alt: "", referrerpolicy: "no-referrer",
      style: `width:${size}px;height:${size}px;border-radius:8px;object-fit:cover;display:block`,
    });
  }
  return h("span", { class: "avatar-chip" }, icon(AVATAR_ICONS[profile.avatar] || AVATAR_ICONS[0], { size: 20 }));
}

/** The player's chosen rune, large. */
function avatarRune(size = 30) {
  return icon(AVATAR_ICONS[profile.avatar] || AVATAR_ICONS[0], { size });
}

function brandMark() {
  return h("div", { class: "brand" }, h("span", { class: "sigil" }, icon("stone", { size: 22 })), "RULEDRIFT");
}

/**
 * Home's top bar. Account and settings live here rather than buried in a menu,
 * because "where do I log in" should never be a question.
 */
function topBar() {
  const user = cloud.currentUser();
  return h("div", { class: "top" },
    brandMark(),
    h("div", { class: "spacer" }),
    !user && cloud.cloudConfigured()
      ? h("button", { class: "btn btn-sm loginbtn", onclick: loginSheet }, "Log in")
      : h("button", { class: "icon-btn", "aria-label": "Profile", title: "Profile", onclick: screenProfile },
        avatarGlyph())
  );
}

function render(node, { wide = false } = {}) {
  stopLoop();
  if (onLeave) { try { onLeave(); } catch {} onLeave = null; }
  app.classList.toggle("wide", wide);
  app.replaceChildren(node);
  window.scrollTo(0, 0);
}

function stopLoop() {
  if (loopHandle) cancelAnimationFrame(loopHandle);
  loopHandle = null;
  document.onkeydown = null;
}

function stat(v, k) {
  return h("div", { class: "stat" }, h("div", { class: "v" }, String(v)), h("div", { class: "k" }, k));
}

function footer() {
  // Keep this honest. The moment an account exists, "nothing leaves this
  // device" stops being true, and a privacy claim that quietly goes stale is
  // worse than never having made one.
  const user = cloud.currentUser();
  return h("footer", {},
    h("div", {},
      user
        ? `Playable offline. Backed up to your account (${user.email || user.name}).`
        : "Playable offline. Nothing you play leaves this device."),
    h("div", { style: "margin-top:4px" }, "Made with AI by Mridul"),
    h("div", { class: "footer-links", style: "margin-top:6px" },
      h("a", { href: "privacy.html" }, "Privacy"),
      " \u00b7 ",
      h("a", { href: "terms.html" }, "Terms")));
}

// ---------------------------------------------------------------------------
// cloud sync
// ---------------------------------------------------------------------------

/**
 * Pull the cloud copy, merge it with what is on this device, and push the
 * result back. Both directions matter: signing in on a new phone must not wipe
 * the laptop, and a laptop that has been offline for a week must not overwrite
 * everything played since.
 */
async function syncNow({ quiet = true } = {}) {
  if (!cloud.signedIn()) return false;

  const read = await cloud.pull();

  // A failed read must never be treated as an empty cloud. Writing here would
  // push this device's profile over a backup we simply could not see - which is
  // exactly how a fresh device wipes out years of play.
  if (!read.ok) {
    cloud.queueSync();
    if (!quiet) toast("Could not reach your backup - nothing was changed.");
    return false;
  }

  if (read.data) {
    const merged = store.mergeProfiles(profile, read.data);
    profile = store.replaceLocal(merged);
  }

  const ok = await cloud.push(profile);
  if (!ok) {
    cloud.queueSync();
    if (!quiet) toast("Saved on this device. Will sync when you're back online.");
  } else if (!quiet) {
    toast("Synced");
  }
  return ok;
}

/** Human-readable proof of the last confirmed backup. */
function syncedLabel() {
  const at = cloud.lastSyncedAt();
  if (!at) return "Not backed up yet";
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "Backed up just now";
  if (mins < 60) return `Backed up ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Backed up ${hrs}h ago`;
  return `Backed up ${new Date(at).toLocaleDateString()}`;
}

/** Fire-and-forget sync after a run, so finishing a game is never blocked. */
function syncInBackground() {
  if (!cloud.signedIn()) return;
  syncNow({ quiet: true }).catch(() => cloud.queueSync());
}

const HERO_STONES = [
  { shape: "triangle", color: "amber", count: 3 },
  { shape: "circle", color: "cyan", count: 1 },
  { shape: "hex", color: "violet", count: 5 },
  { shape: "diamond", color: "magenta", count: 2 },
  { shape: "square", color: "lime", count: 4 },
];

function menuItem(iconName, title, sub, onclick, disabled = false) {
  return h("button", { class: "mode", onclick, disabled },
    h("span", { class: "ic" }, icon(iconName)),
    h("span", { class: "tx" },
      h("span", { class: "nm" }, title),
      h("span", { class: "bl" }, sub)),
    h("span", { class: "go" }, icon("chevron", { size: 18 })));
}

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------

/** Sound, learning, data and about: the old Settings screen, now part of Profile. */
function settingsCards() {
  const muted = isMuted();
  return [
    h("div", { class: "card" },
      h("div", { class: "between" },
        h("div", {},
          h("h3", {}, "Sound"),
          h("div", { class: "small muted" }, "Short sounds on marks and solves")),
        h("button", { class: "btn btn-sm", onclick: (e) => {
          const m = toggleMute();
          e.currentTarget.textContent = m ? "Off" : "On";
        } }, muted ? "Off" : "On"))),

    h("div", { class: "card" },
      h("h3", {}, "Learning"),
      h("p", { class: "small muted" }, "Play the one-minute tutorial puzzle again any time."),
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-sm", onclick: () => { resetTutorial(); screenTutorial(); } }, "Replay tutorial"),
        h("button", { class: "btn btn-sm", onclick: screenGuide }, "How to play"))),

    h("div", { class: "card" },
      h("h3", {}, "Your data"),
      h("p", { class: "small muted" },
        cloud.signedIn()
          ? "Stored in this browser and backed up to your account. Only you can read it."
          : "Stored in this browser only. Nothing is uploaded anywhere."),
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-sm", onclick: async () => {
          toast((await copyText(store.exportProfile())) ? "Copied as JSON" : "Copy failed");
        } }, "Export"),
        h("button", { class: "btn btn-sm", onclick: importSheet }, "Import"),
        h("button", { class: "btn btn-sm", onclick: () => {
          if (confirm("Delete all your Ruledrift history on this device? This cannot be undone.")) {
            profile = store.resetAll();
            resetTutorial();
            toast("History cleared");
            screenHome();
          }
        } }, "Delete all"),
        cloud.signedIn()
          ? h("button", { class: "btn btn-sm", onclick: async (e) => {
            if (!confirm("Delete the copy in your account? This device keeps its history, and you will be signed out.")) return;
            const btn = e.currentTarget;
            btn.textContent = "Deleting...";
            if (await cloud.deleteCloud()) {
              await cloud.signOut();
              toast("Account copy deleted");
              screenProfile();
            } else {
              btn.textContent = "Delete account copy";
              toast("Could not reach your account. Nothing was deleted.", 3800);
            }
          } }, "Delete account copy")
          : null)),

    h("div", { class: "card" },
      h("h3", {}, "About"),
      h("p", { class: "small muted", style: "margin-bottom:0" },
        "Split Clues is a logic grid puzzle. Every puzzle is checked before it is dealt: it has exactly one answer, and the clues alone are enough to reach it - no guessing. Games from the older hidden-rule modes stay in your history. Made with AI by Mridul.")),
  ];
}

/** Hearts, filled for what is left. */
function heartsRow(cur, max, popIndex = -1) {
  return h("div", { class: "lives", role: "img", "aria-label": `${Math.max(0, cur)} of ${max} lives left` },
    ...Array.from({ length: max }, (_, k) =>
      h("span", { class: "life" + (k < cur ? "" : " lost") + (k === popIndex ? " pop" : "") },
        icon(k < cur ? "heart" : "heartOutline", { size: 18 }))));
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------

function dailyLabel(date = new Date()) {
  const p = PRESETS[dailyPreset(date)];
  return `${p.label} \u00b7 ${p.n}\u00d7${p.n}`;
}

function screenHome() {
  const st = store.streakStatus(profile);
  const rank = rankFor(profile.xp);
  const fresh = !tutorialDone();
  const dailyRun = findDailyRun(profile.history);
  const daily = findDailyClues(profile.history);
  const dn = dailyNumber();
  const life = lifetimeStats(profile);

  const wrap = h("div", { class: "stack" },
    topBar(),

    h("div", { class: "hero" },
      h("div", { class: "hero-stones", "aria-hidden": "true" },
        ...HERO_STONES.map((t) => h("div", { class: "tile hs c-" + t.color }, tileSvg(t)))),
      h("h1", {}, "Ruledrift"),
      h("div", { class: "tag" }, "Split Clues: who holds which rune? One answer, and logic alone finds it."),
      h("div", { class: "pills" },
        h("span", { class: "streak-pill" + (st.streak > 0 ? " live" : "") },
          icon("flame", { size: 15 }), st.streak > 0 ? `${st.streak}-day streak` : "No streak yet"),
        profile.history.length
          ? h("span", { class: "streak-pill" }, icon("crown", { size: 15 }), `${rank.name} \u00b7 ${num(profile.xp)} XP`)
          : null)),

    // Today's puzzle first: the same grid for everyone.
    daily
      ? h("button", { class: "mode hero", onclick: () => screenSolved(daily, { replay: true }) },
          h("span", { class: "ic" }, icon("check")),
          h("span", { class: "tx" },
            h("span", { class: "nm" }, `Daily #${dn} solved \u00b7 ${clock(daily.ms)}`),
            h("span", { class: "bl" }, "A new puzzle opens at midnight. Tap to see yours.")),
          h("span", { class: "go" }, icon("chevron", { size: 18 })))
      : h("button", { class: "mode hero", onclick: () => startPuzzle("sc-daily", dailyClueSeed(), dailyPreset()) },
          h("span", { class: "ic" }, icon("calendar")),
          h("span", { class: "tx" },
            h("span", { class: "nm" }, `Daily puzzle #${dn}`),
            h("span", { class: "bl" }, `${dailyLabel()} \u00b7 the same grid for everyone today`)),
          h("span", { class: "go" }, icon("chevron", { size: 18 }))),

    fresh
      ? h("button", { class: "card learncard", onclick: () => { resetTutorial(); screenTutorial(); } },
          h("span", { class: "lc-icon" }, icon("spark", { size: 24 })),
          h("span", {},
            h("span", { class: "lc-title" }, "New here? Learn in 60 seconds"),
            h("span", { class: "lc-sub" }, "One tiny puzzle, played a tap at a time.")),
          h("span", { class: "go" }, icon("chevron", { size: 18 })))
      : null,

    h("div", { class: "runcard" },
      h("div", { class: "rc-head" },
        h("div", { class: "rc-mark" }, icon("map", { size: 26 })),
        h("div", {},
          h("div", { class: "eyebrow" }, "Roguelite"),
          h("h2", {}, "Drift Run"),
          h("p", { class: "rc-sub" }, "Three acts of puzzles. Choose your path, pick perks, and face a boss grid at the end of each act. Wrong checks cost hearts."))),
      h("div", { class: "btn-row" },
        dailyRun
          ? h("button", { class: "btn", onclick: () => screenRunEnd(dailyRun, { replay: true }) },
              icon("check", { size: 18 }), `Daily Run \u00b7 ${num(dailyRun.score)}`)
          : h("button", { class: "btn btn-primary", onclick: () => startRun(dailyRunSeed(), true) },
              icon("calendar", { size: 18 }), `Daily Run #${dn}`),
        h("button", { class: dailyRun ? "btn btn-primary" : "btn", onclick: () => startRun(randomSeedCode(), false) },
          icon("dice", { size: 18 }), "New run")),
      dailyRun ? h("div", { class: "rc-done" }, "Today's Daily Run is done. A new one opens at midnight.") : null),

    h("div", { class: "menu" },
      menuItem("users", "Play with friends", "2 to 6 players, each with different clues", screenFriends),
      menuItem("grid", "Practice", "Easy, Medium, Hard and Expert puzzles", screenPractice),
      menuItem("book", "How to play", "Marks, clues and seats, with examples", screenGuide),
      menuItem("trophy", "Achievements", "What you have unlocked", screenAchievements),
      menuItem("user", "Profile", "Sound, your data and sign-in", screenProfile)),

    life.games
      ? h("div", { class: "stat-grid" },
          stat(life.solved, "Solved"),
          stat(num(profile.bestScore), "Best score"),
          stat(st.longest || 0, "Best streak"))
      : null,

    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// the puzzle, drawn: clue cards and a grid per category
// ---------------------------------------------------------------------------

const CAT_TITLE = { shape: "Rune", colour: "Colour", dots: "Dots" };
const SHORT_SHAPE = { circle: "circle", square: "square", triangle: "triangle", diamond: "diamond", hex: "hex" };

function valueShort(pz, c, v) {
  const cat = pz.cats[c];
  const val = cat.values[v];
  if (cat.id === "shape") return SHORT_SHAPE[val];
  if (cat.id === "dots") return String(val);
  return valueWord(pz, c, v);
}

function valueChip(pz, c, v, size = 18) {
  return h("span", { class: "vchip", title: valueWord(pz, c, v) },
    glyphSvg(pz.cats[c].id, pz.cats[c].values[v], { size }));
}

/** One clue card. `onShare` adds a Share button (friends' rooms). */
function clueCard(pz, i, { onShare = null, shared = false, by = "" } = {}) {
  const parts = clueParts(pz, pz.clues[i]).map((part) =>
    part.item ? (part.item.c < 0 ? h("b", {}, part.text) : valueChip(pz, part.item.c, part.item.v, 17)) : part.text);
  const card = h("div", { class: "clue", "data-clue": i },
    h("span", { class: "cn" }, String(i + 1)),
    h("span", { class: "ct" },
      h("span", { class: "sr" }, clueText(pz, pz.clues[i])),
      h("span", { "aria-hidden": "true" }, ...parts),
      by ? h("span", { class: "cby" }, `shared by ${by}`) : null),
    onShare
      ? h("button", { class: "btn btn-sm cshare", disabled: shared, onclick: (e) => { e.stopPropagation(); onShare(e.currentTarget); } },
          shared ? "Shared" : "Share")
      : null);
  // Tap a clue to dim it once you have used it - a pencil tick, nothing more.
  card.addEventListener("click", () => card.classList.toggle("used"));
  return card;
}

function hasSeatClues(pz) {
  return pz.clues.some((c) => c.t === "left" || c.t === "next" || c.t === "right");
}

function seatLine(pz) {
  return h("div", { class: "seats" },
    h("span", { class: "eyebrow" }, "Seats, left to right"),
    h("div", { class: "seatrow" }, ...pz.people.map((n, i) => h("span", { class: "seat" }, h("i", {}, String(i + 1)), n))));
}

function markGlyph(v) {
  if (v === 2) return icon("check", { size: 24, cls: "mk-check" });
  if (v === 1) return icon("close", { size: 15, cls: "mk-x" });
  return null;
}

/**
 * The grids: one per category, people down the side (in seat order), that
 * category's values across the top. Big cells, no sideways scroll at 390 px.
 */
function boardView(pz, { onTap = null } = {}) {
  const cells = {};
  const el = h("div", { class: "pgrid", style: `--n:${pz.n}` });
  pz.cats.forEach((cat, c) => {
    const g = h("div", { class: "pb-grid", role: "grid", "aria-label": `${CAT_TITLE[cat.id]} grid` },
      h("div", { class: "pb-corner" }, CAT_TITLE[cat.id]),
      ...cat.values.map((val, v) =>
        h("div", { class: "pb-head" }, glyphSvg(cat.id, val, { size: 26 }), h("span", {}, valueShort(pz, c, v)))));
    pz.people.forEach((name, p) => {
      g.appendChild(h("div", { class: "pb-name" }, name));
      for (let v = 0; v < pz.n; v++) {
        const key = cellKey(c, p, v);
        const b = h("button", {
          class: "cell", "data-key": key, "data-v": "0",
          "aria-label": `${name}, ${valueWord(pz, c, v)}: blank`,
          onclick: onTap ? () => onTap(key, b) : null,
        });
        cells[key] = b;
        g.appendChild(b);
      }
    });
    el.appendChild(h("div", { class: "pblock" }, g));
  });

  const words = ["blank", "crossed out", "checked"];
  const setCell = (key, v) => {
    const b = cells[key];
    if (!b || b.dataset.v === String(v)) return;
    b.dataset.v = String(v);
    b.replaceChildren(...[markGlyph(v)].filter(Boolean));
    b.setAttribute("aria-label", b.getAttribute("aria-label").replace(/: [a-z ]+$/, ": " + words[v]));
  };
  return {
    el,
    cells,
    paint(grid) { for (const key of Object.keys(cells)) setCell(key, grid[key] || 0); },
    flashWrong(key) {
      const b = cells[key];
      if (!b) return;
      b.classList.remove("wrong");
      void b.offsetWidth;
      b.classList.add("wrong");
      setTimeout(() => b.classList.remove("wrong"), 900);
    },
    pulse(key) {
      const b = cells[key];
      if (!b) return;
      b.classList.add("hinted");
      b.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setTimeout(() => b.classList.remove("hinted"), 2600);
    },
    lock() { el.classList.add("locked"); },
  };
}

/** React to a mark: sound, the wrong-check flash, a line of feedback. */
function showMark(rec, board, feed) {
  if (!rec) return;
  board.paint(play.grid);
  if (rec.wrong) {
    board.flashWrong(rec.key);
    sfx.wrong();
    juice.punish(null, board.el);
    feed.className = "feedline bad";
    feed.textContent = rec.shielded
      ? "Not that one - your shield took it. It is crossed out for you."
      : "Not that one - the clues rule it out. It is crossed out for you.";
  } else if (rec.value === 2) {
    sfx.correct(play.placed);
    feed.className = "feedline good";
    feed.textContent = "";
  } else {
    feed.textContent = "";
  }
}

function showHint(hres, board, feed, clueWrap) {
  board.paint(play.grid);
  board.pulse(hres.key);
  feed.className = "feedline hint";
  feed.textContent = hres.why;
  if (hres.clue !== null && clueWrap) {
    const card = clueWrap.querySelector(`[data-clue="${hres.clue}"]`);
    if (card) {
      card.classList.add("cited");
      setTimeout(() => card.classList.remove("cited"), 2600);
    }
  }
  sfx.adapt();
}

function chipsRow(...kids) {
  return h("div", { class: "runhud pz-hud" }, ...kids);
}

// ---------------------------------------------------------------------------
// a solo puzzle: Daily or Practice
// ---------------------------------------------------------------------------

const PROGRESS_KEY = "ruledrift.cluesInProgress";

function loadProgress(mode, seed, preset) {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null");
    return p && p.mode === mode && p.seed === seed && p.preset === preset ? p : null;
  } catch {
    return null;
  }
}

function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch {}
}

function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch {}
}

function startPuzzle(mode, seed, preset) {
  const pz = generatePuzzle(seed, preset);
  play = new PuzzlePlay(pz);
  // A half-done puzzle comes back as you left it, clock included.
  const saved = loadProgress(mode, seed, preset);
  let elapsed = 0;
  if (saved) {
    play.applyRemote(saved.grid);
    play.mistakes = saved.mistakes || 0;
    play.hintsUsed = saved.hints || 0;
    elapsed = saved.ms || 0;
  }
  screenPuzzle(mode, elapsed);
}

function screenPuzzle(mode, elapsed = 0) {
  const p = play;
  const pz = p.puzzle;
  const P = PRESETS[pz.preset];
  const daily = mode === "sc-daily";
  const t0 = performance.now() - elapsed;
  const ms = () => performance.now() - t0;

  const timeChip = h("span", { class: "chip" }, icon("clock", { size: 14 }), clock(elapsed));
  const slipChip = h("span", { class: "chip" });
  const placedChip = h("span", { class: "chip" });
  const hintBtn = h("button", { class: "chip btnchip", onclick: useHint }, icon("bulb", { size: 14 }), "Hint");
  const feed = h("div", { class: "feedline" });
  const board = boardView(pz, { onTap: tap });
  const clueWrap = h("div", { class: "clues" }, ...pz.clues.map((_, i) => clueCard(pz, i)));

  const wrap = h("div", { class: "stack pzwrap" },
    h("div", { class: "top gtop" },
      h("button", { class: "icon-btn", "aria-label": "Back", onclick: leave }, icon("back")),
      h("div", { class: "hud-score" },
        h("div", { class: "score", style: "font-size:19px" }, daily ? `Daily #${dailyNumber()}` : "Practice"),
        h("div", { class: "meta" }, `${P.label} \u00b7 ${presetBlurb(pz.preset)}`)),
      h("div", { class: "spacer" }),
      timeChip),
    chipsRow(placedChip, slipChip, hintBtn),
    h("div", { class: "card cluecard" },
      h("div", { class: "between" }, h("h3", {}, "Clues"), h("span", { class: "tiny" }, "Tap a clue to tick it off")),
      hasSeatClues(pz) ? seatLine(pz) : null,
      clueWrap),
    board.el,
    feed,
    h("p", { class: "tiny", style: "text-align:center;margin:0" }, "Tap once for X (not this one), twice for a check."));
  render(wrap, { wide: true });

  function paintHud() {
    placedChip.replaceChildren(icon("check", { size: 14 }), `${p.placed}/${p.total}`);
    slipChip.replaceChildren(icon("warn", { size: 14 }), `${p.mistakes} mistake${p.mistakes === 1 ? "" : "s"}`);
    hintBtn.replaceChildren(icon("bulb", { size: 14 }), p.hintsUsed ? `Hint (${p.hintsUsed} used)` : "Hint");
  }

  function persist() {
    saveProgress({ mode, seed: pz.seed, preset: pz.preset, grid: p.grid, mistakes: p.mistakes, hints: p.hintsUsed, ms: Math.round(ms()) });
  }

  function tap(key) {
    if (p.solved) return;
    const rec = p.tap(key);
    showMark(rec, board, feed);
    paintHud();
    persist();
    if (p.solved) win();
  }

  function useHint() {
    const r = p.hint();
    if (!r) return;
    showHint(r, board, feed, clueWrap);
    paintHud();
    persist();
    if (p.solved) win();
  }

  function win() {
    clearInterval(timer);
    board.lock();
    clearProgress();
    sfx.adapt();
    const result = puzzleResult(p, { mode, ms: ms(), daily });
    const { newlyUnlocked, xpGained } = store.recordResult(profile, result);
    profile = store.load();
    syncInBackground();
    const banner = h("div", { class: "cleared" },
      h("div", { class: "cl-t" }, "Solved"),
      h("div", { class: "cl-s" }, `${clock(result.ms)} \u00b7 +${num(result.score)}`));
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 1500);
    setTimeout(() => screenSolved(result, { newlyUnlocked, xpGained }), 1300);
  }

  function leave() {
    if (!p.solved) persist();
    play = null;
    screenHome();
  }

  board.paint(p.grid);
  paintHud();
  const timer = setInterval(() => timeChip.replaceChildren(icon("clock", { size: 14 }), clock(ms())), 500);
  onLeave = () => { clearInterval(timer); if (!p.solved) persist(); };
}

/** Everyone's rune, drawn whole: the answer, shown only once it is solved. */
function answerStones(pz) {
  const val = (id, p) => {
    const c = pz.cats.findIndex((x) => x.id === id);
    return c < 0 ? null : pz.cats[c].values[pz.solution[c][p]];
  };
  return h("div", { class: "answer" },
    ...pz.people.map((name, p) => h("div", { class: "ans" },
      h("div", { class: "ans-stone" }, tileSvg({ shape: val("shape", p) || "circle", color: val("colour", p) || "gold", count: val("dots", p) || 0 }, { size: 52 })),
      h("div", { class: "ans-n" }, name))));
}

function unlockedCard(ids) {
  if (!ids || !ids.length) return null;
  return h("div", { class: "card" },
    h("h3", {}, ids.length === 1 ? "Achievement unlocked" : "Achievements unlocked"),
    h("div", { style: "margin-top:8px" },
      ...ids.map((id) => h("span", { class: "rulechip" }, icon(iconFor(id), { size: 16 }), labelFor(id)))));
}

function screenSolved(result, { replay = false, newlyUnlocked = [], xpGained = 0 } = {}) {
  const pz = generatePuzzle(result.seed, result.preset);
  const P = PRESETS[result.preset] || PRESETS.easy;
  const daily = result.mode === "sc-daily";
  const team = result.mode === "sc-room";
  const shareText = buildShareText(result, { url: location.origin + location.pathname, dailyNumber: dailyNumber() });
  const title = daily ? `Daily #${dailyNumber(new Date(result.playedAt || Date.now()))}` : team ? "Team puzzle" : "Practice";

  const wrap = h("div", { class: "stack" },
    header(replay ? "Today's puzzle" : title, screenHome),
    h("div", { class: "endtitle" },
      h("h1", {}, result.mistakes || result.hints ? "Solved" : "Flawless"),
      h("p", { class: "small" }, `${P.label} \u00b7 ${presetBlurb(result.preset)}${team ? ` \u00b7 ${result.team} players` : ""}`)),
    answerStones(pz),
    h("div", { class: "card" },
      h("div", { class: "bigscore" },
        h("div", { class: "v" }, num(result.score)),
        h("div", { class: "k" }, "points")),
      h("div", { class: "stat-grid" },
        stat(clock(result.ms), team ? "Team time" : "Time"),
        stat(result.mistakes || 0, "Mistakes"),
        stat(result.hints || 0, "Hints")),
      xpGained ? h("p", { class: "small muted", style: "text-align:center;margin:12px 0 0" },
        `+${num(xpGained)} XP \u00b7 ${rankFor(profile.xp).name}`) : null),
    unlockedCard(newlyUnlocked),
    h("div", { class: "card" },
      h("h3", {}, "Share"),
      h("pre", { class: "sharebox" }, shareText),
      h("button", { class: "btn btn-primary", style: "margin-top:12px", onclick: async () => {
        if (navigator.share) { try { await navigator.share({ text: shareText }); return; } catch {} }
        toast((await copyText(shareText)) ? "Result copied" : "Copy failed");
      } }, icon("share", { size: 18 }), "Share result"),
      h("p", { class: "tiny", style: "margin-top:10px" }, "No spoilers: it says how you did, never who holds what.")),
    h("div", { class: "btn-row" },
      h("button", { class: "btn btn-primary", onclick: () => startPuzzle("sc-practice", randomSeedCode(), result.preset) },
        icon("dice", { size: 18 }), `New ${P.label} puzzle`),
      h("button", { class: "btn", onclick: screenPractice }, "Practice")),
    h("button", { class: "btn btn-ghost", onclick: screenHome }, icon("home", { size: 18 }), "Home"),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// PRACTICE
// ---------------------------------------------------------------------------

const PRESET_ICON = { easy: "stone", easy4: "stone", medium: "grid", hard: "skull", expert: "crown" };

function screenPractice() {
  const wrap = h("div", { class: "stack" },
    header("Practice", screenHome),
    h("p", { class: "small muted", style: "margin:0" }, "A fresh puzzle every time. No lives, unlimited hints - take your time."),
    h("div", { class: "modes" },
      ...PRACTICE.map((id) => {
        const P = PRESETS[id];
        return h("button", { class: "mode" + (id === "easy" ? " hero" : ""), onclick: () => startPuzzle("sc-practice", randomSeedCode(), id) },
          h("span", { class: "ic" }, icon(PRESET_ICON[id])),
          h("span", { class: "tx" },
            h("span", { class: "nm" }, `${P.label} \u00b7 ${P.n}\u00d7${P.n}`),
            h("span", { class: "bl" }, presetBlurb(id))),
          h("span", { class: "go" }, icon("chevron", { size: 18 })));
      })),
    h("button", { class: "btn btn-ghost", onclick: () => { resetTutorial(); screenTutorial(); } }, "Play the tutorial"),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// HOW TO PLAY
// ---------------------------------------------------------------------------

function screenGuide() {
  const demo = generatePuzzle("GUIDE-DEMO", "medium");
  const ex = (t) => demo.clues.findIndex((c) => c.t === t);
  const sample = ["either", "left", "next", "same", "diff"].map(ex).filter((i) => i >= 0).slice(0, 3);
  const row = (title, text) => h("div", { class: "rulerow" }, h("b", {}, title), h("div", { class: "small" }, text));

  const wrap = h("div", { class: "stack" },
    header("How to play", screenHome),
    h("div", { class: "card" },
      h("h3", {}, "The goal"),
      h("p", { class: "small", style: "margin-bottom:0" },
        "Everyone at the table holds one rune stone. Work out who holds which, using only the clues. Every puzzle has exactly one answer, and the clues are always enough to reach it - you never have to guess.")),
    h("div", { class: "card" },
      h("h3", {}, "Marks"),
      row("Tap once: X", "This person does not have this. Cross out what the clues rule out."),
      row("Tap twice: check", "This person has this. The rest of the row and column are crossed out for you."),
      row("Tap a third time", "Clears the cell."),
      row("A wrong check", "Counts as a mistake, flashes red, and is crossed out - so you learn something even then.")),
    h("div", { class: "card" },
      h("h3", {}, "Reading clues"),
      h("p", { class: "small muted" }, "Clues from a Medium puzzle:"),
      h("div", { class: "clues" }, ...sample.map((i) => clueCard(demo, i))),
      row("Bigger grids", "Medium adds colours, Expert adds dots. A clue can join two features: \"The circle is teal\" means whoever holds the circle has the teal rune."),
      row("Seats", "People sit in a row, left to right, in the order the grid lists them. \"Next to\" means the seat beside; \"somewhere left of\" means any seat further left.")),
    h("div", { class: "card" },
      h("h3", {}, "Stuck?"),
      h("p", { class: "small", style: "margin-bottom:0" },
        "Hint fills in one cell that logic can prove right now, and says which clue proves it. Hints cost points, and in Drift Run you only carry a few.")),
    h("div", { class: "card" },
      h("h3", {}, "Ways to play"),
      row("Daily puzzle", "One puzzle for everyone each day, gentle on Monday and biggest on Sunday."),
      row("Practice", "Pick a size, as many as you like."),
      row("Drift Run", "Three acts of puzzles with perks and bosses. Hearts carry across the run; a wrong check costs one."),
      row("Play with friends", "A room code for 2 to 6 players. Each of you sees different clues; share them to solve one grid together.")),
    h("button", { class: "btn btn-primary", onclick: () => { resetTutorial(); screenTutorial(); } }, "Play the tutorial"),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// TUTORIAL: one 3x3 puzzle, a cell at a time
// ---------------------------------------------------------------------------

function screenTutorial() {
  const pz = TUTORIAL_PUZZLE;
  play = new PuzzlePlay(pz);
  let i = 0;

  const progress = h("div", { class: "tut-progress" }, ...TUT_STEPS.map(() => h("i")));
  const banner = h("div", { class: "tut-banner" });
  const board = boardView(pz, { onTap: tap });
  const clueWrap = h("div", { class: "clues" }, ...pz.clues.map((_, k) => clueCard(pz, k)));
  const nextBtn = h("button", { class: "btn btn-primary", style: "display:none" }, "Continue");

  const wrap = h("div", { class: "stack" },
    header("Learn in 60 seconds", screenHome),
    progress,
    banner,
    h("div", { class: "card cluecard" }, h("h3", {}, "Clues"), clueWrap),
    board.el,
    nextBtn,
    h("button", { class: "btn btn-ghost", onclick: () => { markTutorialDone(); screenHome(); } }, "Skip - I'll work it out"),
    footer());
  render(wrap);

  function paint() {
    const step = TUT_STEPS[i];
    [...progress.children].forEach((d, k) => d.classList.toggle("on", k <= i));
    banner.className = "tut-banner";
    banner.textContent = step.prompt;
    nextBtn.style.display = "none";
    Object.values(board.cells).forEach((b) => b.classList.toggle("target", b.dataset.key === step.key));
    clueWrap.querySelectorAll(".clue").forEach((c) => c.classList.toggle("cited", Number(c.dataset.clue) === step.clue));
    board.paint(play.grid);
  }

  function tap(key) {
    const step = TUT_STEPS[i];
    if (nextBtn.style.display === "" ) return;
    if (key !== step.key) {
      banner.className = "tut-banner oops";
      banner.textContent = "Not that cell for this step - tap the glowing one.";
      return;
    }
    const rec = play.tap(key);
    board.paint(play.grid);
    const v = play.grid[key] || 0;
    if (v === step.value) {
      sfx.correct(i + 2);
      juice.celebrate(board.cells[key], v === 2 ? "CHECK" : "X", i === TUT_STEPS.length - 1);
      banner.className = "tut-banner reveal";
      banner.replaceChildren(h("b", {}, "Yes. "), document.createTextNode(step.done));
      board.cells[key].classList.remove("target");
      nextBtn.style.display = "";
      nextBtn.textContent = i === TUT_STEPS.length - 1 ? "Play today's puzzle" : "Continue";
    } else if (v === 1 && step.value === 2) {
      banner.className = "tut-banner";
      banner.textContent = step.halfway || "That is an X. Tap again for a check.";
    } else {
      // Cycled past it: put it back and ask again, gently.
      if (rec && v === 0) {
        banner.className = "tut-banner oops";
        banner.textContent = step.prompt;
      }
    }
  }

  nextBtn.onclick = () => {
    i++;
    if (i >= TUT_STEPS.length) {
      markTutorialDone();
      play = null;
      toast("Tutorial complete");
      if (findDailyClues(profile.history)) startPuzzle("sc-practice", randomSeedCode(), "easy");
      else startPuzzle("sc-daily", dailyClueSeed(), dailyPreset());
    } else {
      paint();
    }
  };

  paint();
}

function screenAchievements() {
  const rows = achievementRows(profile);
  const got = rows.filter((r) => r.tier > 0).length;

  const wrap = h("div", { class: "stack" },
    header("Achievements", screenHome),
    h("div", { class: "stat-grid" },
      stat(`${got}/${rows.length}`, "Started"),
      stat(rows.filter((r) => r.done).length, "Completed"),
      stat(num(profile.xp), "XP")),
    h("div", { class: "card" },
      ...rows.map((r) =>
        h("div", { class: "ach" + (r.tier > 0 ? " got" : "") },
          h("div", { class: "ic" }, icon(r.icon, { size: 22 })),
          h("div", { class: "body" },
            h("div", { class: "nm" }, r.name),
            h("div", { class: "ds" }, r.desc),
            r.maxTier > 1
              ? h("div", { class: "tierdots" },
                  ...Array.from({ length: r.maxTier }, (_, k) =>
                    h("i", { class: k < r.tier ? "on" : "" })))
              : null,
            !r.done && r.need
              ? h("div", {},
                  h("div", { class: "pr" }, h("i", { style: `width:${Math.round(r.progress * 100)}%` })),
                  h("div", { class: "ct" }, `${num(r.value)} / ${num(r.need)}${r.unit}`))
              : null,
            r.done ? h("div", { class: "ct" }, "Complete") : null)))),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// PROFILE
// ---------------------------------------------------------------------------

function screenProfile() {
  const s = lifetimeStats(profile);
  const rank = rankFor(profile.xp);
  const nameInput = h("input", {
    type: "text", maxlength: "18", value: profile.name,
    placeholder: "Your name (shown to friends in a room)",
  });

  const avatarRow = h("div", { class: "avatar-pick" },
    ...AVATAR_ICONS.map((a, i) =>
      h("button", {
        "aria-pressed": String(i === profile.avatar), "aria-label": `Avatar ${i + 1}`,
        onclick: () => {
          profile = store.setIdentity(profile, { avatar: i });
          [...avatarRow.children].forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
          avatarBig.replaceChildren(avatarRune());
        },
      }, icon(a, { size: 22 }))));

  const avatarBig = h("div", { class: "pavatar" }, avatarRune());

  const wrap = h("div", { class: "stack" },
    header("Profile", screenHome),

    h("div", { class: "card pcard" },
      avatarBig,
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-weight:800;font-size:19px" }, profile.name || "Player"),
        h("div", { class: "small muted" }, `${rank.name} \u00b7 rank ${rank.index} of 8`),
        h("div", { class: "xpbar" }, h("i", { style: `width:${Math.round(rank.progress * 100)}%` })),
        h("div", { class: "tiny", style: "margin-top:5px" },
          rank.next ? `${num(rank.toNext)} XP to ${rank.next}` : "Top rank reached"))),

    accountCard(),

    h("div", { class: "card" },
      h("h3", {}, "Display name"),
      h("p", { class: "small muted" }, "Shown to the other players when you play with friends."),
      nameInput,
      avatarRow,
      h("button", { class: "btn btn-sm", style: "margin-top:12px", onclick: () => {
        profile = store.setIdentity(profile, { name: nameInput.value.trim() });
        toast("Saved");
        screenProfile();
      } }, "Save")),

    h("div", { class: "card" },
      h("h3", {}, "Lifetime"),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(s.solved, "Solved"),
        stat(s.clean, "Clean solves"),
        stat(s.longestStreak, "Day streak")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(num(s.bestScore), "Best score"),
        stat(s.runsWon ? `${s.runsWon} won` : s.bestDepth ? `${s.bestDepth}/12` : "\u2014", "Drift Run"),
        stat(s.fastest ? clock(s.fastest) : "\u2014", "Fastest")),
      s.oldGames
        ? h("p", { class: "tiny", style: "margin:12px 0 0" },
            `${s.oldGames} game${s.oldGames === 1 ? "" : "s"} from the older hidden-rule modes ${s.oldGames === 1 ? "is" : "are"} kept in your history and still count towards your XP.`)
        : null),

    h("button", { class: "btn", onclick: screenAchievements }, icon("trophy", { size: 18 }), "Achievements"),

    ...settingsCards(),
    footer());
  render(wrap);
}

/**
 * Sign-in buttons, greyed out with a cross when that provider is not actually
 * switched on in the project. The state is read live and cached, so enabling a
 * provider in the dashboard lights its button up with no code change.
 */
/**
 * The login pop-up. Google renders its own button and forbids restyling it, so
 * it gets its own full-width row inside the pop-up; Discord sits under it at the
 * same width. Either one signs in from here - no second sheet.
 */
function loginSheet() {
  const gslot = h("div", { class: "gsi-slot" });
  const status = h("div", { class: "tiny muted", style: "margin-top:12px;min-height:16px" });
  const back = h("div", { class: "sheet-back" });
  const close = () => back.remove();

  const discordBtn = h("button", { class: "btn oauth oauth-discord", onclick: () => cloud.signIn("discord") },
    h("span", { class: "oa-icon", html: BRAND_SVG.discord }),
    h("span", { class: "oa-label" }, "Continue with Discord"));

  const card = h("div", { class: "sheet" },
    h("div", { class: "sheet-t" }, "Log in"),
    h("div", { class: "sheet-s" },
      "Back up your progress and play on any device. Ruledrift only receives your name and email address."),
    h("div", { class: "stack oauth-stack", style: "margin-top:12px" }, gslot, discordBtn),
    status,
    h("button", { class: "btn btn-sm", style: "margin-top:12px", onclick: close }, "Cancel"));

  back.appendChild(card);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);

  const paint = (avail) => {
    const off = (id) => (avail ? avail[id] === false : false);
    discordBtn.disabled = off("discord");
    discordBtn.title = off("discord") ? "Not set up yet" : "";
    gslot.hidden = off("google") || !cloud.googleIdConfigured();
  };
  paint(cloud.cachedProviders());
  cloud.refreshProviders().then(paint).catch(() => {});

  if (!cloud.googleIdConfigured()) return;
  const dark = !window.matchMedia("(prefers-color-scheme: light)").matches
    || document.documentElement.dataset.theme === "dark";
  cloud.mountGoogleButton(gslot, { dark, width: gslot.clientWidth || Math.min(320, window.innerWidth - 84) },
    async (session) => {
      if (!session) {
        status.textContent = "Google refused that sign-in. Nothing was changed.";
        return;
      }
      status.textContent = "Signing you in...";
      await syncNow({ quiet: true }).catch(() => cloud.queueSync());
      profile = store.load();
      const u = cloud.currentUser();
      if (u && !profile.name) profile = store.setIdentity(profile, { name: u.name });
      close();
      toast("Signed in - progress backed up");
      screenProfile();
    }
  ).catch(() => {
    status.textContent = "Could not reach Google. Check your connection, or use Discord.";
  });
}

/**
 * Paste an Export from another device or the old ruledrift.vercel.app, and
 * merge it in. Merging (never replacing) means a stale copy cannot erase newer
 * games; the same rules as cloud sync decide every field.
 */
function importSheet() {
  const box = h("textarea", { class: "import-box", rows: "6", placeholder: "Paste the text you copied with Export", spellcheck: "false" });
  const status = h("div", { class: "tiny muted", style: "margin-top:10px;min-height:16px" });
  const back = h("div", { class: "sheet-back" });
  const close = () => back.remove();
  const card = h("div", { class: "sheet" },
    h("div", { class: "sheet-t" }, "Import progress"),
    h("div", { class: "sheet-s" },
      "On the other device, open Profile, Your data, Export. Paste it here. Your games are added to the ones on this device; nothing here is lost."),
    box,
    status,
    h("div", { class: "btn-row", style: "margin-top:12px;justify-content:center" },
      h("button", { class: "btn btn-sm btn-primary", onclick: async () => {
        const r = store.parseImport(box.value);
        if (!r.ok) { status.textContent = r.error; return; }
        const before = store.load();
        const merged = store.mergeProfiles(before, r.profile);
        profile = store.replaceLocal(merged);
        const added = (merged.history || []).length - (before.history || []).length;
        close();
        toast(added > 0 ? `Imported ${added} game${added === 1 ? "" : "s"}` : "Imported - nothing new to add");
        if (cloud.signedIn()) await syncNow({ quiet: true }).catch(() => cloud.queueSync());
        screenProfile();
      } }, "Import"),
      h("button", { class: "btn btn-sm", onclick: close }, "Cancel")));
  back.appendChild(card);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  box.focus();
}

// Official brand marks, inlined. A red square with a "G" in it is the tell of a
// login screen nobody should trust; the real logo is the cheapest credibility
// on the page, and it costs one path each.
const BRAND_SVG = {
  google:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/>' +
    '<path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"/>' +
    '<path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.4a12 12 0 0 0 0 10.8l4-3.1z"/>' +
    '<path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"/>' +
    "</svg>",
  discord:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="#fff">' +
    '<path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.4a18.3 18.3 0 0 1 4.3 2.1 17.6 17.6 0 0 0-15 0 18.3 18.3 0 0 1 4.3-2.1L8.6 3a19.8 19.8 0 0 0-5 1.4C.6 8.9-.3 13.3.2 17.6a19.9 19.9 0 0 0 6 3l1.2-1.7a13 13 0 0 1-2-1c.2-.1.3-.2.5-.3a14.2 14.2 0 0 0 12.2 0l.5.3a13 13 0 0 1-2 1l1.2 1.7a19.9 19.9 0 0 0 6-3c.6-5-.8-9.4-3.5-13.2zM8.0 15c-1.2 0-2.1-1.1-2.1-2.4S6.8 10.2 8 10.2s2.2 1.1 2.1 2.4S9.2 15 8 15zm8 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4S17.2 15 16 15z"/>' +
    "</svg>",
};

/**
 * The account panel. Signing in is entirely optional - the card says so plainly
 * rather than nagging, because the game genuinely does not need it.
 */
function accountCard() {
  if (!cloud.cloudConfigured()) {
    return h("div", { class: "card" },
      h("h3", {}, "Accounts"),
      h("p", { class: "small muted", style: "margin-bottom:0" },
        "Not switched on for this build. Your progress is saved on this device only - it survives closing the tab, but not clearing your browser data or moving to another device."));
  }

  const user = cloud.currentUser();

  if (!user) {
    return h("div", { class: "card" },
      h("h3", {}, "Save your progress forever"),
      h("p", { class: "small muted" },
        "Right now everything is stored in this browser. Clear your browsing data and it is gone, and your phone has its own separate history. Sign in and your record is backed up and follows you to any device."),
      h("button", { class: "btn btn-primary loginbtn-card", onclick: loginSheet }, "Log in"),
      h("p", { class: "tiny", style: "margin-top:12px" },
        "Optional. The game works fully without an account, offline and forever."));
  }

  const queued = cloud.hasQueued();
  return h("div", { class: "card" },
    h("div", { class: "pcard" },
      user.avatarUrl
        ? h("img", { class: "pavatar", src: user.avatarUrl, alt: "", referrerpolicy: "no-referrer" })
        : h("div", { class: "pavatar" }, avatarRune()),
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-weight:700" }, user.name),
        h("div", { class: "small muted", style: "overflow:hidden;text-overflow:ellipsis" }, user.email),
        h("div", { class: "tiny", style: "margin-top:4px" },
          // "Backed up" as a bare claim is worth nothing - the whole failure
          // mode here is a sync that quietly did not happen. Show the receipt.
          queued
            ? "Changes waiting to sync"
            : `${syncedLabel()} \u00b7 ${user.provider || "OAuth"}`))),
    h("div", { class: "btn-row", style: "margin-top:14px" },
      h("button", { class: "btn btn-sm", onclick: async (e) => {
        e.currentTarget.textContent = "Syncing...";
        await syncNow({ quiet: false });
        screenProfile();
      } }, "Sync now"),
      h("button", { class: "btn btn-sm", onclick: async (e) => {
        if (!confirm("Sign out? Your progress stays on this device and in the cloud.")) return;
        // Back up before dropping the session. Signing out with unsynced play
        // is the one moment where "we'll sync later" is a lie - there is no
        // later, because the next device has no way to know what it missed.
        const btn = e.currentTarget;
        btn.textContent = "Backing up...";
        const ok = await syncNow({ quiet: true }).catch(() => false);
        if (!ok && !confirm(
          "Your latest progress could not be backed up. Sign out anyway? " +
          "It stays on this device, but another device will not see it.")) {
          btn.textContent = "Sign out";
          return;
        }
        await cloud.signOut();
        toast("Signed out");
        screenProfile();
      } }, "Sign out")));
}

// ---------------------------------------------------------------------------
// PLAY WITH FRIENDS: a room code, a shared grid, split clues
// ---------------------------------------------------------------------------

function myName() {
  const u = cloud.currentUser();
  return (profile.name || (u && u.name) || "Player").slice(0, 40);
}

function screenFriends(prefill = "") {
  if (!cloud.signedIn()) {
    const wrap = h("div", { class: "stack" },
      header("Play with friends", screenHome),
      h("div", { class: "card" },
        h("div", { style: "display:grid;place-items:center;color:var(--gold-hi);margin-bottom:8px" }, icon("users", { size: 40 })),
        h("h3", { style: "text-align:center" }, "Log in to play together"),
        h("p", { class: "small muted", style: "text-align:center" },
          "A room keeps one grid in sync between 2 to 6 phones, so everyone in it needs an account. It takes one tap with Google or Discord."),
        cloud.cloudConfigured()
          ? h("button", { class: "btn btn-primary", onclick: loginSheet }, "Log in")
          : h("p", { class: "tiny" }, "Accounts are not switched on for this build.")),
      footer());
    render(wrap);
    return;
  }

  let preset = "medium";
  const sizeRow = h("div", { class: "seg" },
    ...PRACTICE.map((id) => h("button", {
      class: "segbtn", "aria-pressed": String(id === preset),
      onclick: (e) => {
        preset = id;
        [...sizeRow.children].forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
        sizeNote.textContent = presetBlurb(id);
      },
    }, PRESETS[id].label)));
  const sizeNote = h("div", { class: "tiny", style: "margin-top:8px" }, presetBlurb(preset));
  const codeInput = h("input", {
    type: "text", class: "codein", maxlength: "6", placeholder: "ABC123", value: prefill,
    autocapitalize: "characters", autocomplete: "off", spellcheck: "false", "aria-label": "Room code",
  });
  codeInput.addEventListener("input", () => { codeInput.value = rooms.normalizeRoomCode(codeInput.value); });
  const status = h("div", { class: "tiny", style: "min-height:16px;margin-top:8px" });

  const createBtn = h("button", { class: "btn btn-primary", onclick: async () => {
    createBtn.disabled = true;
    status.textContent = "Opening a room...";
    const u = cloud.currentUser();
    for (let tries = 0; tries < 4; tries++) {
      const code = rooms.newRoomCode();
      const res = await cloud.roomCreate(code, rooms.newRoomData({ uid: u.id, name: myName(), preset }));
      if (res.ok) { screenRoom(code); return; }
      if (res.status !== 409) break;
    }
    createBtn.disabled = false;
    status.textContent = "Could not open a room - check your connection and try again.";
  } }, icon("users", { size: 18 }), "Create a room");

  const joinBtn = h("button", { class: "btn", onclick: async () => {
    const code = rooms.normalizeRoomCode(codeInput.value);
    if (code.length !== 6) { status.textContent = "A room code has 6 letters and numbers."; return; }
    joinBtn.disabled = true;
    status.textContent = "Finding the room...";
    const why = await joinRoom(code);
    joinBtn.disabled = false;
    if (why) status.textContent = why;
  } }, "Join");

  const wrap = h("div", { class: "stack" },
    header("Play with friends", screenHome),
    h("p", { class: "small muted", style: "margin:0" },
      "One puzzle, one shared grid, 2 to 6 players. The clues are dealt out between you, so nobody can solve it alone - tap Share on a clue to show it to everyone."),
    h("div", { class: "card" },
      h("h3", {}, "Start a room"),
      h("p", { class: "small muted" }, "Pick a size, then send your friends the code."),
      sizeRow,
      sizeNote,
      h("div", { style: "margin-top:14px" }, createBtn)),
    h("div", { class: "card" },
      h("h3", {}, "Join a room"),
      h("div", { class: "joinrow" }, codeInput, joinBtn),
      status),
    footer());
  render(wrap);
  if (prefill) codeInput.focus();
}

/** @returns {Promise<string>} why it failed, or "" once on the room screen */
async function joinRoom(code) {
  const got = await cloud.roomGet(code);
  if (!got.ok) return "Could not reach the room - check your connection.";
  if (!got.room) return "No room with that code. Check the letters.";
  const u = cloud.currentUser();
  const can = rooms.canJoin(got.room, u.id);
  if (!can.ok) return can.why;
  if (!can.already) {
    const res = await cloud.roomPatch(code, rooms.joinUpdates(u.id, myName()));
    if (!res.ok) return res.status === 403 ? "That room is full or closed." : "Could not join - check your connection.";
  }
  screenRoom(code);
  return "";
}

function screenRoom(code) {
  const me = cloud.currentUser();
  let pz = null;
  let lastRoom = null;
  let pending = {};      // key -> {v, at}: our marks not yet seen back from the server
  let recorded = false;
  let gone = false;
  let pollTimer = null;
  let tickTimer = null;
  let board = null;
  let clueWrap = null;
  let feed = null;
  let view = "";
  let lobbyKey = "";
  const body = h("div", { class: "stack" });
  const top = h("div", { class: "top gtop" },
    h("button", { class: "icon-btn", "aria-label": "Leave room", onclick: leave }, icon("back")),
    h("div", { class: "hud-score" },
      h("div", { class: "score", style: "font-size:19px" }, `Room ${code}`),
      h("div", { class: "meta" }, "Play with friends")),
    h("div", { class: "spacer" }));
  const timeChip = h("span", { class: "chip" }, icon("clock", { size: 14 }), "0:00");
  top.appendChild(timeChip);
  render(h("div", { class: "stack pzwrap" }, top, body), { wide: true });
  body.appendChild(h("p", { class: "small muted", style: "text-align:center" }, "Opening the room..."));

  function leave() {
    room = null;
    play = null;
    screenHome();
  }

  const isHost = () => lastRoom && lastRoom.host === me.id;
  const startedMs = () => (lastRoom && lastRoom.startedAt ? (lastRoom.solvedAt || Date.now()) - lastRoom.startedAt : 0);

  async function poll() {
    if (gone) return;
    const got = await cloud.roomGet(code);
    if (gone) return;
    if (got.ok && !got.room) {
      gone = true;
      stop();
      body.replaceChildren(h("div", { class: "card" },
        h("h3", {}, "This room has closed"),
        h("p", { class: "small muted" }, "The host closed it, or it was more than a day old."),
        h("button", { class: "btn btn-primary", onclick: () => screenFriends() }, "Back")));
      return;
    }
    if (!got.ok) {
      if (feed) { feed.className = "feedline bad"; feed.textContent = "Connection lost - retrying..."; }
      return;
    }
    if (feed && feed.textContent === "Connection lost - retrying...") feed.textContent = "";
    apply(got.room);
  }

  function apply(rm) {
    lastRoom = rm;
    room = rm;
    if (!pz) pz = generatePuzzle(rm.seed, rm.preset);
    // Remote grid, with our own marks that have not come back yet kept on top.
    const grid = { ...(rm.grid || {}) };
    const now = Date.now();
    for (const [k, p] of Object.entries(pending)) {
      if (now - p.at > 5000 || (grid[k] || 0) === p.v) delete pending[k];
      else if (p.v) grid[k] = p.v;
      else delete grid[k];
    }
    if (!play || play.puzzle !== pz) play = new PuzzlePlay(pz);
    play.applyRemote(grid);
    const solved = rm.status === "solved" || play.solved;
    const next = solved ? "solved" : rm.status === "playing" ? "playing" : "lobby";
    if (next !== view) {
      view = next;
      if (view === "lobby") drawLobby();
      else if (view === "playing") drawPlaying();
      else drawSolved();
    } else if (view === "lobby") {
      // Only redraw when someone joins, so a tap on Start is never swallowed.
      const key = rooms.seatOrder(rm).join(",");
      if (key !== lobbyKey) drawLobby();
    } else if (view === "playing") {
      refreshPlaying();
    }
    if (play.solved && rm.status !== "solved") {
      cloud.roomPatch(code, { status: "solved", solvedAt: Date.now() }).catch(() => {});
    }
  }

  function playerList() {
    const order = rooms.seatOrder(lastRoom);
    return h("div", { class: "players" },
      ...order.map((uid) => h("span", { class: "player" + (uid === me.id ? " me" : "") },
        uid === lastRoom.host ? icon("crown", { size: 14 }) : icon("user", { size: 14 }),
        (lastRoom.players[uid] && lastRoom.players[uid].name) || "Player",
        uid === me.id ? " (you)" : "")));
  }

  function drawLobby() {
    lobbyKey = rooms.seatOrder(lastRoom).join(",");
    const n = Object.keys(lastRoom.players || {}).length;
    const link = `${location.origin}${location.pathname}?room=${code}`;
    body.replaceChildren(
      h("div", { class: "card roomcode" },
        h("div", { class: "eyebrow" }, "Room code"),
        h("div", { class: "bigcode", "aria-label": code.split("").join(" ") }, code),
        h("div", { class: "btn-row", style: "margin-top:12px" },
          h("button", { class: "btn btn-sm", onclick: async () => toast((await copyText(code)) ? "Code copied" : "Copy failed") }, "Copy code"),
          h("button", { class: "btn btn-sm", onclick: async () => {
            const text = `Solve a Ruledrift puzzle with me - room ${code}\n${link}`;
            if (navigator.share) { try { await navigator.share({ text }); return; } catch {} }
            toast((await copyText(text)) ? "Invite copied" : "Copy failed");
          } }, icon("share", { size: 16 }), "Invite"))),
      h("div", { class: "card" },
        h("div", { class: "between" }, h("h3", {}, `Players (${n}/6)`),
          h("span", { class: "tiny" }, `${PRESETS[lastRoom.preset].label} \u00b7 ${presetBlurb(lastRoom.preset)}`)),
        playerList(),
        isHost()
          ? h("div", { style: "margin-top:14px" },
              h("button", { class: "btn btn-primary", onclick: async (e) => {
                e.currentTarget.disabled = true;
                const res = await cloud.roomPatch(code, rooms.startUpdates(lastRoom));
                if (!res.ok) { e.currentTarget.disabled = false; toast("Could not start - check your connection."); }
                else poll();
              } }, n > 1 ? `Start with ${n} players` : "Start on my own"),
              h("p", { class: "tiny", style: "margin-top:8px" },
                n > 1 ? "The clues are dealt out when you start. Anyone who joins later can still mark and read shared clues."
                  : "Waiting for friends. On your own you see every clue."))
          : h("p", { class: "small muted", style: "margin-top:14px" }, `Waiting for ${lastRoom.hostName || "the host"} to start...`)));
  }

  function myClues() {
    const order = lastRoom.order && lastRoom.order.length ? lastRoom.order : rooms.seatOrder(lastRoom);
    if (order.length <= 1 && order[0] === me.id) return pz.clues.map((_, i) => i);
    return cluesFor(pz.clues.length, order, me.id);
  }

  function drawPlaying() {
    feed = h("div", { class: "feedline" });
    board = boardView(pz, { onTap: tap });
    clueWrap = h("div", { class: "clues" });
    const sharedWrap = h("div", { class: "clues", "data-shared": "1" });
    body.replaceChildren(
      playerList(),
      h("div", { class: "card cluecard" },
        h("div", { class: "between" }, h("h3", {}, "Your clues"), h("span", { class: "tiny" }, "Only you can see these")),
        hasSeatClues(pz) ? seatLine(pz) : null,
        clueWrap),
      h("div", { class: "card cluecard sharedcard" },
        h("div", { class: "between" }, h("h3", {}, "Shared board"), h("span", { class: "tiny" }, "Everyone sees these")),
        sharedWrap),
      board.el,
      feed,
      h("p", { class: "tiny", style: "text-align:center;margin:0" }, "One grid for the whole team. Tap once for X, twice for a check."));
    refreshPlaying();
  }

  function refreshPlaying() {
    if (!board) return;
    board.paint(play.grid);
    const posts = rooms.postsOf(lastRoom);
    const sharedSet = new Set(posts.map((p) => p.clue));
    const mine = myClues();
    const mineKey = mine.join(",") + "|" + [...sharedSet].join(",");
    if (clueWrap.dataset.k !== mineKey) {
      clueWrap.dataset.k = mineKey;
      clueWrap.replaceChildren(...(mine.length
        ? mine.map((i) => clueCard(pz, i, { shared: sharedSet.has(i), onShare: (btn) => share(i, btn) }))
        : [h("p", { class: "small muted", style: "margin:0" }, "You joined after the deal, so you hold no clues. Read the shared board and help mark the grid.")]));
    }
    const sharedWrap = body.querySelector('[data-shared="1"]');
    const postKey = posts.map((p) => p.clue).join(",");
    if (sharedWrap && sharedWrap.dataset.k !== postKey) {
      sharedWrap.dataset.k = postKey;
      sharedWrap.replaceChildren(...(posts.length
        ? posts.filter((p) => pz.clues[p.clue]).map((p) => clueCard(pz, p.clue, { by: p.uid === me.id ? "you" : p.by || "a friend" }))
        : [h("p", { class: "small muted", style: "margin:0" }, "Nothing shared yet. Share a clue when a friend needs it.")]));
    }
  }

  async function share(i, btn) {
    btn.disabled = true;
    btn.textContent = "Sharing...";
    const res = await cloud.roomPatch(code, rooms.postUpdates(i, me.id, myName()));
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = "Share";
      toast("Could not share - check your connection.");
      return;
    }
    poll();
  }

  async function tap(key) {
    if (!play || play.solved || view !== "playing") return;
    const rec = play.tap(key);
    if (!rec) return;
    showMark(rec, board, feed);
    const at = Date.now();
    for (const [k, v] of Object.entries(rec.changed)) pending[k] = { v, at };
    const res = await cloud.roomPatch(code, rooms.gridUpdates(rec.changed));
    if (!res.ok) toast("That mark did not reach the room - check your connection.");
    if (play.solved) poll();
  }

  function drawSolved() {
    stop();
    const ms = startedMs();
    const team = Object.keys(lastRoom.players || {}).length;
    if (!recorded) {
      recorded = true;
      const done = profile.history.some((r) => r && r.mode === "sc-room" && r.seed === pz.seed);
      if (!done) {
        const result = puzzleResult(play, { mode: "sc-room", ms, team });
        result.solved = true;
        result.score = result.score || 0;
        store.recordResult(profile, result);
        profile = store.load();
        syncInBackground();
      }
      sfx.adapt();
    }
    timeChip.replaceChildren(icon("clock", { size: 14 }), clock(ms));
    body.replaceChildren(
      h("div", { class: "endtitle" },
        h("h1", {}, "Solved together"),
        h("p", { class: "small" }, `${team} player${team === 1 ? "" : "s"} \u00b7 team time ${clock(ms)}`)),
      answerStones(pz),
      playerList(),
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-primary", onclick: () => screenFriends() }, icon("users", { size: 18 }), "New room"),
        h("button", { class: "btn", onclick: leave }, icon("home", { size: 18 }), "Home")),
      isHost()
        ? h("button", { class: "btn btn-ghost", onclick: async () => { await cloud.roomDelete(code); leave(); } }, "Close this room")
        : null);
  }

  function start() {
    if (pollTimer || gone) return;
    poll();
    pollTimer = setInterval(poll, rooms.POLL_MS);
  }
  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  const onVis = () => (document.hidden ? stop() : view !== "solved" && start());
  document.addEventListener("visibilitychange", onVis);
  tickTimer = setInterval(() => {
    if (view === "playing") timeChip.replaceChildren(icon("clock", { size: 14 }), clock(startedMs()));
  }, 500);
  onLeave = () => {
    gone = true;
    stop();
    clearInterval(tickTimer);
    document.removeEventListener("visibilitychange", onVis);
  };
  start();
}

// ---------------------------------------------------------------------------
// DRIFT RUN
//
// A seeded three-act descent. The engine (driftrun.js) owns every rule and
// number; these screens only draw it and pass taps through.
// ---------------------------------------------------------------------------

const ROMAN = ["I", "II", "III"];
const NODE_ICON = { room: "stone", elite: "skull", rest: "campfire", boss: "crown" };
const PERK_ICON = { heart: "heart", mend: "heartOutline", slow: "hourglass", lantern: "bulb", shield: "shield", hoard: "flame", peek: "eye" };

function startRun(seed, daily) {
  run = new DriftRun({ seed, daily });
  screenRunMap();
}

function runTitle(r) {
  return r.daily ? `Daily Run #${dailyNumber()}` : "Drift Run";
}

function leaveRun() {
  if (run && !run.over && !confirm("Leave this run? It will not be saved.")) return;
  run = null;
  play = null;
  screenHome();
}

/** The strip of chips under the top bar: score, depth and what you are carrying. */
function runChips(r, { hintBtn = null } = {}) {
  return h("div", { class: "runhud" },
    h("span", { class: "chip" }, icon("spark", { size: 14 }), num(r.score)),
    h("span", { class: "chip" }, icon("map", { size: 14 }), `Depth ${r.depth}/${r.length}`),
    hintBtn || h("span", { class: "chip teal" }, icon("bulb", { size: 14 }), `Hints \u00d7${r.hints}`),
    r.shields ? h("span", { class: "chip teal" }, icon("shield", { size: 14 }), `Shield \u00d7${r.shields}`) : null,
    r.slow ? h("span", { class: "chip teal" }, icon("hourglass", { size: 14 }), "Slow clock") : null);
}

function runTop(r, sub) {
  return h("div", { class: "top gtop" },
    h("button", { class: "icon-btn", "aria-label": "Leave run", onclick: leaveRun }, icon("close")),
    h("div", { class: "hud-score" },
      h("div", { class: "score", style: "font-size:19px" }, runTitle(r)),
      h("div", { class: "meta" }, sub)),
    h("div", { class: "spacer" }),
    heartsRow(r.hearts, r.maxHearts));
}

function nodeBlurb(n) {
  if (n.type === "rest") return NODE_TYPES.rest.blurb;
  const P = PRESETS[presetFor(n)];
  const size = `${P.label} ${P.n}\u00d7${P.n}`;
  if (n.type === "elite") return `${size}, against the clock. A perk if you pass.`;
  if (n.type === "boss") return `${size} - the biggest grid of the act.`;
  return `${size}. Solve it to go on.`;
}

// ---- the map --------------------------------------------------------------

function screenRunMap() {
  const r = run;
  const open = new Set(r.options().map((n) => n.id));
  const taken = new Set(r.path);
  const passed = (n) => n.act < r.act || (n.act === r.act && n.step < r.step);
  const nodeEls = {};

  const nodeView = (n) => {
    const state = open.has(n.id) ? "open" : taken.has(n.id) ? "taken" : passed(n) ? "skipped" : "";
    const kind = NODE_TYPES[n.type];
    const el = h(open.has(n.id) ? "button" : "div", {
      class: `node ${n.type} ${state}`,
      "aria-label": open.has(n.id) ? `Go to ${kind.label}` : null,
      onclick: open.has(n.id) ? () => enterNode(n.id) : null,
    },
      h("span", { class: "ns" }, icon(NODE_ICON[n.type], { size: n.type === "boss" ? 32 : 24 })),
      h("span", {}, kind.label),
      state === "open" ? h("span", { class: "nb" }, nodeBlurb(n)) : null);
    nodeEls[n.id] = el;
    return el;
  };

  const links = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  links.setAttribute("class", "links");
  links.setAttribute("aria-hidden", "true");
  const mapEl = h("div", { class: "runmap" }, links);

  let focusRow = null;
  r.map.acts.forEach((a, ai) => {
    const actEl = h("div", { class: "act" + (ai === r.act ? " current" : ai > r.act ? " future" : "") },
      h("div", { class: "act-h" },
        h("span", { class: "eyebrow" }, `Act ${ROMAN[ai]}`),
        h("span", { class: "an" }, a.name)));
    [...a.steps, [a.boss]].forEach((row) => {
      const rowEl = h("div", { class: "steprow" + (row[0].type === "boss" ? " boss" : "") }, ...row.map(nodeView));
      if (row.some((n) => open.has(n.id))) focusRow = rowEl;
      actEl.appendChild(rowEl);
    });
    mapEl.appendChild(actEl);
  });

  const wrap = h("div", { class: "stack" },
    runTop(r, `Act ${ROMAN[Math.min(r.act, 2)]} \u00b7 ${ACTS[Math.min(r.act, 2)].name}`),
    runChips(r),
    r.depth === 0 && r.path.length === 0
      ? h("p", { class: "small muted", style: "text-align:center;margin:0" },
          "Pick a path. Every act ends in a boss grid. Three hearts for the whole run; a wrong check costs one.")
      : null,
    mapEl);
  render(wrap, { wide: true });

  // Links between rows, drawn once the stones have a place on screen.
  const ns = "http://www.w3.org/2000/svg";
  const draw = () => {
    links.replaceChildren();
    const box = mapEl.getBoundingClientRect();
    // Lines leave from under a node's label and arrive at the next stone, so
    // they never run through any text.
    const centre = (id) => {
      const s = nodeEls[id] && nodeEls[id].querySelector(".ns");
      if (!s) return null;
      const b = s.getBoundingClientRect();
      const nb = nodeEls[id].getBoundingClientRect();
      return { x: b.left + b.width / 2 - box.left, top: b.top - box.top, bottom: nb.bottom - box.top };
    };
    // Within an act only: the act heading is the bridge between acts.
    const rows = [];
    r.map.acts.forEach((a) => { a.steps.forEach((s) => rows.push(s)); rows.push([a.boss]); rows.push(null); });
    const last = r.path[r.path.length - 1];
    for (let i = 0; i + 1 < rows.length; i++) {
      if (!rows[i] || !rows[i + 1]) continue;
      for (const from of rows[i]) for (const to of rows[i + 1]) {
        const p1 = centre(from.id), p2 = centre(to.id);
        if (!p1 || !p2) continue;
        const y1 = p1.bottom + 4, y2 = p2.top - 4, my = (y1 + y2) / 2;
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", `M${p1.x} ${y1}C${p1.x} ${my} ${p2.x} ${my} ${p2.x} ${y2}`);
        const ti = r.path.indexOf(from.id);
        const cls = ti >= 0 && r.path[ti + 1] === to.id ? "taken" : from.id === last && open.has(to.id) ? "open" : "";
        if (cls) path.setAttribute("class", cls);
        links.appendChild(path);
      }
    }
  };
  requestAnimationFrame(() => {
    draw();
    if (focusRow && r.path.length) focusRow.scrollIntoView({ block: "center" });
  });
  window.addEventListener("resize", draw);
  onLeave = () => window.removeEventListener("resize", draw);
}

function enterNode(id) {
  const node = run.enter(id, performance.now());
  if (!node) return;
  if (run.phase === "perk") screenRunPerk();
  else {
    shiftAmbient();
    play = run.play;
    screenRunRoom();
  }
}

// ---- a room ---------------------------------------------------------------

function screenRunRoom() {
  const r = run;
  const p = r.play;
  const pz = p.puzzle;
  const node = r.node;
  const kind = NODE_TYPES[node.type];
  const isBoss = node.type === "boss";
  const P = PRESETS[pz.preset];

  const barFill = h("i");
  const bar = h("div", { class: "timerbar" }, barFill);
  const clockLine = h("div", { class: "tiny", style: "text-align:center" });
  const feed = h("div", { class: "feedline" });
  const board = boardView(pz, { onTap: tap });
  const clueWrap = h("div", { class: "clues" }, ...pz.clues.map((_, i) => clueCard(pz, i)));
  const heartsSlot = h("div", {}, heartsRow(r.hearts, r.maxHearts));
  const chipSlot = h("div", {});

  const wrap = h("div", { class: "stack pzwrap" },
    h("div", { class: "top gtop" },
      h("button", { class: "icon-btn", "aria-label": "Leave run", onclick: leaveRun }, icon("close")),
      h("div", { class: "hud-score" },
        h("div", { class: "score", style: "font-size:19px" }, runTitle(r)),
        h("div", { class: "meta" }, `Depth ${r.depth}/${r.length}`)),
      h("div", { class: "spacer" }),
      heartsSlot),
    h("div", { class: "roomtitle" + (isBoss ? " boss" : "") },
      h("span", { class: "eyebrow" }, `Act ${ROMAN[node.act]} \u00b7 ${ACTS[node.act].name}`),
      h("div", { class: "rt-name" }, isBoss ? "The Boss" : kind.label),
      h("div", { class: "tiny" }, `${P.label} \u00b7 ${presetBlurb(pz.preset)}`)),
    chipSlot,
    r.timed ? h("div", { class: "clockslot" }, bar, clockLine) : null,
    h("div", { class: "card cluecard" },
      h("div", { class: "between" }, h("h3", {}, "Clues"), h("span", { class: "tiny" }, "A wrong check costs a heart")),
      hasSeatClues(pz) ? seatLine(pz) : null,
      clueWrap),
    board.el,
    feed);
  render(wrap, { wide: true });

  function paintHud() {
    const hintBtn = h("button", { class: "chip btnchip", onclick: useHint, disabled: r.hints <= 0 },
      icon("bulb", { size: 14 }), `Hint \u00d7${r.hints}`);
    chipSlot.replaceChildren(runChips(r, { hintBtn }));
  }

  function tap(key) {
    if (r.phase !== "room") return;
    const heartsBefore = r.hearts;
    const rec = r.tap(key, performance.now());
    showMark(rec, board, feed);
    if (rec && rec.wrong && !rec.shielded) feed.textContent = "Not that one - a heart lost. It is crossed out for you.";
    heartsSlot.replaceChildren(heartsRow(r.hearts, r.maxHearts, r.hearts < heartsBefore ? r.hearts : -1));
    paintHud();
    after();
  }

  function useHint() {
    const res = r.hint(performance.now());
    if (!res) return;
    showHint(res, board, feed, clueWrap);
    paintHud();
    after();
  }

  function after() {
    if (r.phase === "room") return;
    stopLoop();
    board.lock();
    if (r.phase === "over") {
      setTimeout(finishRun, 900);
      return;
    }
    sfx.adapt();
    const banner = h("div", { class: "cleared" },
      h("div", { class: "cl-t" }, isBoss ? "Boss defeated" : `${kind.label} cleared`),
      h("div", { class: "cl-s" }, `+${num(r.lastBonus)} \u00b7 depth ${r.depth} of ${r.length}`));
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 1500);
    setTimeout(() => {
      if (r.phase === "perk") screenRunPerk();
      else if (r.phase === "won") finishRun();
      else screenRunMap();
    }, 1350);
  }

  function loop() {
    if (!run || r.phase !== "room") return;
    if (r.timed) {
      const left = r.timeLimitMs - (performance.now() - r.roomStart);
      barFill.style.transform = `scaleX(${Math.max(0, left / r.timeLimitMs)})`;
      bar.classList.toggle("low", left < r.timeLimitMs * 0.25);
      clockLine.textContent = `${clock(Math.max(0, left))} left`;
      if (left <= 0) {
        r.timeout(performance.now());
        heartsSlot.replaceChildren(heartsRow(r.hearts, r.maxHearts, r.hearts));
        sfx.wrong();
        feed.className = "feedline bad";
        feed.textContent = "Time is up - one heart lost. Finish it without the clock.";
        bar.parentElement && bar.parentElement.remove();
        after();
      }
    }
    loopHandle = requestAnimationFrame(loop);
  }

  board.paint(p.grid);
  paintHud();
  loopHandle = requestAnimationFrame(loop);
}

// ---- perks ----------------------------------------------------------------

function screenRunPerk() {
  const r = run;
  const node = r.node;
  const rest = node.type === "rest";
  const title = rest ? "Campfire" : node.type === "boss" ? "The boss falls" : "Elite cleared";
  const sub = rest
    ? "Sit by the fire a moment. Take one thing with you."
    : node.type === "boss"
      ? "You won a heart back. Choose a perk for the next act."
      : "The faster room is behind you. Choose a perk.";

  const wrap = h("div", { class: "stack" },
    runTop(r, `Act ${ROMAN[node.act]} \u00b7 ${ACTS[node.act].name}`),
    runChips(r),
    h("div", { class: "endtitle", style: "margin-top:10px" },
      h("div", { style: "display:grid;place-items:center;color:var(--gold-hi);margin-bottom:8px" },
        icon(rest ? "campfire" : node.type === "boss" ? "crown" : "skull", { size: 40 })),
      h("h1", { style: "font-size:28px" }, title),
      h("p", { class: "small" }, sub)),
    h("div", { class: "perks" },
      ...r.perkOffer.map((id) =>
        h("button", { class: "perk", onclick: () => { r.pickPerk(id); toast(`${PERKS[id].label} taken`); screenRunMap(); } },
          h("span", { class: "pk-ic" }, icon(PERK_ICON[id] || "spark", { size: 26 })),
          h("span", {},
            h("div", { class: "pk-n" }, PERKS[id].label),
            h("div", { class: "pk-b" }, PERKS[id].blurb))))));
  render(wrap, { wide: true });
}

// ---- the end --------------------------------------------------------------

function finishRun() {
  sfx.over();
  const result = run.result();
  const { newlyUnlocked, xpGained } = store.recordResult(profile, result);
  profile = store.load();
  syncInBackground();
  run = null;
  play = null;
  screenRunEnd(result, { newlyUnlocked, xpGained });
}

function depthLine(result) {
  const cells = [];
  const per = STEPS_PER_ACT + 1;
  for (let i = 0; i < (result.length || 12); i++) {
    if (i && i % per === 0) cells.push(h("i", { class: "gap" }));
    cells.push(h("i", { class: (i < result.depth ? "on" : "") + (i % per === per - 1 ? " boss" : "") }));
  }
  return h("div", { class: "depthline", role: "img", "aria-label": `Depth ${result.depth} of ${result.length || 12}` }, ...cells);
}

function screenRunEnd(result, { replay = false, newlyUnlocked = [], xpGained = 0 } = {}) {
  const daily = !!result.daily;
  const actName = ACTS[Math.max(0, Math.min(2, (result.actReached || 1) - 1))].name;
  const shareText = buildShareText(result, {
    url: daily ? location.origin + location.pathname : runUrl(result.seed),
    dailyNumber: dailyNumber(),
  });

  const wrap = h("div", { class: "stack" },
    header(replay ? "Today's Daily Run" : daily ? `Daily Run #${dailyNumber()}` : "Drift Run", screenHome),

    h("div", { class: "endtitle" },
      h("h1", {}, result.won ? "Out of the Deep" : "The drift took you"),
      h("p", { class: "small" },
        result.won
          ? "All three acts cleared. Every boss beaten."
          : `You reached ${actName}, depth ${result.depth} of ${result.length || 12}.`),
      depthLine(result)),

    h("div", { class: "card" },
      h("div", { class: "bigscore" },
        h("div", { class: "v" }, num(result.score)),
        h("div", { class: "k" }, "points")),
      h("div", { class: "stat-grid" },
        stat(`${result.depth}/${result.length || 12}`, "Depth"),
        stat(result.rooms || 0, "Puzzles"),
        stat(result.bossesBeaten || 0, "Bosses")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(result.mistakes || 0, "Mistakes"),
        stat(result.hints || 0, "Hints"),
        stat(clock(result.ms), "Time")),
      (result.perks || []).length
        ? h("div", { style: "margin-top:14px;text-align:center" },
            ...(result.perks || []).map((id) => h("span", { class: "rulechip" }, icon(PERK_ICON[id] || "spark", { size: 15 }), (PERKS[id] || { label: id }).label)))
        : null,
      xpGained ? h("p", { class: "small muted", style: "text-align:center;margin:12px 0 0" },
        `+${num(xpGained)} XP \u00b7 ${rankFor(profile.xp).name}`) : null),

    unlockedCard(newlyUnlocked),

    h("div", { class: "card" },
      h("h3", {}, "Share this run"),
      h("pre", { class: "sharebox" }, shareText),
      h("div", { class: "btn-row", style: "margin-top:14px" },
        h("button", { class: "btn btn-primary", onclick: async () => {
          if (navigator.share) { try { await navigator.share({ text: shareText }); return; } catch {} }
          toast((await copyText(shareText)) ? "Result copied" : "Copy failed");
        } }, icon("share", { size: 18 }), "Share result"),
        !daily
          ? h("button", { class: "btn", onclick: async () => {
              toast((await copyText(runUrl(result.seed))) ? "Run link copied" : "Copy failed");
            } }, icon("link", { size: 18 }), "Copy run link")
          : null),
      h("p", { class: "small muted", style: "margin-top:10px" },
        daily
          ? "Everyone gets the same map and the same puzzles today, so scores compare fairly."
          : "The link opens this exact map and these exact puzzles for your friend.")),

    h("div", { class: "btn-row" },
      h("button", { class: "btn btn-primary", onclick: () => startRun(randomSeedCode(), false) }, icon("dice", { size: 18 }), "New run"),
      h("button", { class: "btn", onclick: screenPractice }, "Practice")),
    h("button", { class: "btn btn-ghost", onclick: screenHome }, icon("home", { size: 18 }), "Home"),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/** Plain-language version of a sign-in failure code. */
const SIGN_IN_ERRORS = {
  state_mismatch: "Sign-in failed - it did not start in this tab",
  verify_failed: "Sign-in failed - the sign-in token had already expired",
  network: "Sign-in failed - the network dropped",
  no_token: "Sign-in failed - the provider sent us back without a login",
};

/** Our own codes get a sentence; the sign-in server already speaks in sentences. */
function signInErrorText(code) {
  return SIGN_IN_ERRORS[code] || code;
}

async function boot() {
  // An OAuth return must be handled before anything renders, so the player
  // lands on a signed-in screen rather than seeing a flash of signed-out UI.
  let justSignedIn = false;
  // The sign-in server returns #fp-auth=<token> (or #fp-auth-error=<reason>).
  const hadOAuthHash = cloud.hasSignInHash(location.hash);
  if (cloud.cloudConfigured() && hadOAuthHash) {
    try {
      justSignedIn = Boolean(await cloud.consumeRedirect());
    } catch {
      justSignedIn = false;
    }
    if (justSignedIn) {
      await syncNow({ quiet: true }).catch(() => cloud.queueSync());
      profile = store.load();
      // Adopt the provider's name only if the player has not chosen one.
      const u = cloud.currentUser();
      if (u && !profile.name) profile = store.setIdentity(profile, { name: u.name });
      toast("Signed in - progress backed up");
    } else {
      // Pressing Cancel is not a fault and gets no scolding. A real failure
      // names itself, because "sign-in failed" hides the reason it failed.
      const err = cloud.takeSignInError();
      if (err) toast(signInErrorText(err), 4200);
    }
  } else if (cloud.signedIn() && (cloud.hasQueued() || navigator.onLine !== false)) {
    // Returning signed-in player: sync quietly in the background, never block.
    syncInBackground();
  }

  const params = new URLSearchParams(location.search);
  const incomingRoom = params.get("room");
  const incomingRun = params.get("run");
  if (incomingRun) {
    // A friend's run link: the identical map and rooms. A daily-run seed only
    // plays as the daily on its own day; otherwise it is just a seed.
    history.replaceState({}, "", location.pathname);
    const seed = String(incomingRun).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 16) || randomSeedCode();
    startRun(seed, isDailyRunSeed(seed) && seed === dailyRunSeed());
  } else if (incomingRoom) {
    // A friend's invite: straight to the join box with the code filled in.
    history.replaceState({}, "", location.pathname);
    screenFriends(rooms.normalizeRoomCode(incomingRoom));
  } else if (justSignedIn) {
    screenProfile();
  } else {
    // Always land on home. A first-time player still gets the tutorial, but as
    // an obvious invitation on the home screen rather than by being dropped
    // into it - arriving somewhere you did not choose is its own confusion.
    screenHome();
  }
}

// The world goes up before the first screen, so nothing pops in behind it.
startAmbient();

// Test hook for local smoke tests only; never on the real site.
const LOCAL = ["127.0.0.1", "localhost"].includes(location.hostname);
if (LOCAL) {
  window.__ruledrift = { get play() { return play; }, get run() { return run; }, get room() { return room; } };
}

boot();

// Anything that failed to reach the server gets another chance on reconnect.
window.addEventListener("online", () => {
  if (cloud.signedIn() && cloud.hasQueued()) syncInBackground();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

