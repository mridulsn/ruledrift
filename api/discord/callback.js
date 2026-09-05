// Discord sign-in, finished on our own domain.
//
// Why this function exists
// ------------------------
// Supabase's hosted /auth/v1/authorize sends the player to Discord with
// redirect_uri = <project-ref>.supabase.co/auth/v1/callback, so Discord's
// consent screen honestly announces "you will be redirected outside of Discord
// to https://yvttgbuhwkjeqqvblcbc.supabase.co". That is a hostname the player
// has never heard of on a screen that is asking for their trust, and it reads
// exactly like phishing. It is the same objection that moved Google onto GIS.
//
// Discord has no browser-side equivalent of Google Identity Services, and its
// token endpoint requires the client secret, which a browser cannot hold. So
// the flow is owned here instead. Discord now names ruledrift.vercel.app on the
// consent screen because that genuinely is where it sends the player, and the
// secret lives in a server environment variable that never reaches the repo or
// the browser.
//
// Supabase remains the account system. Once Discord has confirmed who the
// player is, this mints a Supabase session for that email address through the
// admin API. Keying on the email is what makes an existing Discord player land
// on the same auth.users row as before - and therefore the same profiles row,
// and therefore the same progress. Minting a fresh user instead would have
// looked, to them, exactly like their history being deleted.

import { SUPABASE_URL, DISCORD_CLIENT_ID } from "../../src/config.js";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Pure: turn Discord's /users/@me payload into the metadata the game stores.
 * Returns null when the account cannot be used to identify anyone.
 */
export function discordProfile(me) {
  if (!me || !me.email) return null;
  // An unverified address must be refused. The Supabase user is keyed on email,
  // so accepting one would let somebody claim an account that is not theirs.
  if (me.verified === false) return null;
  return {
    email: me.email,
    full_name: me.global_name || me.username || "Player",
    user_name: me.username || "",
    avatar_url: me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
      : "",
    provider: "discord",
    discord_id: String(me.id || ""),
  };
}

/** Only ever back to our own origin, never to a host taken from the query. */
function backToGame(res, origin, params) {
  res.setHeader("Location", `${origin}/#${new URLSearchParams(params)}`);
  res.setHeader("Cache-Control", "no-store");
  res.status(302).end();
}

function adminPost(serviceKey, path, body, method = "POST") {
  return fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * A single-use token the browser can trade for a real Supabase session.
 *
 * generate_link resolves this email to its existing user when there is one, and
 * that is the whole reason it is used: a returning Discord player keeps their
 * id. The metadata is refreshed afterwards so the name and avatar are right on
 * a first sign-in too, where generate_link created the row itself and knows
 * nothing about Discord.
 */
async function mintSessionToken(serviceKey, profile) {
  const res = await adminPost(serviceKey, "/admin/generate_link", {
    type: "magiclink",
    email: profile.email,
  });
  if (!res.ok) return null;

  const link = await res.json();
  if (!link.hashed_token) return null;

  const user = link.user || {};
  const meta = user.user_metadata || {};
  if (user.id && meta.discord_id !== profile.discord_id) {
    // Best effort: a stale display name is not worth failing a login over.
    try {
      await adminPost(serviceKey, `/admin/users/${user.id}`, {
        user_metadata: { ...meta, ...profile },
      }, "PUT");
    } catch {}
  }
  return link.hashed_token;
}

export default async function handler(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const origin = `https://${host}`;
  const q = new URL(req.url, origin).searchParams;
  const state = q.get("state") || "";

  // The player pressed Cancel, or Discord refused outright.
  if (q.get("error")) {
    return backToGame(res, origin, { rd_error: q.get("error"), rd_state: state });
  }
  const code = q.get("code");
  if (!code) return backToGame(res, origin, { rd_error: "no_code", rd_state: state });

  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Missing configuration is a deployment fault, not a player fault, and it must
  // not be reported as though the player's login was refused.
  if (!clientSecret || !serviceKey || !DISCORD_CLIENT_ID) {
    return backToGame(res, origin, { rd_error: "server_not_configured", rd_state: state });
  }

  try {
    // 1. Trade the code for a Discord token. This is the step that needs the
    //    secret, and therefore the step that cannot happen in the browser.
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        // Must match the one sent to /authorize, byte for byte.
        redirect_uri: `${origin}/api/discord/callback`,
      }),
    });
    if (!tokenRes.ok) {
      return backToGame(res, origin, { rd_error: "discord_token", rd_state: state });
    }
    const token = await tokenRes.json();

    // 2. Ask Discord who that token belongs to.
    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) {
      return backToGame(res, origin, { rd_error: "discord_user", rd_state: state });
    }

    const profile = discordProfile(await meRes.json());
    if (!profile) {
      return backToGame(res, origin, { rd_error: "discord_no_email", rd_state: state });
    }

    // 3. Turn that into a Supabase session the game can use.
    const hashed = await mintSessionToken(serviceKey, profile);
    if (!hashed) {
      return backToGame(res, origin, { rd_error: "session_mint", rd_state: state });
    }

    // token_hash rather than the six-digit OTP, so no email address rides in the
    // URL. It is single-use, short-lived, and a fragment is never sent to any
    // server - not even this one.
    return backToGame(res, origin, { rd_otp: hashed, rd_state: state });
  } catch {
    return backToGame(res, origin, { rd_error: "unexpected", rd_state: state });
  }
}
