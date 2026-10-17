// Accounts and cloud backup.
//
// Deliberate constraints:
//
//  1. The game must remain fully playable with no account and no network. Every
//     function here fails soft - if the cloud is unconfigured, signed out, or
//     unreachable, play continues and localStorage stays the source of truth.
//  2. No SDK. Firebase's auth and Firestore endpoints are plain HTTPS, so talking
//     to them with fetch keeps the build at zero dependencies and avoids shipping
//     ~100KB to someone who just wants to tap five tiles.
//  3. The device never trusts the cloud blindly and the cloud never trusts the
//     device. Both sides are merged (see mergeProfiles), so signing in on a new
//     phone cannot wipe the history on your laptop.
//
// How a sign-in works: the provider (Google or Discord) confirms who the player
// is to the sign-in server (auth.mridulsaravanan.com), which hands back a
// Firebase custom token. The page trades that for a Firebase session here.
// Firebase's own provider buttons are not used: they send the player through
// <project>.firebaseapp.com, a hostname nobody recognises.

import {
  API_ORIGIN,
  APP,
  FIREBASE_API_KEY,
  FIREBASE_PROJECT_ID,
  GOOGLE_CLIENT_ID,
  cloudConfigured,
} from "./config.js";

const SESSION_KEY = "ruledrift.session";
const QUEUE_KEY = "ruledrift.pendingSync";
const LAST_SYNC_KEY = "ruledrift.lastSync";
const CLIENT_STATE_KEY = "ruledrift.signInState";
const PROVIDER_CACHE_KEY = "ruledrift.providers";

export const PROVIDERS = [
  { id: "google", label: "Continue with Google", icon: "G" },
  { id: "discord", label: "Continue with Discord", icon: "D" },
];

export { cloudConfigured };

// ---------------------------------------------------------------------------
// server settings
//
// The sign-in server says which providers are really switched on, and (in local
// tests only) where the Firebase emulators are. Asked once per page load; if it
// cannot be reached, the built-in values are used.
// ---------------------------------------------------------------------------

let settingsLoad = null;

function serverSettings() {
  if (!settingsLoad) {
    const ask = fetch(`${API_ORIGIN}/api/config?app=${APP}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const giveUp = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
    settingsLoad = Promise.race([ask, giveUp]);
    // A failed ask must not poison the rest of the visit - the player may just
    // have been offline for a moment.
    settingsLoad.then((s) => { if (!s) settingsLoad = null; });
  }
  return settingsLoad;
}

async function endpoints() {
  const s = (await serverSettings()) || {};
  return {
    auth: s.authHost ? s.authHost + "/" : "https://",
    firestore: s.fsHost || "https://firestore.googleapis.com",
    apiKey: s.apiKey || FIREBASE_API_KEY,
    projectId: s.projectId || FIREBASE_PROJECT_ID,
    googleClientId: s.googleClientId || GOOGLE_CLIENT_ID,
  };
}

// ---------------------------------------------------------------------------
// session storage
// ---------------------------------------------------------------------------

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    // A session left over from the Supabase days cannot be used with Firebase.
    return s && s.firebase ? s : null;
  } catch {
    return null;
  }
}

function writeSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, firebase: true }));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
  return s;
}

/** When the cloud last confirmed a write, or 0. Proof, rather than a promise. */
export function lastSyncedAt() {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markSynced() {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch {}
}

export function currentUser() {
  const s = readSession();
  return s && s.user ? s.user : null;
}

export const signedIn = () => Boolean(currentUser());

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pure: the URL that starts a redirect sign-in (Discord) on the sign-in server.
 * `state` comes back in the #fragment and is checked against this tab's copy,
 * so a crafted link cannot sign a player into somebody else's account.
 */
export function providerStartUrl(apiOrigin, provider, state) {
  const q = new URLSearchParams({ app: APP, cs: state });
  return `${apiOrigin}/api/auth/${encodeURIComponent(provider)}?${q}`;
}

/** Send the player to a provider. Returns to the game with a hash to consume. */
export function signIn(provider) {
  if (!cloudConfigured()) return false;
  const state = hex(crypto.getRandomValues(new Uint8Array(16)));
  try {
    sessionStorage.setItem(CLIENT_STATE_KEY, state);
  } catch {}
  location.href = providerStartUrl(API_ORIGIN, provider, state);
  return true;
}

export async function signOut() {
  // Firebase sessions are tokens held here; dropping them is signing out.
  writeSession(null);
}

/** Pure: read the uid and expiry out of a Firebase ID token without trusting it for anything else. */
export function tokenClaims(idToken) {
  try {
    const body = String(idToken).split(".")[1];
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const c = JSON.parse(json);
    return { uid: c.user_id || c.sub || "", exp: Number(c.exp) || 0 };
  } catch {
    return { uid: "", exp: 0 };
  }
}

// A sign-in that fails must say so. A silent return to the menu looks identical
// to the player changing their mind, and hides every real fault behind it.
let signInError = "";

/** Read and clear the reason the last sign-in attempt failed, if any. */
export function takeSignInError() {
  const e = signInError;
  signInError = "";
  return e;
}

/** Pure: does this page address carry a sign-in result? */
export const hasSignInHash = (hash) => /[#&](fp-auth|fp-auth-error)=/.test(String(hash || ""));

/** Trade a custom token from the sign-in server for a Firebase session. */
async function sessionFromCustomToken(token, who) {
  const ep = await endpoints();
  const res = await fetch(
    `${ep.auth}identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(ep.apiKey)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, returnSecureToken: true }) }
  );
  if (!res.ok) {
    signInError = "verify_failed";
    return null;
  }
  const j = await res.json();
  const { uid } = tokenClaims(j.idToken);
  if (!j.idToken || !uid) {
    signInError = "verify_failed";
    return null;
  }
  return writeSession({
    access_token: j.idToken,
    refresh_token: j.refreshToken || null,
    expires_at: Date.now() + (Number(j.expiresIn) || 3600) * 1000,
    user: {
      id: uid,
      email: who.email || "",
      name: who.name || (who.email || "").split("@")[0] || "Player",
      avatarUrl: who.photo || "",
      provider: who.provider || "",
    },
  });
}

/**
 * Called once on load. The sign-in result arrives in the URL fragment, which
 * must be consumed and scrubbed immediately - a token sitting in the address
 * bar ends up in screenshots, history and shared links.
 */
export async function consumeRedirect() {
  if (!cloudConfigured()) return null;
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hasSignInHash("#" + hash)) return null;
  const p = new URLSearchParams(hash);
  history.replaceState({}, "", location.pathname + location.search);

  let expected = null;
  try {
    expected = sessionStorage.getItem(CLIENT_STATE_KEY);
    sessionStorage.removeItem(CLIENT_STATE_KEY);
  } catch {}

  const err = p.get("fp-auth-error");
  if (err) {
    // Pressing Cancel is the player changing their mind, not a fault.
    signInError = err === "Sign-in was cancelled." ? "" : err;
    return null;
  }
  if (!expected || p.get("cs") !== expected) {
    signInError = "state_mismatch";
    return null;
  }
  const token = p.get("fp-auth");
  if (!token) {
    signInError = "no_token";
    return null;
  }
  try {
    return await sessionFromCustomToken(token, {
      provider: p.get("p") || "",
      name: p.get("n") || "",
      email: p.get("e") || "",
      photo: p.get("ph") || "",
    });
  } catch {
    signInError = "network";
    return null;
  }
}

/** Refresh shortly before expiry so a long session does not fail mid-sync. */
async function validToken() {
  const s = readSession();
  if (!s || !cloudConfigured()) return null;
  if (s.expires_at && Date.now() < s.expires_at - 60000) return s.access_token;
  if (!s.refresh_token) return null;

  try {
    const ep = await endpoints();
    const res = await fetch(`${ep.auth}securetoken.googleapis.com/v1/token?key=${encodeURIComponent(ep.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(s.refresh_token),
    });
    if (!res.ok) {
      // Refresh token rejected - the session is genuinely dead.
      if (res.status === 400 || res.status === 401 || res.status === 403) writeSession(null);
      return null;
    }
    const j = await res.json();
    writeSession({
      ...s,
      access_token: j.id_token,
      refresh_token: j.refresh_token || s.refresh_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    });
    return j.id_token;
  } catch {
    return null; // offline: fail soft, the queue retries later
  }
}

// ---------------------------------------------------------------------------
// Google sign-in
//
// This uses Google Identity Services, and that is not a preference - it is the
// only route left. Doing it by hand with OpenID Connect's `response_type=
// id_token` was tried and rejected by Google at the consent step with
// "redirect_uri_mismatch ... doesn't comply with Google's OAuth 2.0 policy",
// even with the redirect URI registered exactly as sent. Google has retired the
// implicit flow for web clients and GIS is the replacement. Do not try it again.
//
// The cost of GIS is that Google renders its own button and forbids restyling
// it, so it cannot sit inline beside our own. It is therefore presented in its
// own sheet, where a Google-shaped button is exactly what a player expects.
//
// The signed ID token goes to the sign-in server, which checks Google's
// signature and that the token was issued for this game's client ID, then
// returns a Firebase custom token.
// ---------------------------------------------------------------------------

const GIS_SRC = "https://accounts.google.com/gsi/client";

export const googleIdConfigured = () => Boolean(GOOGLE_CLIENT_ID) && cloudConfigured();

let gisLoad = null;

/** Load Google's script once. Rejects offline, or if an extension blocks it. */
function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    return Promise.resolve(window.google.accounts.id);
  }
  if (gisLoad) return gisLoad;
  gisLoad = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GIS_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () =>
      window.google && window.google.accounts && window.google.accounts.id
        ? resolve(window.google.accounts.id)
        : reject(new Error("gsi loaded but empty"));
    el.onerror = () => reject(new Error("gsi blocked"));
    document.head.appendChild(el);
  });
  gisLoad.catch(() => { gisLoad = null; });
  return gisLoad;
}

/**
 * Render Google's button into `el` and report the resulting session.
 * @param {HTMLElement} el      container to render into
 * @param {object}      opts    { dark: boolean, width: number }
 * @param {function}    onDone  called with the session, or null if refused
 * @returns {Promise<void>}     rejects if Google's script cannot be reached
 */
export async function mountGoogleButton(el, opts, onDone) {
  if (!googleIdConfigured()) throw new Error("google sign-in not configured");
  const [id, ep] = await Promise.all([loadGis(), endpoints()]);

  id.initialize({
    client_id: ep.googleClientId,
    auto_select: false,
    callback: (resp) => {
      Promise.resolve(resp && resp.credential ? signInWithGoogleCredential(resp.credential) : null).then(onDone);
    },
  });

  id.renderButton(el, {
    type: "standard",
    theme: (opts && opts.dark) ? "filled_black" : "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "left",
    width: Math.max(200, Math.min(400, Math.round((opts && opts.width) || 300))),
  });
}

/**
 * Trade a Google ID token for a Firebase session, via the sign-in server.
 * @returns {Promise<object|null>} the stored session, or null if it was refused
 */
export async function signInWithGoogleCredential(idToken) {
  if (!cloudConfigured() || !idToken) return null;
  try {
    const res = await fetch(`${API_ORIGIN}/api/auth/google?app=${APP}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: idToken }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.token) return null;
    return await sessionFromCustomToken(j.token, j);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// which providers are actually switched on
//
// Read from the sign-in server rather than hardcoded: it knows whether each
// provider's keys are really in place. A button that promises a login the
// server will refuse is worse than no button.
// ---------------------------------------------------------------------------

/** Pure: turn the server's settings into {google: true, discord: false}. */
export function providerAvailability(settings) {
  const on = (settings && settings.providers) || {};
  const out = {};
  for (const p of PROVIDERS) out[p.id] = Boolean(on[p.id]);
  return out;
}

/** Last known state, or null if we have never successfully asked. */
export function cachedProviders() {
  try {
    const raw = localStorage.getItem(PROVIDER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function refreshProviders() {
  if (!cloudConfigured()) return null;
  const s = await serverSettings();
  // Offline: fall back to whatever we last knew rather than greying out
  // everything and looking broken.
  if (!s) return cachedProviders();
  const avail = providerAvailability(s);
  try {
    localStorage.setItem(PROVIDER_CACHE_KEY, JSON.stringify(avail));
  } catch {}
  return avail;
}

// ---------------------------------------------------------------------------
// profile sync: one Firestore document per player, ruledrift/{uid}, holding the
// whole profile as a JSON string (Firestore's typed fields would only add a
// translation layer for no benefit). The rules let only that player touch it.
// ---------------------------------------------------------------------------

async function docUrl(uid) {
  const ep = await endpoints();
  return `${ep.firestore}/v1/projects/${ep.projectId}/databases/(default)/documents/ruledrift/${encodeURIComponent(uid)}`;
}

/**
 * Pure: turn a read of the player's document into a result the caller can act on.
 *
 * The distinction here is the whole ball game. "There is no backup yet" and
 * "the read failed" used to both come back as null, so a fresh device whose
 * read failed would conclude the cloud was empty and push its empty profile
 * over a real one. Losing someone's history to a dropped request is not a
 * sync bug, it is data destruction, so a failure must be impossible to mistake
 * for an absence.
 *
 * @param {number}      status  HTTP status of the read (0 if it never arrived)
 * @param {object|null} doc     the Firestore document, when status is 200
 * @returns {{ok: boolean, data: object|null}}
 */
export function readPullResponse(status, doc) {
  if (status === 404) return { ok: true, data: null };
  if (status !== 200) return { ok: false, data: null };
  const raw = doc && doc.fields && doc.fields.data && doc.fields.data.stringValue;
  if (typeof raw !== "string") return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    // A backup we cannot read is not an empty backup. Refuse to overwrite it.
    return { ok: false, data: null };
  }
}

/**
 * @returns {Promise<{ok: boolean, data: object|null}>}
 *   ok=false means we could not read - the caller must not write.
 *   ok=true with data=null means there is genuinely no backup yet.
 */
export async function pull() {
  const token = await validToken();
  const user = currentUser();
  if (!token || !user) return readPullResponse(0);
  try {
    const res = await fetch(await docUrl(user.id), { headers: { Authorization: `Bearer ${token}` } });
    return readPullResponse(res.status, res.status === 200 ? await res.json() : null);
  } catch {
    return readPullResponse(0);
  }
}

/** @returns {Promise<boolean>} true if the profile reached the server */
export async function push(profile) {
  const token = await validToken();
  const user = currentUser();
  if (!token || !user) return false;
  try {
    const res = await fetch(`${await docUrl(user.id)}?updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          data: { stringValue: JSON.stringify(profile) },
          updatedAt: { timestampValue: new Date().toISOString() },
        },
      }),
    });
    if (res.ok) {
      clearQueue();
      markSynced();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Delete the player's cloud copy. @returns {Promise<boolean>} true once it is gone */
export async function deleteCloud() {
  const token = await validToken();
  const user = currentUser();
  if (!token || !user) return false;
  try {
    const res = await fetch(await docUrl(user.id), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      try { localStorage.removeItem(LAST_SYNC_KEY); } catch {}
      clearQueue();
    }
    return res.ok;
  } catch {
    return false;
  }
}

// A failed push is remembered so a session played on a train is not lost.
export function queueSync() {
  try {
    localStorage.setItem(QUEUE_KEY, "1");
  } catch {}
}

export function hasQueued() {
  try {
    return localStorage.getItem(QUEUE_KEY) === "1";
  } catch {
    return false;
  }
}

function clearQueue() {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {}
}

// ---------------------------------------------------------------------------
// rooms: play with friends. One Firestore document per room, rooms/{CODE}.
// Every signed-in player can read a room (the code is the invitation); only
// the players listed in it can change it, and a join may add only yourself.
// See firestore.rules in the sign-in server's repository.
//
// Marks are written one field at a time (updateMask "grid.g0r1c2"), so two
// friends marking at the same moment never overwrite each other.
// ---------------------------------------------------------------------------

/** Pure: a plain value as a Firestore REST value. */
export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(toFs) } : {} };
  const fields = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = toFs(x);
  return { mapValue: Object.keys(fields).length ? { fields } : {} };
}

/** Pure: a Firestore REST value as a plain value. Timestamps become epoch ms. */
export function fromFs(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue) || 0;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFs);
  if ("mapValue" in v) {
    const out = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) out[k] = fromFs(x);
    return out;
  }
  return null;
}

/** Pure: quote a dotted field path's segments where Firestore needs it. */
export function fieldPath(path) {
  return String(path).split(".").map((seg) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) ? seg : "`" + seg.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`").join(".");
}

/**
 * Pure: turn {"grid.g0r1c2": 2, "status": "playing", "grid.g0r0c0": undefined}
 * into a PATCH body and its update mask. A path listed with no value is deleted.
 */
export function patchBody(updates) {
  const fields = {};
  const mask = [];
  for (const [path, val] of Object.entries(updates)) {
    mask.push(fieldPath(path));
    if (val === undefined) continue;
    const segs = path.split(".");
    let node = fields;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!node[s] || !node[s].mapValue) node[s] = { mapValue: { fields: {} } };
      if (!node[s].mapValue.fields) node[s].mapValue.fields = {};
      node = node[s].mapValue.fields;
    }
    node[segs[segs.length - 1]] = toFs(val);
  }
  return { fields, mask };
}

/**
 * Pure: read a room fetch. As with pull(), "no such room" and "could not
 * read" must never look the same: one means a mistyped code, the other a
 * dropped connection.
 * @returns {{ok: boolean, status: number, room: object|null}}
 */
export function readRoomResponse(status, doc) {
  if (status === 404) return { ok: true, status, room: null };
  if (status !== 200 || !doc || !doc.fields) return { ok: false, status, room: null };
  const room = fromFs({ mapValue: { fields: doc.fields } });
  room.code = String(doc.name || "").split("/").pop();
  return { ok: true, status, room };
}

async function roomsBase() {
  const ep = await endpoints();
  return `${ep.firestore}/v1/projects/${ep.projectId}/databases/(default)/documents/rooms`;
}

async function roomFetch(path, init = {}) {
  const token = await validToken();
  if (!token || !currentUser()) return { status: 0, json: null };
  try {
    const res = await fetch(`${await roomsBase()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

/** @returns {Promise<{ok, status, room}>} */
export async function roomGet(code) {
  const r = await roomFetch(`/${encodeURIComponent(code)}`);
  return readRoomResponse(r.status, r.json);
}

/** Create a room. Fails (409) if the code is already taken, so it never overwrites one. */
export async function roomCreate(code, data) {
  const r = await roomFetch(`?documentId=${encodeURIComponent(code)}`, {
    method: "POST",
    body: JSON.stringify({ fields: toFs(data).mapValue.fields || {} }),
  });
  return { ok: r.status === 200, status: r.status };
}

/** Change only the listed fields of an existing room. */
export async function roomPatch(code, updates) {
  const { fields, mask } = patchBody(updates);
  const q = mask.map((m) => "updateMask.fieldPaths=" + encodeURIComponent(m)).join("&");
  const r = await roomFetch(`/${encodeURIComponent(code)}?${q}&currentDocument.exists=true`, {
    method: "PATCH",
    body: JSON.stringify({ fields }),
  });
  return { ok: r.status === 200, status: r.status };
}

export async function roomDelete(code) {
  const r = await roomFetch(`/${encodeURIComponent(code)}`, { method: "DELETE" });
  return { ok: r.status === 200, status: r.status };
}
