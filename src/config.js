// Cloud configuration.
//
// Accounts run on Firebase (Auth + Firestore). The game is a static page on
// GitHub Pages, so the parts a browser cannot do - holding the Discord secret,
// checking Google's token, minting a Firebase sign-in token - are done by the
// one small server behind mridulsaravanan.com, at auth.mridulsaravanan.com.
//
// Every value here is safe to commit:
// - The Firebase web API key identifies the project; it authorises nothing.
//   The Firestore rules are what keep each player's backup to that player.
// - OAuth client IDs name the app on the consent screen; the matching secrets
//   live only in the server's environment variables.
//
// Supabase was the account system until October 2026. Its free plan pauses
// after a week without visitors, and a paused project silently breaks every
// sign-in, so it was replaced. Firebase's free plan does not pause.

/** Where the sign-in server is. Anywhere but the real site (a local dev server), it is this origin. */
export const API_ORIGIN =
  typeof location !== "undefined" && /(^|\.)mridulsaravanan\.com$/.test(location.hostname)
    ? "https://auth.mridulsaravanan.com"
    : "";

export const APP = "ruledrift";

export const FIREBASE_API_KEY = "AIzaSyC7eOWSXtmkRFuG0xw_Qv9e9Pfi4_g2h10";
export const FIREBASE_PROJECT_ID = "mayhemnull-5b349";

// Google's public OAuth client ID, for Google Identity Services. The server
// checks that every Google token it is handed was issued for exactly this ID.
export const GOOGLE_CLIENT_ID =
  "45031354820-9t0la84m9fjng5vsrn6svj35o72b92rh.apps.googleusercontent.com";

/** Where the game lives, so a sign-in comes back to the game and not the site's home page. */
export const REDIRECT_URL =
  typeof location !== "undefined" ? location.origin + location.pathname : "";

export const cloudConfigured = () => Boolean(FIREBASE_API_KEY && FIREBASE_PROJECT_ID);
