# Ruledrift

**Split Clues: who holds which rune? Every puzzle has exactly one answer, and
logic alone reaches it.**

A logic grid puzzle (the classic "zebra" kind) drawn with rune stones. It runs
entirely in the browser, works with the network switched off, and has co-op
rooms where each friend holds different clues.

**Play: https://mridulsaravanan.com/ruledrift/**

Published with GitHub Pages under mridulsaravanan.com by the workflow in
`.github/workflows/pages.yml`, which runs the self-test and ships only the
game's own files (not `tools/`).

Run it locally with any static server:

```bash
python -m http.server 8796 --bind 127.0.0.1    # then open http://127.0.0.1:8796
```

---

## The game

People sit in a row, each holding one rune stone. Clues say things like
*"Asha's rune is not a circle"*, *"The circle is teal"*, *"Kai's rune is a
square or a hexagon"* or *"The teal rune sits right next to Ravi"*. Mark the
grid - one tap for an X, two for a check - until everyone's rune is placed.

- **Easy** 3 people, shapes. **Easy+** 4 people, shapes and seats.
- **Medium** 4 people, shapes and colours. **Hard** 5 people, shapes and colours.
- **Expert** 5 people, shapes, colours and dot counts.

A wrong check counts as a mistake, flashes, and is crossed out for you, so even
a slip teaches you something. **Hint** fills in one cell that logic can prove
from the marks already on the grid, and names the clue that proves it.

## Why it never feels like guessing

The puzzle generator (`src/clues.js`) plants a random answer, then adds true
clues one at a time until a solver made only of small, human-sized deductions
fills the whole grid from nothing - "this clue crosses out that cell", "only one
choice is left in this row". Then it removes every clue the others can manage
without. Because every deduction is sound and they reach a full grid, the
planted answer is the only one; the self-test also checks thousands of puzzles
by brute force. The same deductions power the Hint button.

## Modes

- **Daily puzzle** - the same grid for everyone, gentle on Monday, Expert on
  Sunday. Builds the day streak.
- **Practice** - any size, as many as you like.
- **Drift Run** - a seeded three-act roguelite: choose a path of chambers,
  timed elites and campfires, pick perks (extra heart, mend, lantern hints,
  shield, slow clock), and face a boss grid at the end of each act. Hearts
  carry across the run and a wrong check costs one. A run link replays the
  same map and puzzles for a friend.
- **Play with friends** - a 6-character room code for 2 to 6 signed-in
  players. One shared grid; the clues are dealt round-robin, so each player
  sees only their own and taps **Share** to post one to the shared board.

Games from the older hidden-rule modes (Classic, Zen, Blitz, Gauntlet) are
retired but kept in every player's history, Export and cloud backup.

## Rooms

One Firestore document per room, `rooms/{CODE}`: the puzzle's seed and size
(never the answer - every device deals the same puzzle from the seed), the
players, a shared grid and the shared clue posts. Marks are written one field
at a time (`updateMask grid.g0r1c2`), so friends never overwrite each other;
each phone polls every 1.5 s while the room is open. The security rules (in the
sign-in server's repo) let any signed-in player read a room, only its players
change it, a join add only the caller, and only the host delete it. Rooms
close after 24 hours. `tools/rooms_rules_test.mjs` tests the rules against the
Firestore emulator.

## Tech

Plain ES modules, no dependencies, no build step, an offline-first service
worker. The engines (`clues.js`, `driftrun.js`, `rooms.js`) are pure and
seeded, so `node tools/selftest.mjs` can play thousands of puzzles and runs.

## Accounts (optional)

Anonymous offline play is the default and always works. Signing in with **Google
or Discord** adds cloud backup so a record survives clearing your browser and
follows you between devices.

Two design rules make it safe:

- **The device is never overwritten by the cloud, and vice versa.** Both sides
  are merged. Signing in on a new phone cannot wipe your laptop's history, and a
  laptop that has been offline for a week cannot erase what the phone recorded.
- **The merge is idempotent and never sums.** XP, tallies and streaks are
  recomputed from the merged history rather than added together, because
  addition is exactly how sync bugs turn into fake scores. Syncing twice changes
  nothing. 19 tests cover this.

Sync fails soft everywhere: offline rounds are queued and sent on reconnect, a
failed sign-in leaves you playing anonymously, and an unreachable server never
blocks or loses a round.

Backed by Firebase (Auth + Firestore, document `ruledrift/{uid}`), whose
security rules let a player read and write only their own backup. Google and
Discord confirm who the player is to the sign-in server at
auth.mridulsaravanan.com (the `auth-api` project), which hands back a Firebase
custom token. Setup is in [SETUP-ACCOUNTS.md](SETUP-ACCOUNTS.md).

Until October 2026 accounts ran on Supabase. Its free plan pauses after a week
without visitors, which silently broke every sign-in, so it was replaced.
Settings, Your data, Import takes an Export from another device (or the old
vercel.app address) and merges it in.

## Privacy

No analytics and no tracking. Signed out, every result stays in your browser's
localStorage. Signed in, your profile is also stored in your own row in the
database, readable by nobody else. Either way it can be exported as JSON or
deleted from Settings, Your data (Delete all for this device, Delete account
copy for the cloud).

## Licence

MIT
