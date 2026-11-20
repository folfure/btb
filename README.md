# BTB (Bouge Ton Body): smart-trainer workouts in one HTML file

BTB is one web page that runs indoor-cycling sessions on a smart trainer over Bluetooth, with nothing to install and no app server of its own.

It includes:
- workouts and training plans
- a live ride screen
- ERG control
- ride analytics
- Strava upload

The interface is in English and French (Settings › Language).

There are two builds:
- **Hosted** (https://folfure.github.io/btb/): invite-only. Riders sign in with an emailed code, and their data is stored in Supabase (EU). See [SETUP-SUPABASE.md](SETUP-SUPABASE.md).
- **Single file** (`index.html` in the repo): no account. Everything stays in that browser.

## Where it runs

| Device | Browser |
|---|---|
| Windows / macOS / ChromeOS / Android | Chrome or Edge |
| iPhone / iPad | **Bluefy** (free, App Store). Safari and Chrome on iOS have no Web Bluetooth. |
| Anything else | Browse workouts and use **Sim** mode only |

Bluetooth only works on a secure page: `https://…` or `http://localhost`.

## What's in it

- **Library:** 142 workouts and 14 plans, among them a 12-week fat-loss plan and a 24 h relay plan. Power is a fraction of FTP, so every session scales to the rider. You can also build your own workouts.
- **Ride screen:**
  - **Power gauge:** non-linear, 0–1400 W, coloured by zone. From Z4 it glows, from Z5 flames spill out, and it shakes harder up to Z7.
  - **Cadence dial:** in its corner, with the target (90 rpm, or the step's own cadence) straight up.
  - **Step list and stats table:** you choose which tiles appear.
  - **Countdowns:** 10 → GO before a harder step, and 15 → 0 at the end of a hard step.
  - **Coach messages:** during and before efforts.
  - The screen always fits the window.
- **Customize ⚙ on the ride screen:** tiles, steps, chart, cadence dial, flames, and countdowns/coach, each saved separately for the phone and computer layouts. The **Aa** button (computer and tablet) cycles the text size.
- **Progress tab:**
  - per-ride analysis
  - fitness and fatigue trends
  - body data
  - an energy (kcal) estimate
- **Sim mode:** rides without a trainer. A demo rider fills Progress so you can try it out. Demo data is never saved or synced.
- **Settings:**
  - **Display:** theme (Neon Miami or Classic), panel transparency, and ride screen text size (85–150 %).
  - **Language:** English or French.
  - **Trainer calibration:** FTMS spin-down, step by step.
  - **Install as an app.**

## Trainers

- **Bluetooth:** the protocol is detected after connecting.
  - **Standard FTMS** (almost every current smart trainer), **Tacx FE-C over Bluetooth** (older Tacx firmware) and **Wahoo legacy ERG** (older KICKR firmware) all control ERG and slope.
  - A plain **power meter** connects read-only.
- **Trainer not listed when connecting?**
  - It is probably still connected to another app on a device nearby (Zwift, the maker's app…). Close those first.
  - The chooser also lists trainers by name.
  - *Show all Bluetooth devices* lists everything nearby, which helps in Bluefy.
- **Calibration:** Settings › Trainer calibration. The trainer must support FTMS spin-down. Ride about 10 minutes first, with no ride open.
- Not every trainer model has been tested. Please report what works on yours. The Elite Direto X in Bluefy is the main target.

## Before riding

- Close Zwift, the trainer maker's app and similar apps. Most trainers accept only one Bluetooth controller at a time.
- Heart rate comes from a separate Bluetooth strap (the "HR" button).
- In ERG, use the small chainring and a middle cog, and start pedalling before the first interval.

## Signing in (hosted build)

- **Invite only:** the admin invites riders from Supabase. Each rider signs in with an 8-digit code sent by email.
- **The code is only asked for again when the saved sign-in is really gone:**
  - The rider signed out. This only signs out that device.
  - The server ended the session.
  - iOS erased the site's data after about 7 days without opening it.
  - It is the first sign-in on a browser. Bluefy, Safari and the home-screen app each have their own storage.
- **No network at start:** BTB keeps the saved sign-in, retries in the background and lets you ride meanwhile.
- **Why a code?** The sign-in screen and Settings › Account show the reason.

## Install as an app

The hosted build ships a web app manifest and icons:
- **Windows / macOS / Android (Chrome, Edge):** Settings › *Install as an app* › **Install BTB**, or the install icon in the address bar. Bluetooth keeps working in the installed app.
- **iPhone / iPad:** in Safari or Chrome, Share › **Add to Home Screen**.
  - Apple does not allow Bluetooth in home-screen web apps, so this icon is for browsing workouts, plans and rides. To **ride**, use **Bluefy**.
  - The home-screen app has its own storage. Sign in there once with the emailed **code**. Tapping the link in the email opens the browser instead.

The single-file `index.html` has no manifest and cannot be installed.

## Sharing the single-file build

Host `index.html` on any https static host and send the link:
- **Netlify Drop:** drag the folder onto app.netlify.com/drop
- **GitHub Pages:** push `index.html` to a repo, then Settings › Pages
- **Cloudflare Pages**, an S3 bucket, your own web space…

Local test: `python -m http.server 8765`, then open http://localhost:8765.

## Strava upload

- **Upload:** rides upload as gzipped TCX with power, HR and cadence.
  - They upload automatically after each ride. Rides under 2 minutes or without power are skipped.
  - You can also upload from History.
- **Hosted build:** connect in Settings › Strava. The Strava app credentials and the riders' tokens are kept server-side, in a Supabase edge function (`supabase/functions/strava`), and never reach the page or GitHub. See [SETUP-SUPABASE.md](SETUP-SUPABASE.md).
- **Single-file build:** Strava requires the API app's **Client Secret** to log in, because it has no PKCE. Choose one of these:
  - **Each rider brings their own app:**
    - Create one at strava.com/settings/api.
    - Set *Authorization Callback Domain* to the host the page runs on (e.g. `you.github.io` or `localhost`).
    - Paste the Client ID and Secret in Settings. They stay in that browser.
  - **Host a token relay:** `strava-relay.worker.js` is a free Cloudflare Worker that holds the secret, so riders only need the Client ID.
    - New Strava apps accept 1 athlete.
    - You can raise that to 10 on the API settings page. More needs Strava's review.

## Editing / rebuilding

**Source files**
- `src/app.template.html`: the app code (HTML, CSS and JS).
- `src/parts/`: files the build inlines into the page.

  | File | Contents |
  |---|---|
  | `a1-analysis.js` | analysis maths |
  | `a2-*` | Progress and ride-analysis views |
  | `a3-body.js` | body and energy maths |
  | `b1-demo.js` | demo rider for Sim mode |
  | `c0-trainer-proto.js` | trainer protocols: FTMS, Tacx FE-C, Wahoo |
  | `z0-btb-font.js` | BTB logo lettering |
  | `z1-theme.css` | Neon Miami theme (generated) |
  | `z2-gauges.js` | gauges |
  | `z3-ridefx.*` | ride-screen extras: flames, cadence dial, countdowns, coach, text size |

- `src/data/workouts_*.json` and `src/data/plans.json`: the workout library and plans. Power is a fraction of FTP and durations are in seconds.
- `src/i18n/`: French translations. The English text is the key. See [src/i18n/README.md](src/i18n/README.md).
- `src/theme/`: the theme's source art.
  - Edit `theme.src.css`.
  - Regenerate with `cd src/theme && node gen-art.mjs theme.src.css ../parts/z1-theme.css art`.
- `src/theme/icons.mjs`: the app icons.
  - `node src/theme/icons.mjs png` re-renders `src/assets/*.png` with headless Chrome or Edge.
  - `node src/theme/icons.mjs preview out.html` writes a comparison page.
- `src/protocol_notes.md`: the FTMS smart-trainer protocol research the Bluetooth code is based on.

**Build and deploy**
- `node src/build.mjs` validates the data and translations and writes `index.html`.
- `node src/build.mjs --out dist/index.html` writes the hosted build, plus `manifest.webmanifest` and the icons from `src/assets/`.
- With `ERGLAB_SUPABASE_URL` and `ERGLAB_SUPABASE_KEY` set, the build connects to Supabase. Use the **publishable** key only; the build refuses secret keys.
- Pushing to `main` deploys the hosted build to GitHub Pages (`.github/workflows/pages.yml`). The Supabase URL and key come from the repository *Variables*, never from the code.
- `supabase/`: database migrations (Row Level Security), the Strava edge function, and `set-strava-secrets.ps1`.

**Tests**
- `node src/test/analysis.test.mjs`
- `node src/test/body.test.mjs`
- `node src/test/build.test.mjs`
- `node src/test/i18n.test.mjs`
- `node src/test/protocols.test.mjs`

## Licence note

The BTB logo and the "BOUGE TON BODY" tagline are simplified outlines of the **Cyber Brush** typeface by HansCo (Burhan Afif).
- The typeface is free for personal, non-commercial use only.
- Any commercial use of BTB needs its commercial licence (hanscostudio.com).
- The font file itself is not in this repo.
