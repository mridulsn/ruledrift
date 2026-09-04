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

export const SUPABASE_URL = "https://yvttgbuhwkjeqqvblcbc.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2dHRnYnVod2tqZXFxdmJsY2JjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MjE3NjcsImV4cCI6MjEwNDA5Nzc2N30.klR_ZzISpcoiYdccjKwCEoeKVISupc0L4DRD8UKq_bY";

// Google's public OAuth client ID. Safe to commit - it is designed to be read
// out of the page source; it identifies the app, it does not authorise anything.
//
// This exists so Google sign-in can happen *on this domain* via Google Identity
// Services, rather than bouncing through <project-ref>.supabase.co. A player
// being asked to trust a random-looking hostname is a player who closes the tab.
export const GOOGLE_CLIENT_ID =
  "45031354820-9t0la84m9fjng5vsrn6svj35o72b92rh.apps.googleusercontent.com";

/** Where the OAuth provider sends the player back to. */
export const REDIRECT_URL =
  typeof location !== "undefined" ? location.origin + location.pathname : "";

export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
