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

import { SUPABASE_URL, SUPABASE_ANON_KEY, REDIRECT_URL, cloudConfigured } from "./config.js";

const SESSION_KEY = "ruledrift.session";
const QUEUE_KEY = "ruledrift.pendingSync";

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

export function currentUser() {
  const s = readSession();
  return s && s.user ? s.user : null;
}

export const signedIn = () => Boolean(currentUser());

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/** Send the player to Google or Discord. Returns to REDIRECT_URL with a hash. */
export function signIn(provider) {
  if (!cloudConfigured()) return false;
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
      provider: (u.app_metadata && u.app_metadata.provider) || "",
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
// profile sync
// ---------------------------------------------------------------------------

/** @returns {Promise<object|null>} the stored profile, or null if none/offline */
export async function pull() {
  const token = await validToken();
  const user = currentUser();
  if (!token || !user) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=data&id=eq.${user.id}`,
      { headers: authHeaders(token) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows.length ? rows[0].data : null;
  } catch {
    return null;
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
