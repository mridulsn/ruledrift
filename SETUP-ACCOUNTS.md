# Turning on accounts (Google + Discord)

## Current status

| Step | State |
|---|---|
| 1. Supabase project | ✅ done |
| 2. `profiles` table + row-level security | ✅ done |
| 3. URL + anon key in `src/config.js` | ✅ done |
| 4. Discord sign-in | ✅ **working** |
| 5. Google sign-in | ⬜ not set up — its button shows a cross until it is |

The sign-in buttons read the project's live provider list, so **Google lights up
on its own** the moment step 5 is finished. No code change, no redeploy.

Steps 1–3 are recorded below for reference. If you are only here for Google,
skip to section 4.

Everything is free. The two *secret* values never leave the Supabase dashboard.

---

## 1. Create the Supabase project (5 min)

1. Go to https://supabase.com and sign in with GitHub.
2. **New project.** Name it `ruledrift`. Choose the region closest to you —
   **Mumbai (ap-south-1)** for India. Set a database password and save it in
   your password manager; you will not need it for this, but you will later.
3. Wait for it to finish provisioning.

## 2. Create the table (2 min)

1. In the left sidebar open **SQL Editor → New query**.
2. Open `supabase/schema.sql` from this repo, paste the whole file in, and press
   **Run**.
3. You should see `Success. No rows returned.`

That creates one table with Row Level Security switched on, so each player can
only ever read and write their own row.

## 3. Get your two public values (1 min)

**Project Settings → API**, and copy:

| Field in Supabase | Goes into `src/config.js` |
|---|---|
| Project URL | `SUPABASE_URL` |
| `anon` `public` key | `SUPABASE_ANON_KEY` |

Both are safe to commit — the anon key is designed to be public, and the RLS
policies from step 2 are what actually protect the data. **Never** copy the
`service_role` key into this project; it bypasses RLS entirely.

## 4. Google sign-in — ⬜ REMAINING

The callback URL both providers need:

```
https://yvttgbuhwkjeqqvblcbc.supabase.co/auth/v1/callback
```

1. https://console.cloud.google.com → create a project named `Ruledrift`.
2. **OAuth consent screen** → **External** → app name, your email as both
   support and developer contact → save through to the end → **Publish app**
   (without publishing, only hand-listed test accounts can sign in).
3. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorised JavaScript origins:** `https://ruledrift.vercel.app`
   - **Authorised redirect URI:** the callback URL above

   These two fields are different and easy to swap. Origin = the game.
   Redirect = Supabase.
4. Copy the **Client ID** and **Client secret**. Do not screenshot the secret.
5. In Supabase: **Authentication → Providers → Google**, switch it on, paste
   both, **Save**.

Google's console was redesigned recently, so the menu names above may not match
what is on screen. The credentials page is at
https://console.cloud.google.com/auth/clients.

## 5. Discord sign-in — ✅ DONE

Recorded for reference. App name `Ruledrift`, Client ID `1545474193758621776`.

1. https://discord.com/developers/applications → **New Application**.
2. **OAuth2** in the sidebar. Under **Redirects**, add the callback URL above,
   and **Save Changes**.
3. Copy the **Client ID**, then **Reset Secret** for the **Client secret**.
4. In Supabase: **Authentication → Providers → Discord**, switch it on, paste
   both, **Save**.

## 6. Point Supabase back at the game — ✅ DONE

⚠️ The trap that cost us a round of debugging: **Site URL defaults to
`http://localhost:3000`.** Sign-in then succeeds and dumps the player on
ERR_CONNECTION_REFUSED. There are also **two separate Save buttons** on this
page — it is easy to save one and not the other.


**Authentication → URL Configuration:**

- **Site URL:** `https://ruledrift.vercel.app`
- **Redirect URLs:** add both
  - `https://ruledrift.vercel.app`
  - `http://localhost:8777` (so sign-in works while testing locally)

If you skip this, sign-in completes and then bounces the player to a blank page.

## 7. Switch it on (1 min)

Edit `src/config.js`:

```js
export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

Then redeploy:

```bash
vercel deploy --prod --yes
```

The sign-in buttons appear under **Profile** and **Settings**. Until those two
values are filled in, the game behaves exactly as before and shows no sign-in UI
at all. A provider that is not switched on renders greyed out with a cross,
read live from the project rather than hardcoded.

---

## How to check it works

1. Open the game, go to **Profile** (or **Settings**), press the provider button.
2. You should land back on the Profile screen, signed in, with a toast reading
   *"Signed in — progress backed up"*.
3. In Supabase, **Table Editor → profiles** should show one row, with your
   history inside the `data` column.
4. Play a round, then press **Sync now** and confirm `updated_at` moves.
5. The real test: open the game on your **phone**, sign in with the same
   account, and confirm your laptop history appears. Play a round on the phone,
   sync the laptop, and confirm both rounds are present on both devices.

## What happens when things go wrong

The sync is written to fail soft, deliberately:

- **Offline?** The round is saved locally and marked to sync later. It goes up
  automatically when the connection returns.
- **Sign-in fails?** You get a toast and keep playing anonymously.
- **Cloud unreachable?** The game does not block, stall, or lose the round.
- **Two devices with different history?** They are merged, never overwritten.
  The merge is idempotent — syncing repeatedly can never duplicate a session or
  inflate your XP. There are 19 tests covering exactly this in
  `tools/selftest.mjs`.

## Cost

Supabase's free tier is 500MB of database and 50,000 monthly active users. A
profile is a few kilobytes. You will not approach either limit.

One caveat worth knowing: **free Supabase projects pause after 7 days of
inactivity.** If nobody signs in for a week, the first sign-in afterwards fails
until you unpause it from the dashboard. Anonymous play is unaffected.
