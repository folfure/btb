# Hosting BTB with private cloud storage (Supabase, EU)

What you get: an invite-only app at `https://folfure.github.io/btb/`. Each rider signs in with a one-time code by email. Their settings, rides (incl. heart rate), plan progress and Strava connection are stored in your Supabase project in Frankfurt, and nobody can read another rider's data (Row Level Security). Strava credentials and tokens never reach the browser or GitHub.

| Secret / setting | Lives in | Never in |
|---|---|---|
| Supabase URL + **publishable** key | GitHub repo *Variables* → injected into the page at deploy | the code |
| Supabase **secret** key | Supabase only (given to the edge function automatically) | anywhere else |
| Strava Client ID + Secret | Supabase function secrets | GitHub, the page |
| Riders' Strava tokens | `strava_tokens` table (only the edge function can read it) | the browser |

---

## 1. Create the project (5 min)
1. https://supabase.com → **New project** → name `erglab`, region **Central EU (Frankfurt)**, generate a strong database password and keep it in your password manager.
2. **Project Settings › API Keys**: note the **Project URL** and the **publishable key** (`sb_publishable_…`). Do *not* copy the secret key anywhere.

## 2. Lock down sign-in (invite-only)
The database itself only serves **invited** riders (Supabase sets `invited_at` when you use *Invite user*), so a wrong toggle can't open it. Still set all of this:

In **Authentication**:
- **Sign In / Providers**: turn **off** "Allow new users to sign up" and "Allow anonymous sign-ins" and "Allow manual linking". Keep only **Email** enabled (no phone/Google/…), with "Confirm email" on. Set *Email OTP length* = **8** and *Email OTP expiration* = **600** seconds.
- **Rate Limits**: keep "Token verifications" and "Emails sent" low (defaults are fine; don't raise them).
- **Sessions / JWT**: access-token expiry 1800 s or less; keep refresh-token reuse detection on.
- **Emails › Templates › Magic Link** *and* **Confirm signup**:
  - Subject: `Ton code BTB / Your BTB code`.
  - Body: paste the whole of [`supabase/templates/sign-in-code.html`](supabase/templates/sign-in-code.html). It is the Neon Miami card with the code in big type and French and English text. The logo is styled HTML text, not an image, so it still shows in mail apps that block pictures.
- **Emails › Templates › Invite user**:
  - Subject: `Bienvenue sur BTB / You've been invited to BTB`.
  - Body: paste the whole of [`supabase/templates/invite.html`](supabase/templates/invite.html). It has the same look, with an *Accept invitation* button and the plain link under it.
  - Accepting confirms the account and signs the rider straight in. Until then, code sign-in is refused because sign-ups are off.
- **Emails › SMTP settings**: Supabase's built-in mailer only delivers to members of your Supabase team and only a few emails per hour. To invite other riders, plug in an SMTP provider (Resend, Brevo, Postmark…; all have free tiers).
- **URL Configuration**: *Site URL* = `https://folfure.github.io/btb/`; *Redirect URLs* add `https://folfure.github.io/btb/` and `http://localhost:8765/`.

## 3. Create the tables + deploy the Strava function
In a terminal in this folder (Node is enough, `npx` fetches the CLI):
```powershell
npx supabase login
```
```powershell
npx supabase link --project-ref <your-project-ref>
```
```powershell
npx supabase db push
```
(`<your-project-ref>` is the `xxxx` in `https://xxxx.supabase.co`. `db push` creates the tables and security rules from `supabase/migrations/`.)

## 4. Strava
1. https://www.strava.com/settings/api → create an app. *Authorization Callback Domain* = `folfure.github.io`.
2. Store its credentials in Supabase (typed in **your** terminal, never in chat or Git):
   ```powershell
   npx supabase secrets set STRAVA_CLIENT_ID=<id> STRAVA_CLIENT_SECRET=<secret> ALLOWED_ORIGINS=https://folfure.github.io
   ```
3. Deploy the function:
   ```powershell
   npx supabase functions deploy strava
   ```
4. New Strava apps accept **1** athlete. On the Strava API page raise *athlete capacity* to 10; beyond that Strava must review the app.

## 5. GitHub deploy
1. Repo **Settings › Secrets and variables › Actions › Variables** → add
   - `ERGLAB_SUPABASE_URL` = `https://<ref>.supabase.co`
   - `ERGLAB_SUPABASE_KEY` = the `sb_publishable_…` key (the build refuses secret keys)
2. Repo **Settings › Pages** → *Source* = **GitHub Actions**.
3. Push to `main` (or *Actions › Deploy BTB › Run workflow*). The page is rebuilt with cloud sign-in enabled.

## 6. Invite riders
**Authentication › Users › Invite user** → their email. They open the site, type that email, receive a code, done.
(If you ever create a user with *Add user* instead of *Invite*, mark them as a rider in the SQL editor:
`update auth.users set raw_app_meta_data = raw_app_meta_data || '{"erglab_rider":true}' where email = 'them@example.com';`)

To **block** someone without losing their data: *Ban user*. It takes effect immediately, because the database checks on every request. To **erase** someone and all their rides/HR data: *Delete user*.

**Riders on iPhone:** they ride in **Bluefy** (sign in there with a code). They can also add BTB to the home screen (Safari › Share › Add to Home Screen) to browse plans and rides, but Apple gives home-screen apps no Bluetooth, and the icon needs its own sign-in with a code (the email link opens the browser, not the icon).

## 7. Recommended: give BTB its own domain
Every GitHub Pages site of the `folfure` account shares the origin `https://folfure.github.io`. Pages on one origin can read each other's browser storage, which includes a rider's login session. As long as you publish **no other** Pages sites on this account that's fine. For a clean separation, use a custom domain (e.g. `erglab.yourdomain.be`): repo *Settings › Pages › Custom domain* + *Enforce HTTPS*, then update the Supabase Site/Redirect URLs, `ALLOWED_ORIGINS` and the Strava callback domain to it.

## Local testing against the cloud
Create `src/cloud.config.json` (git-ignored):
```json
{ "url": "https://<ref>.supabase.co", "key": "sb_publishable_…" }
```
then `node src/build.mjs` and open http://localhost:8765. Without that file the build is the plain local-only app.

## Notes
- Heart-rate data is health data under GDPR. Keep the project in the EU, invite only people who agreed, and delete users who leave.
- Riders' login sessions live in their own browser and are wiped on *Sign out*. Other pages on the same origin (`folfure.github.io`, i.e. your other GitHub Pages projects) can read browser storage. A custom domain for BTB removes that exposure.
