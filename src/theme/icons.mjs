// BTB app icons (Neon Miami look, original artwork, Cyber Brush lettering from parts/z0-btb-font.js).
// Each icon is a full-bleed 512x512 SVG: iOS / Android apply their own rounded mask.
//   node icons.mjs preview <out.html>   side-by-side preview (large, home-screen size, browser-tab size)
//   node icons.mjs png                  render src/assets/*.png with headless Chrome / Edge
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { btbPath, BTB_FONT } = new Function(readFileSync(join(here, '..', 'parts', 'z0-btb-font.js'), 'utf8') + '; return { btbPath, BTB_FONT };')();

const defs = p => `
<linearGradient id="${p}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#140530"/><stop offset=".42" stop-color="#4a0f6b"/><stop offset=".64" stop-color="#b8167a"/><stop offset=".66" stop-color="#ff3d8a"/><stop offset="1" stop-color="#ff8a3d"/></linearGradient>
<linearGradient id="${p}sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe45c"/><stop offset=".5" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ff2e88"/></linearGradient>
<linearGradient id="${p}chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".44" stop-color="#ffd3ec"/><stop offset=".47" stop-color="#ff3d9a"/><stop offset=".8" stop-color="#ff6a3d"/><stop offset="1" stop-color="#ffc23f"/></linearGradient>
<linearGradient id="${p}ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2ffff"/><stop offset=".44" stop-color="#9cf7ff"/><stop offset=".47" stop-color="#1fc8ff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient>
<radialGradient id="${p}night" cx=".5" cy=".3" r=".85"><stop offset="0" stop-color="#3a1272"/><stop offset=".6" stop-color="#160636"/><stop offset="1" stop-color="#07021a"/></radialGradient>
<filter id="${p}glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="${p}glow2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4"/></filter>`;
const svg = (p, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs>${defs(p)}</defs>${body}</svg>`;
const u = (p, id) => `url(#${p}${id})`;

// striped retro sun: circle cut by horizontal gaps that widen towards the horizon
function sun(p, cx, cy, r, horizon, gaps = 6) {
  const bottom = Math.min(horizon, cy + r); let cuts = '';
  for (let i = 0; i < gaps; i++) { const y = cy - r * 0.15 + (bottom - cy + r * 0.15) * (i + 0.5) / gaps, h = 3 + i * 3.4; cuts += `<rect x="${cx - r - 2}" y="${(y - h / 2).toFixed(1)}" width="${2 * r + 4}" height="${h.toFixed(1)}" fill="#000"/>`; }
  return `<mask id="${p}sm"><rect width="512" height="512" fill="#fff"/>${cuts}<rect y="${horizon}" width="512" height="${512 - horizon}" fill="#000"/></mask>
<circle cx="${cx}" cy="${cy}" r="${r + 26}" fill="#ff3d8a" opacity=".35" filter="${u(p, 'glow')}"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="${u(p, 'sun')}" mask="${u(p, 'sm')}"/>`;
}
// perspective grid floor from the horizon down
function floor(horizon, color = '#ff3d9a', fill = '#12042a') {
  let g = '';
  for (let i = 1; i < 8; i++) { const y = horizon + (512 - horizon) * Math.pow(i / 7, 1.9); g += `<line x1="0" x2="512" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }
  for (let i = -8; i <= 8; i++) g += `<line x1="256" y1="${horizon}" x2="${256 + i * 90}" y2="512"/>`;
  return `<rect y="${horizon}" width="512" height="${512 - horizon}" fill="${fill}"/><g stroke="${color}" stroke-width="3" opacity=".75">${g}</g>
<line x1="0" x2="512" y1="${horizon}" y2="${horizon}" stroke="#ffd0ec" stroke-width="3"/>`;
}
// "BTB" in the brush lettering, its ink box centred on (cx, cy) and `width` wide: chrome B's + ice T,
// a dark drop, cyan / magenta ghosts and a soft glow
function btb(p, cx, cy, width) {
  const G = BTB_FONT.g, K = BTB_FONT.kern, xT = G.B[0] + K.BT, xB2 = xT + G.T[0] + K.TB;
  const b1 = btbPath('B', 40, 0), t = btbPath('T', 40, xT), b2 = btbPath('B', 40, xB2);
  const x0 = b1.box[0], y0 = Math.min(b1.box[1], t.box[1]), x1 = b2.box[2], y1 = Math.max(b1.box[3], t.box[3], b2.box[3]);
  const s = width / (x1 - x0), tf = `translate(${(cx - (x0 + x1) / 2 * s).toFixed(1)} ${(cy - (y0 + y1) / 2 * s).toFixed(1)}) scale(${s.toFixed(3)})`;
  const B = b1.d + b2.d, T = t.d, pair = (b, c, extra = '') => `<path d="${B}" fill="${b}" ${extra}/><path d="${T}" fill="${c}" ${extra}/>`;
  return `<linearGradient id="${p}bc" x1="0" y1="${y0}" x2="0" y2="${y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset=".44" stop-color="#ffd3ec"/><stop offset=".5" stop-color="#ff3d9a"/><stop offset=".8" stop-color="#ff6a3d"/><stop offset="1" stop-color="#ffc23f"/></linearGradient>
<linearGradient id="${p}ti" x1="0" y1="${y0}" x2="0" y2="${y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f2ffff"/><stop offset=".44" stop-color="#9cf7ff"/><stop offset=".5" stop-color="#1fc8ff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient>
<g transform="${tf}">
<g opacity=".6" filter="${u(p, 'glow2')}">${pair('#ff2e88', '#22e6ff')}</g>
<g transform="translate(-1.6 0)" opacity=".9">${pair('#22e6ff', '#22e6ff')}</g>
<g transform="translate(1.6 .6)" opacity=".9">${pair('#ff2e88', '#ff2e88')}</g>
<g transform="translate(1 2.2)">${pair('#14052e', '#14052e')}</g>
${pair(u(p, 'bc'), u(p, 'ti'))}</g>`;
}
// "BOUGE TON BODY" in the brush lettering, white with a dark outline, ink box centred on (cx, cy), `width` wide
function brushTag(cx, cy, width, fill = '#ffffff') {
  const l = btbPath('BOUGE TON BODY'), [x0, y0, x1, y1] = l.box, s = width / (x1 - x0);
  return `<path transform="translate(${(cx - (x0 + x1) / 2 * s).toFixed(1)} ${(cy - (y0 + y1) / 2 * s).toFixed(1)}) scale(${s.toFixed(3)})" d="${l.d}" fill="${fill}" stroke="#14052e" stroke-width="${(2.2 / s * 4).toFixed(2)}" stroke-linejoin="round" paint-order="stroke"/>`;
}

export const ICONS = {
  // the default: striped sunset sun over a neon grid, BTB across the sun, the full name on the grid
  sunset: (p, safe = 1) => svg(p, `<rect width="512" height="512" fill="${u(p, 'sky')}"/>
${sun(p, 256, 236, 150, 330)}
${floor(330)}
<g transform="translate(256 256) scale(${safe}) translate(-256 -256)">
${btb(p, 256, 222, 400)}
<rect x="36" y="364" width="440" height="78" rx="16" fill="#14052e" opacity=".6"/>
${brushTag(256, 403, 404)}</g>`),
};
export const NAMES = { sunset: 'A · Sunset (default)' };
// Android "maskable" icons are cropped to a circle of 80 % of the size: keep the lettering inside it
const maskable = p => ICONS.sunset(p, 0.8);

const [, , cmd, out] = process.argv;
if (cmd === 'preview') {
  const all = Object.entries(ICONS);
  const big = all.map(([k, f]) => `<figure><div class="ic big">${f(k + 'b')}</div><figcaption>${NAMES[k]}</figcaption></figure>`).join('') + `<figure><div class="ic big round">${maskable('mk')}</div><figcaption>A · Android maskable</figcaption></figure>`;
  const small = id => all.map(([k, f]) => `<div class="app"><div class="ic sm">${f(k + id)}</div><span>BTB</span></div>`).join('');
  const fav = all.map(([k, f]) => `<div class="fav"><div class="ic f32">${f(k + 'f')}</div><div class="ic f16">${f(k + 'g')}</div><span>${NAMES[k][0]}</span></div>`).join('');
  writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>BTB icons</title><style>
body{margin:0;background:#0d0b16;color:#eee;font:15px system-ui;padding:24px}
h2{font-weight:600;font-size:16px;margin:22px 0 12px;color:#ffb3d9}
.grid{display:grid;grid-template-columns:repeat(4,200px);gap:22px} figure{margin:0;text-align:center} figcaption{margin-top:8px;font-size:14px}
.ic svg{display:block;width:100%;height:100%} .ic{overflow:hidden} .big{width:200px;height:200px;border-radius:44px} .round{border-radius:50%}
.phone{display:flex;gap:22px;padding:26px;border-radius:28px;width:fit-content;background:linear-gradient(160deg,#5a7bd8,#c56a9b 60%,#e7a26b)}
.phone.light{background:#f2f2f7} .phone.light .app{color:#111;text-shadow:none}
.app{text-align:center;font-size:12px;color:#fff;text-shadow:0 1px 2px #0008} .sm{width:60px;height:60px;border-radius:13.5px;margin-bottom:5px}
.tabs{display:flex;gap:26px;background:#fff;padding:12px 18px;border-radius:10px;width:fit-content}
.fav{display:flex;align-items:center;gap:8px;color:#222;font-size:13px} .f32{width:32px;height:32px;border-radius:7px} .f16{width:16px;height:16px;border-radius:3px}
</style><h2>Large</h2><div class="grid">${big}</div>
<h2>Home screen, real size</h2><div class="phone">${small('s')}</div><div style="height:12px"></div><div class="phone light">${small('t')}</div>
<h2>Small (32 px and 16 px)</h2><div class="tabs">${fav}</div>`);
} else if (cmd === 'png') {
  const exe = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(f => f && existsSync(f));
  if (!exe) throw new Error('No Chrome / Edge found: set CHROME=/path/to/chrome');
  const tmp = mkdtempSync(join(tmpdir(), 'btb-icons-')), assets = join(here, '..', 'assets');
  const jobs = [['icon-512.png', 512, ICONS.sunset('a')], ['icon-192.png', 192, ICONS.sunset('a')], ['apple-touch-icon.png', 180, ICONS.sunset('a')], ['icon-maskable-512.png', 512, maskable('m')]];
  try {
    for (const [name, size, s] of jobs) {
      const html = join(tmp, name + '.html');
      writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:#14052e}svg{display:block;width:${size}px;height:${size}px}</style>${s}`);
      execFileSync(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${join(tmp, 'profile')}`,
        `--window-size=${size},${size}`, `--screenshot=${join(assets, name)}`, pathToFileURL(html).href], { stdio: 'ignore', timeout: 60000 });
      console.log('wrote', name);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
} else if (cmd) throw new Error('usage: node icons.mjs preview <out.html> | png');
