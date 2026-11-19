# BTB (Bouge Ton Body): smart-trainer workouts in one HTML file

`index.html` is the whole app: workouts, plans, live dashboard, ride analytics and ERG control for smart trainers over Bluetooth. No install, no server code.

## Where it runs

| Device | Browser |
|---|---|
| Windows / macOS / ChromeOS / Android | Chrome or Edge |
| iPhone / iPad | **Bluefy** (free, App Store). Safari and Chrome on iOS have no Web Bluetooth. |
| Anything else | Browse workouts and use **Sim** mode only |

Bluetooth only works on a secure page: `https://…` or `http://localhost`.

## Sharing it

Host `index.html` on any https static host and send the link:
- **Netlify Drop**: drag the folder onto app.netlify.com/drop
- **GitHub Pages**: push `index.html` to a repo, then Settings › Pages
- **Cloudflare Pages**, an S3 bucket, your own web space…

Local test: `python -m http.server 8765`, then open http://localhost:8765.

## Install as an app

The hosted site (GitHub Pages build) ships a web app manifest and icons, so it can be installed:
- **Windows / macOS / Android (Chrome, Edge):** Settings › *Install as an app* › **Install BTB**, or the install icon in the address bar. Bluetooth keeps working in the installed app.
- **iPhone / iPad:** in Safari or Chrome, Share › **Add to Home Screen**. Apple does not allow Bluetooth in home-screen web apps, so the icon is for browsing workouts, plans and rides; to **ride**, keep using **Bluefy**. The home-screen app has its own storage: sign in there once with the emailed **code** (tapping the email link opens the browser instead).

The single-file `index.html` in the repo has no manifest and is not installable.

## Trainers

- **Bluetooth** (Chrome/Edge on Windows, macOS, Android, ChromeOS; Bluefy on iPhone/iPad): the protocol is detected after connecting. Standard **FTMS** (almost every current smart trainer), **Tacx FE-C over Bluetooth** (older Tacx firmware) and **Wahoo legacy ERG** (older KICKR firmware) all control ERG and slope; a plain **power meter** connects read-only.
- Trainer not listed when connecting? It is probably still connected to another app (Zwift, the maker's app…, on any device nearby): close those first. The chooser also lists trainers by name, and *Show all Bluetooth devices* lists everything nearby (useful in Bluefy).
- Not tested on every trainer model: report what works on yours.

## Before riding
- Close Zwift, the trainer maker's app and similar. Most trainers accept only one Bluetooth controller at a time.
- Heart rate comes from a separate Bluetooth strap (the "HR" button).
- In ERG: small chainring, middle cog, and start pedalling before the first interval.

## Strava upload

Settings › Strava. Strava requires an API app's **Client Secret** for login (it has no PKCE), so either:
- **Each rider brings their own app**: create one at strava.com/settings/api, set *Authorization Callback Domain* to the host the page runs on (e.g. `you.github.io` or `localhost`), and paste the Client ID + Secret in Settings. They stay in that browser.
- **Host a token relay** (`strava-relay.worker.js`, a free Cloudflare Worker) holding the secret. Riders then only need the Client ID. New Strava apps accept 1 athlete; raise to 10 on the API settings page, more needs Strava review.

Rides upload as TCX (gzipped) with power, HR and cadence, automatically after each ride (rides under 2 minutes or without power are skipped) or from History.

## Editing / rebuilding

- `src/app.template.html`: app code (HTML/CSS/JS)
- `src/data/workouts_*.json`, `src/data/plans.json`: workout library and plans (power as a fraction of FTP, durations in seconds)
- `node src/build.mjs` validates the data and writes `index.html`; `--out dist/index.html` writes a hosted build plus `manifest.webmanifest` and the icons from `src/assets/`
- `src/protocol_notes.md`: FTMS smart-trainer protocol research the Bluetooth code is based on
- `src/parts/`: inlined into the page by the build: analysis maths (`a1-analysis.js`), Progress / ride analysis views (`a2-*`), body & energy maths (`a3-body.js`), demo rider for Sim mode (`b1-demo.js`), BTB logo lettering (`z0-btb-font.js`), Neon Miami theme, logo and gauges (`z1-theme.css`, `z2-gauges.js`)
- `src/theme/`: source art for the theme; regenerate with `cd src/theme && node gen-art.mjs theme.src.css ../parts/z1-theme.css art`
- `src/theme/icons.mjs`: the app icons. `node src/theme/icons.mjs png` re-renders `src/assets/*.png` with headless Chrome or Edge; `node src/theme/icons.mjs preview out.html` writes a comparison page.
- The BTB logo and the "BOUGE TON BODY" tagline are simplified outlines of the **Cyber Brush** typeface by HansCo (Burhan Afif), which is free for personal / non-commercial use only; any commercial use of BTB needs its commercial licence (hanscostudio.com). The font file itself is not in this repo.
- Tests: `node src/test/analysis.test.mjs`, `node src/test/body.test.mjs`, `node src/test/build.test.mjs`
