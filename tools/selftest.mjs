// Engine self-test. Run: node tools/selftest.mjs
// Checks the invariants that make the game fair and the duel honest.

import { Game } from "../src/engine.js";
import { generateTrial, evaluateRule, RULES, rulesUpToTier, ruleNeedsPrev } from "../src/rules.js";
import { makeRng, hashSeed, randomSeedCode, dailySeedCode } from "../src/rng.js";
import { STEPS as TUT, GUIDE_EXAMPLES } from "../src/tutorial.js";
import { MODES, modeConfig, timeLimitForLevel } from "../src/engine.js";
import { rankFor, achievementRows, lifetimeStats } from "../src/achievements.js";
import { mergeProfiles, streaksFromDays } from "../src/storage.js";
import {
  cloudConfigured,
  PROVIDERS,
  signedIn,
  providerAvailability,
  readPullResponse,
  discordAuthorizeUrl,
} from "../src/cloud.js";
import { discordProfile } from "../api/discord/callback.js";
import { DISCORD_CLIENT_ID } from "../src/config.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_CLIENT_ID } from "../src/config.js";

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
  // The config is either fully present or fully absent - half-configured is the
  // state that produces confusing runtime failures.
  const bothOrNeither =
    (Boolean(SUPABASE_URL) && Boolean(SUPABASE_ANON_KEY)) ||
    (!SUPABASE_URL && !SUPABASE_ANON_KEY);
  check("cloud config is all-or-nothing", bothOrNeither,
    `url=${Boolean(SUPABASE_URL)} key=${Boolean(SUPABASE_ANON_KEY)}`);
  check("cloudConfigured() matches the config", cloudConfigured() === Boolean(SUPABASE_URL && SUPABASE_ANON_KEY));

  if (SUPABASE_ANON_KEY) {
    // Shipping a service_role key in client code would hand every visitor full
    // read/write access to every player's data, bypassing RLS entirely.
    let role = null;
    try {
      const body = SUPABASE_ANON_KEY.split(".")[1];
      if (body) role = JSON.parse(Buffer.from(body, "base64url").toString()).role;
    } catch { /* non-JWT publishable keys have no payload to read */ }
    check("the shipped key is NOT a service_role key",
      role !== "service_role", `role=${role}`);
    check("the shipped key is the anon key",
      role === "anon" || role === null || SUPABASE_ANON_KEY.startsWith("sb_publishable_"),
      `role=${role}`);
    check("the project URL is https", /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL), SUPABASE_URL);
  }

  check("both OAuth providers are offered",
    PROVIDERS.length === 2 && PROVIDERS.some((p) => p.id === "google") && PROVIDERS.some((p) => p.id === "discord"),
    PROVIDERS.map((p) => p.id).join(","));
  check("nobody is signed in by default", signedIn() === false);

  // A button that promises a login the server will refuse is worse than no
  // button, so availability is read from the project rather than hardcoded.
  const live = providerAvailability({ external: { discord: true, google: false, email: true } });
  check("an enabled provider reads as available", live.discord === true);
  check("a provider that is off reads as unavailable", live.google === false);

  // Discord is deliberately exempt: it signs in through our own callback, so
  // Supabase's provider toggle no longer describes whether it works.
  check("Discord stays available even if Supabase's provider is switched off",
    providerAvailability({ external: { discord: false } }).discord === Boolean(DISCORD_CLIENT_ID));
  check("availability only covers providers we actually offer",
    Object.keys(live).sort().join(",") === "discord,google", Object.keys(live).join(","));
  // The bug this replaces: a failed read and an empty cloud both returned null,
  // so a fresh device that could not read would push its empty profile over a
  // real backup and destroy it. These two cases must never look alike.
  const failed = readPullResponse(false);
  const empty = readPullResponse(true, []);
  const found = readPullResponse(true, [{ data: { history: [1, 2, 3] } }]);
  check("a failed read is not ok", failed.ok === false);
  check("an empty cloud IS ok, just empty", empty.ok === true && empty.data === null);
  check("a failed read is distinguishable from an empty cloud", failed.ok !== empty.ok);
  check("a found profile comes back intact", found.ok === true && found.data.history.length === 3);

  // And the merge it feeds: an empty device must inherit the cloud, never erase it.
  const restored = mergeProfiles(
    { history: [], dailyResults: {}, updatedAt: 0 },
    { history: [{ playedAt: 5, seed: "AAA", score: 90 }], dailyResults: { "2026-09-01": { score: 90 } }, updatedAt: 10 }
  );
  check("a fresh device inherits the cloud history rather than blanking it",
    restored.history.length === 1 && restored.history[0].score === 90,
    JSON.stringify(restored.history));

  // Google sign-in runs on our own domain via Google Identity Services, which
  // only works if the client ID is the real one. A typo here fails silently at
  // runtime - the button simply never appears - so assert its shape instead.
  check("the Google client ID is either unset or a real one",
    GOOGLE_CLIENT_ID === "" || /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_ID || "(unset)");

  // Everything that DOES depend on the Supabase payload must still fail closed.
  check("a missing settings payload disables the Supabase-backed providers",
    providerAvailability(null).google === false);
  check("an empty external map disables the Supabase-backed providers",
    providerAvailability({ external: {} }).google === false);

  // -------------------------------------------------------------------------
  // Discord sign-in runs on our own domain
  //
  // The whole reason api/discord/callback.js exists is that Supabase's hosted
  // redirect made Discord's consent screen announce
  // "<project-ref>.supabase.co" to the player. If that hostname ever creeps
  // back into the authorize URL, the bug is back and nothing else would catch
  // it - the login would still work, it would just look untrustworthy again.
  // -------------------------------------------------------------------------
  const dUrl = new URL(discordAuthorizeUrl("https://ruledrift.vercel.app", "s7"));
  const dRedirect = dUrl.searchParams.get("redirect_uri");

  check("Discord sign-in starts at Discord", dUrl.origin === "https://discord.com", dUrl.origin);
  check("Discord is sent back to OUR domain, not Supabase's",
    dRedirect === "https://ruledrift.vercel.app/api/discord/callback", dRedirect);
  check("the Supabase hostname never appears on Discord's consent screen",
    !dUrl.search.includes("supabase.co"), dUrl.search);
  check("Discord is asked only for identity and email",
    dUrl.searchParams.get("scope") === "identify email", dUrl.searchParams.get("scope"));
  check("the CSRF state is carried through", dUrl.searchParams.get("state") === "s7");
  check("the authorize URL asks for the code flow",
    dUrl.searchParams.get("response_type") === "code");
  check("the Discord client ID is either unset or a real snowflake",
    DISCORD_CLIENT_ID === "" || /^[0-9]{17,20}$/.test(DISCORD_CLIENT_ID),
    DISCORD_CLIENT_ID || "(unset)");

  // The Supabase user is keyed on email, so an unverified address would let
  // someone claim an account that is not theirs.
  check("an unverified Discord email is refused",
    discordProfile({ id: "1", email: "a@b.com", verified: false }) === null);
  check("a Discord account with no email is refused",
    discordProfile({ id: "1", username: "x" }) === null);

  const dp = discordProfile({ id: "42", email: "a@b.com", verified: true, username: "mridul", avatar: "abc" });
  check("a verified Discord account yields a profile", dp !== null);
  check("the profile keeps the email", dp.email === "a@b.com");
  check("the profile is tagged as discord", dp.provider === "discord");
  check("the avatar URL is built from the account id and hash",
    dp.avatar_url === "https://cdn.discordapp.com/avatars/42/abc.png?size=128", dp.avatar_url);
  check("the display name falls back to the username",
    dp.full_name === "mridul", dp.full_name);
  check("a global name wins over the username",
    discordProfile({ id: "42", email: "a@b.com", verified: true, username: "u", global_name: "G" }).full_name === "G");
  check("an avatarless account yields an empty avatar, not a broken URL",
    discordProfile({ id: "42", email: "a@b.com", verified: true, username: "u" }).avatar_url === "");
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
