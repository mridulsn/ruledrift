// Accounts and cloud backup.
//
// Deliberate constraints:
//
//  1. The game must remain fully playable with no account and no network. Every
//     function here fails soft - if the cloud is unconfigured, signed out, or
//     unreachable, play continues and localStorage stays the source of truth.
//  2. No SDK. Supabase's auth and REST endpoints are plain HTTPS, so talking to
//     them with fetch keeps the build at zero dependencies and avoids shipping
//     ~100KB to someone who just wants to tap five tiles.
//  3. The device never trusts the cloud blindly and the cloud never trusts the
//     device. Both sides are merged (see mergeProfiles), so signing in on a new
//     phone cannot wipe the history on your laptop.

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  REDIRECT_URL,
  GOOGLE_CLIENT_ID,
  DISCORD_CLIENT_ID,
  cloudConfigured,
} from "./config.js";

const SESSION_KEY = "ruledrift.session";
const QUEUE_KEY = "ruledrift.pendingSync";
const LAST_SYNC_KEY = "ruledrift.lastSync";
const DISCORD_STATE_KEY = "ruledrift.discordState";

export const PROVIDERS = [
  { id: "google", label: "Continue with Google", icon: "G" },
  { id: "discord", label: "Continue with Discord", icon: "D" },
];

export { cloudConfigured };

// ---------------------------------------------------------------------------
// session storage
// ---------------------------------------------------------------------------

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
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

/**
 * Pure: the URL that starts Discord sign-in.
 *
 * The point of this function is the redirect_uri. Supabase's hosted authorize
 * endpoint would set it to <project-ref>.supabase.co, and Discord prints that
 * hostname to the player. Pointing it at our own /api/discord/callback is what
 * puts ruledrift's name on the consent screen instead.
 */
export function discordAuthorizeUrl(origin, state) {
  const q = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: `${origin}/api/discord/callback`,
    response_type: "code",
    scope: "identify email",
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${q}`;
}

/** Send the player to a provider. Returns to the game with a hash to consume. */
export function signIn(provider) {
  if (!cloudConfigured()) return false;

  if (provider === "discord") {
    if (!DISCORD_CLIENT_ID) return false;
    // Carried through Discord and back, and checked on return. Without it, a
    // crafted link could drop somebody else's token into this page.
    const state = hex(crypto.getRandomValues(new Uint8Array(16)));
    try {
      sessionStorage.setItem(DISCORD_STATE_KEY, state);
    } catch {}
    location.href = discordAuthorizeUrl(location.origin, state);
    return true;
  }

  // Any provider added later still works through Supabase's generic redirect.
  const url =
    `${SUPABASE_URL}/auth/v1/authorize?provider=${encodeURIComponent(provider)}` +
    `&redirect_to=${encodeURIComponent(REDIRECT_URL)}`;
  location.href = url;
  return true;
}

export async function signOut() {
  const s = readSession();
  if (s && s.access_token && cloudConfigured()) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: authHeaders(s.access_token),
      });
    } catch {
      /* signing out locally is what actually matters */
    }
  }
  writeSession(null);
}

function authHeaders(token) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Called once on load. Supabase returns tokens in the URL fragment, which must
 * be consumed and scrubbed immediately - an access token sitting in the address
 * bar ends up in screenshots, history and shared links.
 */
export async function consumeRedirect() {
  if (!cloudConfigured()) return null;
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hash) return null;
  const p = new URLSearchParams(hash);

  // Discord returns through our own /api/discord/callback carrying a single-use
  // token rather than Supabase's pair, so it is handled before the generic path.
  if (p.has("rd_otp") || p.has("rd_error")) return consumeDiscordReturn(p);

  const access_token = p.get("access_token");
  const refresh_token = p.get("refresh_token");
  if (!access_token) return null;

  history.replaceState({}, "", location.pathname + location.search);

  const expires_at = Date.now() + (Number(p.get("expires_in")) || 3600) * 1000;
  const session = { access_token, refresh_token, expires_at, user: null };
  writeSession(session);

  const user = await fetchUser(access_token);
  if (!user) {
    writeSession(null);
    return null;
  }
  session.user = user;
  return writeSession(session);
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

/**
 * Finish the Discord round trip: check the state, then trade the single-use
 * token for a real Supabase session.
 */
async function consumeDiscordReturn(p) {
  history.replaceState({}, "", location.pathname + location.search);

  let expected = null;
  try {
    expected = sessionStorage.getItem(DISCORD_STATE_KEY);
    sessionStorage.removeItem(DISCORD_STATE_KEY);
  } catch {}

  const err = p.get("rd_error");
  if (err) {
    // "access_denied" is the player pressing Cancel, which is not a fault.
    signInError = err === "access_denied" ? "" : err;
    return null;
  }

  const otp = p.get("rd_otp");
  if (!expected || p.get("rd_state") !== expected) {
    signInError = "state_mismatch";
    return null;
  }
  if (!otp) {
    signInError = "no_token";
    return null;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", token_hash: otp }),
    });
    if (!res.ok) {
      signInError = "verify_failed";
      return null;
    }
    const j = await res.json();
    if (!j.access_token) {
      signInError = "verify_failed";
      return null;
    }

    const session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || null,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      user: null,
    };
    writeSession(session);

    const user = await fetchUser(j.access_token);
    if (!user) {
      writeSession(null);
      signInError = "profile_failed";
      return null;
    }
    session.user = user;
    return writeSession(session);
  } catch {
    signInError = "network";
    return null;
  }
}

async function fetchUser(token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(token) });
    if (!res.ok) return null;
    const u = await res.json();
    const meta = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || "",
      name: meta.full_name || meta.name || meta.user_name || (u.email || "").split("@")[0] || "Player",
      avatarUrl: meta.avatar_url || meta.picture || "",
      // Discord users are minted via the admin API, so their provider is
      // recorded in user_metadata; Google's arrives in app_metadata.
      provider: meta.provider || (u.app_metadata && u.app_metadata.provider) || "",
    };
  } catch {
    return null;
  }
}

/** Refresh shortly before expiry so a long session does not fail mid-sync. */
async function validToken() {
  const s = readSession();
  if (!s || !cloudConfigured()) return null;
  if (s.expires_at && Date.now() < s.expires_at - 60000) return s.access_token;
  if (!s.refresh_token) return s.access_token || null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) {
      // Refresh token rejected - the session is genuinely dead.
      if (res.status === 400 || res.status === 401) writeSession(null);
      return null;
    }
    const j = await res.json();
    writeSession({
      access_token: j.access_token,
      refresh_token: j.refresh_token || s.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      user: s.user,
    });
    return j.access_token;
  } catch {
    return s.access_token || null; // offline: try the old token, fail soft
  }
}

// ---------------------------------------------------------------------------
// Google sign-in without the Supabase hostname
//
// Supabase's generic redirect sends the player to <project-ref>.supabase.co and
// Google prints that hostname on the consent screen. It is correct and it looks
// exactly like phishing, so Google is handled separately: the browser gets a
// signed ID token from Google on this origin, and only that token is handed to
// Supabase. The player is never asked to trust a domain they did not choose.
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
// A per-attempt nonce carries the security: the SHA-256 goes to Google and ends
// up inside the signed token, the raw value stays here and goes to Supabase,
// which refuses the token unless the two agree. That is what stops a token
// minted for another site from being replayed into this one.
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
  // A failed load must not poison every later attempt - the player may simply
  // have been offline for a moment.
  gisLoad.catch(() => { gisLoad = null; });
  return gisLoad;
}

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeNonce() {
  const raw = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hashed = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return { raw, hashed };
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
  const id = await loadGis();
  const { raw, hashed } = await makeNonce();

  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: hashed,
    auto_select: false,
    callback: (resp) => {
      Promise.resolve(
        resp && resp.credential ? signInWithGoogleCredential(resp.credential, raw) : null
      ).then(onDone);
    },
  });

  id.renderButton(el, {
    type: "standard",
    theme: (opts && opts.dark) ? "filled_black" : "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "left",
    width: Math.max(200, Math.min(400, Math.round((opts && opts.width) || 300))),
  });
}

/**
 * Trade a Google ID token for a Supabase session.
 * @returns {Promise<object|null>} the stored session, or null if it was refused
 */
export async function signInWithGoogleCredential(idToken, nonce) {
  if (!cloudConfigured() || !idToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", id_token: idToken, nonce }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.access_token) return null;

    const session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || null,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      user: null,
    };
    writeSession(session);

    const user = await fetchUser(j.access_token);
    if (!user) {
      writeSession(null);
      return null;
    }
    session.user = user;
    return writeSession(session);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// which providers are actually switched on
//
// Read from the project rather than hardcoded, so a provider that gets enabled
// in the dashboard lights up here on its own. A button that promises a login
// the server will refuse is worse than no button.
// ---------------------------------------------------------------------------

const PROVIDER_CACHE_KEY = "ruledrift.providers";

/** Pure: turn Supabase's settings payload into {google: true, discord: false, ...} */
export function providerAvailability(settings) {
  const ext = (settings && settings.external) || {};
  const out = {};
  for (const p of PROVIDERS) out[p.id] = Boolean(ext[p.id]);

  // Discord no longer signs in through Supabase's provider - it runs through
  // our own /api/discord/callback - so Supabase's toggle no longer describes
  // whether it works. The secret still sitting in that provider is stale, and
  // switching the provider off (a reasonable tidy-up) would grey out a button
  // that works perfectly. What Discord sign-in actually needs is the client ID.
  out.discord = Boolean(DISCORD_CLIENT_ID);
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
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return cachedProviders();
    const avail = providerAvailability(await res.json());
    try {
      localStorage.setItem(PROVIDER_CACHE_KEY, JSON.stringify(avail));
    } catch {}
    return avail;
  } catch {
    // Offline: fall back to whatever we last knew rather than greying out
    // everything and looking broken.
    return cachedProviders();
  }
}

// ---------------------------------------------------------------------------
// profile sync
// ---------------------------------------------------------------------------

/**
 * Pure: turn a read of the profiles table into a result the caller can act on.
 *
 * The distinction here is the whole ball game. "There is no backup yet" and
 * "the read failed" used to both come back as null, so a fresh device whose
 * read failed would conclude the cloud was empty and push its empty profile
 * over a real one. Losing someone's history to a dropped request is not a
 * sync bug, it is data destruction, so a failure must be impossible to mistake
 * for an absence.
 *
 * @returns {{ok: boolean, data: object|null}}
 */
export function readPullResponse(ok, rows) {
  if (!ok) return { ok: false, data: null };
  return { ok: true, data: rows && rows.length ? rows[0].data : null };
}

/**
 * @returns {Promise<{ok: boolean, data: object|null}>}
 *   ok=false means we could not read - the caller must not write.
 *   ok=true with data=null means there is genuinely no backup yet.
 */
export async function pull() {
  const token = await validToken();
  const user = currentUser();
  if (!token || !user) return readPullResponse(false);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=data&id=eq.${user.id}`,
      { headers: authHeaders(token) }
    );
    if (!res.ok) return readPullResponse(false);
    return readPullResponse(true, await res.json());
  } catch {
    return readPullResponse(false);
  }
}

/** @returns {Promise<boolean>} true if the profile reached the server */
export async function push(profile) {
  const token = await validToken();
  const user = currentUser();
  if (!token || !user) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        id: user.id,
        data: profile,
        updated_at: new Date().toISOString(),
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
