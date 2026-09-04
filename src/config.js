// Cloud configuration.
//
// Fill these two in to turn on accounts. Until then the game runs exactly as it
// always has: fully offline, no network calls, no sign-in button anywhere.
//
// Both values are safe to commit. The anon key is *designed* to be public - it
// only grants what Row Level Security allows, and the policies in
// supabase/schema.sql restrict every row to the user who owns it. The Google and
// Discord client secrets are NOT here; those live in the Supabase dashboard and
// should never appear in this repository.
//
// See SETUP-ACCOUNTS.md for the ten-minute walkthrough.

export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

/** Where the OAuth provider sends the player back to. */
export const REDIRECT_URL =
  typeof location !== "undefined" ? location.origin + location.pathname : "";

export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
