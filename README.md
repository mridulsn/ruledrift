# Ruledrift

**Nobody tells you the rule. You work it out from green and red. Then it silently changes.**

A brain game that runs entirely in the browser, works with the network switched
off, and lets you duel a friend on a byte-identical board with no server and no
account.

Play: *(link added after deploy)*

---

## The idea

Most "brain training" games are reaction tests with a progress bar. Ruledrift is
built on the **Wisconsin Card Sorting Task** - a genuine neuropsychological test
of cognitive flexibility.

Five tiles appear. Each has three independent attributes: a shape, a colour, and
a dot count. A hidden rule decides which tile is correct - *most dots*, *the only
tile of its colour*, *the one matching the colour of the last correct tile*, and
others that unlock as you play. You are never told which rule is running. Green
and red feedback is your only evidence.

Once you have got it right a few times in a row, the rule **changes silently**.
No warning, no animation. The skill the game trains is noticing that your model
of the world has stopped working, and dropping it fast.

That is also why the game can measure something real.

## What it measures

Two of the five scores are metrics clinicians actually use on this task:

| Metric | What it means |
|---|---|
| **Perseverative errors** | Wrong taps that would have been *correct under the previous rule*. The signature of being stuck on an idea that has stopped paying. |
| **Adaptation latency** | Trials needed to lock onto the new rule after a silent change. |
| Speed | Mean reaction time on correct answers. |
| Induction | Accuracy in the first three trials after a change - how fast you form a new hypothesis from thin evidence. |
| Consistency | Variability of your reaction time. Erratic timing means divided attention. |

These feed a radar chart, a trend line per metric, and a calendar of daily play,
all stored locally.

### An honest note

The evidence for "brain training" is weaker than the industry implies. Training
improves the trained task and closely related ones; **far transfer to general
intelligence is not reliably supported** when studies use active control groups.
Ruledrift shows you a real measurement of how you adapt. It does not claim to
raise your IQ, and the in-game help page says so.

## Multiplayer with no server

The whole game is a deterministic function of a seed. `mulberry32` seeded from an
FNV-1a hash of the seed code drives every board, every rule, and every rule
change, so two players on seed `K7F2QM` get exactly the same game.

That gives real competition with **no backend, no account, and no network**:

1. Generate a seed, send your friend the link or the six characters.
2. You both play the identical board - offline is fine.
3. Paste each other's result code. The comparison is exact.

The result code is spoiler-free on top and machine-readable on the last line:

```
RULEDRIFT Daily #248
4,820 pts · L7 · 88% · Brain 74

🟩🟩🟦🟩🟥🟩🟩🟩🟧🟩

#RD1:eyJzIjoiSzdGMlFNIiwi...
```

🟩 correct · 🟦 caught a rule change · 🟧 stuck on the old rule · 🟥 wrong

## Retention design

Deliberate, and drawn from what the 2026 benchmarks actually support rather than
from habit:

- **Daily board** seeded from the date, identical worldwide - the shared-experience
  loop that made Wordle spread.
- **Streaks with one freeze.** A single missed day is forgiven once. Losing a long
  streak to one busy day is the fastest way to make someone quit for good.
- **Meta layer on day 3.** Tier 2 rules unlock at 3 sessions, tier 3 at 8. New
  content arriving on days 3-5 is the best-supported retention lever there is.
- **The reward is the report.** Progression is a measurement of you, not a currency.
- **Onboarding nudge.** For the first two sessions only, two consecutive misses
  after a change surfaces a hint that rules change at all. After that, silence.

## Tech

No framework, no bundler, no dependencies. Plain ES modules, SVG, and the Canvas-free
DOM, so first paint is immediate and a share link opens instantly.

```
src/rng.js       seeded PRNG - the basis of offline multiplayer
src/rules.js     8 rules, generation with guaranteed-unique answers
src/engine.js    state machine, scoring, metrics      <- pure, no DOM
src/storage.js   localStorage profile, streaks, unlocks
src/share.js     result codes, duel comparison
src/charts.js    hand-rolled SVG charts (no chart library)
src/tiles.js     tile rendering
src/audio.js     WebAudio blips - no audio assets
src/main.js      screens and the game loop
tools/selftest.mjs   engine invariant tests
tools/make_icons.py  icon generation
```

### Two invariants worth calling out

Both are enforced by the generator and covered by tests:

1. **Every board has exactly one correct answer** under the active rule.
2. **A rule change is never invisible.** On a switch trial the new rule's answer
   must differ from what the old rule would have chosen - otherwise the player
   could not possibly detect the change, and dying to it would be unfair.

## Running it

```bash
python -m http.server 8777      # any static server works
node tools/selftest.mjs         # 20 engine invariant checks
python tools/make_icons.py      # regenerate icons
```

Deploys as static files anywhere. Ships as a PWA - installable, offline, no
network calls of any kind.

## Roadmap

- [ ] Live rooms (real-time duel over a small serverless relay)
- [ ] Weekly resettable leaderboard - repeating boards drive materially more
      competitive engagement than perpetual ones
- [ ] More rule families (relational rules, two-attribute conjunctions)
- [ ] Android build via Trusted Web Activity for the Play Store
- [ ] Export the report as a PDF

## Privacy

No analytics, no accounts, no network requests. Every result is in your browser's
localStorage and can be exported or deleted from the report screen.

## Licence

MIT
