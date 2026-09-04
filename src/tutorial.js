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
    prompt: "One of these five is the winner. Which one looks different to you? Tap it.",
    tiles: [
      T("circle", "cyan", 1), T("circle", "cyan", 1), T("circle", "cyan", 5),
      T("circle", "cyan", 1), T("circle", "cyan", 1),
    ],
    target: 2,
    success: "Yes! That one was the winner.",
    teach:
      "Notice that nobody told you why. This game keeps a secret: a hidden reason that decides which tile wins. You have to work it out by guessing and watching what turns green.",
    fail: "Look again. Four of them are the same. One is not.",
  },
  {
    prompt: "Five new tiles. The secret has not changed. Tap the winner.",
    tiles: [
      T("square", "amber", 2), T("circle", "violet", 1), T("hex", "lime", 4),
      T("diamond", "cyan", 2), T("triangle", "magenta", 1),
    ],
    target: 2,
    success: "Correct again.",
    teach:
      "This time the shapes and colours were all different - but that did not matter. The secret is: THE TILE WITH THE MOST DOTS WINS.",
    fail: "Count the dots on each tile. Which one has the most?",
    failHint: "Ignore the colours and the shapes. Just count dots: 2, 1, 4, 2, 1.",
  },
  {
    prompt: "Once more. Tap the tile with the most dots.",
    tiles: [
      T("hex", "lime", 3), T("circle", "amber", 1), T("square", "magenta", 2),
      T("triangle", "cyan", 5), T("diamond", "violet", 1),
    ],
    target: 3,
    success: "Three right in a row.",
    teach: "Now you know the secret and you can trust it. Remember it for the next one.",
    fail: "Count again: 3, 1, 2, 5, 1. Which is the biggest?",
  },
  {
    // The rug-pull. Most-dots is deliberately a different tile from the correct
    // one, so the expected wrong tap is exactly the mistake the game measures.
    prompt: "Keep going. Tap the winner.",
    tiles: [
      T("circle", "cyan", 5), T("square", "cyan", 2), T("circle", "amber", 3),
      T("square", "amber", 2), T("circle", "lime", 1),
    ],
    target: 4,
    switched: true,
    success: "Yes - the green one. It was the only tile of that colour.",
    teach:
      "THE SECRET CHANGED, and nothing warned you. It stopped being 'most dots' and became 'the only one of its colour'. This is the whole game: when your answer suddenly stops working, the secret has changed - so stop using it and look for the new one.",
    fail: "Not any more. The 'most dots' secret has stopped working. Forget the dots - look at the COLOURS instead.",
    failHint: "Count the colours: two blue, two orange, and one green sitting all on its own. Tap the lonely one.",
  },
  {
    prompt: "New secret, same idea. Tap the winner.",
    tiles: [
      T("hex", "violet", 4), T("square", "cyan", 1), T("hex", "violet", 2),
      T("square", "amber", 4), T("hex", "amber", 3),
    ],
    target: 1,
    success: "That is it. You know how to play.",
    teach:
      "That is everything. In a real game the secret keeps changing every few turns and three mistakes end the round - but the board straight after a change is always free, and there is no clock at all until level 10. Take as long as you like.",
    fail: "Which colour appears only ONCE? Two purple, two orange... and one more.",
  },
];

/** Rules the tutorial never mentions by name - it shows them instead. */
export const TUTORIAL_RULES_SHOWN = ["MOST_PIPS", "UNIQUE_COLOR"];

/**
 * The two worked examples printed in the guide. They live here rather than in
 * the UI so the test suite can prove the captions tell the truth - a guide that
 * teaches the wrong answer is worse than no guide.
 */
export const GUIDE_EXAMPLES = {
  mostDots: {
    rule: "MOST_PIPS",
    target: 2,
    tiles: [
      T("square", "amber", 2), T("circle", "violet", 1), T("hex", "lime", 4),
      T("diamond", "cyan", 2), T("triangle", "magenta", 1),
    ],
  },
  uniqueColour: {
    rule: "UNIQUE_COLOR",
    target: 4,
    // Deliberately also the board where "most dots" points somewhere else, so
    // the guide can show the moment an old idea stops working.
    oldRule: "MOST_PIPS",
    tiles: [
      T("circle", "cyan", 5), T("square", "cyan", 2), T("circle", "amber", 3),
      T("square", "amber", 2), T("circle", "lime", 1),
    ],
  },
};

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
