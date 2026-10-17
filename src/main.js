// Ruledrift - app shell, screens and the game loop.

import { Game, DOMAIN_LABELS, DOMAIN_BLURBS, RULE_BY_ID, RULES, MODES, modeConfig } from "./engine.js";
import { BOSS_RULES } from "./rules.js";
import { DriftRun, ACTS, NODE_TYPES, PERKS, STEPS_PER_ACT, dailyRunSeed, findDailyRun, isDailyRunSeed } from "./driftrun.js";
import { icon, AVATAR_ICONS } from "./icons.js";
import { startAmbient, shiftAmbient } from "./ambient.js";
import { randomSeedCode, normalizeSeedCode, dailySeedCode, dailyNumber, makeRng, hashSeed } from "./rng.js";
import { generateTrial, rulesUpToTier } from "./rules.js";
import * as store from "./storage.js";
import { tileSvg, tileLabel, crackSvg } from "./tiles.js";
import { lineChart, radarChart, streakCalendar, ruleBars } from "./charts.js";
import { buildShareText, decodePayload, compare, copyText, challengeUrl, runUrl } from "./share.js";
import { sfx, isMuted, toggleMute } from "./audio.js";
import * as juice from "./juice.js";
import { STEPS as TUT_STEPS, GUIDE_EXAMPLES, tutorialDone, markTutorialDone, resetTutorial } from "./tutorial.js";
import { achievementRows, rankFor, lifetimeStats, labelFor, iconFor } from "./achievements.js";
import * as cloud from "./cloud.js";

const app = document.getElementById("app");
let profile = store.load();
let game = null;
let run = null;
let loopHandle = null;
let onLeave = null;   // per-screen cleanup (e.g. a resize listener)

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

/** A small non-interactive board, used by the guide and the codex. */
function miniBoard(tiles, target) {
  return h("div", { class: "miniboard" },
    ...tiles.map((t, i) =>
      h("div", { class: "mt" + (i === target ? " hit" : "") }, tileSvg(t, { size: 26 }))));
}

/**
 * A worked example: a full-size board with a caption under every tile and the
 * winner marked. Someone who cannot follow the prose can still read the answer
 * straight off the picture.
 */
function workedExample(tiles, target, captionFn, note) {
  return h("div", {},
    h("div", { class: "exboard" },
      ...tiles.map((t, i) =>
        h("div", { class: "extile" + (i === target ? " win" : "") },
          h("div", { class: "exart" }, tileSvg(t, { size: 54 })),
          h("div", { class: "excap" }, captionFn(t, i)),
          i === target ? h("div", { class: "exwin" }, "WINNER") : null))),
    note ? h("p", { class: "small", style: "margin-top:10px" }, note) : null);
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

const COLOUR_WORDS = {
  cyan: "blue", amber: "orange", magenta: "pink", lime: "green", violet: "purple",
};
const plainColour = (c) => COLOUR_WORDS[c] || c;

/** A deterministic example board for a rule, so the guide always looks the same. */
function exampleFor(ruleId, salt = 1) {
  const rng = makeRng(hashSeed("example:" + ruleId + ":" + salt));
  const prev = { shape: "circle", color: "cyan", count: 3 };
  const { tiles, target } = generateTrial(rng, ruleId, prev, null);
  return { tiles, target, prev };
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------

// A fixed, pretty board for the hero: one of each shape, colour and count.
const HERO_STONES = [
  { shape: "triangle", color: "amber", count: 3 },
  { shape: "circle", color: "cyan", count: 1 },
  { shape: "hex", color: "violet", count: 5 },
  { shape: "diamond", color: "magenta", count: 2 },
  { shape: "square", color: "lime", count: 4 },
];

function screenHome() {
  const st = store.streakStatus(profile);
  const tier = store.tierFor(profile);
  const rank = rankFor(profile.xp);
  const fresh = !tutorialDone();
  const dailyRun = findDailyRun(profile.history);
  const dn = dailyNumber();

  const wrap = h("div", { class: "stack" },
    topBar(),

    h("div", { class: "hero" },
      h("div", { class: "hero-stones", "aria-hidden": "true" },
        ...HERO_STONES.map((t) => h("div", { class: "tile hs c-" + t.color }, tileSvg(t)))),
      h("h1", {}, "Ruledrift"),
      h("div", { class: "tag" }, "Nobody tells you the rule. Work it out. Then it changes."),
      h("div", { class: "pills" },
        h("span", { class: "streak-pill" + (st.streak > 0 ? " live" : "") },
          icon("flame", { size: 15 }), st.streak > 0 ? `${st.streak}-day streak` : "No streak yet"),
        profile.history.length
          ? h("span", { class: "streak-pill" }, icon("crown", { size: 15 }), `${rank.name} \u00b7 ${num(profile.xp)} XP`)
          : null)),

    // The hook: Drift Run, front and centre.
    h("div", { class: "runcard" },
      h("div", { class: "rc-head" },
        h("div", { class: "rc-mark" }, icon("map", { size: 26 })),
        h("div", {},
          h("div", { class: "eyebrow" }, "New \u00b7 Roguelite"),
          h("h2", {}, "Drift Run"),
          h("p", { class: "rc-sub" }, "Three acts. Choose your path, pick perks, and face a boss whose secret needs two things at once."))),
      h("div", { class: "btn-row" },
        dailyRun
          ? h("button", { class: "btn", onclick: () => screenRunEnd(dailyRun, { replay: true }) },
              icon("check", { size: 18 }), `Daily #${dn} \u00b7 ${num(dailyRun.score)}`)
          : h("button", { class: "btn btn-primary", onclick: () => startRun(dailyRunSeed(), true) },
              icon("calendar", { size: 18 }), `Daily #${dn}`),
        h("button", { class: dailyRun ? "btn btn-primary" : "btn", onclick: () => startRun(randomSeedCode(), false) },
          icon("dice", { size: 18 }), "New run")),
      dailyRun ? h("div", { class: "rc-done" }, "Today's Daily Run is done. A new one opens at midnight.") : null),

    // Never lose the tutorial just because home comes first now.
    fresh
      ? h("button", { class: "card learncard", onclick: () => { resetTutorial(); screenTutorial(); } },
          h("span", { class: "lc-icon" }, icon("spark", { size: 24 })),
          h("span", {},
            h("span", { class: "lc-title" }, "New here? Learn in 60 seconds"),
            h("span", { class: "lc-sub" }, "Five boards. It teaches itself - much easier than reading.")),
          h("span", { class: "go" }, icon("chevron", { size: 18 })))
      : null,

    menuItem("play", "Classic modes", "Daily, Quick play, Zen, Blitz, Gauntlet, Duel", screenPlay),

    h("div", { class: "menu" },
      menuItem("book", "How to play", "The rules, with worked examples", screenGuide),
      menuItem("chart", "My report", profile.history.length ? "Your profile over time" : "Play once to unlock",
        screenStats, !profile.history.length),
      menuItem("trophy", "Achievements", "What you have unlocked", screenAchievements),
      menuItem("codex", "Rule codex", `Every rule \u00b7 tier ${tier} of 3`, screenCodex),
      menuItem("user", "Profile", "Sound, your data and sign-in", screenProfile)),

    profile.history.length
      ? h("div", { class: "stat-grid" },
          stat(num(profile.bestScore), "Best score"),
          stat(profile.bestBrain || "\u2014", "Best brain"),
          stat(profile.history.length, "Sessions"))
      : null,

    footer());
  render(wrap);
}

function menuItem(iconName, title, sub, onclick, disabled = false) {
  return h("button", { class: "mode", onclick, disabled },
    h("span", { class: "ic" }, icon(iconName)),
    h("span", { class: "tx" },
      h("span", { class: "nm" }, title),
      h("span", { class: "bl" }, sub)),
    h("span", { class: "go" }, icon("chevron", { size: 18 })));
}

// ---------------------------------------------------------------------------
// PLAY - mode picker
// ---------------------------------------------------------------------------

function screenPlay() {
  const st = store.streakStatus(profile);
  const dn = dailyNumber();

  const modeBtn = (mode, iconName, onclick, hero = false) =>
    h("button", { class: "mode" + (hero ? " hero" : ""), onclick },
      h("span", { class: "ic" }, icon(iconName)),
      h("span", { class: "tx" },
        h("span", { class: "nm" }, mode.label),
        h("span", { class: "bl" }, mode.blurb)),
      h("span", { class: "go" }, icon("chevron", { size: 18 })));

  const wrap = h("div", { class: "stack" },
    header("Classic modes", screenHome),

    h("div", { class: "modes" },
      st.done
        ? modeBtn({ label: `Daily #${dn} complete`, blurb: "Tap to see today's result" }, "check",
            () => screenResult(profile.dailyResults[store.dayKey()], { replay: true }))
        : modeBtn({ ...MODES.daily, label: `Daily #${dn}` }, "calendar",
            () => startGame("daily", dailySeedCode()), true),
      modeBtn(MODES.quick, "target", () => startGame("quick", randomSeedCode())),
      modeBtn(MODES.zen, "lotus", () => startGame("zen", randomSeedCode())),
      modeBtn(MODES.blitz, "bolt", () => startGame("blitz", randomSeedCode())),
      modeBtn(MODES.gauntlet, "spiral", () => startGame("gauntlet", randomSeedCode())),
      modeBtn(MODES.duel, "swords", () => screenDuel())),

    h("p", { class: "small muted", style: "text-align:center" },
      "Not sure? ", h("b", {}, "Quick play"), " is the normal game. There is no clock until level 10."),

    h("button", { class: "btn btn-ghost", onclick: screenGuide }, "How to play"),
    footer());
  render(wrap);
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
          h("div", { class: "small muted" }, "Short blips on every answer")),
        h("button", { class: "btn btn-sm", onclick: (e) => {
          const m = toggleMute();
          e.currentTarget.textContent = m ? "Off" : "On";
        } }, muted ? "Off" : "On"))),

    h("div", { class: "card" },
      h("h3", {}, "Learning"),
      h("p", { class: "small muted" }, "Run the five-board walkthrough again any time."),
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
        "Ruledrift is built on the Wisconsin Card Sorting Task, a real test of cognitive flexibility. It measures how fast you adapt - it does not claim to raise your IQ. Made with AI by Mridul.")),
  ];
}

// ---------------------------------------------------------------------------
// TUTORIAL
//
// Scripted and unkillable. The player learns one rule by using it, is allowed to
// trust it, and then has it taken away on step 4 - which is the only way to
// teach the actual mechanic.
// ---------------------------------------------------------------------------

function screenTutorial() {
  let i = 0;
  let attempts = 0;

  const progress = h("div", { class: "tut-progress" },
    ...TUT_STEPS.map(() => h("i")));
  const banner = h("div", { class: "tut-banner" });
  const board = h("div", { class: "board" });
  const nextBtn = h("button", { class: "btn btn-primary", style: "display:none" }, "Continue");

  const wrap = h("div", { class: "stack" },
    header("Learn in 60 seconds", screenHome),
    progress,
    banner,
    board,
    nextBtn,
    h("button", { class: "btn btn-ghost", onclick: () => { markTutorialDone(); screenHome(); } },
      "Skip - I'll work it out"),
    footer());
  render(wrap);

  function paint() {
    const step = TUT_STEPS[i];
    attempts = 0;
    [...progress.children].forEach((d, k) => d.classList.toggle("on", k <= i));
    banner.className = "tut-banner";
    banner.textContent = step.prompt;
    nextBtn.style.display = "none";
    board.replaceChildren(
      ...step.tiles.map((tile, idx) => stoneButton(tile, idx, (e) => tap(idx, e.currentTarget))));
  }

  function tap(idx, el) {
    const step = TUT_STEPS[i];
    if (idx === step.target) {
      el.classList.add("correct");
      sfx.correct(i + 2);
      juice.celebrate(el, step.switched ? "GOT IT" : "RIGHT", !!step.switched);
      banner.className = "tut-banner" + (step.switched ? " reveal" : "");
      banner.replaceChildren(
        h("b", {}, step.success), document.createTextNode(" " + step.teach));
      nextBtn.style.display = "";
      nextBtn.textContent = i === TUT_STEPS.length - 1 ? "Play for real" : "Continue";
      board.querySelectorAll(".tile").forEach((t) => (t.onclick = null));
    } else {
      attempts++;
      crack(el);
      setTimeout(() => uncrack(el), 700);
      sfx.wrong();
      juice.punish(el, board);
      banner.className = "tut-banner oops";
      // The step-4 miss is the whole lesson, so it gets the real explanation
      // immediately rather than a generic nudge.
      banner.textContent = attempts >= 2 && step.failHint ? step.failHint : step.fail;
    }
  }

  nextBtn.onclick = () => {
    i++;
    if (i >= TUT_STEPS.length) {
      markTutorialDone();
      toast("Tutorial complete");
      startGame("quick", randomSeedCode());
    } else {
      paint();
    }
  };

  document.onkeydown = (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) {
      const el = board.children[n - 1];
      if (el && el.onclick) el.click();
    }
    if (e.key === "Enter" && nextBtn.style.display === "") nextBtn.click();
  };

  paint();
}

// ---------------------------------------------------------------------------
// GAME
// ---------------------------------------------------------------------------

/** One rune stone, as a button. Shared by the tutorial, the classic game and Drift Run. */
function stoneButton(tile, i, onclick) {
  return h("button", {
    class: "tile c-" + tile.color, "aria-label": tileLabel(tile, i), onclick,
  }, h("span", { class: "key" }, String(i + 1)), tileSvg(tile));
}

function crack(el) {
  if (!el) return;
  el.classList.add("wrong");
  if (!el.querySelector(".crack")) el.appendChild(crackSvg(Math.floor(Math.random() * 3)));
}

function uncrack(el) {
  if (!el) return;
  el.classList.remove("wrong");
  const c = el.querySelector(".crack");
  if (c) c.remove();
}

/** Hearts, filled for what is left. */
function heartsRow(cur, max, popIndex = -1) {
  return h("div", { class: "lives", role: "img", "aria-label": `${Math.max(0, cur)} of ${max} lives left` },
    ...Array.from({ length: max }, (_, k) =>
      h("span", { class: "life" + (k < cur ? "" : " lost") + (k === popIndex ? " pop" : "") },
        icon(k < cur ? "heart" : "heartOutline", { size: 18 }))));
}

function startGame(mode, seed) {
  game = new Game({ seed, mode, maxTier: store.tierFor(profile) });
  screenGame();
}

function screenGame() {
  const cfg = modeConfig(game.mode);
  const scoreEl = h("div", { class: "score" }, "0");
  const metaEl = h("div", { class: "meta" }, "");
  const livesEl = h("div", { class: "lives" });
  const barFill = h("i");
  const bar = h("div", { class: "timerbar" }, barFill);
  const board = h("div", { class: "board" });
  const feed = h("div", { class: "feedline" }, "");

  const noClock = h("div", { class: "noclock" }, "No clock \u00b7 take your time");
  const clockSlot = h("div", { class: "clockslot" }, noClock);

  const wrap = h("div", { class: "stack" },
    h("div", { class: "top gtop" },
      h("button", { class: "icon-btn", "aria-label": "Quit",
        onclick: () => { if (confirm("Quit this run?")) screenHome(); } }, icon("close")),
      h("div", { class: "hud-score" }, scoreEl, metaEl),
      h("div", { class: "spacer" }),
      livesEl),
    clockSlot,
    board,
    feed);
  render(wrap);

  let trialStart = 0;
  let locked = false;
  const hintsOn = profile.history.length < 2;
  let consecutiveWrong = 0;
  let comeback = false;
  let clockAnnounced = false;

  function paintHud() {
    scoreEl.textContent = num(game.score);
    metaEl.textContent = `${cfg.label} \u00b7 L${game.level} \u00b7 streak ${game.streak}`;
    livesEl.replaceChildren(heartsRow(game.lives, game.maxLives));

    // The clock arrives partway through a run, so this has to be re-checked
    // every board rather than decided once from the mode.
    if (game.timed) {
      if (clockSlot.firstChild !== bar) clockSlot.replaceChildren(bar);
      if (!clockAnnounced) {
        clockAnnounced = true;
        announceClock();
      }
    } else if (clockSlot.firstChild !== noClock) {
      clockSlot.replaceChildren(noClock);
    }
  }

  /** The clock showing up is a real moment - mark it. */
  function announceClock() {
    const secs = Math.round(game.timeLimitMs / 1000);
    const banner = h("div", { class: "clockcut" },
      h("div", { class: "cc-title" }, icon("clock", { size: 22 }), "The clock starts"),
      h("div", { class: "cc-sub" }, `You have ${secs} seconds a board from here. It gets shorter each level.`));
    document.body.appendChild(banner);
    sfx.adapt();
    setTimeout(() => banner.remove(), 2600);
  }

  function paintBoard() {
    const t = game.trial;
    board.replaceChildren(...t.tiles.map((tile, i) => stoneButton(tile, i, (e) => choose(i, e.currentTarget))));
  }

  function nextTrial() {
    if (game.over) return finish();
    paintHud();
    paintBoard();
    locked = false;
    trialStart = performance.now();
    game.markShown(trialStart);
  }

  function choose(index, el) {
    if (locked || game.over) return;
    locked = true;
    const rt = performance.now() - trialStart;
    const wasSwitch = game.trial.isSwitchTrial;
    const target = game.trial.target;
    const rec = game.answer(index, rt);
    const nodes = board.children;

    if (rec.correct) {
      nodes[index].classList.add("correct");
      sfx.correct(game.streak);
      consecutiveWrong = 0;
      if (game.streak >= 10 && game.maxLives - game.lives >= 2) comeback = true;

      if (wasSwitch) {
        sfx.adapt();
        juice.celebrate(nodes[index], `+${num(rec.gained)}`, true);
        feed.className = "feedline hint";
        feed.textContent = "Caught the change.";
      } else {
        juice.celebrate(nodes[index], `+${num(rec.gained)}`, false);
        feed.className = "feedline good";
        feed.textContent = game.streak >= 3 ? `${game.streak} in a row` : "";
      }
    } else {
      if (index >= 0 && nodes[index]) crack(nodes[index]);
      if (nodes[target]) nodes[target].classList.add("reveal");
      sfx.wrong();
      juice.punish(index >= 0 ? nodes[index] : null, board);
      consecutiveWrong++;
      feed.className = rec.freeLook ? "feedline hint" : "feedline bad";
      feed.textContent = rec.freeLook
        ? "The rule just changed. That one was free - look at the answer."
        : rec.perseverative
          ? "That was the old rule."
          : rec.timedOut ? "Too slow." : "Not that one.";
      // Onboarding only: the silence is the game, but a brand-new player who is
      // drowning gets one nudge so they learn that rules change at all.
      if (hintsOn && consecutiveWrong >= 2) {
        feed.className = "feedline hint";
        feed.textContent = "The rule changed. Find the new one.";
      }
    }

    // The light shifts only once the first board of a new rule has been
    // answered, so it never gives a change away in advance.
    if (wasSwitch) setTimeout(shiftAmbient, 120);

    setTimeout(() => { feed.textContent = ""; nextTrial(); }, rec.correct ? 280 : 660);
  }

  function finish() {
    stopLoop();
    sfx.over();
    const result = game.result();
    result.comeback = comeback;
    const { newlyUnlocked, xpGained } = store.recordResult(profile, result);
    profile = store.load();
    syncInBackground();
    setTimeout(() => screenResult(result, { newlyUnlocked, xpGained }), 400);
  }

  document.onkeydown = (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) {
      e.preventDefault();
      const el = board.children[n - 1];
      if (el) choose(n - 1, el);
    }
    if (e.key === "Escape") screenHome();
  };

  function loop() {
    if (!game || game.over) return;
    if (!locked && game.timed) {
      const elapsed = performance.now() - trialStart;
      const frac = Math.max(0, 1 - elapsed / game.timeLimitMs);
      barFill.style.transform = `scaleX(${frac})`;
      bar.classList.toggle("low", frac < 0.3);
      if (elapsed >= game.timeLimitMs) {
        locked = true;
        const rec = game.answer(-1, game.timeLimitMs);
        const t = board.children[rec.target];
        if (t) t.classList.add("reveal");
        sfx.wrong();
        juice.punish(null, board);
        feed.className = "feedline bad";
        feed.textContent = "Too slow.";
        setTimeout(() => { feed.textContent = ""; nextTrial(); }, 660);
      }
    }
    loopHandle = requestAnimationFrame(loop);
  }

  nextTrial();
  loopHandle = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// RESULT
// ---------------------------------------------------------------------------

function screenResult(result, { replay = false, newlyUnlocked = [], xpGained = 0 } = {}) {
  const url = challengeUrl(result.seed);
  const shareText = buildShareText(result, {
    url: result.mode === "daily" ? location.origin + location.pathname : url,
    dailyNumber: dailyNumber(),
    name: profile.name,
  });

  const compareBox = h("textarea", {
    placeholder: "Paste your friend's result code here...", "aria-label": "Friend result code",
  });
  const compareOut = h("div", {});

  const wrap = h("div", { class: "stack" },
    header(replay ? "Today's result" : "Run over", screenHome),

    h("div", { class: "card" },
      h("div", { class: "bigscore" },
        h("div", { class: "v" }, num(result.score)),
        h("div", { class: "k" },
          `${modeConfig(result.mode).label} \u00b7 L${result.level} \u00b7 ${result.correct}/${result.trials} correct \u00b7 best streak ${result.maxStreak}`)),
      h("div", { style: "text-align:center" },
        h("div", { class: "brainbadge" },
          h("div", { class: "n" }, String(result.brainScore)),
          h("div", { class: "tiny" }, "Brain score"))),
      xpGained ? h("p", { class: "small muted", style: "text-align:center;margin:12px 0 0" },
        `+${num(xpGained)} XP \u00b7 ${rankFor(profile.xp).name}`) : null),

    unlockedCard(newlyUnlocked),

    h("div", { class: "card" },
      h("h3", {}, "How you adapted"),
      h("p", { class: "small muted" },
        result.ruleChanges === 0
          ? "The rule never changed this run - too short."
          : `The rule changed ${result.ruleChanges} time${result.ruleChanges === 1 ? "" : "s"}. ` +
            (result.meanAdaptationLatency !== null
              ? `You locked back on in ${result.meanAdaptationLatency} trials on average.`
              : "You never found it again.") +
            (result.perseverativeErrors
              ? ` ${result.perseverativeErrors} of your mistakes were the old rule still running.`
              : " None of your mistakes were the old rule - clean switching.")),
      domainList(result.domains)),

    h("div", { class: "card" },
      h("h3", {}, "Share this run"),
      stripView(result, "margin:12px 0"),
      stripLegend(),
      h("div", { class: "btn-row", style: "margin-top:14px" },
        h("button", { class: "btn btn-primary", onclick: async () => {
          if (navigator.share) { try { await navigator.share({ text: shareText }); return; } catch {} }
          toast((await copyText(shareText)) ? "Result copied" : "Copy failed");
        } }, "Share result"),
        result.mode !== "daily"
          ? h("button", { class: "btn", onclick: async () => {
              toast((await copyText(url)) ? "Challenge link copied" : "Copy failed");
            } }, "Copy board link")
          : null),
      h("p", { class: "small muted", style: "margin-top:10px" },
        "The code carries your score. Your friend pastes it back to see who won - the board is identical, so the comparison is fair.")),

    h("div", { class: "card" },
      h("h3", {}, "Compare with a friend"),
      compareBox,
      h("button", { class: "btn btn-sm", style: "margin-top:10px", onclick: () => {
        const them = decodePayload(compareBox.value);
        if (!them) { toast("Could not read that code"); return; }
        const c = compare(result, them);
        store.recordDuel(profile, { seed: result.seed, mine: result.score, theirs: them.score, at: Date.now() });
        profile = store.load();
        compareOut.replaceChildren(compareTable(c, them));
      } }, "Compare"),
      compareOut),

    h("div", { class: "btn-row" },
      h("button", { class: "btn btn-primary", onclick: () => startGame(result.mode === "daily" ? "quick" : result.mode, randomSeedCode()) }, "Play again"),
      h("button", { class: "btn", onclick: screenStats }, "My report")),
    h("button", { class: "btn btn-ghost", onclick: screenHome }, "Home"),
    footer());
  render(wrap);
}

/** The run as drawn squares - shape and colour both carry the meaning. */
function stripView(result, style = "", maxLen = 40) {
  const log = result.log || [];
  const trimmed = log.length > maxLen ? log.slice(-maxLen) : log;
  return h("div", { class: "strip", style, role: "img", "aria-label": `${trimmed.filter((t) => t.c).length} of ${trimmed.length} correct` },
    ...trimmed.map((t) => h("i", { class: t.c ? (t.s ? "s" : "c") : t.p ? "p" : "w" })));
}

function stripLegend() {
  const one = (cls) => h("span", { class: "strip" }, h("i", { class: cls }));
  return h("div", { class: "legend" },
    h("span", {}, one("c"), "correct"),
    h("span", {}, one("s"), "caught a change"),
    h("span", {}, one("p"), "stuck on old rule"),
    h("span", {}, one("w"), "wrong"));
}

function unlockedCard(ids) {
  if (!ids || !ids.length) return null;
  return h("div", { class: "card" },
    h("h3", {}, ids.length === 1 ? "Achievement unlocked" : "Achievements unlocked"),
    h("div", { style: "margin-top:8px" },
      ...ids.map((id) => h("span", { class: "rulechip" }, icon(iconFor(id), { size: 16 }), labelFor(id)))));
}

function domainList(domains) {
  return h("div", { class: "domain-list" },
    ...Object.entries(DOMAIN_LABELS).map(([k, label]) => {
      const v = domains[k];
      return h("div", { class: "domain-item", title: DOMAIN_BLURBS[k] },
        h("span", {}, label),
        h("span", { class: "domain-bar" }, h("i", { style: `width:${v == null ? 0 : v}%` })),
        h("span", { class: "domain-val" }, v == null ? "\u2014" : String(v)));
    }));
}

function compareTable(c, them) {
  return h("div", { style: "margin-top:14px" },
    h("div", { class: `verdict ${c.verdict}` },
      c.verdict === "win" ? "You win" : c.verdict === "loss" ? `${them.name} wins` : "Dead tie"),
    !c.sameBoard
      ? h("p", { class: "small", style: "color:var(--warn)" },
          "Different boards - not a like-for-like comparison. Use the same seed for a real duel.")
      : null,
    h("table", { class: "cmp" },
      h("thead", {}, h("tr", {}, h("th", {}, "Metric"), h("th", {}, "You"), h("th", {}, them.name))),
      h("tbody", {}, ...c.rows.map((r) =>
        h("tr", {},
          h("td", {}, r.label),
          h("td", { class: r.better > 0 ? "win" : r.better < 0 ? "lose" : "" }, String(r.mine)),
          h("td", { class: r.better < 0 ? "win" : r.better > 0 ? "lose" : "" }, String(r.theirs)))))));
}

// ---------------------------------------------------------------------------
// GUIDE
// ---------------------------------------------------------------------------

function screenGuide() {
  // Boards come from tutorial.js so the test suite can verify the captions.
  const boardA = GUIDE_EXAMPLES.mostDots.tiles;
  const boardB = GUIDE_EXAMPLES.uniqueColour.tiles;

  const wrap = h("div", { class: "stack" },
    header("How to play", screenHome),

    h("div", { class: "card" },
      h("h3", { style: "font-size:18px" }, "The game keeps a secret"),
      h("p", {},
        "Five tiles show up. ", h("b", {}, "One of them is the winner."), " The game knows why, but it will not tell you."),
      h("p", {},
        "You tap a stone to guess. It ", h("b", { style: "color:var(--good)" }, "flares gold"),
        " if you were right and ", h("b", { style: "color:var(--bad)" }, "cracks"), " if you were wrong."),
      h("p", { style: "margin-bottom:0" },
        "By guessing a few times you work out the secret. ",
        h("b", {}, "Then the game quietly changes it"), " and you have to work out the new one.")),

    h("div", { class: "card" },
      h("button", { class: "btn btn-primary", onclick: () => { resetTutorial(); screenTutorial(); } },
        icon("play", { size: 16 }), "Show me - 60 seconds"),
      h("p", { class: "small muted", style: "margin:10px 0 0" },
        "This is much easier than reading. It walks you through five boards and you learn it by playing.")),

    h("div", { class: "card" },
      h("h3", {}, "Every tile has three things"),
      h("p", { class: "small" }, "That is all a tile is. Any one of the three can be the secret."),
      h("div", { class: "threeup" },
        h("div", {}, h("div", { class: "tu-art" }, tileSvg({ shape: "hex", color: "lime", count: 4 }, { size: 46 })),
          h("b", {}, "Shape"), h("div", { class: "small muted" }, "circle, square, triangle, diamond, six-sided")),
        h("div", {}, h("div", { class: "tu-art" }, tileSvg({ shape: "circle", color: "magenta", count: 3 }, { size: 46 })),
          h("b", {}, "Colour"), h("div", { class: "small muted" }, "blue, orange, pink, green, purple")),
        h("div", {}, h("div", { class: "tu-art" }, tileSvg({ shape: "square", color: "cyan", count: 2 }, { size: 46 })),
          h("b", {}, "Dots"), h("div", { class: "small muted" }, "one to five dots inside the shape")))),

    h("div", { class: "card" },
      h("h3", {}, "Worked example 1 - the secret is \u201cmost dots\u201d"),
      h("p", { class: "small" }, "Ignore the shapes and colours completely. Just count the dots on each tile:"),
      workedExample(boardA, GUIDE_EXAMPLES.mostDots.target, (t) => `${t.count} dot${t.count === 1 ? "" : "s"}`,
        "4 is the biggest number, so the green six-sided tile wins. If you tapped it, it flares gold.")),

    h("div", { class: "card" },
      h("h3", {}, "Worked example 2 - the secret has changed"),
      h("p", { class: "small" },
        "Now the same game gives you this board. If you still count dots you would tap the first tile, because it has 5. ",
        h("b", {}, "It cracks."), " The secret is not about dots any more. Look at the colours instead:"),
      workedExample(boardB, GUIDE_EXAMPLES.uniqueColour.target, (t) => plainColour(t.color),
        "Two blue, two orange - and one green sitting on its own. The lonely colour wins."),
      h("p", { class: "small", style: "margin-top:10px" },
        h("b", {}, "This is the whole game."), " Nothing warns you that the secret changed. You find out because your answer suddenly cracks. When that happens, stop using your old idea and look for a new one.")),

    h("div", { class: "card" },
      h("h3", {}, "There is no clock while you are learning"),
      h("p", { class: "small" },
        "For the first nine levels nothing is timing you. Sit and stare at a board for a minute if you want to - working out the secret is the whole point, and rushing that would only teach you to panic."),
      h("p", { class: "small" },
        "From ", h("b", {}, "level 10"), " a clock appears, and it announces itself when it does. It starts at a very generous ",
        h("b", {}, "20 seconds"), " a board, then gets a little shorter each level after that, down to a minimum of under two seconds a long way later."),
      h("p", { class: "small", style: "margin-bottom:0" },
        "If you never want a clock at all, play ", h("b", {}, "Zen"), ". If you want one from the very first board, play ", h("b", {}, "Blitz"), ".")),

    h("div", { class: "card" },
      h("h3", {}, "How a round ends"),
      h("ul", { class: "plainlist" },
        h("li", {}, h("b", {}, "Three mistakes and the round is over."), " The dots at the top right show how many you have left."),
        h("li", {}, h("b", {}, "The board right after the secret changes is free."),
          " You could not possibly have known the new secret, so getting that one wrong costs you nothing. Look carefully at which stone lights up gold - that is your clue."),
        h("li", {}, h("b", {}, "Repeating a dead idea does cost you."),
          " Once you have been shown the change, sticking with the old secret is a real mistake."),
        h("li", {}, "A level is six correct answers, so the clock at level 10 means about ", h("b", {}, "54 right"), " in one round. It is meant to be a milestone."))),

    h("div", { class: "card" },
      h("h3", {}, "Drift Run"),
      h("p", { class: "small" },
        "A short run through three acts. At each step you choose left or right: a ", h("b", {}, "chamber"),
        " (four right answers to pass), an ", h("b", {}, "elite"), " (the rule turns every two or three, and you earn a perk), or a ",
        h("b", {}, "campfire"), " (rest and pick a perk). Each act ends with a ", h("b", {}, "boss"),
        " whose secret needs two things at once - colour and shape, or colour and dots."),
      h("p", { class: "small", style: "margin-bottom:0" },
        "You have three hearts for the whole run. The first board of every room is free, because you cannot know a rule you have never seen. The Daily Run is the same map for everyone today.")),

    h("div", { class: "card" },
      h("h3", {}, "Controls"),
      h("p", { class: "small" }, "Tap a tile with your finger or mouse. On a keyboard, press ", h("b", {}, "1"), " to ", h("b", {}, "5"), " to pick a tile, and ", h("b", {}, "Esc"), " to quit a round.")),

    h("div", { class: "card" },
      h("h3", {}, "All the secrets it can use"),
      h("p", { class: "small" }, "There are eight. You start with four, and the rest arrive as you play."),
      ...RULES.map((r) =>
        h("div", { class: "rulerow" },
          h("b", {}, r.label),
          h("div", { class: "small muted" }, r.reveal)))),

    h("div", { class: "card" },
      h("h3", {}, "The five scores"),
      h("div", { class: "domain-list" },
        ...Object.entries(DOMAIN_LABELS).map(([k, label]) =>
          h("div", {},
            h("b", { style: "font-size:13.5px" }, label),
            h("p", { class: "small muted", style: "margin:2px 0 0" }, DOMAIN_BLURBS[k]))))),

    h("div", { class: "card" },
      h("h3", {}, "Playing with friends"),
      h("p", { class: "small muted" },
        "There is no server and no account. A seed code fully determines the board, so anyone playing your seed gets the same tiles in the same order. Share the seed, play separately - even offline - then paste each other's result codes to compare. The duel is exact.")),

    h("div", { class: "card" },
      h("h3", {}, "An honest note on brain training"),
      h("p", { class: "small muted" },
        "This is built on the Wisconsin Card Sorting Task, a real test of cognitive flexibility, and it measures two things clinicians use: perseverative errors and adaptation latency."),
      h("p", { class: "small muted" },
        "But be sceptical of anyone selling you a smarter brain. The evidence says practice makes you better at the trained task and closely related ones; it does not reliably raise general intelligence. Ruledrift shows you a real measurement of how you adapt. It does not claim to raise your IQ.")),

    h("button", { class: "btn btn-primary", onclick: () => startGame("quick", randomSeedCode()) }, "Start playing"),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// CODEX
// ---------------------------------------------------------------------------

function screenCodex() {
  const tier = store.tierFor(profile);
  const unlocked = new Set(rulesUpToTier(tier).map((r) => r.id));

  const wrap = h("div", { class: "stack" },
    header("Rule codex", screenHome),
    h("p", { class: "small muted" },
      "Every rule the game can use. New ones unlock as you play - three sessions for tier 2, eight for tier 3."),
    h("div", { class: "card" },
      ...RULES.map((r) => {
        const known = unlocked.has(r.id);
        const s = profile.ruleStats[r.id];
        const acc = s && s.seen ? Math.round((s.correct / s.seen) * 100) : null;
        const ex = known ? exampleFor(r.id, 2) : null;
        return h("div", { class: "codex-item" + (known ? "" : " locked") },
          known ? miniBoard(ex.tiles, ex.target) : h("div", { class: "miniboard" },
            ...[0, 1, 2].map(() => h("div", { class: "mt" }, icon("lock", { size: 16 })))),
          h("div", { class: "cx-body" },
            h("div", { style: "font-weight:700;font-size:14.5px" },
              known ? r.label : "Locked", h("span", { class: "tiny", style: "margin-left:8px" }, `Tier ${r.tier}`)),
            h("div", { class: "small muted", style: "margin-top:2px" },
              known ? r.reveal : "Keep playing to unlock."),
            s ? h("div", { class: "tiny", style: "margin-top:5px" },
              `seen ${s.seen} \u00b7 ${acc}% correct`) : null));
      })),
    h("div", { class: "card" },
      h("div", { class: "section-h" }, h("span", { style: "color:#ff9f7a" }, icon("crown")), h("h3", {}, "Boss rules")),
      h("p", { class: "small muted" }, "Only in Drift Run, at the end of each act. Each one needs two things at once. They show here once you have met them."),
      ...BOSS_RULES.map((r) => {
        const s = profile.ruleStats[r.id];
        const known = !!(s && s.seen);
        const ex = known ? exampleFor(r.id, 2) : null;
        const acc = known ? Math.round((s.correct / s.seen) * 100) : null;
        return h("div", { class: "codex-item" + (known ? "" : " locked") },
          known ? miniBoard(ex.tiles, ex.target) : h("div", { class: "miniboard" },
            ...[0, 1, 2].map(() => h("div", { class: "mt" }, icon("lock", { size: 16 })))),
          h("div", { class: "cx-body" },
            h("div", { style: "font-weight:800;font-size:14.5px" }, known ? r.label : "Unmet boss"),
            h("div", { class: "small muted", style: "margin-top:2px" },
              known ? r.reveal : "Reach a boss room in Drift Run to meet it."),
            known ? h("div", { class: "tiny", style: "margin-top:5px" }, `seen ${s.seen} \u00b7 ${acc}% correct`) : null));
      })),
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// ACHIEVEMENTS
// ---------------------------------------------------------------------------

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
    placeholder: "Your name (shown in duels)",
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
      h("p", { class: "small muted" }, "Used to label you in a duel comparison."),
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
        stat(s.sessions, "Sessions"),
        stat(num(s.totalTrials), "Boards"),
        stat(s.totalTrials ? Math.round((s.totalCorrect / s.totalTrials) * 100) + "%" : "\u2014", "Accuracy")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(s.adaptations, "Adaptations"),
        stat(s.bestRunStreak, "Best streak"),
        stat(s.longestStreak, "Day streak")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(num(s.bestScore), "Best score"),
        stat(s.bestBrain || "\u2014", "Best brain"),
        stat(`${s.rulesSeen}/8`, "Rules met"))),

    h("div", { class: "btn-row" },
      h("button", { class: "btn", onclick: screenAchievements }, "Achievements"),
      h("button", { class: "btn", onclick: screenStats, disabled: !profile.history.length }, "Report")),

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
// DUEL
// ---------------------------------------------------------------------------

function screenDuel(prefill = "") {
  const seedInput = h("input", { type: "text", placeholder: "Seed code, e.g. K7F2QM", value: prefill, maxlength: "12" });
  const mySeed = randomSeedCode();

  const wrap = h("div", { class: "stack" },
    header("Duel a friend", screenHome),
    h("div", { class: "card stack" },
      h("h3", {}, "1. Start a new board"),
      h("p", { class: "small muted" },
        "A seed is the whole game. Send it to a friend and you both play the identical board - no account, no server, and it works with the network off."),
      h("div", { class: "row" },
        h("div", { class: "mono", style: "font-size:26px;font-weight:800;letter-spacing:3px;flex:1" }, mySeed),
        h("button", { class: "btn btn-sm", onclick: async () => {
          toast((await copyText(challengeUrl(mySeed))) ? "Link copied" : "Copy failed");
        } }, "Copy link")),
      h("button", { class: "btn btn-primary", onclick: () => startGame("duel", mySeed) }, "Play this board")),
    h("div", { class: "card stack" },
      h("h3", {}, "2. Or join their board"),
      seedInput,
      h("button", { class: "btn", onclick: () => {
        const s = normalizeSeedCode(seedInput.value);
        if (s.length < 4) { toast("Enter their seed code"); return; }
        startGame("duel", s);
      } }, "Play their board")),
    profile.duels.length
      ? h("div", { class: "card" },
          h("h3", {}, "Recent duels"),
          ...profile.duels.slice(0, 6).map((d) =>
            h("div", { class: "between", style: "padding:7px 0;border-bottom:1px solid var(--line)" },
              h("span", { class: "mono small" }, d.seed),
              h("span", { class: "small", style: `color:${d.mine >= d.theirs ? "var(--good)" : "var(--bad)"}` },
                `${num(d.mine)} v ${num(d.theirs)}`))))
      : null,
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// STATS / REPORT
// ---------------------------------------------------------------------------

function screenStats() {
  const hist = profile.history;
  const recent = hist.slice(-30);
  const last = hist[hist.length - 1];

  // Average each domain over the last 10 sessions, so one bad run does not
  // redraw the whole profile.
  const avg = (arr, k) => {
    const vals = arr.map((r) => r.domains[k]).filter((v) => typeof v === "number");
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const window10 = hist.slice(-10);
  const baseline = hist.slice(0, 5);
  const avgDomains = {};
  const baseDomains = {};
  for (const k of Object.keys(DOMAIN_LABELS)) {
    avgDomains[k] = avg(window10, k);
    baseDomains[k] = avg(baseline, k);
  }

  const ruleRows = Object.entries(profile.ruleStats)
    .filter(([, v]) => v.seen > 0)
    .map(([id, v]) => ({ label: (RULE_BY_ID[id] || { label: id }).label, value: v.correct / v.seen }))
    .sort((a, b) => b.value - a.value);

  const st = store.streakStatus(profile);

  const wrap = h("div", { class: "stack" },
    header("Your brain report", screenHome),

    h("div", { class: "stat-grid" },
      stat(hist.length, "Sessions"),
      stat(st.longest || st.streak, "Longest streak"),
      stat(profile.bestBrain || "\u2014", "Best brain")),

    h("div", { class: "card" },
      h("h3", {}, "Cognitive profile"),
      h("p", { class: "small muted" },
        baseline.length >= 3
          ? "Solid: your last 10 sessions. Dashed: your first 5, for comparison."
          : "Solid line: your last 10 sessions."),
      h("div", { style: "display:grid;place-items:center" },
        radarChart(avgDomains, DOMAIN_LABELS, { size: 300, compare: baseline.length >= 3 ? baseDomains : null })),
      domainList(avgDomains)),

    h("div", { class: "card" },
      h("h3", {}, "Brain score over time"),
      h("div", { class: "chart-wrap" }, lineChart(recent.map((r) => r.brainScore), { label: "Brain score" }))),

    h("div", { class: "card" },
      h("h3", {}, "Adaptation speed"),
      h("p", { class: "small muted" }, "Trials needed to lock on after a silent rule change. Lower is better."),
      h("div", { class: "chart-wrap" },
        lineChart(recent.map((r) => r.meanAdaptationLatency).filter((v) => typeof v === "number"),
          { label: "Adaptation latency", color: "var(--accent-2)" }))),

    h("div", { class: "card" },
      h("h3", {}, "Reaction time"),
      h("div", { class: "chart-wrap" },
        lineChart(recent.map((r) => r.meanRt), { label: "Mean reaction time", color: "var(--warn)", format: (v) => `${v}ms` }))),

    ruleRows.length
      ? h("div", { class: "card" },
          h("h3", {}, "Accuracy by rule"),
          h("p", { class: "small muted" }, "Which rules you actually spot, and which ones catch you out."),
          h("div", { class: "chart-wrap" }, ruleBars(ruleRows)))
      : null,

    h("div", { class: "card" },
      h("h3", {}, "Daily calendar"),
      h("div", { class: "chart-wrap" }, streakCalendar(profile.dailyResults))),

    last
      ? h("div", { class: "card" },
          h("h3", {}, "Last run"),
          stripView(last, "margin:10px 0"),
          h("div", { class: "small muted" },
            `${modeConfig(last.mode).label} \u00b7 ${num(last.score)} pts \u00b7 ${Math.round(last.accuracy * 100)}% \u00b7 ${last.perseverativeErrors} perseverative error${last.perseverativeErrors === 1 ? "" : "s"}`))
      : null,
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// DRIFT RUN
//
// A seeded three-act descent. The engine (driftrun.js) owns every rule and
// number; these screens only draw it and pass taps through.
// ---------------------------------------------------------------------------

const ROMAN = ["I", "II", "III"];
const NODE_ICON = { room: "stone", elite: "skull", rest: "campfire", boss: "crown" };
const PERK_ICON = { heart: "heart", mend: "heartOutline", slow: "hourglass", peek: "eye", shield: "shield", hoard: "flame" };
const FAMILY_WORDS = { dots: "dots", colour: "colour", shape: "shape", memory: "the last winner" };

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
  screenHome();
}

/** The strip of chips under the top bar: score, depth and what you are carrying. */
function runChips(r, { peekBtn = null } = {}) {
  return h("div", { class: "runhud" },
    h("span", { class: "chip" }, icon("spark", { size: 14 }), num(r.score)),
    h("span", { class: "chip" }, icon("map", { size: 14 }), `Depth ${r.depth}/${r.length}`),
    r.perks.slow ? h("span", { class: "chip teal" }, icon("hourglass", { size: 14 }), "Slow clock") : null,
    r.perks.shield ? h("span", { class: "chip teal" }, icon("shield", { size: 14 }), `Shield \u00d7${r.perks.shield}`) : null,
    peekBtn || (r.perks.peek ? h("span", { class: "chip teal" }, icon("eye", { size: 14 }), `Peek \u00d7${r.perks.peek}`) : null));
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
      state === "open" ? h("span", { class: "nb" }, n.type === "boss" ? "Two-part secrets. Six to win." : kind.blurb) : null);
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
          "Pick a path. Every act ends in a boss. Three hearts for the whole run.")
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
  const node = run.enter(id);
  if (!node) return;
  if (run.phase === "perk") screenRunPerk();
  else {
    shiftAmbient();
    screenRunRoom();
  }
}

// ---- a room ---------------------------------------------------------------

function screenRunRoom() {
  const r = run;
  const g = r.game;
  const node = r.node;
  const kind = NODE_TYPES[node.type];
  const isBoss = node.type === "boss";

  const scoreChip = h("span", { class: "chip" }, icon("spark", { size: 14 }), num(r.score));
  const pips = h("div", { class: "roompips", "aria-label": "Progress in this room" },
    ...Array.from({ length: g.goal }, () => h("i")));
  const barFill = h("i");
  const bar = h("div", { class: "timerbar" }, barFill);
  const noClock = h("div", { class: "noclock" }, "No clock in this act");
  const clockSlot = h("div", { class: "clockslot" }, g.timed ? bar : noClock);
  const board = h("div", { class: "board" });
  const feed = h("div", { class: "feedline" }, "");
  const peekLine = h("div", { class: "peekline" });
  const heartsSlot = h("div", {}, heartsRow(r.hearts, r.maxHearts));
  const chipSlot = h("div", {});

  const wrap = h("div", { class: "stack roomwrap" },
    h("div", { class: "top gtop" },
      h("button", { class: "icon-btn", "aria-label": "Leave run", onclick: leaveRun }, icon("close")),
      h("div", { class: "hud-score" },
        h("div", { class: "score", style: "font-size:19px" }, runTitle(r)),
        h("div", { class: "meta" }, `Depth ${r.depth}/${r.length}`)),
      h("div", { class: "spacer" }),
      heartsSlot),
    h("div", { class: "roomtitle" + (isBoss ? " boss" : "") },
      h("span", { class: "eyebrow" }, `Act ${ROMAN[node.act]} \u00b7 ${ACTS[node.act].name}`),
      h("div", { class: "rt-name" }, isBoss ? "The Boss" : kind.label)),
    pips,
    chipSlot,
    h("div", { class: "roomplay" }, clockSlot, board, peekLine, feed));
  render(wrap);

  let trialStart = 0;
  let locked = false;

  function paintHud() {
    [...pips.children].forEach((p, k) => p.classList.toggle("on", k < g.correctCount));
    scoreChip.replaceChildren(icon("spark", { size: 14 }), num(r.score));
    const peekBtn = r.perks.peek
      ? h("button", { class: "chip btnchip", onclick: usePeek }, icon("eye", { size: 14 }), `Peek \u00d7${r.perks.peek}`)
      : null;
    chipSlot.replaceChildren(h("div", { class: "runhud", style: "justify-content:center;margin:0" },
      scoreChip,
      r.perks.slow ? h("span", { class: "chip teal" }, icon("hourglass", { size: 14 }), "Slow clock") : null,
      r.perks.shield ? h("span", { class: "chip teal" }, icon("shield", { size: 14 }), `Shield \u00d7${r.perks.shield}`) : null,
      peekBtn));
  }

  function usePeek() {
    const fam = r.usePeek();
    if (!fam) return;
    const words = fam.map((f) => FAMILY_WORDS[f] || f);
    peekLine.replaceChildren(icon("eye", { size: 14, cls: "inline" }),
      ` This secret looks at ${words.length > 1 ? words.slice(0, -1).join(", ") + " and " + words[words.length - 1] : words[0]}.`);
    peekLine.style.cssText = "display:flex;gap:6px;align-items:center;justify-content:center";
    paintHud();
  }

  function paintBoard() {
    board.replaceChildren(...g.trial.tiles.map((tile, i) => stoneButton(tile, i, (e) => choose(i, e.currentTarget))));
  }

  function nextTrial() {
    paintHud();
    paintBoard();
    locked = false;
    trialStart = performance.now();
    g.markShown(trialStart);
  }

  function choose(index, el) {
    if (locked || r.phase !== "room") return;
    locked = true;
    const rt = performance.now() - trialStart;
    const t = g.trial;
    const heartsBefore = r.hearts;
    const rec = index < 0 ? r.timeout() : r.answer(index, rt);
    react(rec, t, index, heartsBefore, el);
  }

  function react(rec, t, index, heartsBefore, el) {
    const nodes = board.children;
    if (rec.correct) {
      nodes[index].classList.add("correct");
      sfx.correct(g.streak);
      juice.celebrate(nodes[index], `+${num(rec.gained)}`, t.isSwitchTrial);
      if (t.isSwitchTrial) sfx.adapt();
      feed.className = "feedline " + (t.isSwitchTrial ? "hint" : "good");
      feed.textContent = t.isSwitchTrial ? "Caught the change." : g.streak >= 3 ? `${g.streak} in a row` : "";
    } else {
      if (index >= 0 && nodes[index]) crack(nodes[index]);
      if (nodes[t.target]) nodes[t.target].classList.add("reveal");
      sfx.wrong();
      juice.punish(index >= 0 ? nodes[index] : null, board);
      const firstOfRoom = rec.freeLook && !t.isSwitchTrial;
      feed.className = "feedline " + (rec.freeLook || rec.shielded ? "hint" : "bad");
      feed.textContent = firstOfRoom
        ? "New room, new secret. That one was free - look at the answer."
        : rec.freeLook
          ? "The rule just changed. That one was free - look at the answer."
          : rec.shielded
            ? "Your shield held. That was the old rule."
            : rec.perseverative ? "That was the old rule." : rec.timedOut ? "Too slow." : "Not that one.";
    }
    heartsSlot.replaceChildren(heartsRow(r.hearts, r.maxHearts, r.hearts < heartsBefore ? r.hearts : -1));
    if (t.isSwitchTrial) setTimeout(shiftAmbient, 120);
    paintHud();

    if (r.phase === "room") {
      setTimeout(() => { feed.textContent = ""; peekLine.replaceChildren(); nextTrial(); }, rec.correct ? 300 : 700);
      return;
    }
    stopLoop();
    if (g.cleared) {
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
    } else {
      setTimeout(finishRun, 900);
    }
  }

  document.onkeydown = (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) {
      e.preventDefault();
      const el = board.children[n - 1];
      if (el) choose(n - 1, el);
    }
    if (e.key === "Escape") leaveRun();
  };

  function loop() {
    if (!run || r.phase !== "room") return;
    if (!locked && g.timed) {
      const elapsed = performance.now() - trialStart;
      const frac = Math.max(0, 1 - elapsed / g.timeLimitMs);
      barFill.style.transform = `scaleX(${frac})`;
      bar.classList.toggle("low", frac < 0.3);
      if (elapsed >= g.timeLimitMs) {
        locked = true;
        const t = g.trial;
        const heartsBefore = r.hearts;
        react(r.timeout(), t, -1, heartsBefore, null);
      }
    }
    loopHandle = requestAnimationFrame(loop);
  }

  nextTrial();
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
    name: profile.name,
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
        stat(`${Math.round(result.accuracy * 100)}%`, "Accuracy"),
        stat(result.perseverativeErrors, "Old-rule errors")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(result.bossesBeaten || 0, "Bosses"),
        stat(result.brainScore, "Brain score"),
        stat(result.maxStreak, "Best streak")),
      (result.perks || []).length
        ? h("div", { style: "margin-top:14px;text-align:center" },
            ...(result.perks || []).map((id) => h("span", { class: "rulechip" }, icon(PERK_ICON[id] || "spark", { size: 15 }), (PERKS[id] || { label: id }).label)))
        : null,
      xpGained ? h("p", { class: "small muted", style: "text-align:center;margin:12px 0 0" },
        `+${num(xpGained)} XP \u00b7 ${rankFor(profile.xp).name}`) : null),

    unlockedCard(newlyUnlocked),

    h("div", { class: "card" },
      h("h3", {}, "Share this run"),
      stripView(result, "margin:12px 0", 60),
      stripLegend(),
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
          ? "Everyone gets the same map and the same rooms today, so scores compare fairly."
          : "The link opens this exact map and these exact rooms for your friend.")),

    h("div", { class: "btn-row" },
      h("button", { class: "btn btn-primary", onclick: () => startRun(randomSeedCode(), false) }, icon("dice", { size: 18 }), "New run"),
      h("button", { class: "btn", onclick: screenStats }, "My report")),
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
  const incoming = params.get("s");
  const incomingRun = params.get("run");
  if (incomingRun) {
    // A friend's run link: the identical map and rooms. A daily-run seed only
    // plays as the daily on its own day; otherwise it is just a seed.
    history.replaceState({}, "", location.pathname);
    const seed = String(incomingRun).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 16) || randomSeedCode();
    startRun(seed, isDailyRunSeed(seed) && seed === dailyRunSeed());
  } else if (incoming) {
    history.replaceState({}, "", location.pathname);
    screenDuel(normalizeSeedCode(incoming));
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
  window.__ruledrift = { get game() { return game; }, get run() { return run; } };
}

boot();

// Anything that failed to reach the server gets another chance on reconnect.
window.addEventListener("online", () => {
  if (cloud.signedIn() && cloud.hasQueued()) syncInBackground();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
