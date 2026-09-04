// Ruledrift - app shell, screens and the game loop.

import { Game, DOMAIN_LABELS, DOMAIN_BLURBS, RULE_BY_ID, LIVES } from "./engine.js";
import { randomSeedCode, normalizeSeedCode, dailySeedCode, dailyNumber } from "./rng.js";
import * as store from "./storage.js";
import { tileSvg, tileLabel } from "./tiles.js";
import { lineChart, radarChart, streakCalendar, ruleBars } from "./charts.js";
import { buildShareText, decodePayload, compare, copyText, challengeUrl, resultStrip } from "./share.js";
import { sfx, isMuted, toggleMute } from "./audio.js";

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

function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: "toast" }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function num(n) {
  return Number(n || 0).toLocaleString();
}

function header(title, onBack) {
  return h(
    "div",
    { class: "top" },
    onBack
      ? h("button", { class: "icon-btn", onclick: onBack, "aria-label": "Back" }, "←")
      : h("div", { class: "brand" }, h("span", { class: "dot" }), "RULEDRIFT"),
    title ? h("h2", {}, title) : null,
    h("div", { class: "spacer" }),
    h(
      "button",
      {
        class: "icon-btn",
        "aria-label": "Toggle sound",
        onclick: (e) => {
          const m = toggleMute();
          e.currentTarget.textContent = m ? "\u{1F507}" : "\u{1F50A}";
        },
      },
      isMuted() ? "\u{1F507}" : "\u{1F50A}"
    )
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

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------

function screenHome() {
  const st = store.streakStatus(profile);
  const tier = store.tierFor(profile);
  const dn = dailyNumber();

  const wrap = h(
    "div",
    { class: "stack" },
    header(),
    h(
      "div",
      { class: "hero" },
      h("h1", {}, "Ruledrift"),
      h("div", { class: "tag" }, "Nobody tells you the rule. Work it out. Then it changes."),
      h(
        "div",
        { style: "margin-top:14px" },
        h(
          "span",
          { class: "streak-pill" + (st.streak > 0 ? " live" : "") },
          st.streak > 0 ? `\u{1F525} ${st.streak}-day streak` : "No streak yet"
        )
      )
    ),

    h(
      "div",
      { class: "stat-grid" },
      stat(num(profile.bestScore), "Best score"),
      stat(profile.bestBrain || "--", "Best brain"),
      stat(profile.history.length, "Sessions")
    ),

    h(
      "div",
      { class: "card stack" },
      st.done
        ? h(
            "button",
            { class: "btn", onclick: () => screenResult(profile.dailyResults[store.dayKey()], { replay: true }) },
            `✓ Daily #${dn} done - see result`
          )
        : h("button", { class: "btn btn-primary", onclick: () => startGame("daily", dailySeedCode()) },
            `▶ Play Daily #${dn}`),
      h("p", { class: "small muted", style: "margin:0" },
        "Everyone in the world gets the same Daily board. Come back tomorrow to keep the streak."),
      h("div", { class: "btn-row" },
        h("button", { class: "btn", onclick: () => startGame("practice", randomSeedCode()) }, "Quick play"),
        h("button", { class: "btn", onclick: screenDuel }, "⚔ Duel a friend")
      )
    ),

    h(
      "div",
      { class: "card" },
      h("div", { class: "between" },
        h("div", {},
          h("h3", {}, "Your brain report"),
          h("div", { class: "small muted" },
            profile.history.length ? `${profile.history.length} sessions recorded` : "Play once to unlock")
        ),
        h("button", { class: "btn btn-sm", onclick: screenStats, disabled: !profile.history.length }, "Open")
      )
    ),

    h(
      "div",
      { class: "card" },
      h("h3", {}, `Rules unlocked · tier ${tier} of 3`),
      h("div", { style: "margin-top:6px" },
        Object.values(RULE_BY_ID)
          .filter((r) => r.tier <= tier)
          .map((r) => h("span", { class: "rulechip" }, r.label))),
      tier < 3
        ? h("p", { class: "small muted", style: "margin:10px 0 0" },
            tier === 1 ? "Play 3 sessions to unlock tier 2." : "Play 8 sessions (or hit Brain 70) to unlock tier 3.")
        : null
    ),

    h("button", { class: "btn btn-ghost", onclick: screenHelp }, "How to play"),
    footer()
  );
  render(wrap);
}

function stat(v, k) {
  return h("div", { class: "stat" }, h("div", { class: "v" }, String(v)), h("div", { class: "k" }, k));
}

function footer() {
  return h(
    "footer",
    {},
    h("div", {}, "Works offline. Nothing you play leaves this device."),
    h("div", { style: "margin-top:4px" }, "Built by Mridul")
  );
}

// ---------------------------------------------------------------------------
// GAME
// ---------------------------------------------------------------------------

function startGame(mode, seed) {
  game = new Game({ seed, mode, maxTier: store.tierFor(profile) });
  screenGame();
}

function screenGame() {
  const scoreEl = h("div", { class: "score" }, "0");
  const metaEl = h("div", { class: "meta" }, "");
  const livesEl = h("div", { class: "lives" });
  const barFill = h("i");
  const bar = h("div", { class: "timerbar" }, barFill);
  const board = h("div", { class: "board" });
  const feed = h("div", { class: "feedline" }, "");

  const wrap = h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "top" },
      h("button", { class: "icon-btn", onclick: () => { if (confirm("Quit this run?")) screenHome(); }, "aria-label": "Quit" }, "✕"),
      h("div", {}, scoreEl, metaEl),
      h("div", { class: "spacer" }),
      livesEl
    ),
    bar,
    board,
    feed
  );
  render(wrap);

  let trialStart = 0;
  let locked = false;
  const hintsOn = profile.history.length < 2;
  let consecutiveWrong = 0;

  function paintHud() {
    scoreEl.textContent = num(game.score);
    metaEl.textContent = `Level ${game.level} · streak ${game.streak}`;
    livesEl.replaceChildren(
      ...Array.from({ length: LIVES }, (_, i) =>
        h("span", { class: "life" + (i < LIVES - game.lives ? " lost" : "") })
      )
    );
  }

  function paintBoard() {
    const t = game.trial;
    board.replaceChildren(
      ...t.tiles.map((tile, i) =>
        h(
          "button",
          {
            class: "tile",
            "aria-label": tileLabel(tile, i),
            onclick: () => choose(i),
          },
          h("span", { class: "key" }, String(i + 1)),
          tileSvg(tile)
        )
      )
    );
  }

  function nextTrial() {
    if (game.over) return finish();
    paintHud();
    paintBoard();
    locked = false;
    trialStart = performance.now();
    game.markShown(trialStart);
  }

  function choose(index) {
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
      if (wasSwitch) {
        sfx.adapt();
        feed.className = "feedline hint";
        feed.textContent = "Caught the change. +250";
        const c = h("div", { class: "combo" }, "ADAPTED");
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 700);
      } else {
        feed.className = "feedline good";
        feed.textContent = game.streak >= 3 ? `${game.streak} in a row · +${num(rec.gained)}` : `+${num(rec.gained)}`;
      }
    } else {
      if (index >= 0) nodes[index].classList.add("wrong");
      if (nodes[target]) nodes[target].classList.add("reveal");
      sfx.wrong();
      consecutiveWrong++;
      feed.className = "feedline bad";
      if (rec.perseverative) {
        feed.textContent = "That was the old rule.";
      } else if (rec.timedOut) {
        feed.textContent = "Too slow.";
      } else {
        feed.textContent = "Not that one.";
      }
      // Onboarding only: the silence is the game, but a brand-new player who is
      // drowning gets one nudge so they learn that rules change at all.
      if (hintsOn && consecutiveWrong >= 2) {
        feed.className = "feedline hint";
        feed.textContent = "The rule changed. Find the new one.";
      }
    }

    setTimeout(() => {
      feed.textContent = "";
      nextTrial();
    }, rec.correct ? 260 : 620);
  }

  function finish() {
    stopLoop();
    sfx.over();
    const result = game.result();
    profile = store.recordResult(profile, result);
    setTimeout(() => screenResult(result), 380);
  }

  document.onkeydown = (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) {
      e.preventDefault();
      choose(n - 1);
    }
    if (e.key === "Escape") screenHome();
  };

  function loop() {
    if (!game || game.over) return;
    if (!locked) {
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
        feed.className = "feedline bad";
        feed.textContent = "Too slow.";
        setTimeout(() => { feed.textContent = ""; nextTrial(); }, 620);
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

function screenResult(result, { replay = false } = {}) {
  const url = challengeUrl(result.seed);
  const shareText = buildShareText(result, {
    url: result.mode === "daily" ? location.origin + location.pathname : url,
    dailyNumber: dailyNumber(),
  });

  const compareBox = h("textarea", {
    placeholder: "Paste your friend's result code here to compare...",
    "aria-label": "Friend result code",
  });
  const compareOut = h("div", {});

  const wrap = h(
    "div",
    { class: "stack" },
    header(replay ? "Today's result" : "Run over", screenHome),

    h(
      "div",
      { class: "card" },
      h("div", { class: "bigscore" },
        h("div", { class: "v" }, num(result.score)),
        h("div", { class: "k" }, `Level ${result.level} · ${result.correct}/${result.trials} correct · best streak ${result.maxStreak}`)
      ),
      h("div", { style: "text-align:center" },
        h("div", { class: "brainbadge" },
          h("div", { class: "n" }, String(result.brainScore)),
          h("div", { class: "tiny" }, "Brain score")
        )
      )
    ),

    h(
      "div",
      { class: "card" },
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
      domainList(result.domains)
    ),

    h(
      "div",
      { class: "card" },
      h("h3", {}, "Share this run"),
      h("div", { class: "strip", style: "margin:12px 0" }, resultStrip(result)),
      h("div", { class: "legend" },
        legend("\u{1F7E9}", "correct"),
        legend("\u{1F7E6}", "caught a rule change"),
        legend("\u{1F7E7}", "stuck on old rule"),
        legend("\u{1F7E5}", "wrong")),
      h("div", { class: "btn-row", style: "margin-top:14px" },
        h("button", { class: "btn btn-primary", onclick: async () => {
          if (navigator.share) {
            try { await navigator.share({ text: shareText }); return; } catch {}
          }
          toast((await copyText(shareText)) ? "Result copied" : "Copy failed");
        } }, "Share result"),
        result.mode !== "daily"
          ? h("button", { class: "btn", onclick: async () => {
              toast((await copyText(url)) ? "Challenge link copied" : "Copy failed");
            } }, "Copy board link")
          : null
      ),
      h("p", { class: "small muted", style: "margin-top:10px" },
        "The code carries your score. Your friend pastes it back in to see who won - the board is identical, so the comparison is fair.")
    ),

    h(
      "div",
      { class: "card" },
      h("h3", {}, "Compare with a friend"),
      compareBox,
      h("button", { class: "btn btn-sm", style: "margin-top:10px", onclick: () => {
        const them = decodePayload(compareBox.value);
        if (!them) { toast("Could not read that code"); return; }
        const c = compare(result, them);
        store.recordDuel(profile, { seed: result.seed, mine: result.score, theirs: them.score, at: Date.now() });
        compareOut.replaceChildren(compareTable(c, them));
      } }, "Compare"),
      compareOut
    ),

    h("div", { class: "btn-row" },
      h("button", { class: "btn btn-primary", onclick: () => startGame("practice", randomSeedCode()) }, "Play again"),
      h("button", { class: "btn", onclick: screenStats }, "My report")
    ),
    h("button", { class: "btn btn-ghost", onclick: screenHome }, "Home"),
    footer()
  );
  render(wrap);
}

function legend(sym, text) {
  return h("span", {}, `${sym} ${text}`);
}

function domainList(domains) {
  return h(
    "div",
    { class: "domain-list" },
    ...Object.entries(DOMAIN_LABELS).map(([k, label]) => {
      const v = domains[k];
      return h(
        "div",
        { class: "domain-item", title: DOMAIN_BLURBS[k] },
        h("span", {}, label),
        h("span", { class: "domain-bar" }, h("i", { style: `width:${v === null || v === undefined ? 0 : v}%` })),
        h("span", { class: "domain-val" }, v === null || v === undefined ? "--" : String(v))
      );
    })
  );
}

function compareTable(c, them) {
  const rows = c.rows.map((r) =>
    h("tr", {},
      h("td", {}, r.label),
      h("td", { class: r.better > 0 ? "win" : r.better < 0 ? "lose" : "" }, String(r.mine)),
      h("td", { class: r.better < 0 ? "win" : r.better > 0 ? "lose" : "" }, String(r.theirs))
    )
  );
  return h(
    "div",
    { style: "margin-top:14px" },
    h("div", { class: `verdict ${c.verdict}` },
      c.verdict === "win" ? "You win" : c.verdict === "loss" ? `${them.name} wins` : "Dead tie"),
    !c.sameBoard
      ? h("p", { class: "small", style: "color:var(--warn)" },
          "Different boards - this is not a like-for-like comparison. Use the same seed for a real duel.")
      : null,
    h("table", { class: "cmp" },
      h("thead", {}, h("tr", {}, h("th", {}, "Metric"), h("th", {}, "You"), h("th", {}, them.name))),
      h("tbody", {}, ...rows))
  );
}

// ---------------------------------------------------------------------------
// DUEL
// ---------------------------------------------------------------------------

function screenDuel(prefill = "") {
  const seedInput = h("input", { type: "text", placeholder: "Seed code, e.g. K7F2QM", value: prefill, maxlength: "12" });
  const mySeed = randomSeedCode();

  const wrap = h(
    "div",
    { class: "stack" },
    header("Duel a friend", screenHome),
    h(
      "div",
      { class: "card stack" },
      h("h3", {}, "1. Start a new board"),
      h("p", { class: "small muted" },
        "A seed is the whole game. Send it to a friend and you both play the identical board - no account, no server, and it works with the network off."),
      h("div", { class: "row" },
        h("div", { class: "mono", style: "font-size:26px;font-weight:800;letter-spacing:3px;flex:1" }, mySeed),
        h("button", { class: "btn btn-sm", onclick: async () => {
          toast((await copyText(challengeUrl(mySeed))) ? "Link copied" : "Copy failed");
        } }, "Copy link")),
      h("button", { class: "btn btn-primary", onclick: () => startGame("duel", mySeed) }, "Play this board")
    ),
    h(
      "div",
      { class: "card stack" },
      h("h3", {}, "2. Or join their board"),
      seedInput,
      h("button", { class: "btn", onclick: () => {
        const s = normalizeSeedCode(seedInput.value);
        if (s.length < 4) { toast("Enter their seed code"); return; }
        startGame("duel", s);
      } }, "Play their board")
    ),
    profile.duels.length
      ? h("div", { class: "card" },
          h("h3", {}, "Recent duels"),
          ...profile.duels.slice(0, 6).map((d) =>
            h("div", { class: "between", style: "padding:7px 0;border-bottom:1px solid var(--line)" },
              h("span", { class: "mono small" }, d.seed),
              h("span", { class: "small", style: `color:${d.mine >= d.theirs ? "var(--good)" : "var(--bad)"}` },
                `${num(d.mine)} v ${num(d.theirs)}`))))
      : null,
    footer()
  );
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
  const window10 = hist.slice(-10);
  const avgDomains = {};
  for (const k of Object.keys(DOMAIN_LABELS)) {
    const vals = window10.map((r) => r.domains[k]).filter((v) => typeof v === "number");
    avgDomains[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const baseline = hist.slice(0, 5);
  const baseDomains = {};
  for (const k of Object.keys(DOMAIN_LABELS)) {
    const vals = baseline.map((r) => r.domains[k]).filter((v) => typeof v === "number");
    baseDomains[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }

  // Accuracy per rule across all history.
  const perRule = {};
  for (const r of hist) for (const id of r.rulesSeen || []) perRule[id] = perRule[id] || { seen: 0 };
  const ruleRows = Object.keys(perRule).map((id) => ({
    label: (RULE_BY_ID[id] || { label: id }).label,
    value: Math.min(1, (hist.filter((r) => (r.rulesSeen || []).includes(id)).reduce((a, r) => a + r.accuracy, 0) /
      Math.max(1, hist.filter((r) => (r.rulesSeen || []).includes(id)).length))),
  }));

  const st = store.streakStatus(profile);

  const wrap = h(
    "div",
    { class: "stack" },
    header("Your brain report", screenHome),

    h("div", { class: "stat-grid" },
      stat(hist.length, "Sessions"),
      stat(st.longest || st.streak, "Longest streak"),
      stat(profile.bestBrain || "--", "Best brain")),

    h("div", { class: "card" },
      h("h3", {}, "Cognitive profile"),
      h("p", { class: "small muted" },
        baseline.length >= 3
          ? "Solid line: your last 10 sessions. Dashed: your first 5, for comparison."
          : "Solid line: your last 10 sessions."),
      h("div", { style: "display:grid;place-items:center" },
        radarChart(avgDomains, DOMAIN_LABELS, {
          size: 300,
          compare: baseline.length >= 3 ? baseDomains : null,
        })),
      domainList(avgDomains)),

    h("div", { class: "card" },
      h("h3", {}, "Brain score over time"),
      h("div", { class: "chart-wrap" }, lineChart(recent.map((r) => r.brainScore), { label: "Brain score" }))),

    h("div", { class: "card" },
      h("h3", {}, "Adaptation speed"),
      h("p", { class: "small muted" }, "Trials needed to lock on after a silent rule change. Lower is better."),
      h("div", { class: "chart-wrap" },
        lineChart(
          recent.map((r) => r.meanAdaptationLatency).filter((v) => typeof v === "number"),
          { label: "Adaptation latency", color: "var(--accent-2)", format: (v) => v }
        ))),

    h("div", { class: "card" },
      h("h3", {}, "Reaction time"),
      h("div", { class: "chart-wrap" },
        lineChart(recent.map((r) => r.meanRt), { label: "Mean reaction time", color: "var(--warn)", format: (v) => `${v}ms` }))),

    ruleRows.length
      ? h("div", { class: "card" },
          h("h3", {}, "Accuracy by rule seen"),
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

    h("div", { class: "card" },
      h("h3", {}, "Your data"),
      h("p", { class: "small muted" },
        "Everything is stored in this browser only. Nothing is uploaded anywhere."),
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-sm", onclick: async () => {
          toast((await copyText(store.exportProfile())) ? "Data copied as JSON" : "Copy failed");
        } }, "Export JSON"),
        h("button", { class: "btn btn-sm", onclick: () => {
          if (confirm("Delete all your Ruledrift history? This cannot be undone.")) {
            profile = store.resetAll();
            toast("History cleared");
            screenHome();
          }
        } }, "Delete all"))),
    footer()
  );
  render(wrap);
}

// ---------------------------------------------------------------------------
// HELP
// ---------------------------------------------------------------------------

function screenHelp() {
  const wrap = h(
    "div",
    { class: "stack" },
    header("How to play", screenHome),
    h("div", { class: "card" },
      h("ol", { class: "how" },
        h("li", {}, h("b", {}, "Five tiles appear."), " One of them is correct. You are never told why."),
        h("li", {}, h("b", {}, "Tap one."), " Green means right, red means wrong. That feedback is your only clue."),
        h("li", {}, h("b", {}, "Work out the rule"), " - most dots, the only tile of its colour, the one matching the last correct tile, and others you have not unlocked yet."),
        h("li", {}, h("b", {}, "Once you have it, it changes."), " Silently. No warning. Your job is to notice fast and stop applying the old one."),
        h("li", {}, h("b", {}, "Three mistakes and the run ends."), " The clock also gets faster every level."))),
    h("div", { class: "card" },
      h("h3", {}, "What the scores mean"),
      h("div", { class: "domain-list" },
        ...Object.entries(DOMAIN_LABELS).map(([k, label]) =>
          h("div", {}, h("b", { style: "font-size:13.5px" }, label),
            h("p", { class: "small muted", style: "margin:2px 0 0" }, DOMAIN_BLURBS[k]))))),
    h("div", { class: "card" },
      h("h3", {}, "An honest note on brain training"),
      h("p", { class: "small muted" },
        "This game is built on the Wisconsin Card Sorting Task, a real test of cognitive flexibility, and it measures two things clinicians actually use: perseverative errors and adaptation latency."),
      h("p", { class: "small muted" },
        "But be sceptical of anyone selling you a smarter brain. The evidence says practice makes you better at the trained task and at closely related ones; it does not reliably raise general intelligence. Ruledrift shows you a real measurement of how you adapt. It does not claim to raise your IQ.")),
    h("div", { class: "card" },
      h("h3", {}, "Playing with friends"),
      h("p", { class: "small muted" },
        "There is no server and no account. A seed code fully determines the board, so anyone playing your seed gets the same tiles in the same order. Share the seed, play separately - even offline - then paste each other's result codes to compare. The duel is exact.")),
    footer()
  );
  render(wrap);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const incoming = params.get("s");
if (incoming) {
  history.replaceState({}, "", location.pathname);
  screenDuel(normalizeSeedCode(incoming));
} else {
  screenHome();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
