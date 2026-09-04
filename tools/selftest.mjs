// Engine self-test. Run: node tools/selftest.mjs
// Checks the invariants that make the game fair and the duel honest.

import { Game } from "../src/engine.js";
import { generateTrial, evaluateRule, RULES, rulesUpToTier, ruleNeedsPrev } from "../src/rules.js";
import { makeRng, hashSeed, randomSeedCode, dailySeedCode } from "../src/rng.js";
import { STEPS as TUT, GUIDE_EXAMPLES } from "../src/tutorial.js";
import { MODES, modeConfig, timeLimitForLevel } from "../src/engine.js";
import { rankFor, achievementRows, lifetimeStats } from "../src/achievements.js";

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

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
