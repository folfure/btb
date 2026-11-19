# ERGlab: smart-trainer workouts in one HTML file

`index.html` is the whole app: workouts, plans, live dashboard and Bluetooth ERG control for FTMS trainers (Elite Direto X and others). No install, no server code.

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

## Before riding (Direto X)
- Close Zwift, the Elite apps and similar. The trainer accepts only one Bluetooth controller at a time.
- Heart rate comes from a separate Bluetooth strap (the "HR" button). The Direto X doesn't relay HR.
- In ERG: small chainring, middle cog, and start pedalling before the first interval.

## Editing / rebuilding

- `src/app.template.html`: app code (HTML/CSS/JS)
- `src/data/workouts_*.json`, `src/data/plans.json`: workout library and plans (power as a fraction of FTP, durations in seconds)
- `node src/build.mjs` validates the data and writes `index.html`
- `src/protocol_notes.md`: FTMS / Direto X protocol research the Bluetooth code is based on
