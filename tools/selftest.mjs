// Engine self-test. Run: node tools/selftest.mjs
// Checks the invariants that make the game fair and the duel honest.

import { Game } from "../src/engine.js";
import {
  generateTrial, evaluateRule, RULES, rulesUpToTier, ruleNeedsPrev,
  BOSS_RULES, isBossRule, shortcutHits, constructTrial, ruleFamilies,
} from "../src/rules.js";
import {
  DriftRun, buildRunMap, dailyRunSeed, findDailyRun, isDailyRunSeed, STEPS_PER_ACT, PERKS, MAX_HEARTS,
} from "../src/driftrun.js";
import { makeRng, hashSeed, randomSeedCode, dailySeedCode } from "../src/rng.js";
import { STEPS as TUT, GUIDE_EXAMPLES } from "../src/tutorial.js";
import { MODES, modeConfig, timeLimitForLevel } from "../src/engine.js";
import { rankFor, achievementRows, lifetimeStats, xpFor } from "../src/achievements.js";
import { mergeProfiles, streaksFromDays, parseImport } from "../src/storage.js";
import {
  cloudConfigured,
  PROVIDERS,
  signedIn,
  providerAvailability,
  readPullResponse,
  providerStartUrl,
  tokenClaims,
  hasSignInHash,
} from "../src/cloud.js";
import { FIREBASE_API_KEY, FIREBASE_PROJECT_ID, GOOGLE_CLIENT_ID, API_ORIGIN } from "../src/config.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// Deterministic autoplayer: knows the rule, so it plays perfectly except when
// the rule has just changed - which is exactly how a good human plays.
function autoplay(seed, tier, { perfect = true, rng = null } = {}) {
  const g = new Game({ seed, mode: "quick", maxTier: tier });
  let guard = 0;
  while (!g.over && guard++ < 5000) {
    const t = g.trial;
    let pick = t.target;
    if (!perfect && rng && rng.next() < 0.25) pick = rng.int(t.tiles.length);
    g.answer(pick, 800 + (rng ? rng.int(600) : 0));
  }
  return g;
}

console.log("\n1. Rule generation always yields exactly one answer");
{
  const rng = makeRng(hashSeed("gen-test"));
  let bad = 0;
  let checked = 0;
  for (const rule of RULES) {
    for (let i = 0; i < 4000; i++) {
      const prev = { shape: rng.pick(["circle", "square", "triangle", "diamond", "hex"]),
                     color: rng.pick(["cyan", "amber", "magenta", "lime", "violet"]),
                     count: rng.range(1, 5) };
      const { tiles, target } = generateTrial(rng, rule.id, prev, null);
      checked++;
      if (target < 0 || target >= tiles.length) { bad++; continue; }
      if (evaluateRule(rule.id, tiles, prev) !== target) bad++;
    }
  }
  check(`every generated board is solvable (${checked} boards)`, bad === 0, `bad=${bad}`);
}

console.log("\n2. A rule change is always detectable");
{
  const rng = makeRng(hashSeed("switch-test"));
  let invisible = 0;
  let tested = 0;
  for (let i = 0; i < 6000; i++) {
    const pool = rulesUpToTier(3).map((r) => r.id);
    const oldRule = rng.pick(pool);
    const newRule = rng.pick(pool.filter((r) => r !== oldRule));
    const prev = { shape: "circle", color: "cyan", count: 3 };
    const { tiles, target } = generateTrial(rng, newRule, prev, oldRule);
    const oldAnswer = evaluateRule(oldRule, tiles, prev);
    tested++;
    // If the old rule points at the same tile, the player cannot possibly tell
    // the rule changed - that would be an unfair death.
    if (oldAnswer === target) invisible++;
  }
  check(`switch trials never keep the same answer (${tested} switches)`, invisible === 0, `invisible=${invisible}`);
}

console.log("\n3. Determinism - same seed, identical game");
{
  const seed = "K7F2QM";
  const rngA = makeRng(hashSeed("play-a"));
  const rngB = makeRng(hashSeed("play-a"));
  const a = autoplay(seed, 3, { perfect: false, rng: rngA });
  const b = autoplay(seed, 3, { perfect: false, rng: rngB });
  check("same seed gives the same score", a.score === b.score, `${a.score} vs ${b.score}`);
  check("same seed gives the same trial count", a.trials.length === b.trials.length);
  check(
    "same seed gives the same rule sequence",
    JSON.stringify(a.trials.map((t) => t.rule)) === JSON.stringify(b.trials.map((t) => t.rule))
  );

  const c = autoplay("DIFFERENT", 3, { perfect: false, rng: makeRng(hashSeed("play-a")) });
  check("a different seed gives a different game", JSON.stringify(a.trials.map((t) => t.rule)) !== JSON.stringify(c.trials.map((t) => t.rule)));
}

console.log("\n4. Termination and lives");
{
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const g = new Game({ seed: "T" + i, mode: "quick", maxTier: 3 });
    let n = 0;
    while (!g.over && n++ < 4000) g.answer(0, 900); // always tap tile 0
    if (!g.over) { worst = -1; break; }
    worst = Math.max(worst, g.trials.length);
    if (g.lives > 0) { worst = -2; break; }
  }
  check("a bad player always dies, and quickly", worst > 0 && worst < 400, `worst=${worst}`);
}

console.log("\n5. Echo rules never appear before there is something to echo");
{
  let bad = 0;
  for (let i = 0; i < 400; i++) {
    const g = new Game({ seed: "E" + i, mode: "quick", maxTier: 3 });
    if (ruleNeedsPrev(g.currentRule)) bad++;
    let n = 0;
    while (!g.over && n++ < 500) {
      if (ruleNeedsPrev(g.trial.rule) && !g.prevTarget) bad++;
      g.answer(g.trial.target, 800);
      if (n > 120) break;
    }
  }
  check("no echo rule without a previous target", bad === 0, `bad=${bad}`);
}

console.log("\n6. Perseverative errors are actually detected");
{
  // Play the OLD rule on purpose after every switch and confirm it is flagged.
  let flagged = 0;
  let opportunities = 0;
  for (let i = 0; i < 300; i++) {
    const g = new Game({ seed: "P" + i, mode: "quick", maxTier: 3 });
    let n = 0;
    while (!g.over && n++ < 400) {
      const t = g.trial;
      if (t.isSwitchTrial && g.previousRule && t.answers[g.previousRule] >= 0) {
        opportunities++;
        const rec = g.answer(t.answers[g.previousRule], 800);
        if (rec.perseverative) flagged++;
      } else {
        g.answer(t.target, 800);
      }
    }
  }
  check(
    `sticking to the old rule is flagged (${flagged}/${opportunities})`,
    opportunities > 50 && flagged === opportunities,
    `flagged=${flagged} of ${opportunities}`
  );
}

console.log("\n7. Metrics are sane");
{
  const g = autoplay("METRICS", 3, { perfect: false, rng: makeRng(hashSeed("m")) });
  const r = g.result();
  check("accuracy in 0..1", r.accuracy >= 0 && r.accuracy <= 1, String(r.accuracy));
  check("brain score in 0..100", r.brainScore >= 0 && r.brainScore <= 100, String(r.brainScore));
  check("every domain in 0..100 or null",
    Object.values(r.domains).every((v) => v === null || (v >= 0 && v <= 100)),
    JSON.stringify(r.domains));
  check("log length matches trials", r.log.length === r.trials);
  check("perseverative errors never exceed total errors",
    r.perseverativeErrors <= r.trials - r.correct);

  const perfect = autoplay("METRICS", 3, { perfect: true });
  const pr = perfect.result();
  check("a perfect player still eventually dies on the clock or a switch", pr.trials > 0);
  check("perfect play scores higher than sloppy play", pr.score > r.score, `${pr.score} vs ${r.score}`);
}

console.log("\n8. Daily seed is stable within a day, different across days");
{
  const d1 = dailySeedCode(new Date(2026, 8, 4));
  const d1b = dailySeedCode(new Date(2026, 8, 4, 23, 59));
  const d2 = dailySeedCode(new Date(2026, 8, 5));
  check("same day, same seed", d1 === d1b, `${d1} vs ${d1b}`);
  check("next day, different seed", d1 !== d2);
  check("random seed codes are 6 chars", randomSeedCode().length === 6);
}

console.log("\n9. Tutorial boards are exactly what they claim");
{
  const rulesUsed = ["MOST_PIPS","MOST_PIPS","MOST_PIPS","UNIQUE_COLOR","UNIQUE_COLOR"];
  let bad = 0;
  TUT.forEach((step, i) => {
    const got = evaluateRule(rulesUsed[i], step.tiles, null);
    if (got !== step.target) { bad++; console.log(`     step ${i+1}: rule says ${got}, script says ${step.target}`); }
    if (step.tiles.length !== 5) bad++;
  });
  check("every tutorial board's answer matches its intended rule", bad === 0, `bad=${bad}`);

  // The rug-pull only teaches anything if the old rule points somewhere else.
  const sw = TUT.find((s) => s.switched);
  const oldRuleSays = evaluateRule("MOST_PIPS", sw.tiles, null);
  check("the switch step punishes the OLD rule", oldRuleSays >= 0 && oldRuleSays !== sw.target,
    `old rule -> ${oldRuleSays}, correct is ${sw.target}`);
  check("every tutorial step has prompt, success, teach and fail text",
    TUT.every((s) => s.prompt && s.success && s.teach && s.fail));
}

console.log("\n9b. The guide's worked examples tell the truth");
{
  for (const [name, ex] of Object.entries(GUIDE_EXAMPLES)) {
    const got = evaluateRule(ex.rule, ex.tiles, null);
    check(`guide example "${name}" really is won by ${ex.rule}`, got === ex.target,
      `rule picks ${got}, guide labels ${ex.target}`);
    check(`guide example "${name}" has 5 tiles`, ex.tiles.length === 5);
  }
  // The second example is only instructive if the old rule points elsewhere.
  const b = GUIDE_EXAMPLES.uniqueColour;
  const old = evaluateRule(b.oldRule, b.tiles, null);
  check("the 'secret changed' example really does defeat the old rule",
    old >= 0 && old !== b.target, `old rule -> ${old}, winner is ${b.target}`);

  // Two different jobs: the label is a short name you can mutter mid-game, the
  // reveal is the full teaching text. Neither may drift into the other's job.
  const jargon = /perseverativ|latency|induction|heuristic|parity/i;
  const badReveal = RULES.filter((r) => !r.reveal || r.reveal.length < 120 || jargon.test(r.reveal));
  check("every rule's explanation is elaborate and jargon-free", badReveal.length === 0,
    badReveal.map((r) => `${r.id}(${(r.reveal || "").length})`).join(","));

  const badLabel = RULES.filter((r) => !r.label || r.label.length > 16 || r.label.split(" ").length > 3);
  check("every rule label stays short and punchy", badLabel.length === 0,
    badLabel.map((r) => r.label).join(" | "));
}

console.log("\n9c. The clock stays away while you are learning");
{
  // The whole point: a beginner must never be rushed.
  const early = [1, 2, 3, 5, 8, 9].map((L) => timeLimitForLevel(L, "quick"));
  check("no clock at all before level 10", early.every((t) => t === Infinity),
    early.join(","));
  check("the clock appears exactly at level 10",
    timeLimitForLevel(9, "quick") === Infinity && isFinite(timeLimitForLevel(10, "quick")));
  check("it starts generous (20s)", timeLimitForLevel(10, "quick") === 20000,
    String(timeLimitForLevel(10, "quick")));

  // It must tighten, monotonically, and never below the floor.
  let prev = Infinity, monotone = true, floorOk = true;
  for (let L = 10; L <= 60; L++) {
    const t = timeLimitForLevel(L, "quick");
    if (t > prev) monotone = false;
    if (t < 1700) floorOk = false;
    prev = t;
  }
  check("the clock only ever tightens", monotone);
  check("it never drops below the 1.7s floor", floorOk);
  check("it reaches the floor eventually", timeLimitForLevel(60, "quick") === 1700);
  check("blitz is timed from board one", isFinite(timeLimitForLevel(1, "blitz")));
  check("zen is never timed", [1, 10, 50].every((L) => timeLimitForLevel(L, "zen") === Infinity));

  // A free look on the switch board is what makes level 10 reachable at all.
  const g = new Game({ seed: "FREE", mode: "quick", maxTier: 3 });
  let frees = 0, n = 0;
  while (!g.over && n++ < 400) {
    const t = g.trial;
    const rec = t.isSwitchTrial ? g.answer((t.target + 1) % 5, 900) : g.answer(t.target, 900);
    if (rec.freeLook) frees++;
  }
  check("getting the switch board wrong costs no life", frees >= 3 && g.lives === g.maxLives,
    `frees=${frees}, lives=${g.lives}/${g.maxLives}`);

  // ...but repeating a dead rule later still does.
  const g2 = new Game({ seed: "FREE2", mode: "quick", maxTier: 3 });
  let m = 0;
  while (!g2.over && m++ < 400) {
    const t = g2.trial;
    g2.answer(t.isSwitchTrial ? t.target : (t.target + 1) % 5, 900);
  }
  check("being wrong on a normal board still costs a life", g2.over && g2.lives <= 0);

  // And the milestone has to actually be attainable by a strong player.
  const reached = (() => {
    const rng = makeRng(hashSeed("reach"));
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const gg = new Game({ seed: "R" + i, mode: "quick", maxTier: 3 });
      let known = null, k = 0;
      while (!gg.over && k++ < 3000) {
        const t = gg.trial;
        gg.answer(known === t.rule && rng.next() < 0.97 ? t.target : rng.int(5), 1200);
        known = t.rule;
      }
      if (gg.level >= 10) hits++;
    }
    return hits;
  })();
  check(`level 10 is reachable by a strong player (${reached}/200 runs)`, reached >= 60,
    `only ${reached}/200`);
}

console.log("\n10. Modes behave differently");
{
  check("zen has no clock", timeLimitForLevel(1, "zen") === Infinity);
  check("blitz is timed earlier than quick", timeLimitForLevel(3, "blitz") < timeLimitForLevel(3, "quick"));
  check("zen is more forgiving", modeConfig("zen").lives > modeConfig("quick").lives);
  check("gauntlet switches every 3", modeConfig("gauntlet").runMin === 3 && modeConfig("gauntlet").runMax === 3);

  const g = new Game({ seed: "GAUNT", mode: "gauntlet", maxTier: 3 });
  let n = 0;
  while (!g.over && n++ < 60) g.answer(g.trial.target, 700);
  check("gauntlet produces far more rule changes", g.ruleChanges >= 12, `changes=${g.ruleChanges} in ${g.trials.length} trials`);

  const zen = new Game({ seed: "ZEN", mode: "zen", maxTier: 2 });
  check("zen reports itself untimed", zen.timed === false && zen.maxLives === 5);
}

console.log("\n11. Ranks and achievements");
{
  check("rank 0 XP is the first rank", rankFor(0).index === 1);
  check("rank climbs with XP", rankFor(200000).index === 8 && rankFor(200000).next === null);
  check("rank progress stays in 0..1",
    [0, 1500, 9000, 60000, 999999].every((x) => { const r = rankFor(x); return r.progress >= 0 && r.progress <= 1; }));

  const empty = { history: [], duels: [], ruleStats: {}, unlocked: [], xp: 0, longestStreak: 0, bestBrain: 0, bestScore: 0 };
  const rows = achievementRows(empty);
  check("a new player has every achievement locked", rows.every((r) => r.tier === 0), rows.filter(r=>r.tier>0).map(r=>r.id).join(","));
  check("achievement rows never NaN",
    rows.every((r) => Number.isFinite(r.progress) && r.progress >= 0 && r.progress <= 1));

  const played = { ...empty, history: [{ adaptations: 6, maxStreak: 9, trials: 20, correct: 18, byRule: {} }], longestStreak: 3, bestBrain: 55 };
  const rows2 = achievementRows(played);
  const adapt = rows2.find((r) => r.id === "adapt");
  check("stepped achievement advances one tier at 6 adaptations", adapt.tier === 1, `tier=${adapt.tier}`);
  check("lifetime stats aggregate history", lifetimeStats(played).adaptations === 6);
}

console.log("\n12. Profile merge never loses or invents progress");
{
  const mkResult = (t, score, mode = "quick") => ({
    seed: "S" + t, mode, playedAt: t, score, level: 2, trials: 20, correct: 16,
    accuracy: 0.8, maxStreak: 5, ruleChanges: 2, adaptations: 2, meanRt: 1200,
    rtSd: 200, meanAdaptationLatency: 2, perseverativeErrors: 1,
    perseverativeRate: 0.25, brainScore: 60, domains: {}, byRule: { MOST_PIPS: { seen: 10, correct: 8 } },
    rulesSeen: ["MOST_PIPS"], log: [],
  });
  const base = () => ({
    name: "", avatar: 0, updatedAt: 0, xp: 0, unlocked: [], ruleStats: {},
    history: [], bestScore: 0, bestBrain: 0, streak: 0, longestStreak: 0,
    lastDailyDay: null, freezes: 1, dailyResults: {}, tierUnlocked: 1,
    duels: [], createdAt: 1000,
  });

  const laptop = { ...base(), name: "Laptop", updatedAt: 500,
    history: [mkResult(100, 1000), mkResult(200, 2000)], bestScore: 2000, bestBrain: 60, xp: 3000 };
  const phone = { ...base(), name: "Phone", updatedAt: 900,
    history: [mkResult(300, 5000), mkResult(200, 2000)], bestScore: 5000, bestBrain: 60, xp: 7000 };

  const m = mergeProfiles(laptop, phone);
  check("merge keeps every distinct session", m.history.length === 3, `got ${m.history.length}`);
  check("merge de-duplicates the shared session",
    m.history.filter((r) => r.playedAt === 200).length === 1);
  check("merge keeps the better best-score", m.bestScore === 5000, String(m.bestScore));
  check("merge takes the newer device's display name", m.name === "Phone", m.name);
  check("merge keeps the earliest created date", m.createdAt === 1000);

  // The property that matters most: syncing twice must not double anything.
  const once = mergeProfiles(laptop, phone);
  const twice = mergeProfiles(once, phone);
  const thrice = mergeProfiles(twice, phone);
  check("merging repeatedly is idempotent (XP)", once.xp === twice.xp && twice.xp === thrice.xp,
    `${once.xp} -> ${twice.xp} -> ${thrice.xp}`);
  check("merging repeatedly is idempotent (history)",
    once.history.length === thrice.history.length, `${once.history.length} vs ${thrice.history.length}`);
  check("merging with itself changes nothing",
    JSON.stringify(mergeProfiles(once, once).history) === JSON.stringify(once.history));

  const ab = mergeProfiles(laptop, phone);
  const ba = mergeProfiles(phone, laptop);
  check("merge order does not matter (history)",
    JSON.stringify(ab.history.map((r) => r.playedAt)) === JSON.stringify(ba.history.map((r) => r.playedAt)));
  check("merge order does not matter (XP)", ab.xp === ba.xp, `${ab.xp} vs ${ba.xp}`);

  check("rule tallies are never summed into fiction",
    ab.ruleStats.MOST_PIPS.seen <= 30, JSON.stringify(ab.ruleStats.MOST_PIPS));

  // A brand new device signing in must adopt the cloud, not erase it.
  const fresh = mergeProfiles(base(), phone);
  check("an empty device adopts the cloud history", fresh.history.length === 2);
  check("an empty device does not zero the best score", fresh.bestScore === 5000);

  const nothing = mergeProfiles(base(), base());
  check("merging two empty profiles is safe",
    nothing.history.length === 0 && nothing.xp === 0 && nothing.streak === 0);

  // Daily results and streaks rebuild from the days actually played.
  const d1 = { ...base(), dailyResults: { "2026-09-01": mkResult(1, 500, "daily"), "2026-09-02": mkResult(2, 500, "daily") } };
  const d2 = { ...base(), dailyResults: { "2026-09-03": mkResult(3, 900, "daily"), "2026-09-02": mkResult(2, 1500, "daily") } };
  const dm = mergeProfiles(d1, d2);
  check("daily results merge across devices", Object.keys(dm.dailyResults).length === 3);
  check("the better daily score wins", dm.dailyResults["2026-09-02"].score === 1500);
  check("streak is recomputed from real days", dm.longestStreak === 3 && dm.streak === 3,
    `longest=${dm.longestStreak} current=${dm.streak}`);

  const gap = streaksFromDays(["2026-09-01", "2026-09-02", "2026-09-09"]);
  check("a broken streak resets", gap.longest === 2 && gap.current === 1,
    `longest=${gap.longest} current=${gap.current}`);
  check("streaks on no days are zero", streaksFromDays([]).longest === 0);
}

console.log("\n13. Cloud is optional and fails soft");
{
  check("cloud config is all-or-nothing",
    (Boolean(FIREBASE_API_KEY) && Boolean(FIREBASE_PROJECT_ID)) || (!FIREBASE_API_KEY && !FIREBASE_PROJECT_ID));
  check("cloudConfigured() matches the config", cloudConfigured() === Boolean(FIREBASE_API_KEY && FIREBASE_PROJECT_ID));
  check("the Firebase key is a public web key, not a service account",
    /^AIza[0-9A-Za-z_-]{35}$/.test(FIREBASE_API_KEY), FIREBASE_API_KEY);
  check("off the real site, the sign-in server is this origin (local dev)", API_ORIGIN === "");

  check("both OAuth providers are offered",
    PROVIDERS.length === 2 && PROVIDERS.some((p) => p.id === "google") && PROVIDERS.some((p) => p.id === "discord"),
    PROVIDERS.map((p) => p.id).join(","));
  check("nobody is signed in by default", signedIn() === false);

  // A button that promises a login the server will refuse is worse than no
  // button, so availability comes from the sign-in server, which knows.
  const live = providerAvailability({ providers: { discord: true, google: false, github: true } });
  check("an enabled provider reads as available", live.discord === true);
  check("a provider that is off reads as unavailable", live.google === false);
  check("availability only covers providers we actually offer",
    Object.keys(live).sort().join(",") === "discord,google", Object.keys(live).join(","));
  check("a missing settings payload disables every provider",
    providerAvailability(null).google === false && providerAvailability(null).discord === false);

  // The bug this replaces: a failed read and an empty cloud both returned null,
  // so a fresh device that could not read would push its empty profile over a
  // real backup and destroy it. These two cases must never look alike.
  const failed = readPullResponse(0);
  const denied = readPullResponse(403);
  const empty = readPullResponse(404);
  const found = readPullResponse(200, { fields: { data: { stringValue: JSON.stringify({ history: [1, 2, 3] }) } } });
  const corrupt = readPullResponse(200, { fields: { data: { stringValue: "{not json" } } });
  check("a failed read is not ok", failed.ok === false && denied.ok === false);
  check("no backup yet IS ok, just empty", empty.ok === true && empty.data === null);
  check("a failed read is distinguishable from an empty cloud", failed.ok !== empty.ok);
  check("a found profile comes back intact", found.ok === true && found.data.history.length === 3);
  check("an unreadable backup is a failure, so it is never overwritten", corrupt.ok === false);

  // And the merge it feeds: an empty device must inherit the cloud, never erase it.
  const restored = mergeProfiles(
    { history: [], dailyResults: {}, updatedAt: 0 },
    { history: [{ playedAt: 5, seed: "AAA", score: 90 }], dailyResults: { "2026-09-01": { score: 90 } }, updatedAt: 10 }
  );
  check("a fresh device inherits the cloud history rather than blanking it",
    restored.history.length === 1 && restored.history[0].score === 90,
    JSON.stringify(restored.history));

  check("the Google client ID is either unset or a real one",
    GOOGLE_CLIENT_ID === "" || /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_ID || "(unset)");

  // Discord starts on the sign-in server, on our own domain, so Discord's
  // consent screen never names a hostname the player does not recognise.
  const dUrl = new URL(providerStartUrl("https://auth.mridulsaravanan.com", "discord", "s7"));
  check("Discord sign-in starts on our own sign-in server",
    dUrl.origin === "https://auth.mridulsaravanan.com" && dUrl.pathname === "/api/auth/discord", dUrl.href);
  check("the server is told which game is asking", dUrl.searchParams.get("app") === "ruledrift");
  check("the tab's own state is carried through", dUrl.searchParams.get("cs") === "s7");
  check("no third-party hostname is in the start URL", !/supabase|firebaseapp|vercel\.app/.test(dUrl.href), dUrl.href);

  check("a sign-in result in the address is recognised",
    hasSignInHash("#fp-auth=abc&p=discord&cs=1") && hasSignInHash("#fp-auth-error=nope") && !hasSignInHash("#seed=AAA"));
  const fakeTok = ["e30", Buffer.from(JSON.stringify({ user_id: "u_abc", exp: 99 })).toString("base64url"), "sig"].join(".");
  const tc = tokenClaims(fakeTok);
  check("the player id is read from the Firebase token", tc.uid === "u_abc" && tc.exp === 99, JSON.stringify(tc));
  check("a garbage token gives no player id", tokenClaims("nope").uid === "");
}

console.log("\n14. Import merges, never replaces");
{
  check("non-JSON is refused with a reason", parseImport("hello").ok === false && /not Ruledrift/.test(parseImport("hello").error));
  check("a JSON list is refused", parseImport("[1,2]").ok === false);
  check("a damaged history is refused", parseImport('{"history": 5}').ok === false);
  check("an export with no games is refused", parseImport("{}").ok === false);
  const exp = JSON.stringify({ name: "M", history: [{ playedAt: 7, seed: "BBB", score: 50 }, { junk: true }], dailyResults: {}, xp: 10 });
  const r = parseImport(exp);
  check("a real export is accepted, junk entries dropped", r.ok === true && r.profile.history.length === 1, JSON.stringify(r));
  const local = { history: [{ playedAt: 9, seed: "CCC", score: 70 }], dailyResults: {}, updatedAt: 5 };
  const merged = mergeProfiles(local, r.profile);
  check("importing keeps this device's games and adds the imported ones",
    merged.history.length === 2 && merged.history.some((x) => x.seed === "CCC") && merged.history.some((x) => x.seed === "BBB"));
  const again = mergeProfiles(merged, r.profile);
  check("importing the same export twice adds nothing", again.history.length === 2);
}

console.log("\n15. The classic game is untouched by Drift Run");
{
  // A fingerprint of 60 classic games (5 modes x 4 seeds x 3 tiers), taken from
  // the engine before Drift Run existed. If this moves, old seeds, old duels and
  // old dailies would no longer replay the same boards.
  let acc = "";
  for (const mode of ["quick", "daily", "zen", "blitz", "gauntlet"]) for (const seed of ["K7F2QM", "DAILY-20261017", "AB12CD", "ZZZZZZ"]) for (const tier of [1, 2, 3]) {
    const g = new Game({ seed, mode, maxTier: tier });
    let n = 0;
    while (!g.over && n++ < 150) {
      const t = g.trial;
      acc += t.tiles.map((x) => x.shape[0] + x.color[0] + x.count).join("") + t.target + t.rule[0];
      g.answer(n % 7 === 3 ? (t.target + 1) % 5 : t.target, 900);
    }
    acc += "|" + g.score;
  }
  check("classic boards are byte-identical to before Drift Run", hashSeed(acc).toString(16) === "1ab5529",
    hashSeed(acc).toString(16));
  check("the normal rule pool never contains a boss rule",
    [1, 2, 3].every((t) => rulesUpToTier(t).every((r) => !isBossRule(r.id))));
  check("there are still exactly eight core rules", RULES.length === 8 && BOSS_RULES.length === 3);
}

// Independent oracle: which tiles satisfy each rule's defining property. Written
// separately from evaluateRule, so a bug in one cannot hide in the other.
function oracle(rule, tiles, prev) {
  const idx = [0, 1, 2, 3, 4];
  const countOf = (key) => (i) => tiles.filter((t) => t[key] === tiles[i][key]).length;
  const colourN = countOf("color");
  const shapeN = countOf("shape");
  const counts = tiles.map((t) => t.count);
  switch (rule) {
    case "MOST_PIPS": return idx.filter((i) => counts[i] === Math.max(...counts));
    case "FEWEST_PIPS": return idx.filter((i) => counts[i] === Math.min(...counts));
    case "UNIQUE_COLOR": return idx.filter((i) => colourN(i) === 1);
    case "UNIQUE_SHAPE": return idx.filter((i) => shapeN(i) === 1);
    case "ODD_PARITY": return idx.filter((i) => tiles.filter((t) => t.count % 2 === tiles[i].count % 2).length === 1);
    case "MATCH_LAST_COLOR": return prev ? idx.filter((i) => tiles[i].color === prev.color) : [];
    case "MATCH_LAST_SHAPE": return prev ? idx.filter((i) => tiles[i].shape === prev.shape) : [];
    case "SHARES_NOTHING": return prev ? idx.filter((i) => tiles[i].color !== prev.color && tiles[i].shape !== prev.shape) : [];
    case "BOSS_DOUBLE_LONER": return idx.filter((i) => colourN(i) === 1 && shapeN(i) === 1);
    case "BOSS_RICH_TWIN": {
      const pairColours = [...new Set(tiles.map((t) => t.color))].filter((c) => tiles.filter((t) => t.color === c).length === 2);
      if (pairColours.length !== 1) return [];
      const tw = idx.filter((i) => tiles[i].color === pairColours[0]);
      return tw.filter((i) => tw.every((j) => j === i || tiles[i].count > tiles[j].count));
    }
    case "BOSS_HUMBLE_LONER": {
      const lone = idx.filter((i) => shapeN(i) === 1);
      if (lone.length < 2) return [];
      return lone.filter((i) => lone.every((j) => j === i || tiles[i].count < tiles[j].count));
    }
    default: return [];
  }
}

/**
 * Plays a whole Drift Run. `style` decides the taps: "perfect" always right,
 * "sloppy" mostly right with deliberate old-rule mistakes, "bad" always tile 0.
 * `onTrial` sees every board before it is answered.
 */
function playRun(seed, { style = "perfect", rng = null, onTrial = null, daily = false } = {}) {
  const run = new DriftRun({ seed, daily });
  let guard = 0;
  while (!run.over && guard++ < 6000) {
    if (run.phase === "map") {
      const opts = run.options();
      run.enter(opts[rng ? rng.int(opts.length) : 0].id);
    } else if (run.phase === "perk") {
      run.pickPerk(run.perkOffer[rng ? rng.int(run.perkOffer.length) : 0]);
    } else if (run.phase === "room") {
      const g = run.game;
      const t = g.trial;
      if (onTrial) onTrial(run, g, t);
      let pick = t.target;
      if (style === "bad") pick = 0;
      else if (style === "sloppy") {
        const roll = rng.next();
        const old = g.previousRule ? t.answers[g.previousRule] : -1;
        if (roll < 0.12 && old >= 0) pick = old;
        else if (roll < 0.2) pick = rng.int(5);
      }
      run.answer(pick, 700 + (rng ? rng.int(500) : 0));
    }
  }
  return run;
}

console.log("\n16. Drift Run maps");
{
  let badShape = 0, nonDeterministic = 0, distinct = new Set();
  for (let i = 0; i < 500; i++) {
    const seed = "MAP" + i;
    const m = buildRunMap(seed);
    if (JSON.stringify(m) !== JSON.stringify(buildRunMap(seed))) nonDeterministic++;
    distinct.add(JSON.stringify(m.acts.map((a) => a.steps.map((s) => s.map((n) => n.type)))));
    if (m.acts.length !== 3 || m.length !== 12) badShape++;
    for (const a of m.acts) {
      if (a.steps.length !== STEPS_PER_ACT || a.boss.type !== "boss") badShape++;
      let rests = 0;
      for (const s of a.steps) {
        if (s.length !== 2 || s[0].type === s[1].type) badShape++;
        rests += s.filter((n) => n.type === "rest").length;
      }
      if (rests !== 1) badShape++;
    }
    const first = m.acts[0].steps[0].map((n) => n.type).sort().join(",");
    if (first !== "elite,room") badShape++;
  }
  check("every map is 3 acts of 3 left/right steps plus a boss (500 maps)", badShape === 0, `bad=${badShape}`);
  check("every act has exactly one campfire, and every choice is a real choice", badShape === 0);
  check("the same seed always draws the same map", nonDeterministic === 0, `diff=${nonDeterministic}`);
  check("different seeds draw different maps", distinct.size > 20, `distinct=${distinct.size}`);

  const d1 = dailyRunSeed(new Date(2026, 9, 17, 0, 5));
  const d1b = dailyRunSeed(new Date(2026, 9, 17, 23, 55));
  const d2 = dailyRunSeed(new Date(2026, 9, 18));
  check("the Daily Run seed is the same all day", d1 === d1b && d1 === "RUN-20261017", d1);
  check("the Daily Run seed changes the next day", d1 !== d2);
  check("the Daily Run is not the classic Daily", d1 !== dailySeedCode(new Date(2026, 9, 17)) && isDailyRunSeed(d1) && !isDailyRunSeed("K7F2QM"));
}

console.log("\n17. Drift Run boards are always fair");
{
  const tally = { room: 0, elite: 0, boss: 0, bossRule: 0, switches: 0, bossSwitches: 0 };
  const byBoss = {};
  let unsolvable = 0, notExactlyOne = 0, invisible = 0, shortcut = 0, staleEcho = 0;
  const onTrial = (run, g, t) => {
    tally[run.node.type]++;
    const prev = g.prevTarget;
    const hits = oracle(t.rule, t.tiles, prev);
    if (t.target < 0 || t.target > 4 || evaluateRule(t.rule, t.tiles, prev) !== t.target) unsolvable++;
    if (hits.length !== 1 || hits[0] !== t.target) notExactlyOne++;
    if (ruleNeedsPrev(t.rule) && !prev) staleEcho++;
    if (isBossRule(t.rule)) {
      tally.bossRule++;
      byBoss[t.rule] = (byBoss[t.rule] || 0) + 1;
      if (shortcutHits(t.rule, t.tiles, prev, t.target)) shortcut++;
    }
    if (t.isSwitchTrial) {
      tally.switches++;
      if (isBossRule(t.rule) || isBossRule(g.previousRule)) tally.bossSwitches++;
      if (evaluateRule(g.previousRule, t.tiles, prev) === t.target) invisible++;
    }
  };
  const rng = makeRng(hashSeed("run-fair"));
  let wins = 0, deaths = 0;
  for (let i = 0; i < 500; i++) {
    const r = playRun("FAIR" + i, { style: i % 2 ? "sloppy" : "perfect", rng, onTrial });
    if (r.won) wins++; else deaths++;
  }
  const boards = tally.room + tally.elite + tally.boss;
  check(`every Drift Run board has exactly one correct tile (${boards} boards, 500 runs)`, unsolvable === 0 && notExactlyOne === 0,
    `unsolvable=${unsolvable} notOne=${notExactlyOne}`);
  check(`every node type was really played (room ${tally.room}, elite ${tally.elite}, boss ${tally.boss})`,
    tally.room > 1000 && tally.elite > 1000 && tally.boss > 1000);
  check(`all three boss rules were dealt (${Object.entries(byBoss).map(([k, v]) => k.slice(5) + " " + v).join(", ")})`,
    BOSS_RULES.every((b) => (byBoss[b.id] || 0) > 200));
  check("no boss board can be won with a one-attribute idea", shortcut === 0, `shortcut=${shortcut}`);
  check(`a rule change is never invisible (${tally.switches} changes, ${tally.bossSwitches} into or out of a boss rule)`,
    invisible === 0 && tally.bossSwitches > 500, `invisible=${invisible}`);
  check("no echo rule without a previous winner in any room", staleEcho === 0, `bad=${staleEcho}`);
  check(`perfect runs clear the run, sloppy ones can fail (${wins} won, ${deaths} lost)`, wins >= 250 && deaths > 0);

  // The constructive fallback, driven directly: it must be just as fair.
  const frng = makeRng(hashSeed("fallback"));
  let fbad = 0;
  for (const b of BOSS_RULES) for (let i = 0; i < 3000; i++) {
    const { tiles, target } = constructTrial(frng, b.id, null);
    const hits = oracle(b.id, tiles, null);
    if (hits.length !== 1 || hits[0] !== target || shortcutHits(b.id, tiles, null, target)) fbad++;
  }
  check("the boss-board fallback builder is fair too (9000 boards)", fbad === 0, `bad=${fbad}`);

  // Every boss rule against every core rule, both directions, with and without a previous winner.
  const srng = makeRng(hashSeed("boss-switch"));
  let sbad = 0, sn = 0;
  for (const b of BOSS_RULES) for (const r of RULES) for (let i = 0; i < 120; i++) {
    const prev = i % 2 ? { shape: srng.pick(["circle", "square", "triangle", "diamond", "hex"]), color: srng.pick(["cyan", "amber", "magenta", "lime", "violet"]), count: 3 } : null;
    if (ruleNeedsPrev(r.id) && !prev) continue;
    for (const [now, old] of [[b.id, r.id], [r.id, b.id]]) {
      const g = generateTrial(srng, now, prev, old);
      sn++;
      const hits = oracle(now, g.tiles, prev);
      if (hits.length !== 1 || hits[0] !== g.target || evaluateRule(old, g.tiles, prev) === g.target) sbad++;
    }
  }
  check(`boss <-> core rule switches stay fair and visible (${sn} switches)`, sbad === 0, `bad=${sbad}`);
}

console.log("\n18. Drift Run is deterministic");
{
  const fp = (seed) => {
    const out = [];
    const r = playRun(seed, {
      style: "sloppy", rng: makeRng(hashSeed("same-hands")),
      onTrial: (run, g, t) => out.push(run.node.id + ":" + t.tiles.map((x) => x.shape[0] + x.color[0] + x.count).join("") + t.target),
    });
    return JSON.stringify([out, r.score, r.path, r.taken, r.hearts]);
  };
  check("the same seed and the same taps give the identical run", fp("SAMESEED") === fp("SAMESEED"));
  check("a different seed gives a different run", fp("SAMESEED") !== fp("OTHERSEED"));

  // A room's boards depend only on the seed and the room, never on the path taken to it.
  const a = new DriftRun({ seed: "PATHS" });
  const b = new DriftRun({ seed: "PATHS" });
  a.enter(a.options()[0].id);
  b.enter(b.options()[0].id);
  check("two players entering the same room see the same first board",
    JSON.stringify(a.trial.tiles) === JSON.stringify(b.trial.tiles));
  const bossA = new DriftRun({ seed: "BOSSPATH" });
  const bossB = new DriftRun({ seed: "BOSSPATH" });
  const walk = (run, lane) => {
    while (run.step < STEPS_PER_ACT) {
      if (run.phase === "map") run.enter(run.options()[Math.min(lane, run.options().length - 1)].id);
      else if (run.phase === "perk") run.pickPerk(run.perkOffer[0]);
      else run.answer(run.trial.target, 800);
    }
    run.enter(run.options()[0].id);
    return run.trial.tiles;
  };
  check("the act-one boss deals the same first board whichever path led there",
    JSON.stringify(walk(bossA, 0)) === JSON.stringify(walk(bossB, 1)));
  check("a boss room opens on its boss rule", bossA.game.currentRule === "BOSS_DOUBLE_LONER", bossA.game.currentRule);
}

console.log("\n19. Hearts, perks and the end of a run");
{
  const bad = playRun("BADRUN", { style: "bad" });
  check("a bad player loses every heart and the run ends", bad.over && !bad.won && bad.hearts <= 0 && bad.phase === "over");
  const good = playRun("GOODRUN", { style: "perfect" });
  check("a perfect player clears all 12 nodes and wins", good.won && good.depth === 12 && good.bossesBeaten === 3,
    `depth=${good.depth} bosses=${good.bossesBeaten}`);

  const r = good.result();
  check("a run result is a normal history record", r.mode === "run" && r.seed === "GOODRUN" && typeof r.playedAt === "number" &&
    r.log.length === r.trials && r.accuracy === 1 && r.brainScore >= 0 && r.brainScore <= 100 && r.level === 12);
  check("a run result carries depth, bosses and perks", r.depth === 12 && r.length === 12 && r.won === true &&
    r.bossesBeaten === 3 && Array.isArray(r.perks) && r.perks.length >= 3, JSON.stringify({ d: r.depth, p: r.perks }));
  check("boss rules show up in the run's per-rule tally", BOSS_RULES.some((b) => r.byRule[b.id]));
  check("a lost run reports where it stopped", bad.result().depth < 12 && bad.result().won === false);

  // The first board of every room is a free look: you cannot know a rule you have not seen.
  const fresh = new DriftRun({ seed: "FREEFIRST" });
  fresh.enter(fresh.options()[0].id);
  const t0 = fresh.trial;
  fresh.answer((t0.target + 1) % 5, 800);
  check("a wrong first board in a room costs no heart", fresh.hearts === 3, `hearts=${fresh.hearts}`);
  const t1 = fresh.trial;
  fresh.answer((t1.target + 1) % 5, 800);
  check("a wrong board after that does", fresh.hearts === 2, `hearts=${fresh.hearts}`);

  // Shield: forgive exactly one perseverative error.
  let shieldOk = false, shieldSecond = false, tried = 0;
  for (let i = 0; i < 200 && !shieldOk; i++) {
    const run = new DriftRun({ seed: "SHIELD" + i });
    run.perks.shield = 1;
    run.enter(run.options()[0].id);
    let guard = 0, hits = 0;
    while (run.phase === "room" && guard++ < 60) {
      const g = run.game;
      const t = g.trial;
      const old = g.previousRule ? t.answers[g.previousRule] : -1;
      if (!t.isSwitchTrial && g.previousRule && old >= 0 && old !== t.target) {
        tried++;
        const before = run.hearts;
        const rec = run.answer(old, 800);
        hits++;
        if (hits === 1) shieldOk = rec.perseverative && rec.shielded && run.hearts === before && run.perks.shield === 0;
        if (hits === 2) { shieldSecond = rec.perseverative && !rec.shielded && run.hearts === before - 1; break; }
      } else run.answer(t.target, 800);
    }
    if (!shieldSecond) shieldOk = false;
  }
  check("a shield forgives one stuck-on-the-old-rule mistake, and only one", shieldOk && shieldSecond, `tried=${tried}`);

  // Perk offers and their effects, over many seeds.
  let sawHeart = false, heartOk = true, sawSlow = false, slowOk = true, campMend = true, offersOk = true, peekOk = true;
  for (let i = 0; i < 300; i++) {
    const rng = makeRng(hashSeed("perk" + i));
    const run = new DriftRun({ seed: "PERK" + i });
    let guard = 0;
    while (!run.over && guard++ < 3000) {
      if (run.phase === "map") run.enter(run.options()[rng.int(2) % run.options().length].id);
      else if (run.phase === "perk") {
        const offer = run.perkOffer;
        if (offer.length !== 3 || new Set(offer).size !== 3 || !offer.every((p) => PERKS[p])) offersOk = false;
        if (run.node.type === "rest" && run.hearts < run.maxHearts && !offer.includes("mend")) campMend = false;
        const pick = offer.includes("heart") && i % 2 ? "heart" : offer.includes("slow") ? "slow" : offer[rng.int(3)];
        const before = { max: run.maxHearts, hearts: run.hearts };
        run.pickPerk(pick);
        if (pick === "heart") {
          sawHeart = true;
          if (run.maxHearts !== Math.min(MAX_HEARTS, before.max + 1) || run.hearts !== Math.min(run.maxHearts, before.hearts + 1)) heartOk = false;
        }
        if (pick === "slow") sawSlow = true;
      } else {
        const g = run.game;
        if (run.perks.slow && run.node.act === 1 && run.node.type === "room" && g.timeLimitMs !== 22500) slowOk = false;
        if (!run.perks.slow && run.node.act === 1 && run.node.type === "room" && g.timeLimitMs !== 15000) slowOk = false;
        if (run.node.act === 0 && g.timed) slowOk = false;
        if (run.perks.peek > 0 && rng.next() < 0.3) {
          const fam = run.usePeek();
          if (!fam || !fam.length || JSON.stringify(fam) !== JSON.stringify(ruleFamilies(g.currentRule))) peekOk = false;
        }
        run.answer(rng.next() < 0.9 ? g.trial.target : rng.int(5), 800);
      }
    }
  }
  check("every perk offer is three different real perks", offersOk);
  check("a campfire always offers Mend to a hurt player", campMend);
  check("Extra heart adds a full heart", sawHeart && heartOk);
  check("act one has no clock; Slow clock stretches the act-two clock from 15s to 22.5s", sawSlow && slowOk);
  check("a peek names the attribute family of the secret, and nothing more", peekOk);
  const np = new DriftRun({ seed: "NOPEEK" });
  np.enter(np.options()[0].id);
  check("a peek with none left reveals nothing", np.usePeek() === null);
}

console.log("\n20. Drift Run results sync like every other game");
{
  const runA = playRun("SYNC-A", { style: "perfect" }).result();
  runA.playedAt = 1000;
  const runB = playRun(dailyRunSeed(new Date(2026, 9, 17)), { style: "sloppy", rng: makeRng(hashSeed("sb")), daily: true }).result();
  runB.playedAt = 2000;
  const quick = autoplay("SYNC-Q", 2).result();
  quick.playedAt = 1500;
  const sum = (h) => h.reduce((s, r) => s + xpFor(r), 0);
  const mk = (history, updatedAt) => ({ history, dailyResults: {}, duels: [], ruleStats: {}, unlocked: [], updatedAt, xp: sum(history), bestScore: Math.max(0, ...history.map((r) => r.score)) });
  const laptop = mk([runA, quick], 10);
  const phone = mk([runB, quick], 20);
  const m = mergeProfiles(laptop, phone);
  check("merge keeps both runs and the shared quick game once", m.history.length === 3 &&
    m.history.filter((r) => r.mode === "run").length === 2);
  check("merged XP is recomputed from history, never summed", m.xp === sum(m.history), `${m.xp} vs ${sum(m.history)}`);
  const again = mergeProfiles(mergeProfiles(m, phone), laptop);
  check("merging runs again changes nothing", again.xp === m.xp && again.history.length === 3);
  check("merge order does not matter with runs", JSON.stringify(mergeProfiles(phone, laptop).history.map((r) => r.playedAt)) ===
    JSON.stringify(m.history.map((r) => r.playedAt)));
  check("the best score counts runs", m.bestScore === Math.max(runA.score, runB.score, quick.score));
  check("a run keeps its depth and perks through a merge", m.history.find((r) => r.seed === "SYNC-A").depth === 12);
  check("today's Daily Run is found from merged history", findDailyRun(m.history, new Date(2026, 9, 17)) &&
    findDailyRun(m.history, new Date(2026, 9, 17)).seed === "RUN-20261017" && findDailyRun(m.history, new Date(2026, 9, 18)) === null);

  const imp = parseImport(JSON.stringify(m));
  check("an export with runs imports cleanly", imp.ok && imp.profile.history.filter((r) => r.mode === "run").length === 2);
  check("boss rules do not count towards the eight core rules",
    lifetimeStats({ ...m, ruleStats: { BOSS_DOUBLE_LONER: { seen: 3, correct: 2 }, MOST_PIPS: { seen: 1, correct: 1 } } }).rulesSeen === 1);
  check("Drift Run shows its own name on result screens", modeConfig("run").label === "Drift Run");
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
