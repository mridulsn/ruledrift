// Rooms: Split Clues with friends, by room code. Pure helpers only; the
// network calls live in cloud.js and the screens in main.js.
//
// A room holds the puzzle's seed and size (never the answer - every device
// deals the same puzzle from the seed), who is in it, one shared grid and the
// clues players have chosen to share. When the host starts, the clues are dealt
// round-robin to the players in the order they joined; each sees only their
// own, and "Share" is how they talk.

import { randomSeedCode } from "./rng.js";

export const MAX_PLAYERS = 6;
export const ROOM_HOURS = 24;
export const POLL_MS = 1500;

export const newRoomCode = () => randomSeedCode();

export function normalizeRoomCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/** The document a host creates. */
export function newRoomData({ uid, name, preset, now = Date.now(), seed = "" }) {
  return {
    host: uid,
    hostName: name,
    seed: seed || "ROOM-" + randomSeedCode(),
    preset,
    status: "lobby",
    players: { [uid]: { name, joinedAt: now } },
    order: [],
    grid: {},
    posts: {},
    createdAt: new Date(now),
    expiresAt: new Date(now + ROOM_HOURS * 3600000),
    startedAt: 0,
    solvedAt: 0,
  };
}

/** The join write: only the caller's own entry. */
export function joinUpdates(uid, name, now = Date.now()) {
  return { [`players.${uid}`]: { name, joinedAt: now } };
}

/** Players in the order they joined. */
export function seatOrder(room) {
  return Object.entries((room && room.players) || {})
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0) || (a[0] < b[0] ? -1 : 1))
    .map(([uid]) => uid);
}

/** The host's start write: locks the deal so a late joiner cannot reshuffle it. */
export function startUpdates(room, now = Date.now()) {
  return { status: "playing", order: seatOrder(room), startedAt: now };
}

/** Grid writes for a set of changed cells; a cleared cell deletes its field. */
export function gridUpdates(changed) {
  const out = {};
  for (const [k, v] of Object.entries(changed || {})) out[`grid.${k}`] = v ? v : undefined;
  return out;
}

export function postUpdates(clueIndex, uid, name, now = Date.now()) {
  return { [`posts.c${clueIndex}`]: { uid, by: name, at: now } };
}

/** Shared clue posts, oldest first: [{clue, uid, by, at}]. */
export function postsOf(room) {
  return Object.entries((room && room.posts) || {})
    .map(([k, p]) => ({ clue: Number(String(k).slice(1)), ...(p || {}) }))
    .filter((p) => Number.isInteger(p.clue))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

export function roomExpired(room, now = Date.now()) {
  return !room || Boolean(room.expiresAt && now >= room.expiresAt);
}

export function canJoin(room, uid, now = Date.now()) {
  if (!room || roomExpired(room, now)) return { ok: false, why: "That room has closed." };
  if (room.players && room.players[uid]) return { ok: true, already: true };
  if (Object.keys(room.players || {}).length >= MAX_PLAYERS) return { ok: false, why: "That room is full (6 players)." };
  if (room.status === "solved") return { ok: false, why: "That room's puzzle is already solved." };
  return { ok: true };
}
