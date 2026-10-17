// Self-test. Run: node tools/selftest.mjs
// Checks the invariants that make the game fair: every puzzle has exactly one
// answer that logic reaches, every hint is provable, runs and rooms are
// deterministic, and no sync can lose or invent progress.

import {
  generatePuzzle, solveLogic, clueHolds, clueText, clueParts, clueKind, findHint, PuzzlePlay, PRESETS, PRACTICE,
  cellKey, parseKey, isTrue, dailyPreset, dailyClueSeed, findDailyClues, puzzleResult, scorePuzzle, cluesFor, clock,
} from "../src/clues.js";
import {
  DriftRun, buildRunMap, dailyRunSeed, findDailyRun, isDailyRunSeed, STEPS_PER_ACT, PERKS, MAX_HEARTS, ACTS, ELITE_MS, presetFor,
} from "../src/driftrun.js";
import { dailySeedCode } from "../src/rng.js";
import { TUTORIAL_PUZZLE, STEPS as TUT } from "../src/tutorial.js";
import { rankFor, achievementRows, lifetimeStats, xpFor, unlockedSet } from "../src/achievements.js";
import { mergeProfiles, streaksFromDays, parseImport } from "../src/storage.js";
import * as storage from "../src/storage.js";
import {
  cloudConfigured,
  PROVIDERS,
  signedIn,
  providerAvailability,
  readPullResponse,
  providerStartUrl,
  tokenClaims,
  hasSignInHash,
  toFs, fromFs, fieldPath, patchBody, readRoomResponse,
} from "../src/cloud.js";
import * as roomsLib from "../src/rooms.js";
import { buildShareText } from "../src/share.js";
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function perms(n) {
  const out = [];
  const rec = (arr, used) => {
    if (arr.length === n) { out.push(arr.slice()); return; }
    for (let i = 0; i < n; i++) if (!used[i]) { used[i] = true; arr.push(i); rec(arr, used); arr.pop(); used[i] = false; }
  };
  rec([], []);
  return out;
}
const PERMS = { 3: perms(3), 4: perms(4), 5: perms(5) };

/** Every answer the clues allow, by brute force (stops at `limit`). */
function bruteSolutions(pz, limit = 3) {
  const { n, k, clues } = pz;
  const cats = (cl) => [cl.a, cl.b, cl.b2].filter(Boolean).map((it) => it.c).filter((c) => c >= 0);
  const by = Array.from({ length: k }, () => []);
  for (const cl of clues) by[Math.max(-1, ...cats(cl))].push(cl);
  const found = [];
  const sol = [];
  const rec = (c) => {
    if (found.length >= limit) return;
    if (c === k) { found.push(sol.map((r) => r.slice())); return; }
    for (const p of PERMS[n]) {
      sol[c] = p;
      // Only clues whose categories are all chosen can be checked yet.
      const partial = sol.slice(0, c + 1);
      if (by[c].every((cl) => clueHolds(partial, cl))) rec(c + 1);
    }
    sol.length = c;
  };
  rec(0);
  return found;
}

/** Tap a cell until it shows `v`. */
function setMark(play, key, v) {
  for (let i = 0; i < 3 && (play.grid[key] || 0) !== v; i++) play.tap(key);
}

/** Solve a puzzle perfectly: a check on every true cell. */
function solveByHand(play) {
  const pz = play.puzzle;
  for (let c = 0; c < pz.k; c++) for (let p = 0; p < pz.n; p++) {
    const key = cellKey(c, p, pz.solution[c][p]);
    if (play.solved) return;
    setMark(play, key, 2);
  }
}

console.log("\n1. Every puzzle has exactly one answer, and logic alone reaches it (2,000 per size)");
{
  const SEEDS = 2000;
  for (const id of Object.keys(PRESETS)) {
    const P = PRESETS[id];
    let notLogic = 0, untrue = 0, notMinimal = 0, badShape = 0, nondet = 0, minC = 99, maxC = 0;
    const kinds = new Set();
    for (let i = 0; i < SEEDS; i++) {
      const pz = generatePuzzle("T" + i, id);
      const r = solveLogic(pz.n, pz.k, pz.clues);
      if (!r.done || JSON.stringify(r.solution) !== JSON.stringify(pz.solution)) notLogic++;
      if (!pz.clues.every((cl) => clueHolds(pz.solution, cl))) untrue++;
      // Minimal for logic: take any one clue away and the deductions stall.
      for (let j = 0; j < pz.clues.length; j++) {
        if (solveLogic(pz.n, pz.k, pz.clues.filter((_, x) => x !== j)).done) { notMinimal++; break; }
      }
      if (pz.n !== P.n || pz.k !== P.cats.length || pz.people.length !== P.n || new Set(pz.people).size !== P.n ||
        pz.cats.some((c) => c.values.length !== P.n || new Set(c.values).size !== P.n)) badShape++;
      if (i % 10 === 0 && JSON.stringify(generatePuzzle("T" + i, id)) !== JSON.stringify(pz)) nondet++;
      minC = Math.min(minC, pz.clues.length);
      maxC = Math.max(maxC, pz.clues.length);
      for (const cl of pz.clues) kinds.add(clueKind(cl));
    }
    check(`${id}: logic fills the grid and lands on the planted answer`, notLogic === 0, `bad=${notLogic}`);
    check(`${id}: every clue is true`, untrue === 0, `bad=${untrue}`);
    check(`${id}: no clue is spare (removing any one stalls the logic)`, notMinimal === 0, `bad=${notMinimal}`);
    check(`${id}: right number of people, values and categories`, badShape === 0, `bad=${badShape}`);
    check(`${id}: the same seed deals the same puzzle`, nondet === 0, `bad=${nondet}`);
    check(`${id}: a sensible number of clues (${minC}-${maxC})`, minC >= 2 && maxC <= 20);
    if (id !== "easy") check(`${id}: a mix of clue kinds (${[...kinds].join(", ")})`, kinds.size >= 4);
  }
  check("different seeds deal different puzzles",
    new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(generatePuzzle("D" + i, "medium").solution))).size > 30);
  check("a size id that does not exist falls back to Easy", generatePuzzle("X", "nope").preset === "easy");
}

console.log("\n2. Brute force agrees: exactly one answer");
{
  const plan = { easy: 2000, easy4: 2000, medium: 2000, hard: 300, expert: 8 };
  for (const [id, count] of Object.entries(plan)) {
    let bad = 0;
    for (let i = 0; i < count; i++) {
      const pz = generatePuzzle("T" + i, id);
      const all = bruteSolutions(pz, 2);
      if (all.length !== 1 || JSON.stringify(all[0]) !== JSON.stringify(pz.solution)) bad++;
    }
    check(`${id}: brute force finds one answer, the planted one (${count} puzzles)`, bad === 0, `bad=${bad}`);
  }
}

console.log("\n3. Hints are always provable, and say why");
{
  for (const id of Object.keys(PRESETS)) {
    let fallback = 0, wrong = 0, unsolved = 0, noReason = 0, steps = 0;
    for (let i = 0; i < 300; i++) {
      const pz = generatePuzzle("H" + i, id);
      const play = new PuzzlePlay(pz);
      let guard = 0;
      while (!play.solved && guard++ < 200) {
        const hres = play.hint();
        if (!hres) break;
        steps++;
        if (hres.fallback) fallback++;
        if (hres.value === 2 && !isTrue(pz, hres.key)) wrong++;
        if (hres.value === 1 && isTrue(pz, hres.key)) wrong++;
        if (!hres.why || /undefined|NaN/.test(hres.why)) noReason++;
      }
      if (!play.solved) unsolved++;
    }
    check(`${id}: hints alone solve every puzzle, never peeking at the answer`, fallback === 0 && unsolved === 0, `fallback=${fallback} unsolved=${unsolved}`);
    check(`${id}: every hinted mark is right`, wrong === 0, `wrong=${wrong}`);
    check(`${id}: every hint gives a reason`, noReason === 0 && steps > 0);
  }
  // Hints work from half-finished grids too, not just from empty.
  const pz = generatePuzzle("MID", "hard");
  const play = new PuzzlePlay(pz);
  setMark(play, cellKey(0, 0, pz.solution[0][0]), 2);
  const hres = play.hint();
  check("a hint on a half-done grid is a new, correct mark", hres && !hres.fallback && (hres.value === 2) === isTrue(pz, hres.key));
  const cited = (() => {
    for (let i = 0; i < 50; i++) {
      const p2 = new PuzzlePlay(generatePuzzle("C" + i, "medium"));
      const h2 = p2.hint();
      if (h2 && h2.clue !== null) return /^Clue \d+ proves it/.test(h2.why);
    }
    return false;
  })();
  check("a clue-based hint names its clue", cited);

  // A wrong X is the one thing that can strand a player: the hint fixes it first.
  const p3 = new PuzzlePlay(generatePuzzle("FIX", "medium"));
  const truthKey = cellKey(1, 2, p3.puzzle.solution[1][2]);
  p3.tap(truthKey);
  const fix = p3.hint();
  check("an X on the real answer is found and cleared by a hint", fix && fix.fix && fix.key === truthKey && !p3.grid[truthKey]);
  const p4 = new PuzzlePlay(generatePuzzle("FIX2", "easy"));
  const falseKey = cellKey(0, 0, (p4.puzzle.solution[0][0] + 1) % 3);
  p4.grid[falseKey] = 2; // as if it came from elsewhere
  const fix2 = p4.hint();
  check("a wrong check is found and turned into an X", fix2 && fix2.fix && fix2.key === falseKey && p4.grid[falseKey] === 1);
}

console.log("\n4. Marks, mistakes and the end of a puzzle");
{
  const pz = generatePuzzle("PLAY", "medium");
  const play = new PuzzlePlay(pz);
  const t = cellKey(0, 1, pz.solution[0][1]);
  const f = cellKey(0, 1, (pz.solution[0][1] + 1) % pz.n);
  check("one tap is an X", play.tap(f).value === 1 && play.grid[f] === 1);
  const wrong = play.tap(f);
  check("a wrong check counts one mistake", wrong.wrong === true && play.mistakes === 1);
  check("a wrong check settles as an X, never a check", play.grid[f] === 1);
  play.tap(t);
  const right = play.tap(t);
  check("a right check stays", right.value === 2 && !right.wrong && play.grid[t] === 2);
  const autoX = Object.keys(right.changed).filter((k) => k !== t);
  check("a check crosses out the rest of its row and column", autoX.length >= 2 * (pz.n - 1) - 1 &&
    autoX.every((k) => play.grid[k] === 1 && !isTrue(pz, k)));
  check("a third tap clears a cell", (() => { const q = new PuzzlePlay(pz); q.tap(f); q.tap(f); q.tap(t); q.tap(t); return q.tap(t).value === 0 && !q.grid[t]; })());
  check("not solved until every rune is placed", !play.solved);
  solveByHand(play);
  check("placing every rune solves it", play.solved && play.placed === play.total);
  check("a solved grid ignores further taps", play.tap(f) === null);
  const shielded = new PuzzlePlay(pz, { shields: 1 });
  const s1 = shielded.place(f, 2);
  check("a shield forgives one wrong check", s1.wrong && s1.shielded && shielded.mistakes === 0 && shielded.forgiven === 1);
  check("only one", shielded.place(cellKey(0, 2, (pz.solution[0][2] + 1) % pz.n), 2).shielded === false && shielded.mistakes === 1);

  const res = puzzleResult(play, { mode: "sc-practice", ms: 95000, playedAt: 1234 });
  check("a solved puzzle makes a full history record", res.game === "clues" && res.mode === "sc-practice" && res.solved &&
    res.seed === "PLAY" && res.preset === "medium" && res.mistakes === 1 && res.ms === 95000 && res.playedAt === 1234);
  check("score rewards pace and punishes slips", scorePuzzle("medium", 60000) > scorePuzzle("medium", 300000) &&
    scorePuzzle("medium", 60000, 0) > scorePuzzle("medium", 60000, 2) && scorePuzzle("medium", 60000, 0, 0) > scorePuzzle("medium", 60000, 0, 1));
  check("score never goes below a floor", scorePuzzle("easy", 9e9, 50, 50) > 0);
  check("the clock reads like a clock", clock(0) === "0:00" && clock(65000) === "1:05" && clock(600000) === "10:00");

  check("cell keys round-trip", JSON.stringify(parseKey(cellKey(2, 4, 3))) === JSON.stringify({ c: 2, p: 4, v: 3 }) && parseKey("x") === null);
  const remote = new PuzzlePlay(pz);
  remote.applyRemote({ [t]: 2, junk: 5, g9r9c9x: 1, [f]: 7 });
  check("marks from a friend are taken, junk is not", remote.grid[t] === 2 && Object.keys(remote.grid).length === 1);
}

console.log("\n5. Clues read as sentences");
{
  let bad = 0, n = 0;
  const kinds = new Set();
  for (const id of Object.keys(PRESETS)) {
    for (let i = 0; i < 200; i++) {
      const pz = generatePuzzle("W" + i, id);
      for (const cl of pz.clues) {
        n++;
        kinds.add(clueKind(cl));
        const txt = clueText(pz, cl);
        const parts = clueParts(pz, cl);
        if (!/^[A-Z].*\.$/.test(txt) || /undefined|NaN|null|\s\s/.test(txt)) bad++;
        if (!parts.length || parts.some((p) => !p.item && typeof p.text !== "string")) bad++;
      }
    }
  }
  check(`${n} clues all render as clean sentences`, bad === 0, `bad=${bad}`);
  check("every clue kind is dealt somewhere", ["same", "diff", "either", "link", "unlink", "left", "next", "right"].every((k) => kinds.has(k)), [...kinds].join(","));
  const pz = generatePuzzle("WORDS", "expert");
  check("an expert clue mentions real names or features", pz.clues.every((cl) => {
    const t = clueText(pz, cl);
    return pz.people.some((p) => t.includes(p)) || /circle|square|triangle|diamond|hexagon|teal|amber|rose|green|violet|dot/.test(t);
  }));
}

console.log("\n6. The Daily puzzle");
{
  const mon = new Date(2026, 9, 12), sun = new Date(2026, 9, 18);
  check("Monday is Easy, Sunday is Expert", dailyPreset(mon) === "easy" && dailyPreset(sun) === "expert");
  check("every weekday has a real size", Array.from({ length: 7 }, (_, i) => dailyPreset(new Date(2026, 9, 12 + i))).every((p) => PRESETS[p]));
  const s1 = dailyClueSeed(new Date(2026, 9, 17, 0, 5)), s2 = dailyClueSeed(new Date(2026, 9, 17, 23, 55));
  check("the Daily seed is the same all day", s1 === s2 && s1 === "CLUES-20261017", s1);
  check("the Daily seed changes the next day", s1 !== dailyClueSeed(new Date(2026, 9, 18)));
  check("the Daily puzzle is not the Daily Run or the old Daily", s1 !== dailyRunSeed(new Date(2026, 9, 17)) && s1 !== dailySeedCode(new Date(2026, 9, 17)));
  check("everyone gets the same Daily", JSON.stringify(generatePuzzle(s1, dailyPreset(new Date(2026, 9, 17)))) ===
    JSON.stringify(generatePuzzle(s1, dailyPreset(new Date(2026, 9, 17)))));
  const hist = [{ game: "clues", mode: "sc-practice", seed: s1 }, { mode: "daily", seed: "DAILY-20261017" }, { game: "clues", mode: "sc-daily", seed: s1, ms: 5 }];
  check("today's Daily is found from history, and only today's", findDailyClues(hist, new Date(2026, 9, 17)).ms === 5 &&
    findDailyClues(hist, new Date(2026, 9, 18)) === null);
}

console.log("\n7. The tutorial puzzle teaches what it says");
{
  const pz = TUTORIAL_PUZZLE;
  const r = solveLogic(pz.n, pz.k, pz.clues);
  check("the tutorial's two clues solve it by logic", r.done && JSON.stringify(r.solution) === JSON.stringify(pz.solution));
  check("both tutorial clues are needed", pz.clues.every((_, j) => !solveLogic(pz.n, pz.k, pz.clues.filter((__, x) => x !== j)).done));
  check("the clues say what the steps claim", clueText(pz, pz.clues[0]) === "Ravi's rune is a square." &&
    clueText(pz, pz.clues[1]) === "Mira's rune is not a triangle.");
  const play = new PuzzlePlay(pz);
  let ok = true;
  for (const st of TUT) {
    if (st.value === 2 && !isTrue(pz, st.key)) ok = false;
    if (st.value === 1 && isTrue(pz, st.key)) ok = false;
    if ((play.grid[st.key] || 0) !== 0) ok = false; // each step's cell is still blank when it is asked for
    setMark(play, st.key, st.value);
    if (play.grid[st.key] !== st.value) ok = false;
  }
  check("following the four steps never makes a mistake and solves it", ok && play.solved && play.mistakes === 0);
}

// A run played with a fake clock: `style` decides how it plays each room.
function playRun(seed, { style = "perfect", daily = false, lane = 0, slips = 0 } = {}) {
  const r = new DriftRun({ seed, daily });
  let now = 0;
  let guard = 0;
  while (!r.over && guard++ < 200) {
    if (r.phase === "map") {
      const opts = r.options();
      r.enter(opts[Math.min(lane, opts.length - 1)].id, now);
    } else if (r.phase === "perk") {
      r.pickPerk(r.perkOffer[0]);
    } else if (r.phase === "room") {
      const pz = r.play.puzzle;
      // Optional slips first: a wrong check on a false cell.
      for (let s = 0; s < slips && r.phase === "room"; s++) {
        const key = cellKey(0, 0, (pz.solution[0][0] + 1 + s) % pz.n);
        if (r.play.grid[key] === 1) continue;
        while (r.phase === "room" && (r.play.grid[key] || 0) !== 1) r.tap(key, (now += 1000));
        if (r.phase !== "room") break;
        if (style === "sloppy") r.tap(key, (now += 1000)); // check it: wrong
      }
      for (let c = 0; c < pz.k && r.phase === "room"; c++) {
        for (let p = 0; p < pz.n && r.phase === "room"; p++) {
          const key = cellKey(c, p, pz.solution[c][p]);
          while (r.phase === "room" && r.play && (r.play.grid[key] || 0) !== 2) r.tap(key, (now += 1000));
        }
      }
    }
  }
  return r;
}

console.log("\n8. Drift Run maps (unchanged machinery)");
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
  check("the same seed always draws the same map", nonDeterministic === 0, `diff=${nonDeterministic}`);
  check("different seeds draw different maps", distinct.size > 20, `distinct=${distinct.size}`);
  const d1 = dailyRunSeed(new Date(2026, 9, 17, 0, 5));
  check("the Daily Run seed is the same all day", d1 === dailyRunSeed(new Date(2026, 9, 17, 23, 55)) && d1 === "RUN-20261017", d1);
  check("the Daily Run seed changes the next day", d1 !== dailyRunSeed(new Date(2026, 9, 18)) && isDailyRunSeed(d1) && !isDailyRunSeed("K7F2QM"));
  check("puzzles grow act by act, and every boss is the biggest grid of its act", ACTS.every((a) =>
    PRESETS[a.boss].n * PRESETS[a.boss].cats.length >= PRESETS[a.elite].n * PRESETS[a.elite].cats.length &&
    PRESETS[a.elite].n * PRESETS[a.elite].cats.length >= PRESETS[a.room].n * PRESETS[a.room].cats.length) &&
    ACTS[2].boss === "expert");
  check("every elite has a clock", ACTS.every((a) => ELITE_MS[a.elite] > 0));
}

console.log("\n9. Drift Run rooms are puzzles: hearts, perks, the end");
{
  let lost = 0, notWon = 0;
  for (let i = 0; i < 40; i++) {
    const r = playRun("WIN" + i, { lane: i % 2 });
    if (!r.won) notWon++;
    if (r.hearts <= 0) lost++;
  }
  check("a perfect player wins every run (40 runs, both lanes)", notWon === 0 && lost === 0, `notWon=${notWon}`);
  const r = playRun("FULL");
  const res = r.result(777);
  const rests = res.path.filter((id) => buildRunMap("FULL").acts.some((a) => a.steps.flat().some((n) => n.id === id && n.type === "rest"))).length;
  check("a won run cleared all 12 depths, one puzzle per non-campfire step", res.won && res.depth === 12 && res.rooms === 12 - rests && res.bossesBeaten === 3, JSON.stringify(res).slice(0, 200));
  check("a run is one history record of the new kind", res.game === "clues" && res.mode === "sc-run" && res.playedAt === 777 && res.seed === "FULL");
  check("a clean run counts clean rooms and no slips", res.mistakes === 0 && res.cleanRooms === res.rooms && res.hints === 0);
  check("same seed, same play, same result", JSON.stringify(playRun("DET").result(1)) === JSON.stringify(playRun("DET").result(1)));
  check("the rooms a run deals depend only on the seed and the room", JSON.stringify(generatePuzzle("DET:a0s0l0", presetFor({ act: 0, type: "room" }))) ===
    JSON.stringify((() => { const x = new DriftRun({ seed: "DET" }); const n = x.options().find((o) => o.type === "room"); x.enter(n.id); return x.play.puzzle; })()));

  const sloppy = playRun("SLIP", { style: "sloppy", slips: 1 });
  check("wrong checks cost hearts until the run ends", sloppy.over && !sloppy.won && sloppy.hearts === 0, `hearts=${sloppy.hearts} phase=${sloppy.phase}`);
  check("a lost run still records how deep it went", sloppy.result().depth >= 1 && sloppy.result().mistakes >= 3);

  // Shield, lantern, mend, heart.
  const x = new DriftRun({ seed: "PERKS" });
  const roomNode = x.options().find((o) => o.type === "room");
  x.enter(roomNode.id, 0);
  x.shields = 1; x.play.shields = 1;
  const pz = x.play.puzzle;
  const bad = cellKey(0, 0, (pz.solution[0][0] + 1) % pz.n);
  x.tap(bad, 1); const rec = x.tap(bad, 2);
  check("a shield takes a wrong check instead of a heart", rec.wrong && rec.shielded && x.hearts === 3 && x.shields === 0);
  x.tap(cellKey(0, 0, (pz.solution[0][0] + 2) % pz.n), 3);
  const rec2 = x.tap(cellKey(0, 0, (pz.solution[0][0] + 2) % pz.n), 4);
  check("without one, a wrong check costs a heart", rec2.wrong && !rec2.shielded && x.hearts === 2);
  const hintsBefore = x.hints;
  check("a hint is spent from the run's supply", x.hint(5) && x.hints === hintsBefore - 1 && x.hintsUsed === 1);
  x.hints = 0;
  check("no hints left means no hint", x.hint(6) === null);

  const y = new DriftRun({ seed: "PERKS" });
  y.phase = "perk"; y.perkOffer = ["lantern", "heart", "mend"]; y.node = { type: "elite", act: 0 };
  y.pickPerk("lantern");
  check("Lantern adds two hints", y.hints === 3);
  y.phase = "perk"; y.perkOffer = ["heart"]; y.node = { type: "elite", act: 0 };
  y.pickPerk("heart");
  check("Extra heart raises the cap and fills it", y.maxHearts === 4 && y.hearts === 4);
  check("every perk has a label", Object.values(PERKS).every((p) => p.label && p.blurb) && MAX_HEARTS === 5);

  // An elite's clock: running out costs a heart and stops the clock.
  const e = new DriftRun({ seed: "ELITE" });
  const eliteNode = e.options().find((o) => o.type === "elite");
  e.enter(eliteNode.id, 0);
  check("an elite room is timed", e.timed && e.timeLimitMs === ELITE_MS[presetFor(eliteNode)]);
  check("running out of time costs a heart, once", e.timeout(e.timeLimitMs + 1) && e.hearts === 2 && !e.timed && e.timeout(9e9) === false);
  const slowRun = new DriftRun({ seed: "ELITE" });
  slowRun.slow = true;
  slowRun.enter(eliteNode.id, 0);
  check("Slow clock gives half as long again", slowRun.timeLimitMs === Math.round(ELITE_MS[presetFor(eliteNode)] * 1.5));
  const chamber = new DriftRun({ seed: "ELITE" });
  chamber.enter(chamber.options().find((o) => o.type === "room").id, 0);
  check("an ordinary chamber has no clock", !chamber.timed && chamber.timeout(1) === false);

  const hist = [{ game: "clues", mode: "sc-run", seed: "RUN-20261017", score: 5 }, { mode: "run", seed: "RUN-20261017", score: 9 }];
  check("today's Daily Run is found from history, never an old-style run", findDailyRun(hist, new Date(2026, 9, 17)).score === 5);
}

console.log("\n10. Ranks and achievements");
{
  check("rank 0 XP is the first rank", rankFor(0).index === 1);
  check("rank climbs with XP", rankFor(200000).index === 8 && rankFor(200000).next === null);
  const empty = { history: [], duels: [], ruleStats: {}, unlocked: [], xp: 0, longestStreak: 0, bestBrain: 0, bestScore: 0 };
  const rows = achievementRows(empty);
  check("a new player has every achievement locked", rows.every((r) => r.tier === 0));
  check("achievement rows never NaN", rows.every((r) => Number.isFinite(r.progress) && r.progress >= 0 && r.progress <= 1));
  const oldOnly = { ...empty, history: [{ mode: "quick", adaptations: 6, maxStreak: 9, trials: 20, correct: 18, score: 900, playedAt: 1 }] };
  check("old hidden-rule games do not unlock the new achievements", achievementRows(oldOnly).every((r) => r.tier === 0));
  check("old games are counted as kept", lifetimeStats(oldOnly).oldGames === 1 && lifetimeStats(oldOnly).solved === 0);
  const pzr = { game: "clues", mode: "sc-practice", solved: true, preset: "expert", n: 5, k: 3, ms: 100000, mistakes: 0, hints: 0, score: 2000, playedAt: 2 };
  const runr = { game: "clues", mode: "sc-run", rooms: 4, cleanRooms: 2, bossesBeaten: 1, won: false, depth: 5, score: 3000, playedAt: 3 };
  const roomr = { ...pzr, mode: "sc-room", preset: "medium", n: 4, k: 2, ms: 200000, team: 3, playedAt: 4 };
  const prof = { ...empty, history: [...oldOnly.history, pzr, runr, roomr] };
  const st = lifetimeStats(prof);
  check("puzzles solved counts singles, rooms and run rooms", st.solved === 6 && st.clean === 4 && st.teamSolves === 1, JSON.stringify(st));
  const un = unlockedSet(prof, pzr);
  check("first solve, quick mind, grandmaster, team and boss unlock", ["sc_solved.1", "sc_quick", "sc_expert", "sc_team"].every((id) => un.has(id)) &&
    unlockedSet(prof, runr).has("sc_boss"));
  check("XP: new records are their score, old keep their formula, none is NaN",
    xpFor(pzr) === 2000 && xpFor(oldOnly.history[0]) === 900 + 6 * 40 + 18 * 5 && xpFor({}) === 0 && xpFor({ score: 5 }) === 5 && xpFor(null) === 0);
}

console.log("\n11. History: old games survive, new games join, nothing is counted twice");
{
  // A tiny localStorage, so load() and recordResult() run for real.
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const oldGame = (t, score, mode = "quick") => ({
    seed: "OLD" + t, mode, playedAt: t, score, level: 2, trials: 20, correct: 16, accuracy: 0.8, maxStreak: 5,
    ruleChanges: 2, adaptations: 2, brainScore: 61, byRule: { MOST_PIPS: { seen: 10, correct: 8 } }, log: [],
  });
  const oldProfile = {
    name: "Mridul", avatar: 3, updatedAt: 50, xp: 0, unlocked: ["adapt.1", "bossbreaker"], ruleStats: {},
    history: [oldGame(100, 1000), oldGame(200, 2000, "daily"), { seed: "RUN-20261001", mode: "run", playedAt: 300, score: 4000, depth: 7, adaptations: 3, correct: 40 }],
    bestScore: 4000, bestBrain: 61, streak: 2, longestStreak: 4, lastDailyDay: "2026-10-01", freezes: 1,
    dailyResults: { "2026-10-01": oldGame(200, 2000, "daily") }, tierUnlocked: 3, duels: [{ seed: "X", at: 5 }], createdAt: 10,
  };
  localStorage.setItem("ruledrift.v2", JSON.stringify(oldProfile));
  let prof = storage.load();
  check("an old profile loads with every old game", prof.history.length === 3 && prof.name === "Mridul");
  check("old XP is rebuilt from old history without NaN", Number.isFinite(prof.xp) && prof.xp === oldProfile.history.reduce((s, r) => s + xpFor(r), 0), String(prof.xp));

  const play = new PuzzlePlay(generatePuzzle(dailyClueSeed(new Date(2026, 9, 2)), "easy"));
  solveByHand(play);
  const daily = puzzleResult(play, { mode: "sc-daily", ms: 40000, daily: true, playedAt: new Date(2026, 9, 2, 9).getTime() });
  const out = storage.recordResult(prof, daily);
  prof = storage.load();
  check("a new game joins the old history", prof.history.length === 4 && prof.history.filter((r) => r.game === "clues").length === 1);
  check("old games are untouched", JSON.stringify(prof.history.slice(0, 3)) === JSON.stringify(oldProfile.history));
  check("XP stays a real number and adds exactly the new score", Number.isFinite(prof.xp) && out.xpGained === daily.score);
  check("best score and best brain never go NaN", Number.isFinite(prof.bestScore) && prof.bestBrain === 61);
  check("the new Daily continues the day streak", prof.streak === 3 && prof.lastDailyDay === "2026-10-02", `streak=${prof.streak}`);
  check("old achievements stay unlocked, new ones are added", prof.unlocked.includes("adapt.1") && prof.unlocked.includes("sc_solved.1"));

  const phone = { ...prof, history: [...prof.history.slice(0, 2), { game: "clues", mode: "sc-practice", seed: "P1", playedAt: 999, score: 700, solved: true, n: 3, k: 1 }], updatedAt: 60 };
  const m = mergeProfiles(prof, phone);
  const sum = m.history.reduce((s, r) => s + xpFor(r), 0);
  check("merging old and new history keeps every distinct game once", m.history.length === 5, String(m.history.length));
  check("merged XP is recomputed from history, never summed", m.xp === Math.max(prof.xp, phone.xp, sum) && m.xp < prof.xp + phone.xp, `${m.xp}`);
  const again = mergeProfiles(mergeProfiles(m, phone), prof);
  check("merging again changes nothing", again.xp === m.xp && again.history.length === 5);
  check("merge order does not matter", JSON.stringify(mergeProfiles(phone, prof).history) === JSON.stringify(m.history));
  check("an export with both kinds imports cleanly", (() => {
    const r = parseImport(JSON.stringify(m));
    return r.ok && r.profile.history.length === 5 && r.profile.history.some((x) => x.mode === "run") && r.profile.history.some((x) => x.mode === "sc-daily");
  })());
  delete globalThis.localStorage;
}

console.log("\n12. Rooms: the pure parts");
{
  const doc = { a: "x", n: 3, f: 1.5, b: true, z: null, arr: [1, "two"], empty: [], m: { k: { deep: 2 } }, none: {} };
  const back = fromFs(toFs(doc));
  check("values round-trip through Firestore's format", JSON.stringify(back) === JSON.stringify(doc), JSON.stringify(back));
  check("dates become timestamps and come back as ms", fromFs(toFs(new Date(5000))) === 5000);
  check("plain field paths stay plain, odd ones are quoted", fieldPath("grid.g0r1c2") === "grid.g0r1c2" && fieldPath("players.u:1") === "players.`u:1`");
  const pb = patchBody({ "grid.g0r1c2": 2, "grid.g0r0c0": undefined, status: "playing" });
  check("a patch lists every path in its mask", pb.mask.join(",") === "grid.g0r1c2,grid.g0r0c0,status");
  check("a patch only sends the values it sets (a cleared cell is deleted)",
    pb.fields.grid.mapValue.fields.g0r1c2.integerValue === "2" && !("g0r0c0" in pb.fields.grid.mapValue.fields) && pb.fields.status.stringValue === "playing");

  check("no such room is an absence, not a failure", readRoomResponse(404).ok === true && readRoomResponse(404).room === null);
  check("a failed read is a failure", readRoomResponse(0).ok === false && readRoomResponse(403).ok === false);
  const data = roomsLib.newRoomData({ uid: "u_a", name: "A", preset: "medium", now: 1000, seed: "ROOM-X" });
  const read = readRoomResponse(200, { name: "projects/p/databases/(default)/documents/rooms/ABC123", fields: toFs(data).mapValue.fields });
  check("a room reads back whole", read.ok && read.room.code === "ABC123" && read.room.host === "u_a" && read.room.players.u_a.name === "A" &&
    read.room.expiresAt === 1000 + 24 * 3600000 && read.room.status === "lobby");

  const r = { ...read.room, players: { u_c: { name: "C", joinedAt: 30 }, u_a: { name: "A", joinedAt: 10 }, u_b: { name: "B", joinedAt: 20 } } };
  const order = roomsLib.seatOrder(r);
  check("players are seated in the order they joined", order.join(",") === "u_a,u_b,u_c");
  check("starting locks the deal", JSON.stringify(roomsLib.startUpdates(r, 5)) === JSON.stringify({ status: "playing", order, startedAt: 5 }));
  let dealOk = true;
  for (let clues = 4; clues <= 16; clues++) {
    for (let players = 1; players <= 6; players++) {
      const ord = Array.from({ length: players }, (_, i) => "u" + i);
      const all = ord.flatMap((u) => cluesFor(clues, ord, u)).sort((a, b) => a - b);
      const sizes = ord.map((u) => cluesFor(clues, ord, u).length);
      if (all.join(",") !== Array.from({ length: clues }, (_, i) => i).join(",")) dealOk = false;
      if (Math.max(...sizes) - Math.min(...sizes) > 1) dealOk = false;
    }
  }
  check("the deal gives every clue to exactly one player, evenly", dealOk);
  check("someone not in the deal gets no clues", cluesFor(8, ["u0", "u1"], "late").length === 0);
  check("a join writes only the caller's own entry", Object.keys(roomsLib.joinUpdates("u_z", "Z", 1)).join() === "players.u_z");
  check("grid writes are one field per cell", JSON.stringify(Object.keys(roomsLib.gridUpdates({ g0r0c0: 1, g0r1c1: 0 }))) === '["grid.g0r0c0","grid.g0r1c1"]' &&
    roomsLib.gridUpdates({ g0r1c1: 0 })["grid.g0r1c1"] === undefined);
  const posts = roomsLib.postsOf({ posts: { c4: { uid: "u_b", by: "B", at: 9 }, c1: { uid: "u_a", by: "A", at: 3 }, junk: { at: 1 } } });
  check("shared clues come back oldest first", posts.map((p) => p.clue).join(",") === "1,4");
  const full = { players: Object.fromEntries(Array.from({ length: 6 }, (_, i) => ["u" + i, { name: "P", joinedAt: i }])), expiresAt: 10000 };
  check("a full room turns a seventh player away", !roomsLib.canJoin(full, "u9", 5).ok && roomsLib.canJoin(full, "u0", 5).already);
  check("a closed room turns everyone away", !roomsLib.canJoin(full, "u0", 20000).ok);
  check("codes are six typeable characters", /^[A-HJ-NP-Z2-9]{6}$/.test(roomsLib.newRoomCode()) && roomsLib.normalizeRoomCode(" ab-c12x9 ") === "ABC12X");
}

console.log("\n13. Share text never spoils the answer");
{
  let spoiled = 0;
  for (let i = 0; i < 100; i++) {
    const pz = generatePuzzle("SH" + i, PRACTICE[i % PRACTICE.length]);
    const play = new PuzzlePlay(pz);
    solveByHand(play);
    const txt = buildShareText(puzzleResult(play, { mode: "sc-daily", ms: 61000 }), { dailyNumber: 290, url: "https://x/" });
    if (pz.people.some((p) => txt.includes(p)) || /circle|square|triangle|diamond|hexagon|teal|rose|violet/.test(txt)) spoiled++;
    if (!/Daily #290/.test(txt) || !/1:01/.test(txt)) spoiled++;
  }
  check("no share text names a person or a rune (100 puzzles)", spoiled === 0, `bad=${spoiled}`);
  const runTxt = buildShareText(playRun("SHARE").result(), { dailyNumber: 3 });
  check("a run's share text says how deep it went", /Cleared all three acts|Depth/.test(runTxt) && /\d+ puzzles/.test(runTxt), runTxt);
}

console.log("\n14. Profile merge never loses or invents progress");
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

console.log("\n15. Cloud is optional and fails soft");
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

console.log("\n16. Import merges, never replaces");
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

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
