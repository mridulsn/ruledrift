# Accounts setup

Accounts are optional; the game plays fully without them.

## How it fits together

- **Firebase project** `mayhemnull-5b349` (account mridul8527@gmail.com, Spark free plan,
  Firestore in asia-south1). It is shared with MayhemNull. Ruledrift's backups live in the
  collection `ruledrift/{uid}`. The rules (kept in `auth-api/firestore.rules`) allow each
  player to read and write only their own document.
- **Sign-in server**: the Vercel project `mayhemnull` (team gitching-bot), source in
  `C:\Users\smrid\Projects\auth-api`, served at https://auth.mridulsaravanan.com.
  Ruledrift calls it with `?app=ruledrift`; its settings use the `RD_` prefix:
  - `RD_GOOGLE_CLIENT_ID`: Google OAuth client in Cloud project `braided-verve-337808`
    (account allmightest@gmail.com). Authorized JavaScript origins must include
    `https://mridulsaravanan.com`.
  - `RD_DISCORD_CLIENT_ID` / `RD_DISCORD_CLIENT_SECRET`: the Discord application "Ruledrift"
    (client ID 1545474193758621776). OAuth2 redirect:
    `https://auth.mridulsaravanan.com/api/auth/discord`.
- The uid is `u_` + the first 28 hex characters of sha256(lower-case verified email), so the
  same person gets the same account whichever button they press.

## Never

- Never put a client secret or the Firebase service-account key in this repository.
- Never screenshot a secret field while setting a provider up.
