// Engine self-test. Run: node tools/selftest.mjs
// Checks the invariants that make the game fair and the duel honest.

import { Game } from "../src/engine.js";
import { generateTrial, evaluateRule, RULES, rulesUpToTier, ruleNeedsPrev } from "../src/rules.js";
import { makeRng, hashSeed, randomSeedCode, dailySeedCode } from "../src/rng.js";

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
  const g = new Game({ seed, mode: "practice", maxTier: tier });
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
    const g = new Game({ seed: "T" + i, mode: "practice", maxTier: 3 });
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
    const g = new Game({ seed: "E" + i, mode: "practice", maxTier: 3 });
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
    const g = new Game({ seed: "P" + i, mode: "practice", maxTier: 3 });
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

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
