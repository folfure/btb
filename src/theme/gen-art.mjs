// Generates the Neon Miami background art as separate compact SVG layers, encodes them as data: URIs
// and substitutes them into the theme CSS source (%%NAME%% placeholders).
// Layers (all in "stage" units: the stage is 1600 x 1000, horizon at y=700, sun centre x=800):
//   SKY0   dusk sky (early state)            1600 x 1200 box, bottom = horizon
//   SKY1   night sky + stars (final state)   1600 x 1200 box, bottom = horizon  (opacity animates in)
//   HALO   sun halo                          1040 x 1040 box around the sun     (opacity shimmers)
//   SUN    striped retro sun                 1040 x 1040 box                     (translateY: the sunset)
//   GROUND ridge, skyline, floor, converging grid lines   stage y 550..1000      (static)
//   HL     horizontal grid lines, self-similar (ratio 1.38) so scaleY loops seamlessly (grid scrolls)
//   HAZE   floor haze near the horizon + crisp horizon line                     (static)
//   GLOW   horizon bloom + sun reflection on the grid                            (opacity animates in)
//   PALML / PALMR  palm silhouettes                                              (slow sway)
// Usage: node gen-art.mjs <theme.src.css> <out.css> [<svgDumpDir>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const f1 = n => String(Math.round(n));
const f2 = n => String(Math.round(n * 100) / 100);
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const poly = pts => 'M' + pts.map(p => f1(p[0]) + ' ' + f1(p[1])).join('L') + 'Z';
const svg = (vb, body, par = 'none') => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${vb}' preserveAspectRatio='${par}'>${body}</svg>`.replace(/\n\s*/g, '');

// ---------- palms ----------
function trunk(bx, by, tx, ty, bend, w0, w1) {
  const cx = (bx + tx) / 2 + bend, cy = (by + ty) / 2, N = 46, L = [], R = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const x = u * u * bx + 2 * u * t * cx + t * t * tx, y = u * u * by + 2 * u * t * cy + t * t * ty;
    const dx = 2 * u * (cx - bx) + 2 * t * (tx - cx), dy = 2 * u * (cy - by) + 2 * t * (ty - cy), l = Math.hypot(dx, dy);
    const nx = -dy / l, ny = dx / l, w = (w0 + (w1 - w0) * Math.pow(t, 0.8)) / 2 * (i % 3 === 0 ? 1.1 : 1);
    L.push([x + nx * w, y + ny * w]); R.push([x - nx * w, y - ny * w]);
  }
  return poly([...L, ...R.reverse()]);
}
function frond(cx, cy, deg, len, droop, wid, r) {
  const a = deg * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
  const P = t => [cx + dx * len * t, cy + dy * len * t + droop * len * t * t];
  const T = t => { const x = dx * len, y = dy * len + 2 * droop * len * t, l = Math.hypot(x, y); return [x / l, y / l]; };
  const env = t => wid * Math.pow(Math.sin(Math.PI * Math.min(1, t)), 0.55) * (1 - 0.3 * t);
  const M = 18, A = [], B = [];
  for (let i = 1; i <= M; i++) {
    const t = i / M * 0.96, [px, py] = P(t), [tx, ty] = T(t), nx = -ty, ny = tx;
    for (const side of [1, -1]) {
      const w = env(t) * (0.8 + 0.4 * r()), [qx, qy] = P(Math.min(1, t + 0.06));
      const tip = [qx + side * nx * w, qy + side * ny * w + w * 0.85];
      const notch = [px + side * nx * w * 0.1, py + side * ny * w * 0.1];
      (side > 0 ? A : B).push(notch, tip);
    }
  }
  return poly([[cx, cy], ...A, P(1), ...B.reverse()]);
}
function palm({ bx, by, tx, ty, bend, w0, w1, s = 1, seed = 1, tilt = 0 }) {
  const r = rng(seed);
  const fr = [[-176, 150, 1.05], [-152, 168, .95], [-127, 152, .8], [-103, 125, .62], [-79, 128, .66], [-54, 158, .86], [-29, 166, 1.0], [-6, 150, 1.15], [168, 112, .9], [14, 112, .95]];
  let d = trunk(bx, by, tx, ty, bend, w0, w1);
  for (const [deg, len, droop] of fr) d += frond(tx, ty, deg + tilt + (r() - .5) * 8, len * s * (0.9 + r() * 0.2), droop, 21 * s, r);
  let nuts = '';
  for (let i = 0; i < 3; i++) nuts += `<circle cx='${f1(tx - 7 * s + i * 7 * s)}' cy='${f1(ty + 7 * s + (i % 2) * 4 * s)}' r='${f1(6 * s)}'/>`;
  return `<path d='${d}'/>${nuts}`;
}
const palmSvg = (palms, id) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 440 900'><defs><linearGradient id='${id}' x1='0' y1='1' x2='0' y2='0'><stop offset='0' stop-color='#ff8a2a' stop-opacity='.55'/><stop offset='.5' stop-color='#ff2e88' stop-opacity='.45'/><stop offset='1' stop-color='#b03bff' stop-opacity='.35'/></linearGradient></defs><g fill='#07021a' stroke='url(#${id})' stroke-width='1.6' stroke-linejoin='round'>${palms.map(palm).join('')}</g></svg>`;
const PALML = palmSvg([
  { bx: 40, by: 940, tx: 70, ty: 540, bend: 34, w0: 20, w1: 10, s: .78, seed: 7, tilt: 6 },
  { bx: 150, by: 940, tx: 235, ty: 250, bend: -70, w0: 26, w1: 12, s: 1, seed: 3, tilt: 4 },
], 'pl');
const PALMR = palmSvg([
  { bx: 410, by: 940, tx: 400, ty: 600, bend: -24, w0: 18, w1: 9, s: .7, seed: 11, tilt: -4 },
  { bx: 320, by: 940, tx: 215, ty: 330, bend: 60, w0: 24, w1: 11, s: .95, seed: 5, tilt: -6 },
], 'pr');

const W = 1600, H = 1000, HY = 700, CX = 800;

// ---------- sky (box 1600 x 1200, bottom edge = horizon; the stage top is at y=500) ----------
const SKY0 = svg('0 0 1600 1200', `<defs><linearGradient id='a' x1='0' y1='0' x2='0' y2='1'>
<stop offset='0' stop-color='#170640'/><stop offset='.42' stop-color='#2a0b5e'/><stop offset='.64' stop-color='#5a1a7e'/>
<stop offset='.8' stop-color='#9a3088'/><stop offset='.92' stop-color='#d4508a'/><stop offset='1' stop-color='#f27a86'/></linearGradient></defs>
<rect width='1600' height='1200' fill='url(#a)'/>`);

function sky1() {
  const r = rng(42);
  let stars = '', spark = '';
  for (let i = 0; i < 150; i++) {
    const y = Math.pow(r(), 1.35) * 1060, x = r() * W, s = r();
    const op = (0.3 + r() * 0.6) * (1 - Math.max(0, (y - 760) / 360));
    stars += `<circle cx='${f1(x)}' cy='${f1(y)}' r='${f2(0.6 + s * 1.3)}' opacity='${op.toFixed(2)}'/>`;
  }
  for (let i = 0; i < 7; i++) {
    const x = 80 + r() * 1440, y = 200 + r() * 600, s = 5 + r() * 5;
    spark += `<path d='M${f1(x)} ${f2(y - s)}L${f2(x + s * .22)} ${f2(y - s * .22)}L${f2(x + s)} ${f1(y)}L${f2(x + s * .22)} ${f2(y + s * .22)}L${f1(x)} ${f2(y + s)}L${f2(x - s * .22)} ${f2(y + s * .22)}L${f2(x - s)} ${f1(y)}L${f2(x - s * .22)} ${f2(y - s * .22)}Z'/>`;
  }
  return svg('0 0 1600 1200', `<defs><linearGradient id='a' x1='0' y1='0' x2='0' y2='1'>
<stop offset='0' stop-color='#090220'/><stop offset='.42' stop-color='#0b0326'/><stop offset='.64' stop-color='#170632'/>
<stop offset='.84' stop-color='#36094f'/><stop offset='1' stop-color='#6e1462'/></linearGradient>
<linearGradient id='b' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ff2e88' stop-opacity='0'/><stop offset='.7' stop-color='#ff3d78' stop-opacity='.42'/><stop offset='1' stop-color='#ff7a4a' stop-opacity='.72'/></linearGradient></defs>
<rect width='1600' height='1200' fill='url(#a)'/><rect y='900' width='1600' height='300' fill='url(#b)'/>
<g fill='#fff'>${stars}</g><g fill='#ffe6f6' opacity='.85'>${spark}</g>`);
}
const SKY1 = sky1();

// ---------- sun (box 1040 x 1040, sun centre 520,520, r 205) ----------
const HALO = svg('0 0 1040 1040', `<defs><radialGradient id='h' cx='.5' cy='.5' r='.5'>
<stop offset='0' stop-color='#ff5a8f' stop-opacity='.62'/><stop offset='.4' stop-color='#c42e8c' stop-opacity='.26'/><stop offset='.7' stop-color='#6a1872' stop-opacity='.08'/><stop offset='1' stop-color='#3a0b5a' stop-opacity='0'/></radialGradient></defs>
<circle cx='520' cy='520' r='520' fill='url(#h)'/>`);
function sun() {
  let cuts = '';
  for (let k = 0; k < 8; k++) cuts += `<rect x='0' y='${f2(530 + k * 23.5)}' width='1040' height='${f2(2.6 + k * 2.3)}'/>`;
  return svg('0 0 1040 1040', `<defs><linearGradient id='s' x1='0' y1='315' x2='0' y2='725' gradientUnits='userSpaceOnUse'>
<stop offset='.06' stop-color='#fff1b0'/><stop offset='.3' stop-color='#ffc35e'/><stop offset='.55' stop-color='#ff7a52'/><stop offset='.78' stop-color='#ff3f78'/><stop offset='1' stop-color='#d81b8e'/></linearGradient>
<mask id='m'><rect width='1040' height='1040' fill='#fff'/><g fill='#000'>${cuts}</g></mask></defs>
<circle cx='520' cy='520' r='205' fill='url(#s)' mask='url(#m)'/>`);
}
const SUN = sun();

// ---------- ground: ridge, skyline, floor, converging grid lines (stage y 550..1000) ----------
function ground() {
  const r = rng(4242);
  let ridge = [[0, HY]], x = 0;
  while (x < W) { x += 40 + r() * 70; ridge.push([Math.min(W, x), HY - 18 - r() * (Math.abs(x - CX) < 260 ? 20 : 75)]); }
  ridge.push([W, HY]);
  const ridgeD = poly(ridge), ridgeLine = 'M' + ridge.slice(1, -1).map(p => f1(p[0]) + ' ' + f1(p[1])).join('L');
  let city = '', win = '';
  const block = (x0, x1, hmax) => {
    let xx = x0;
    while (xx < x1) {
      const w = 14 + r() * 30, h = 18 + r() * hmax * (1 - Math.abs((xx - (x0 + x1) / 2) / (x1 - x0)));
      city += `<rect x='${f1(xx)}' y='${f1(HY - h)}' width='${f1(w)}' height='${f1(h + 1)}'/>`;
      if (h > 50 && r() > .45) city += `<rect x='${f1(xx + w / 2 - 1.5)}' y='${f1(HY - h - 16)}' width='3' height='16'/>`;
      for (let wy = HY - h + 7; wy < HY - 8; wy += 9) for (let wx = xx + 4; wx < xx + w - 4; wx += 7) if (r() > .86) win += `<rect x='${f1(wx)}' y='${f1(wy)}' width='2.4' height='3'/>`;
      xx += w + 2 + r() * 6;
    }
  };
  block(250, 580, 120); block(1030, 1380, 105);
  let grid = '';
  for (let i = -24; i <= 24; i++) grid += `M${f1(CX + i * 6)} ${HY + 1}L${f1(CX + i * 165)} ${H}`;
  return svg('0 550 1600 450', `<defs>
<linearGradient id='f' x1='0' y1='${HY}' x2='0' y2='${H}' gradientUnits='userSpaceOnUse'><stop offset='0' stop-color='#2a0848'/><stop offset='.35' stop-color='#14052c'/><stop offset='1' stop-color='#070118'/></linearGradient>
<filter id='b' filterUnits='userSpaceOnUse' x='0' y='690' width='1600' height='320'><feGaussianBlur stdDeviation='4'/></filter></defs>
<path d='${ridgeD}' fill='#250844'/>
<path d='${ridgeLine}' fill='none' stroke='#ff3dae' stroke-opacity='.55' stroke-width='1.6'/>
<g fill='#10031f'>${city}</g><g fill='#ffd23f' opacity='.55'>${win}</g>
<rect y='${HY}' width='${W}' height='${H - HY}' fill='url(#f)'/>
<path d='${grid}' stroke='#ff3dae' stroke-width='5' opacity='.32' fill='none' filter='url(#b)'/>
<path d='${grid}' stroke='#ff5fc4' stroke-width='1.7' fill='none'/>`);
}
const GROUND = ground();

// ---------- horizontal grid lines: box 1600 x 414 (138% of the 300-unit floor), lines at d = 414 / 1.38^n.
// Scaling the box by 1/1.38 maps line n onto line n+1, so scaleY(1/1.38 -> 1) loops without a seam. ----------
function hlines() {
  let core = '', glow = '';
  for (let n = 0; n <= 26; n++) {
    const d = 414 / Math.pow(1.38, n), t = 0.0105 * d, g = t * 4;
    core += `<rect y='${f2(d - t / 2)}' width='1600' height='${f2(Math.max(0.05, t))}'/>`;
    glow += `<rect y='${f2(d - g / 2)}' width='1600' height='${f2(Math.max(0.1, g))}'/>`;
  }
  return svg('0 0 1600 414', `<g fill='#ff3dae' opacity='.2'>${glow}</g><g fill='#ff6cc8'>${core}</g>`);
}
const HL = hlines();

// ---------- haze over the far floor + crisp horizon line (stage y 690..1000) ----------
const HAZE = svg('0 690 1600 310', `<defs><linearGradient id='z' x1='0' y1='${HY}' x2='0' y2='${HY + 150}' gradientUnits='userSpaceOnUse'>
<stop offset='0' stop-color='#2a0848' stop-opacity='.95'/><stop offset='.12' stop-color='#26073f' stop-opacity='.7'/><stop offset='.45' stop-color='#1c0636' stop-opacity='.25'/><stop offset='1' stop-color='#14052c' stop-opacity='0'/></linearGradient></defs>
<rect y='${HY}' width='1600' height='150' fill='url(#z)'/><rect y='${HY - 1.5}' width='1600' height='3' fill='#ff8ad0'/>`);

// ---------- horizon bloom + sun reflection on the grid (stage y 600..1000) ----------
function glow() {
  let refl = '';
  for (let k = 0; k < 11; k++) {
    const y = HY + 7 + k * 9 + k * k * 1.6, h = 2.2 + k * 0.85, w = 300 * (1 - k * 0.07) * (0.92 + (k % 2) * 0.12);
    refl += `<rect x='${f1(CX - w / 2)}' y='${f2(y)}' width='${f1(w)}' height='${f2(h)}' rx='${f2(h / 2)}'/>`;
  }
  return svg('0 600 1600 400', `<defs>
<filter id='b' filterUnits='userSpaceOnUse' x='0' y='600' width='1600' height='400'><feGaussianBlur stdDeviation='9'/></filter>
<filter id='c' filterUnits='userSpaceOnUse' x='0' y='600' width='1600' height='400'><feGaussianBlur stdDeviation='1.6'/></filter>
<linearGradient id='r' x1='0' y1='${HY}' x2='0' y2='${HY + 260}' gradientUnits='userSpaceOnUse'><stop offset='0' stop-color='#ffcf7a' stop-opacity='.95'/><stop offset='.35' stop-color='#ff6a6a' stop-opacity='.6'/><stop offset='1' stop-color='#ff2e88' stop-opacity='0'/></linearGradient>
<radialGradient id='e' cx='${CX}' cy='${HY}' r='560' gradientTransform='translate(0 ${HY}) scale(1 .16) translate(0 -${HY})' gradientUnits='userSpaceOnUse'><stop offset='0' stop-color='#ff6a9a' stop-opacity='.75'/><stop offset='.5' stop-color='#ff3d8b' stop-opacity='.3'/><stop offset='1' stop-color='#ff3d8b' stop-opacity='0'/></radialGradient></defs>
<rect y='${HY - 90}' width='1600' height='180' fill='url(#e)'/>
<rect y='${HY - 7}' width='1600' height='14' fill='#ff3dae' opacity='.55' filter='url(#b)'/>
<g fill='url(#r)' filter='url(#c)'>${refl}</g>`);
}
const GLOW = glow();

const ART = { SKY0, SKY1, HALO, SUN, GROUND, HL, HAZE, GLOW, PALML, PALMR };
const enc = s => 'url("data:image/svg+xml,' + s.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, "'") + '")';
const [, , src, out, dump] = process.argv;
if (dump) { mkdirSync(dump, { recursive: true }); for (const [k, v] of Object.entries(ART)) writeFileSync(join(dump, k.toLowerCase() + '.svg'), v); }
let css = readFileSync(src, 'utf8');
for (const [k, v] of Object.entries(ART)) {
  if (!css.includes(`%%${k}%%`)) throw new Error('placeholder missing: ' + k);
  css = css.split(`%%${k}%%`).join(enc(v));
}
const left = css.match(/%%[A-Z0-9]+%%/);
if (left) throw new Error('unknown placeholder ' + left[0]);
writeFileSync(out, css);
console.log(Object.entries(ART).map(([k, v]) => k + ' ' + v.length).join(', '), '| css', css.length);
