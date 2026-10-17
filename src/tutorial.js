// The tutorial: one tiny 3x3 puzzle, played a cell at a time.
//
// Scripted rather than generated, so every new player meets the three ideas in
// the same order: an X means "not this one", a check means "this one", and the
// clues plus the grid are always enough - nobody ever has to guess.

export const TUTORIAL_PUZZLE = {
  seed: "TUTORIAL",
  preset: "easy",
  n: 3,
  k: 1,
  people: ["Asha", "Ravi", "Mira"],
  cats: [{ id: "shape", label: "Rune", values: ["circle", "square", "triangle"] }],
  // solution[category][person] = value: Asha triangle, Ravi square, Mira circle.
  solution: [[2, 1, 0]],
  clues: [
    { t: "same", a: { c: -1, v: 1 }, b: { c: 0, v: 1 } },
    { t: "diff", a: { c: -1, v: 2 }, b: { c: 0, v: 2 } },
  ],
};

/** Each step waits for one mark on one cell. */
export const STEPS = [
  {
    clue: 0, key: "g0r1c1", value: 2,
    prompt: "Clue 1 says Ravi's rune is a square. Tap Ravi's square twice: one tap is an X, two is a check.",
    halfway: "That is an X - it means \"not this one\". Tap the same cell again for a check.",
    done: "A check also crosses out the rest of its row and column: Ravi holds nothing else, and nobody else holds the square.",
  },
  {
    clue: 1, key: "g0r2c2", value: 1,
    prompt: "Clue 2 says Mira's rune is not a triangle. Tap Mira's triangle once to cross it out.",
    done: "Crossed out. Now look at Mira's row.",
  },
  {
    clue: null, key: "g0r2c0", value: 2,
    prompt: "Mira has only one rune left. Check it: tap it twice.",
    done: "No guess needed - the grid told you.",
  },
  {
    clue: null, key: "g0r0c2", value: 2,
    prompt: "Last one. What is left for Asha? Check it.",
    done: "Solved. That is the whole game: clues and a grid, never a guess. Bigger puzzles add colours and dots.",
  },
];

export const TUTORIAL_KEY = "ruledrift.cluesTutorialDone";

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
