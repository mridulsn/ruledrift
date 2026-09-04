// The tutorial.
//
// It is scripted rather than generated, because the one thing a new player must
// experience is the rug-pull - learning a rule, trusting it, and having it taken
// away - and that cannot be left to chance on trial four.
//
// Design rules taken from FTUE research and applied literally:
//   - teach by doing, never by a wall of text ("put a gap in front of them,
//     not a manual")
//   - a win inside the first thirty seconds
//   - one idea at a time
//   - nothing can kill you in here; a wrong tap just asks you to look again
//   - skippable at any point

const T = (shape, color, count) => ({ shape, color, count });

export const STEPS = [
  {
    // Step 1: no instructions beyond "pick one". The board is engineered so the
    // answer is obvious, which means the player's first act is a success.
    prompt: "Five tiles. One of them is correct. Tap the one you think it is.",
    tiles: [
      T("circle", "cyan", 1), T("circle", "cyan", 1), T("circle", "cyan", 5),
      T("circle", "cyan", 1), T("circle", "cyan", 1),
    ],
    target: 2,
    success: "Correct - and nobody told you why.",
    teach: "That is the entire game. You are never told the rule. You work it out from green and red.",
    fail: "Have another look. One of them stands out.",
  },
  {
    prompt: "Same rule is still running. Find it again.",
    tiles: [
      T("square", "amber", 2), T("circle", "violet", 1), T("hex", "lime", 4),
      T("diamond", "cyan", 2), T("triangle", "magenta", 1),
    ],
    target: 2,
    success: "Right again.",
    teach: "Shapes and colours changed. The rule did not. It is still: the most dots.",
    fail: "Colours and shapes are noise here. Count the dots.",
  },
  {
    prompt: "Once more, to be sure.",
    tiles: [
      T("hex", "lime", 3), T("circle", "amber", 1), T("square", "magenta", 2),
      T("triangle", "cyan", 5), T("diamond", "violet", 1),
    ],
    target: 3,
    success: "Three in a row. You have got the rule.",
    teach: "Now you trust it. Hold that thought.",
    fail: "Still the most dots.",
  },
  {
    // The rug-pull. Most-dots is deliberately a different tile from the correct
    // one, so the expected wrong tap is exactly the mistake the game measures.
    prompt: "Keep going.",
    tiles: [
      T("circle", "cyan", 5), T("square", "cyan", 2), T("circle", "amber", 3),
      T("square", "amber", 2), T("circle", "lime", 1),
    ],
    target: 4,
    switched: true,
    success: "You found it - the only tile of its colour.",
    teach:
      "The rule changed. Nothing announced it. That is the game: notice that your rule has stopped working, drop it, and find the new one.",
    fail: "The old rule just stopped working. Stop counting dots and look again - what else could single one tile out?",
    failHint: "Two cyan, two amber... and one that is alone.",
  },
  {
    prompt: "New rule. Prove you have it.",
    tiles: [
      T("hex", "violet", 4), T("square", "cyan", 1), T("hex", "violet", 2),
      T("square", "amber", 4), T("hex", "amber", 3),
    ],
    target: 1,
    success: "That is it. You are playing properly now.",
    teach:
      "In a real run the rule changes every few correct answers, a clock runs, and three mistakes end it. Everything else you just learned.",
    fail: "Which colour appears exactly once?",
  },
];

/** Rules the tutorial never mentions by name - it shows them instead. */
export const TUTORIAL_RULES_SHOWN = ["MOST_PIPS", "UNIQUE_COLOR"];

export const TUTORIAL_KEY = "ruledrift.tutorialDone";

export function tutorialDone() {
  try {
    return localStorage.getItem(TUTORIAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTutorialDone() {
  try {
    localStorage.setItem(TUTORIAL_KEY, "1");
  } catch {}
}

export function resetTutorial() {
  try {
    localStorage.removeItem(TUTORIAL_KEY);
  } catch {}
}
