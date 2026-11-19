// Builds dist/theme-demo.html: template CSS + markup, theme CSS, gauges JS and a fake ride.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const repo = 'C:/Users/ofeys/Documents/hometrainer';
const tpl = readFileSync(repo + '/src/app.template.html', 'utf8');
const css = tpl.slice(tpl.indexOf('<style>') + 7, tpl.indexOf('</style>'));
const body = tpl.slice(tpl.indexOf('<body>') + 6, tpl.indexOf('<script'));
const theme = readFileSync(repo + '/src/parts/z1-theme.css', 'utf8');
const gauges = readFileSync(repo + '/src/parts/z2-gauges.js', 'utf8');
const demo = String.raw`
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const S = { ftp: 250, weight: 75, maxHr: 185 };
const PZ = [
  { n: 'Z1', name: 'Active recovery', lo: 0, hi: 0.55, col: '#8b95a7' }, { n: 'Z2', name: 'Endurance', lo: 0.55, hi: 0.75, col: '#3d8bfd' },
  { n: 'Z3', name: 'Tempo', lo: 0.75, hi: 0.90, col: '#2fbf71' }, { n: 'Z4', name: 'Threshold', lo: 0.90, hi: 1.05, col: '#f5c518' },
  { n: 'Z5', name: 'VO2max', lo: 1.05, hi: 1.20, col: '#ff8a1f' }, { n: 'Z6', name: 'Anaerobic', lo: 1.20, hi: 1.50, col: '#ff3b3b' },
  { n: 'Z7', name: 'Neuromuscular', lo: 1.50, hi: 9, col: '#b04dff' }];
const HZ = [
  { n: 'Z1', name: 'Recovery', lo: 0, hi: 0.60, col: '#8b95a7' }, { n: 'Z2', name: 'Endurance', lo: 0.60, hi: 0.70, col: '#3d8bfd' },
  { n: 'Z3', name: 'Aerobic', lo: 0.70, hi: 0.80, col: '#2fbf71' }, { n: 'Z4', name: 'Threshold', lo: 0.80, hi: 0.90, col: '#ff8a1f' },
  { n: 'Z5', name: 'Maximum', lo: 0.90, hi: 9, col: '#ff3b3b' }];
const pZone = f => PZ.find(z => f < z.hi - 1e-9) || PZ[6];
const hZone = f => HZ.find(z => f < z.hi - 1e-9) || HZ[4];
` + gauges + String.raw`
let G = {};
function buildGauges() {
  const ftp = S.ftp, maxP = Math.ceil(ftp * 1.6 / 50) * 50, cad = (THEMES[document.documentElement.dataset.theme] || THEMES.classic).cad;
  G.power = makeGauge($('#gPower'), { label: 'Power', unit: 'watts', min: 0, max: maxP, bands: PZ.map(z => ({ from: z.lo * ftp, to: Math.min(z.hi, 9) * ftp, col: z.col })), ticks: [0, Math.round(ftp * 0.55), Math.round(ftp * 0.9), ftp, Math.round(ftp * 1.2), maxP] });
  const wk = ftp / S.weight, maxW = Math.ceil(wk * 1.6 * 2) / 2;
  G.wkg = makeGauge($('#gWkg'), { label: 'W/kg', unit: 'W/kg', min: 0, max: maxW, bands: PZ.map(z => ({ from: z.lo * wk, to: Math.min(z.hi, 9) * wk, col: z.col })), ticks: [0, +(wk * 0.75).toFixed(1), +wk.toFixed(1), maxW] });
  G.cad = makeGauge($('#gCad'), { label: 'Cadence', unit: 'rpm', min: 0, max: 140, bands: [[0, 60], [60, 75], [75, 100], [100, 115], [115, 140]].map((b, i) => ({ from: b[0], to: b[1], col: cad[i] })), ticks: [0, 60, 90, 120, 140] });
  const hrMin = 40, mx = S.maxHr;
  G.hr = makeGauge($('#gHr'), { label: 'Heart rate', unit: 'bpm', min: hrMin, max: mx + 5, bands: HZ.map(z => ({ from: Math.max(hrMin, z.lo * mx), to: Math.min(z.hi, 1.03) * mx, col: z.col })), ticks: [hrMin, Math.round(mx * 0.7), Math.round(mx * 0.9), mx] });
}
const TABS = ['workouts', 'plans', 'ride', 'build', 'history', 'settings'];
function go(id) {
  document.body.classList.toggle('riding', id === 'ride');
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + id));
  $$('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
}
const qs = new URLSearchParams(location.search);
applyTheme(qs.get('theme') || 'neon');
$('#tabs').innerHTML = TABS.map(t => '<button data-tab="' + t + '"><span>' + t[0].toUpperCase() + t.slice(1) + '</span></button>').join('');
$('#btabs').innerHTML = TABS.map(t => '<button data-tab="' + t + '"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>' + t[0].toUpperCase() + t.slice(1) + '</span></button>').join('');
$$('[data-tab]').forEach(b => b.onclick = () => go(b.dataset.tab));
const tb = document.createElement('button'); tb.className = 'pill'; tb.id = 'themeBtn'; tb.textContent = 'Theme';
tb.onclick = () => { applyTheme(document.documentElement.dataset.theme === 'neon' ? 'classic' : 'neon'); buildGauges(); };
tb.style.cssText = 'position:fixed;right:10px;bottom:90px;z-index:50'; document.body.appendChild(tb);
$('#pillTrainer').classList.add('ok'); $('#pillHr').classList.add('ok');
// library
const prof = cols => '<svg viewBox="0 0 300 54" preserveAspectRatio="none">' + cols.map((c, i) => '<rect x="' + i * 30 + '" y="' + (54 - c[0]) + '" width="29" height="' + c[0] + '" fill="' + PZ[c[1]].col + '"/>').join('') + '</svg>';
$('#cats').innerHTML = '<button class="chip on">All <span class="dim">212</span></button><button class="chip" style="color:#3d8bfd"><i style="background:#3d8bfd"></i>Endurance <span class="dim">40</span></button><button class="chip on" style="color:#f5c518"><i style="background:#f5c518"></i>Threshold <span class="dim">22</span></button><button class="chip" style="color:#b04dff"><i style="background:#b04dff"></i>Sprint <span class="dim">9</span></button>';
$('#libCount').textContent = '212 workouts · scaled to FTP 250 W (3.33 W/kg)';
$('#lib').innerHTML = [['2x20 @ FTP', 'Threshold', '#f5c518'], ['Miami Nights 30/30', 'VO2max', '#ff8a1f'], ['Ocean Drive Endurance', 'Endurance', '#3d8bfd']].map(([n, c, col]) =>
  '<div class="card wcard"><div class="top"><h3>' + n + '</h3><span class="badge" style="color:' + col + '">' + c + '</span></div><div class="prof">' + prof([[14, 1], [20, 2], [44, 3], [10, 0], [44, 3], [10, 0], [48, 4], [12, 0], [30, 2], [12, 0]]) + '</div><div class="kv num"><span><b>1h05</b></span><span>TSS <b>78</b></span><span>IF <b>0.85</b></span><span>avg <b>212 W</b></span></div><div class="desc">Classic threshold builder with long steady efforts at FTP.</div></div>').join('');
$('#hist').innerHTML = '<div class="card hist"><div><b>2x20 @ FTP</b> <span class="dim" style="font-size:13px">19/11/2026, 18:02</span><div class="kv num" style="margin-top:3px"><span><b>1:05:12</b></span><span>avg <b>212 W</b></span><span>NP <b>231 W</b></span><span>TSS <b>78</b></span><span>IF <b>0.92</b></span></div></div><div class="row"><button class="btn sm">TCX</button><button class="btn sm danger">✕</button></div><div class="mini">' + prof([[14, 1], [20, 2], [44, 3], [10, 0], [44, 3], [10, 0], [48, 4], [12, 0], [30, 2], [12, 0]]) + '</div></div>';
$('#zoneTable').innerHTML = PZ.map(z => '<div style="background:' + z.col + '">' + z.n + '<span>' + z.name + '</span></div>').join('');
$('#rideEmpty').classList.add('hidden'); $('#rideMain').classList.remove('hidden');
$('#rWname').textContent = 'Miami Nights 30/30'; $('#rState').textContent = 'Riding'; $('#rState').className = 'state-tag run';
$('#cStart').textContent = '❚❚ Pause'; $('#cStart').className = 'btn lg'; $('#cErg').className = 'btn sm primary';
$('#rideConnect').classList.add('hidden');
[['#sAvg', '212<small>W</small>'], ['#sNp', '231<small>W</small>'], ['#sTss', '41<small>· 0.92</small>'], ['#sKj', '512<small>kJ</small>'], ['#sIavg', '262<small>W</small>'], ['#sHr', '148<small>bpm</small>'], ['#sCad', '91<small>rpm</small>'], ['#sDist', '14.2<small>km</small>']].forEach(([s, h]) => $(s).innerHTML = h);
buildGauges();
go(qs.get('view') || 'ride');
if (qs.get('gate')) { $('#gate').classList.remove('hidden'); document.body.classList.add('gated'); $('#gateEmailF').classList.remove('hidden'); $('#gateMsg').textContent = 'Enter the email address you were invited with.'; }
const plan = [[300, 0.6, 'Warm-up'], [30, 1.3, 'Sprint'], [60, 1.05, 'Over'], [60, 0.95, 'Under'], [20, 1.8, 'Kick']];
let t = 0, p = 150, hr = 120, c = 88;
function tick() {
  t += 1; const seg = plan[Math.floor(t / 12) % plan.length]; const tgt = Math.round(seg[1] * S.ftp);
  p += (tgt - p) * 0.35 + (Math.random() - 0.5) * 18; hr += ((90 + seg[1] * 75) - hr) * 0.05; c += (90 + (seg[1] > 1.4 ? 22 : 0) - c) * 0.3 + (Math.random() - 0.5) * 3;
  const pz = pZone(p / S.ftp), hz = hZone(hr / S.maxHr), col = pZone(seg[1]).col;
  G.power.set(p, { target: tgt, color: pz.col, zoneText: pz.n + ' · ' + pz.name.toUpperCase(), subHtml: '<b>' + Math.round(p / S.ftp * 100) + '%</b> FTP · Δ <b>' + Math.round(p - tgt) + '</b> W' });
  G.wkg.set(p / S.weight, { target: tgt / S.weight, color: pz.col, zoneText: pz.n, dec: 1, subHtml: 'FTP <b>3.33</b> W/kg · 75 kg' });
  G.cad.set(c, { target: 90, color: themeCad(c), zoneText: c < 60 ? 'GRIND' : c < 75 ? 'LOW' : c < 100 ? 'SWEET' : c < 115 ? 'HIGH' : 'SPIN', subHtml: 'target <b>90</b> rpm' });
  G.hr.set(hr, { color: hz.col, zoneText: hz.n + ' · ' + hz.name.toUpperCase(), subHtml: '<b>' + Math.round(hr / S.maxHr * 100) + '%</b> of max 185' });
  $('#rIname').textContent = seg[2] + '  ·  2/6'; $('#rTgt').textContent = tgt; $('#rTgt').style.color = col; $('#rTgtPct').textContent = Math.round(seg[1] * 100) + '% FTP'; $('#rTgtPct').style.color = col;
  $('#rTgtCad').textContent = '@ 90 rpm'; $('#rLeft').innerHTML = '0:' + String(48 - (t % 12) * 4).padStart(2, '0') + '<small>left in interval</small>';
  $('#rProg').style.width = ((t % 12) / 12 * 100) + '%'; $('#rProg').style.background = col; $('#ivlStripe').style.background = col;
  $('#rEl').textContent = '24:' + String(t % 60).padStart(2, '0'); $('#rRem').textContent = '41:10'; $('#rIdx').textContent = '7 / 31';
  $('#rNext').innerHTML = 'Next: <span><b style="color:' + PZ[5].col + '">325 W</b> 30s</span> &nbsp;·&nbsp; <span style="opacity:.7"><b style="color:' + PZ[1].col + '">150 W</b> 30s</span>';
}
if (qs.get('still')) { for (let i = 0; i < 20; i++) tick(); } else { tick(); setInterval(tick, 250); }
// chart preview with the theme stream colours
(function () {
  const cv = $('#chart'), r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d;
  const x = cv.getContext('2d'); x.scale(d, d); const cs = getComputedStyle(document.documentElement), W = r.width, H = r.height;
  for (let i = 0; i < 60; i++) { const f = plan[i % 5][1]; x.fillStyle = pZone(f).col; x.globalAlpha = .55; x.fillRect(30 + i * (W - 34) / 60, H - 16 - f * 70, (W - 34) / 60 - 1, f * 70); }
  x.globalAlpha = 1;
  [['--c-power', 0.9, 60], ['--c-hr', 0.6, 30], ['--c-cad', 0.5, 15]].forEach(([v, b, a]) => { x.strokeStyle = cs.getPropertyValue(v).trim(); x.lineWidth = 1.6; x.beginPath(); for (let i = 0; i < W - 34; i += 3) x.lineTo(30 + i, H - 16 - (b + Math.sin(i / 23) * .2 + Math.random() * .05) * a); x.stroke(); });
})();
`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0d13"><title>BTB theme demo</title><style>${css.replace('/*__PARTS_CSS__*/', theme)}</style></head><body>${body}<script>'use strict';${demo}</script></body></html>`;
mkdirSync(repo + '/dist', { recursive: true });
writeFileSync(repo + '/dist/theme-demo.html', html);
console.log('demo', html.length);
