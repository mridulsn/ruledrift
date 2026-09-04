// Ruledrift - app shell, screens and the game loop.

import { Game, DOMAIN_LABELS, DOMAIN_BLURBS, RULE_BY_ID, RULES, MODES, modeConfig } from "./engine.js";
import { randomSeedCode, normalizeSeedCode, dailySeedCode, dailyNumber, makeRng, hashSeed } from "./rng.js";
import { generateTrial, rulesUpToTier } from "./rules.js";
import * as store from "./storage.js";
import { AVATARS } from "./storage.js";
import { tileSvg, tileLabel } from "./tiles.js";
import { lineChart, radarChart, streakCalendar, ruleBars } from "./charts.js";
import { buildShareText, decodePayload, compare, copyText, challengeUrl, resultStrip } from "./share.js";
import { sfx, isMuted, toggleMute } from "./audio.js";
import * as juice from "./juice.js";
import { STEPS as TUT_STEPS, GUIDE_EXAMPLES, tutorialDone, markTutorialDone, resetTutorial } from "./tutorial.js";
import { achievementRows, rankFor, lifetimeStats, labelFor } from "./achievements.js";
import * as cloud from "./cloud.js";

const app = document.getElementById("app");
let profile = store.load();
let game = null;
let loopHandle = null;

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
      ? h("button", { class: "icon-btn", onclick: onBack, "aria-label": "Back" }, "←")
      : h("div", { class: "brand" }, h("span", { class: "dot" }), "RULEDRIFT"),
    title ? h("h2", {}, title) : null,
    h("div", { class: "spacer" }),
    h("button", {
      class: "icon-btn", "aria-label": "Toggle sound",
      onclick: (e) => { e.currentTarget.textContent = toggleMute() ? "\u{1F507}" : "\u{1F50A}"; },
    }, isMuted() ? "\u{1F507}" : "\u{1F50A}")
  );
}

function render(node) {
  stopLoop();
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
    h("div", { style: "margin-top:4px" }, "Built by Mridul"));
}

/** A small non-interactive board, used by the guide and the codex. */
function miniBoard(tiles, target) {
  return h("div", { class: "miniboard" },
    ...tiles.map((t, i) =>
      h("div", { class: "mt" + (i === target ? " hit" : "") }, tileSvg(t, { size: 28 }))));
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
  const remote = await cloud.pull();
  if (remote) {
    const merged = store.mergeProfiles(profile, remote);
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

function screenHome() {
  const st = store.streakStatus(profile);
  const tier = store.tierFor(profile);
  const dn = dailyNumber();
  const rank = rankFor(profile.xp);
  const named = profile.name || "Player";

  const modeBtn = (mode, icon, onclick, hero = false) =>
    h("button", { class: "mode" + (hero ? " hero" : ""), onclick },
      h("span", { class: "ic" }, icon),
      h("span", { class: "tx" },
        h("span", { class: "nm" }, mode.label),
        h("span", { class: "bl" }, mode.blurb)),
      h("span", { class: "go" }, "›"));

  const wrap = h("div", { class: "stack" },
    header(),

    h("button", { class: "card pcard", style: "width:100%;text-align:left", onclick: screenProfile },
      h("div", { class: "pavatar" }, AVATARS[profile.avatar] || AVATARS[0]),
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-weight:700;font-size:16px" }, named),
        h("div", { class: "small muted" }, `${rank.name} · ${num(profile.xp)} XP`),
        h("div", { class: "xpbar" }, h("i", { style: `width:${Math.round(rank.progress * 100)}%` }))),
      h("span", { class: "streak-pill" + (st.streak > 0 ? " live" : "") },
        st.streak > 0 ? `\u{1F525} ${st.streak}` : "\u{1F525} 0")),

    h("div", { class: "modes" },
      st.done
        ? modeBtn({ label: `Daily #${dn} complete`, blurb: "Tap to see today's result" }, "✓",
            () => screenResult(profile.dailyResults[store.dayKey()], { replay: true }))
        : modeBtn({ ...MODES.daily, label: `Daily #${dn}` }, "\u{1F5D3}",
            () => startGame("daily", dailySeedCode()), true),
      modeBtn(MODES.quick, "\u{1F3AF}", () => startGame("quick", randomSeedCode())),
      modeBtn(MODES.zen, "\u{1F9D8}", () => startGame("zen", randomSeedCode())),
      modeBtn(MODES.blitz, "⚡", () => startGame("blitz", randomSeedCode())),
      modeBtn(MODES.gauntlet, "\u{1F300}", () => startGame("gauntlet", randomSeedCode())),
      modeBtn(MODES.duel, "⚔", () => screenDuel())),

    h("div", { class: "stat-grid" },
      stat(num(profile.bestScore), "Best score"),
      stat(profile.bestBrain || "—", "Best brain"),
      stat(profile.history.length, "Sessions")),

    h("div", { class: "btn-row" },
      h("button", { class: "btn", onclick: screenGuide }, "How to play"),
      h("button", { class: "btn", onclick: screenStats, disabled: !profile.history.length }, "My report")),
    h("div", { class: "btn-row" },
      h("button", { class: "btn", onclick: screenAchievements }, "Achievements"),
      h("button", { class: "btn", onclick: screenCodex }, `Rule codex · ${tier}/3`)),

    footer());
  render(wrap);
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
      ...step.tiles.map((tile, idx) =>
        h("button", {
          class: "tile", "aria-label": tileLabel(tile, idx),
          onclick: (e) => tap(idx, e.currentTarget),
        }, h("span", { class: "key" }, String(idx + 1)), tileSvg(tile))));
  }

  function tap(idx, el) {
    const step = TUT_STEPS[i];
    if (idx === step.target) {
      el.classList.add("correct");
      sfx.correct(i + 2);
      juice.celebrate(el, step.switched ? "GOT IT" : "✓", !!step.switched);
      banner.className = "tut-banner" + (step.switched ? " reveal" : "");
      banner.replaceChildren(
        h("b", {}, step.success), document.createTextNode(" " + step.teach));
      nextBtn.style.display = "";
      nextBtn.textContent = i === TUT_STEPS.length - 1 ? "Play for real" : "Continue";
      board.querySelectorAll(".tile").forEach((t) => (t.onclick = null));
    } else {
      attempts++;
      el.classList.add("wrong");
      setTimeout(() => el.classList.remove("wrong"), 400);
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

  const noClock = h("div", { class: "noclock" }, "No clock — take your time");
  const clockSlot = h("div", { class: "clockslot" }, noClock);

  const wrap = h("div", { class: "stack" },
    h("div", { class: "top" },
      h("button", { class: "icon-btn", "aria-label": "Quit",
        onclick: () => { if (confirm("Quit this run?")) screenHome(); } }, "✕"),
      h("div", {}, scoreEl, metaEl),
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
    metaEl.textContent = `${cfg.label} · L${game.level} · streak ${game.streak}`;
    livesEl.replaceChildren(
      ...Array.from({ length: game.maxLives }, (_, k) =>
        h("span", { class: "life" + (k < game.maxLives - game.lives ? " lost" : "") })));

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
      h("div", { class: "cc-title" }, "⏱ THE CLOCK STARTS"),
      h("div", { class: "cc-sub" }, `You have ${secs} seconds a board from here. It gets shorter each level.`));
    document.body.appendChild(banner);
    sfx.adapt();
    setTimeout(() => banner.remove(), 2600);
  }

  function paintBoard() {
    const t = game.trial;
    board.replaceChildren(
      ...t.tiles.map((tile, i) =>
        h("button", {
          class: "tile", "aria-label": tileLabel(tile, i),
          onclick: (e) => choose(i, e.currentTarget),
        }, h("span", { class: "key" }, String(i + 1)), tileSvg(tile))));
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
      if (index >= 0 && nodes[index]) nodes[index].classList.add("wrong");
      if (nodes[target]) nodes[target].classList.add("reveal");
      sfx.wrong();
      juice.punish(index >= 0 ? nodes[index] : null, board);
      consecutiveWrong++;
      feed.className = rec.freeLook ? "feedline hint" : "feedline bad";
      feed.textContent = rec.freeLook
        ? "The rule just changed — that one was free. Look at the answer."
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
          `${modeConfig(result.mode).label} · L${result.level} · ${result.correct}/${result.trials} correct · best streak ${result.maxStreak}`)),
      h("div", { style: "text-align:center" },
        h("div", { class: "brainbadge" },
          h("div", { class: "n" }, String(result.brainScore)),
          h("div", { class: "tiny" }, "Brain score"))),
      xpGained ? h("p", { class: "small muted", style: "text-align:center;margin:12px 0 0" },
        `+${num(xpGained)} XP · ${rankFor(profile.xp).name}`) : null),

    newlyUnlocked.length
      ? h("div", { class: "card" },
          h("h3", {}, newlyUnlocked.length === 1 ? "Achievement unlocked" : "Achievements unlocked"),
          h("div", { style: "margin-top:8px" },
            ...newlyUnlocked.map((id) => h("span", { class: "rulechip" }, labelFor(id)))))
      : null,

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
      h("div", { class: "strip", style: "margin:12px 0" }, resultStrip(result)),
      h("div", { class: "legend" },
        h("span", {}, "\u{1F7E9} correct"),
        h("span", {}, "\u{1F7E6} caught a change"),
        h("span", {}, "\u{1F7E7} stuck on old rule"),
        h("span", {}, "\u{1F7E5} wrong")),
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

function domainList(domains) {
  return h("div", { class: "domain-list" },
    ...Object.entries(DOMAIN_LABELS).map(([k, label]) => {
      const v = domains[k];
      return h("div", { class: "domain-item", title: DOMAIN_BLURBS[k] },
        h("span", {}, label),
        h("span", { class: "domain-bar" }, h("i", { style: `width:${v == null ? 0 : v}%` })),
        h("span", { class: "domain-val" }, v == null ? "—" : String(v)));
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
        "You tap a tile to guess. It turns ", h("b", { style: "color:var(--good)" }, "green"),
        " if you were right and ", h("b", { style: "color:var(--bad)" }, "red"), " if you were wrong."),
      h("p", { style: "margin-bottom:0" },
        "By guessing a few times you work out the secret. ",
        h("b", {}, "Then the game quietly changes it"), " and you have to work out the new one.")),

    h("div", { class: "card" },
      h("button", { class: "btn btn-primary", onclick: () => { resetTutorial(); screenTutorial(); } },
        "▶ Show me - 60 seconds"),
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
      h("h3", {}, "Worked example 1 - the secret is “most dots”"),
      h("p", { class: "small" }, "Ignore the shapes and colours completely. Just count the dots on each tile:"),
      workedExample(boardA, GUIDE_EXAMPLES.mostDots.target, (t) => `${t.count} dot${t.count === 1 ? "" : "s"}`,
        "4 is the biggest number, so the green six-sided tile wins. If you tapped it, it turns green.")),

    h("div", { class: "card" },
      h("h3", {}, "Worked example 2 - the secret has changed"),
      h("p", { class: "small" },
        "Now the same game gives you this board. If you still count dots you would tap the first tile, because it has 5. ",
        h("b", {}, "It turns red."), " The secret is not about dots any more. Look at the colours instead:"),
      workedExample(boardB, GUIDE_EXAMPLES.uniqueColour.target, (t) => plainColour(t.color),
        "Two blue, two orange - and one green sitting on its own. The lonely colour wins."),
      h("p", { class: "small", style: "margin-top:10px" },
        h("b", {}, "This is the whole game."), " Nothing warns you that the secret changed. You find out because your answer suddenly turns red. When that happens, stop using your old idea and look for a new one.")),

    h("div", { class: "card" },
      h("h3", {}, "There is no clock while you are learning"),
      h("p", { class: "small" },
        "For the first nine levels nothing is timing you. Sit and stare at a board for a minute if you want to — working out the secret is the whole point, and rushing that would only teach you to panic."),
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
          " You could not possibly have known the new secret, so getting that one wrong costs you nothing. Look carefully at which tile lights up green — that is your clue."),
        h("li", {}, h("b", {}, "Repeating a dead idea does cost you."),
          " Once you have been shown the change, sticking with the old secret is a real mistake."),
        h("li", {}, "A level is six correct answers, so the clock at level 10 means about ", h("b", {}, "54 right"), " in one round. It is meant to be a milestone."))),

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
            ...[0, 1, 2].map(() => h("div", { class: "mt" }, "?"))),
          h("div", { style: "flex:1;min-width:0" },
            h("div", { style: "font-weight:700;font-size:14.5px" },
              known ? r.label : "Locked", h("span", { class: "tiny", style: "margin-left:8px" }, `Tier ${r.tier}`)),
            h("div", { class: "small muted", style: "margin-top:2px" },
              known ? r.reveal : "Keep playing to unlock."),
            s ? h("div", { class: "tiny", style: "margin-top:5px" },
              `seen ${s.seen} · ${acc}% correct`) : null));
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
          h("div", { class: "ic" }, r.icon),
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
    ...AVATARS.map((a, i) =>
      h("button", {
        "aria-pressed": String(i === profile.avatar), "aria-label": `Avatar ${i + 1}`,
        onclick: () => {
          profile = store.setIdentity(profile, { avatar: i });
          [...avatarRow.children].forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
          avatarBig.textContent = AVATARS[i];
        },
      }, a)));

  const avatarBig = h("div", { class: "pavatar" }, AVATARS[profile.avatar] || AVATARS[0]);

  const wrap = h("div", { class: "stack" },
    header("Profile", screenHome),

    h("div", { class: "card pcard" },
      avatarBig,
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-weight:800;font-size:19px" }, profile.name || "Player"),
        h("div", { class: "small muted" }, `${rank.name} · rank ${rank.index} of 8`),
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
        stat(s.totalTrials ? Math.round((s.totalCorrect / s.totalTrials) * 100) + "%" : "—", "Accuracy")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(s.adaptations, "Adaptations"),
        stat(s.bestRunStreak, "Best streak"),
        stat(s.longestStreak, "Day streak")),
      h("div", { class: "stat-grid", style: "margin-top:10px" },
        stat(num(s.bestScore), "Best score"),
        stat(s.bestBrain || "—", "Best brain"),
        stat(`${s.rulesSeen}/8`, "Rules met"))),

    h("div", { class: "btn-row" },
      h("button", { class: "btn", onclick: screenAchievements }, "Achievements"),
      h("button", { class: "btn", onclick: screenStats, disabled: !profile.history.length }, "Report")),

    h("div", { class: "card" },
      h("h3", {}, "Your data"),
      h("p", { class: "small muted" },
        cloud.signedIn()
          ? "Your history is stored in this browser and backed up to your account. Only you can read it. Deleting below clears this device; sign out first if you want to keep the cloud copy."
          : "Everything is in this browser only. Nothing is uploaded anywhere."),
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-sm", onclick: async () => {
          toast((await copyText(store.exportProfile())) ? "Copied as JSON" : "Copy failed");
        } }, "Export"),
        h("button", { class: "btn btn-sm", onclick: () => { resetTutorial(); screenTutorial(); } }, "Replay tutorial"),
        h("button", { class: "btn btn-sm", onclick: () => {
          if (confirm("Delete all your Ruledrift history? This cannot be undone.")) {
            profile = store.resetAll();
            resetTutorial();
            toast("History cleared");
            screenHome();
          }
        } }, "Delete all"))),
    footer());
  render(wrap);
}

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
      h("div", { class: "stack", style: "margin-top:12px" },
        ...cloud.PROVIDERS.map((p) =>
          h("button", { class: `btn oauth oauth-${p.id}`, onclick: () => cloud.signIn(p.id) },
            h("span", { class: "oa-icon" }, p.icon), p.label))),
      h("p", { class: "tiny", style: "margin-top:12px" },
        "Optional. The game works fully without an account, offline and forever."));
  }

  const queued = cloud.hasQueued();
  return h("div", { class: "card" },
    h("div", { class: "pcard" },
      user.avatarUrl
        ? h("img", { class: "pavatar", src: user.avatarUrl, alt: "", referrerpolicy: "no-referrer" })
        : h("div", { class: "pavatar" }, AVATARS[profile.avatar] || AVATARS[0]),
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-weight:700" }, user.name),
        h("div", { class: "small muted", style: "overflow:hidden;text-overflow:ellipsis" }, user.email),
        h("div", { class: "tiny", style: "margin-top:4px" },
          queued ? "⚠ Changes waiting to sync" : `Backed up · signed in with ${user.provider || "OAuth"}`))),
    h("div", { class: "btn-row", style: "margin-top:14px" },
      h("button", { class: "btn btn-sm", onclick: async (e) => {
        e.currentTarget.textContent = "Syncing...";
        await syncNow({ quiet: false });
        screenProfile();
      } }, "Sync now"),
      h("button", { class: "btn btn-sm", onclick: async () => {
        if (!confirm("Sign out? Your progress stays on this device and in the cloud.")) return;
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
      stat(profile.bestBrain || "—", "Best brain")),

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
          h("div", { class: "strip", style: "margin:10px 0" }, resultStrip(last)),
          h("div", { class: "small muted" },
            `${num(last.score)} pts · ${Math.round(last.accuracy * 100)}% · ${last.perseverativeErrors} perseverative error${last.perseverativeErrors === 1 ? "" : "s"}`))
      : null,
    footer());
  render(wrap);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  // An OAuth return must be handled before anything renders, so the player
  // lands on a signed-in screen rather than seeing a flash of signed-out UI.
  let justSignedIn = false;
  if (cloud.cloudConfigured() && location.hash.includes("access_token")) {
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
      toast("Sign-in failed. You can keep playing without an account.");
    }
  } else if (cloud.signedIn() && (cloud.hasQueued() || navigator.onLine !== false)) {
    // Returning signed-in player: sync quietly in the background, never block.
    syncInBackground();
  }

  const params = new URLSearchParams(location.search);
  const incoming = params.get("s");
  if (incoming) {
    history.replaceState({}, "", location.pathname);
    screenDuel(normalizeSeedCode(incoming));
  } else if (justSignedIn) {
    screenProfile();
  } else if (!tutorialDone() && !profile.history.length) {
    // First ever visit goes straight into the tutorial. The single biggest cause
    // of a bounce is a player who does not know what they are looking at.
    screenTutorial();
  } else {
    screenHome();
  }
}

boot();

// Anything that failed to reach the server gets another chance on reconnect.
window.addEventListener("online", () => {
  if (cloud.signedIn() && cloud.hasQueued()) syncInBackground();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
