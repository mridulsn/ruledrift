// Firestore rules for rooms/{CODE}, tested against the local emulator with the
// same request bodies the game sends (cloud.js toFs / patchBody).
//
// Needs the Firestore + Auth emulators on 8080 / 9099 (project demo-fp) and
// the sign-in server's repo next to this one for its custom-token signer:
//   node tools/rooms_rules_test.mjs C:/Users/smrid/Projects/auth-api
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toFs, patchBody, readRoomResponse } from "../src/cloud.js";
import { newRoomData, joinUpdates, startUpdates, gridUpdates, postUpdates } from "../src/rooms.js";

const api = path.resolve(process.argv[2] || "../Projects/auth-api");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  client_email: "sa@demo-fp.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  project_id: "demo-fp",
});
const fp = await import(pathToFileURL(path.join(api, "api/_lib/fp.js")).href);

const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const FS = "http://127.0.0.1:8080/v1/projects/demo-fp/databases/(default)/documents/rooms";
let pass = 0, fail = 0;
const check = (n, ok, info) => {
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + n + (!ok && info !== undefined ? "  -- " + JSON.stringify(info).slice(0, 300) : ""));
};

async function signIn(uid) {
  const r = await fetch(AUTH + "/accounts:signInWithCustomToken?key=fake", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: fp.customToken(uid, { provider: "google" }), returnSecureToken: true }),
  });
  const j = await r.json();
  return j.idToken;
}
const H = (t) => (t ? { Authorization: "Bearer " + t, "Content-Type": "application/json" } : { "Content-Type": "application/json" });

async function create(token, code, data) {
  const r = await fetch(`${FS}?documentId=${code}`, { method: "POST", headers: H(token), body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
  return r.status;
}
async function patch(token, code, updates) {
  const { fields, mask } = patchBody(updates);
  const q = mask.map((m) => "updateMask.fieldPaths=" + encodeURIComponent(m)).join("&");
  const r = await fetch(`${FS}/${code}?${q}&currentDocument.exists=true`, { method: "PATCH", headers: H(token), body: JSON.stringify({ fields }) });
  return r.status;
}
async function get(token, code) {
  const r = await fetch(`${FS}/${code}`, { headers: H(token) });
  return readRoomResponse(r.status, r.status === 200 ? await r.json() : null);
}
async function del(token, code) {
  const r = await fetch(`${FS}/${code}`, { method: "DELETE", headers: H(token) });
  return r.status;
}

const HOST = "u_host00000000000000000000000000";
const FRIEND = "u_friend000000000000000000000000";
const OUT = "u_outsider0000000000000000000000";
const tHost = await signIn(HOST);
const tFriend = await signIn(FRIEND);
const tOut = await signIn(OUT);
check("emulator gave three sessions", tHost && tFriend && tOut);

const code = "R" + Math.random().toString(36).slice(2, 7).toUpperCase();
const data = newRoomData({ uid: HOST, name: "Host", preset: "medium" });

check("signed-out create is refused", (await create(null, code, data)) === 403);
check("create naming someone else as host is refused", (await create(tFriend, code, data)) === 403);
check("create with another player already in it is refused",
  (await create(tHost, code, { ...data, players: { ...data.players, [FRIEND]: { name: "F", joinedAt: 1 } } })) === 403);
check("create with a 3-day expiry is refused",
  (await create(tHost, code, { ...data, expiresAt: new Date(Date.now() + 72 * 3600000) })) === 403);
check("host creates the room", (await create(tHost, code, data)) === 200);
check("the same code cannot be created twice", (await create(tHost, code, data)) !== 200);

let g = await get(tOut, code);
check("any signed-in player can read the room", g.ok && g.room && g.room.host === HOST && g.room.preset === "medium");
g = await get(null, code);
check("signed out cannot read it", !g.ok && g.status === 403);
g = await get(tHost, "NOSUCH");
check("a missing room is an absence, not a failure", g.ok && g.room === null);

check("outsider cannot mark the grid", (await patch(tOut, code, gridUpdates({ g0r0c0: 1 }))) === 403);
check("outsider cannot add someone else", (await patch(tOut, code, joinUpdates(FRIEND, "F"))) === 403);
check("join that also changes the grid is refused",
  (await patch(tFriend, code, { ...joinUpdates(FRIEND, "F"), ...gridUpdates({ g0r0c0: 1 }) })) === 403);
check("friend joins (adds only themselves)", (await patch(tFriend, code, joinUpdates(FRIEND, "Friend"))) === 200);
check("a member cannot rewrite another player's entry", (await patch(tFriend, code, { [`players.${HOST}`]: { name: "X", joinedAt: 1 } })) === 403);
check("a member cannot change the host", (await patch(tFriend, code, { host: FRIEND })) === 403);
check("a member cannot change the seed", (await patch(tFriend, code, { seed: "OTHER" })) === 403);

g = await get(tHost, code);
check("host starts the game", (await patch(tHost, code, startUpdates(g.room))) === 200);
check("friend marks a cell", (await patch(tFriend, code, gridUpdates({ g0r1c2: 2, g0r1c0: 1 }))) === 200);
check("host marks a different cell at the same time", (await patch(tHost, code, gridUpdates({ g1r0c0: 1 }))) === 200);
check("friend shares a clue", (await patch(tFriend, code, postUpdates(3, FRIEND, "Friend"))) === 200);
check("a cleared cell deletes its field", (await patch(tFriend, code, gridUpdates({ g0r1c0: 0 }))) === 200);
g = await get(tOut, code);
check("both marks survive, the cleared one is gone",
  g.room.grid.g0r1c2 === 2 && g.room.grid.g1r0c0 === 1 && !("g0r1c0" in g.room.grid), g.room.grid);
check("the deal order lists host then friend", JSON.stringify(g.room.order) === JSON.stringify([HOST, FRIEND]), g.room.order);
check("the shared post is there", g.room.posts.c3 && g.room.posts.c3.uid === FRIEND);

check("a seventh player cannot join a full room", await (async () => {
  const c2 = code + "F";
  // Only the host can be in a new room, so fill it the legal way: by joins.
  if ((await create(tHost, c2, newRoomData({ uid: HOST, name: "Host", preset: "easy" }))) !== 200) return false;
  for (let i = 1; i < 6; i++) {
    const uid = `u_p${i}000000000000000000000000000`;
    if ((await patch(await signIn(uid), c2, joinUpdates(uid, "P" + i))) !== 200) return false;
  }
  return (await patch(tOut, c2, joinUpdates(OUT, "Late"))) === 403;
})());

check("non-host cannot delete the room", (await del(tFriend, code)) === 403);
check("outsider cannot delete the room", (await del(tOut, code)) === 403);
check("host deletes the room", (await del(tHost, code)) === 200);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
