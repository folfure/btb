/* =====================================================================
   THEMES + NEON GAUGES
   Globals: THEMES, applyTheme(name), themeCad(c), makeGauge(host, o) (replaces the template's makeGauge),
   plus helpers nmDecor(on) / nmLogoSvg(prefix, tagline) used by applyTheme for the neon background + logo.
   Styling lives in parts/z1-theme.css (.ng* classes); colours that change at ride time go through
   one CSS custom property (--gc on the gauge card), so set() only touches a handful of attributes.
   ===================================================================== */
const THEMES = {
  neon: {
    label: t('Neon Miami'),
    //   Z1 recovery  Z2 endurance Z3 tempo   Z4 threshold Z5 VO2max  Z6 anaerobic Z7 neuromuscular
    pz: ['#9a94c8', '#3d9bff', '#1ef2a6', '#ffd23f', '#ff8a2a', '#ff2e63', '#c13bff'],
    hz: ['#9a94c8', '#3d9bff', '#1ef2a6', '#ff8a2a', '#ff2e63'],
    //    <60        60-75      75-100     100-115    >115 rpm
    cad: ['#ff2e63', '#ff8a2a', '#1ef2a6', '#3d9bff', '#c13bff'],
    meta: '#0c0520',
  },
  classic: {
    label: t('Classic'),
    pz: ['#8b95a7', '#3d8bfd', '#2fbf71', '#f5c518', '#ff8a1f', '#ff3b3b', '#b04dff'],
    hz: ['#8b95a7', '#3d8bfd', '#2fbf71', '#ff8a1f', '#ff3b3b'],
    cad: ['#ff3b3b', '#ff8a1f', '#2fbf71', '#3d8bfd', '#b04dff'],
    meta: '#0a0d13',
  },
};

// Switches the look. Writes the zone colours in place (PZ/HZ objects keep their identity) and the
// --z1..--z7 variables; does not re-render anything (the caller re-renders). Returns the applied name.
function applyTheme(name) {
  const key = THEMES[name] ? name : 'neon', t = THEMES[key], root = document.documentElement;
  root.dataset.theme = key;
  if (typeof PZ !== 'undefined') PZ.forEach((z, i) => { if (t.pz[i]) z.col = t.pz[i]; });
  if (typeof HZ !== 'undefined') HZ.forEach((z, i) => { if (t.hz[i]) z.col = t.hz[i]; });
  t.pz.forEach((c, i) => root.style.setProperty('--z' + (i + 1), c));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.meta);
  if (document.body) nmDecor(key === 'neon');
  else document.addEventListener('DOMContentLoaded', () => nmDecor(document.documentElement.dataset.theme === 'neon'), { once: true });
  return key;
}

// Neon-only decoration: the animated sunset layers (#nmBg) and the cyberpunk logo in every .brand.
// Idempotent: calling it again with the same state changes nothing (the sunset does not replay);
// switching to classic removes the layers and restores the original brand markup.
function nmDecor(on) {
  let bg = document.getElementById('nmBg');
  if (on && !bg) {
    bg = document.createElement('div');
    bg.id = 'nmBg';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = '<span class="nm-stage"><span class="nm-sky0"></span><span class="nm-sky1"></span>'
      + '<span class="nm-sun"><span class="nm-halo"></span><span class="nm-disc"></span></span>'
      + '<span class="nm-ground"></span><span class="nm-floor"><span class="nm-hl"></span></span>'
      + '<span class="nm-haze"></span><span class="nm-glow"></span></span>'
      + '<span class="nm-palm nm-palm-l"></span><span class="nm-palm nm-palm-r"></span><span class="nm-shade"></span>';
    document.body.prepend(bg);
  } else if (!on && bg) bg.remove();
  document.querySelectorAll('.brand').forEach(el => {
    const swapped = !!el.querySelector('svg.nm-logo');
    if (on && !swapped) {
      if (!nmDecor.orig.has(el)) nmDecor.orig.set(el, el.innerHTML);
      const id = () => 'nmL' + (nmDecor.seq = (nmDecor.seq || 0) + 1) + '-';
      // gate: big logo with tagline; header: full logo + a wordmark-only variant that CSS shows on phones
      el.innerHTML = el.closest('.gate') ? nmLogoSvg(id(), 'gate') : nmLogoSvg(id(), 'full') + nmLogoSvg(id(), 'stack');
    } else if (!on && swapped && nmDecor.orig.has(el)) el.innerHTML = nmDecor.orig.get(el);
  });
}
nmDecor.orig = new WeakMap();

// BTB logo: "BTB" in the Cyber Brush lettering (parts/z0-btb-font.js), chrome B's and an ice-blue T, cyan/magenta
// ghost copies (chromatic aberration), scanlines and two glitch slices that the CSS flashes for a few frames
// every ~7 s, plus the "BOUGE TON BODY" tagline in the same lettering.
// p = unique id prefix, mode = 'full' (BTB + two-line tagline beside it, header), 'stack' (tagline under a smaller
// BTB, phone header) or 'gate' (big BTB with the tagline underneath, sign-in screen). The viewBox follows the ink.
function nmLogoSvg(p, mode) {
  const u = id => `url(#${p}${id})`, G = BTB_FONT.g, K = BTB_FONT.kern;
  const xT = G.B[0] + K.BT, xB2 = xT + G.T[0] + K.TB;
  const b1 = btbPath('B', 40, 0), t = btbPath('T', 40, xT), b2 = btbPath('B', 40, xB2);
  const bx = [b1.box[0], Math.min(b1.box[1], t.box[1], b2.box[1]), b2.box[2], Math.max(b1.box[3], t.box[3], b2.box[3])]; // BTB bounds
  const both = (a, b = a) => `<use href="#${p}chr" ${a}/><use href="#${p}ice" ${b}/>`;
  const at = (r, x, y) => `transform="translate(${+(x - r.box[0]).toFixed(2)} ${+(y - r.box[1]).toFixed(2)})"`; // put a path's top-left ink at (x, y)
  let tag = '', vb = [bx[0], bx[1], bx[2], bx[3]];
  if (mode === 'full') {
    const l1 = btbPath('BOUGE TON', 21), l2 = btbPath('BODY', 21), x = bx[2] + 5, h = bx[3] - bx[1];
    tag = `<g class="nm-tagl"><path d="${l1.d}" ${at(l1, x, bx[1] + 1)} fill="${u('i')}"/><path class="nm-tag2" d="${l2.d}" ${at(l2, x + 2, bx[1] + h * 0.52)}/></g>`;
    vb[2] = Math.max(x + l1.box[2] - l1.box[0], x + 2 + l2.box[2] - l2.box[0]);
  } else if (mode === 'gate' || mode === 'stack') {
    const w0 = btbPath('BOUGE TON BODY').box, size = 40 * (mode === 'gate' ? 168 : 236) / (w0[2] - w0[0]), l = btbPath('BOUGE TON BODY', size), cx = (bx[0] + bx[2]) / 2, w = l.box[2] - l.box[0];
    const gap = mode === 'gate' ? 3 : 1;
    tag = `<g class="nm-tagl"><path d="${l.d}" ${at(l, cx - w / 2, bx[3] + gap)} fill="${u('i')}"/></g>`;
    vb = [Math.min(bx[0], cx - w / 2), bx[1], Math.max(bx[2], cx + w / 2), bx[3] + gap + l.box[3] - l.box[1]];
  }
  const pad = 3, VB = [vb[0] - pad, vb[1] - pad, vb[2] - vb[0] + 2 * pad, vb[3] - vb[1] + 2 * pad].map(v => +v.toFixed(1));
  return `<svg class="nm-logo nm-${mode}" viewBox="${VB.join(' ')}" style="aspect-ratio:${VB[2]}/${VB[3]}" role="img" aria-label="BTB – Bouge Ton Body"><defs>
<linearGradient id="${p}e" x1="0" y1="${bx[1]}" x2="0" y2="${bx[3]}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset=".44" stop-color="#ffd3ec"/><stop offset=".5" stop-color="#ff3d9a"/><stop offset=".8" stop-color="#ff6a3d"/><stop offset="1" stop-color="#ffc23f"/></linearGradient>
<linearGradient id="${p}l" x1="0" y1="${bx[1]}" x2="0" y2="${bx[3]}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f2ffff"/><stop offset=".44" stop-color="#9cf7ff"/><stop offset=".5" stop-color="#1fc8ff"/><stop offset="1" stop-color="#7a5cff"/></linearGradient>
<linearGradient id="${p}i" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2ffff"/><stop offset=".55" stop-color="#9cf7ff"/><stop offset="1" stop-color="#3fd0ff"/></linearGradient>
<pattern id="${p}p" width="4" height="2.2" patternUnits="userSpaceOnUse"><rect width="4" height=".8" fill="#0c0520" fill-opacity=".34"/></pattern>
<path id="${p}chr" d="${b1.d + b2.d}"/>
<path id="${p}ice" d="${t.d}"/>
<clipPath id="${p}c"><use href="#${p}chr"/><use href="#${p}ice"/></clipPath>
<clipPath id="${p}c1"><rect x="${bx[0] - 10}" y="8" width="${bx[2] - bx[0] + 20}" height="6"/></clipPath>
<clipPath id="${p}c2"><rect x="${bx[0] - 10}" y="25" width="${bx[2] - bx[0] + 20}" height="5"/></clipPath>
</defs>
<g class="nm-ga">${both('x="-1.8" fill="#22e6ff" fill-opacity=".8"')}</g>
<g class="nm-gb">${both('x="1.8" y=".5" fill="#ff2e88" fill-opacity=".85"')}</g>
<g class="nm-wm">${both(`fill="${u('e')}"`, `fill="${u('l')}"`)}<rect x="${bx[0]}" y="${bx[1]}" width="${bx[2] - bx[0]}" height="${bx[3] - bx[1]}" fill="${u('p')}" clip-path="${u('c')}"/></g>
<g class="nm-s1" clip-path="${u('c1')}">${both('fill="#ffffff"', 'fill="#8ff6ff"')}</g>
<g class="nm-s2" clip-path="${u('c2')}">${both('fill="#22e6ff"', 'fill="#ff4fb0"')}</g>
${tag}</svg>`;
}

// Cadence colour of the active theme (same bands as the template's cadColor).
function themeCad(c) {
  const t = THEMES[document.documentElement.dataset.theme] || THEMES.classic;
  return t.cad[c < 60 ? 0 : c < 75 ? 1 : c < 100 ? 2 : c < 115 ? 3 : 4];
}

// o = { label, unit, min, max, bands: [{from, to, col}], ticks: [numbers] }
// returns { o, set(v, { target, color, zoneText, subHtml, dec }) }
function makeGauge(host, o) {
  const id = 'ng' + (makeGauge.seq = (makeGauge.seq || 0) + 1) + '-';
  const CX = 100, CY = 100, R = 80, RB = 91, A0 = 135, SW = 270;
  const span = (o.max - o.min) || 1;
  const frac = v => Math.min(1, Math.max(0, (v - o.min) / span));
  const ang = v => A0 + SW * frac(v);
  const xy = (r, a) => { const t = a * Math.PI / 180; return [(CX + r * Math.cos(t)).toFixed(2), (CY + r * Math.sin(t)).toFixed(2)]; };
  const arc = (r, a0, a1) => { const [x0, y0] = xy(r, a0), [x1, y1] = xy(r, a1); return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  const txt = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LEN = (R * SW * Math.PI / 180).toFixed(2);   // length of the value arc in user units
  const full = arc(R, A0, A0 + SW);

  // zone bands: faint tint inside the track + a crisp outer ring (with a static blurred copy for the glow)
  let tint = '', ring = '';
  for (const b of o.bands || []) {
    const a0 = ang(b.from), a1 = ang(Math.min(b.to, o.max));
    if (a1 - a0 < 0.4) continue;
    tint += `<path d="${arc(R, a0, a1)}" stroke="${txt(b.col)}"/>`;
    ring += `<path d="${arc(RB, a0 + 0.8, a1 - 0.8)}" stroke="${txt(b.col)}"/>`;
  }
  // fine ticks every 5 degrees + major ticks at o.ticks
  let mi = '', ma = '', lb = '';
  for (let a = A0; a <= A0 + SW + 0.01; a += SW / 54) { const [x0, y0] = xy(66, a), [x1, y1] = xy(70, a); mi += `M${x0} ${y0}L${x1} ${y1}`; }
  const ticks = (o.ticks || []).filter(v => isFinite(v)).map(Number).sort((a, b) => a - b);
  let lastA = Infinity;
  for (let i = ticks.length - 1; i >= 0; i--) {   // labels from the top end down; skip ones that would collide
    const v = ticks[i], a = ang(v), [x0, y0] = xy(62.5, a), [x1, y1] = xy(70, a);
    ma += `M${x0} ${y0}L${x1} ${y1}`;
    if (lastA - a < 21 && i !== 0) continue;
    if (lastA - a < 21 && i === 0) lb = lb.replace(/<text[^>]*>[^<]*<\/text>$/, '');
    const [tx, ty] = xy(52, a);
    lb += `<text class="ng-lb" x="${tx}" y="${(+ty + 4).toFixed(2)}" text-anchor="middle">${txt(+v.toFixed(2))}</text>`;
    lastA = a;
  }
  const tip = `<g class="ng-tip" style="transform-origin:${CX}px ${CY}px;transform:rotate(${A0}deg);opacity:0">
      <path class="ng-ndl" d="M${CX + R - 11} ${CY}H${CX + RB + 4}" stroke-width="1.6" stroke-linecap="round"/>
      <circle class="ng-halo" cx="${CX + R}" cy="${CY}" r="9"/><circle class="ng-core" cx="${CX + R}" cy="${CY}" r="3.6"/></g>`;
  const tgt = `<g class="ng-tgt" style="transform-origin:${CX}px ${CY}px;transform:rotate(${A0}deg);opacity:0">
      <path class="ng-tgt-o" d="M${CX + R - 7} ${CY}H${CX + R + 7}" stroke-width="5.5" stroke-linecap="round"/>
      <path class="ng-tgt-l" d="M${CX + R - 7} ${CY}H${CX + R + 7}" stroke-width="2.4" stroke-linecap="round"/>
      <path class="ng-tgt-c" d="M${CX + RB + 2.5} ${CY}L${CX + RB + 10} ${CY - 5.5}L${CX + RB + 10} ${CY + 5.5}Z"/></g>`;

  host.innerHTML = `<div class="gl">${txt(o.label)}</div>
  <svg class="ng" viewBox="-4 -3 208 189" role="img" aria-label="${txt(o.label)}">
    <defs>
      <radialGradient id="${id}f" cx="50%" cy="36%" r="64%"><stop offset="0" class="ng-f1"/><stop offset="1" class="ng-f2"/></radialGradient>
      <linearGradient id="${id}c" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity=".03"/><stop offset="1" stop-color="#fff" stop-opacity=".28"/></linearGradient>
      <filter id="${id}g" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter>
    </defs>
    <circle class="ng-face" cx="${CX}" cy="${CY}" r="72" fill="url(#${id}f)"/>
    <circle class="ng-chrome" cx="${CX}" cy="${CY}" r="72.5" fill="none" stroke="url(#${id}c)" stroke-width="1.2"/>
    <path class="ng-track" d="${full}" stroke-width="12" fill="none" stroke-linecap="round"/>
    <g class="ng-tint" stroke-width="12" fill="none">${tint}</g>
    <g class="ng-bglow" filter="url(#${id}g)" stroke-width="6" fill="none">${ring}</g>
    <g class="ng-bands" stroke-width="3.5" fill="none">${ring}</g>
    <path class="ng-mi" d="${mi}" stroke-width="1" fill="none"/>
    <path class="ng-ma" d="${ma}" stroke-width="1.8" stroke-linecap="round" fill="none"/>
    ${lb}
    <g class="ng-vg" fill="none" stroke-linecap="round" stroke-dasharray="${LEN} ${LEN}" style="stroke-dashoffset:${LEN};opacity:0">
      <path class="ng-g2" d="${full}" stroke-width="25"/>
      <path class="ng-g1" d="${full}" stroke-width="17"/>
      <path class="ng-v" d="${full}" stroke-width="11"/>
      <path class="ng-hl" d="${full}" stroke-width="2.2" transform="translate(${CX} ${CY}) scale(.955) translate(-${CX} -${CY})"/>
    </g>
    ${tgt}${tip}
    <text class="ng-vglow" x="${CX}" y="${CY + 13}" text-anchor="middle">–</text>
    <text class="ng-val num" x="${CX}" y="${CY + 13}" text-anchor="middle">–</text>
    <text class="ng-unit" x="${CX}" y="${CY + 31}" text-anchor="middle">${txt(o.unit)}</text>
    <text class="ng-zone" x="${CX}" y="${CY + 77}" text-anchor="middle"></text>
  </svg><div class="gs"></div>`;
  host.style.setProperty('--gc', '#555');
  host.classList.remove('ng-on');
  const q = s => host.querySelector(s);
  const el = { vg: q('.ng-vg'), tip: q('.ng-tip'), tgt: q('.ng-tgt'), val: q('.ng-val'), glow: q('.ng-vglow'), zone: q('.ng-zone'), sub: q('.gs') };
  const last = { ok: false, off: null, col: '#555', txt: '–', long: false, zt: '', tk: null, sub: '' };
  return {
    o,
    set(v, { target = null, color = '#888', zoneText = '', subHtml = '', dec = 0 } = {}) {
      const ok = v != null && isFinite(v);
      if (ok !== last.ok) {
        last.ok = ok;
        el.vg.style.opacity = el.tip.style.opacity = ok ? 1 : 0;
        host.classList.toggle('ng-on', ok);
      }
      if (ok) {
        const f = frac(v), off = (LEN * (1 - f)).toFixed(1);
        if (off !== last.off) { last.off = off; el.vg.style.strokeDashoffset = off; el.tip.style.transform = `rotate(${(A0 + SW * f).toFixed(2)}deg)`; }
      }
      const col = ok ? String(color || '#888') : '#555';
      if (col !== last.col) { last.col = col; host.style.setProperty('--gc', col); }
      const t = ok ? (dec ? v.toFixed(dec) : String(Math.round(v))) : '–';
      if (t !== last.txt) {
        last.txt = t; el.val.textContent = t; el.glow.textContent = t;
        const long = t.length >= 4;
        if (long !== last.long) { last.long = long; el.val.classList.toggle('ng-long', long); el.glow.classList.toggle('ng-long', long); }
      }
      const zt = ok ? String(zoneText || '') : '';
      if (zt !== last.zt) { last.zt = zt; el.zone.textContent = zt; }
      const tk = target != null && isFinite(target) ? (A0 + SW * frac(target)).toFixed(2) : null;
      if (tk !== last.tk) {
        if (tk != null) { el.tgt.style.transform = `rotate(${tk}deg)`; el.tgt.style.opacity = 1; } else el.tgt.style.opacity = 0;
        last.tk = tk;
      }
      const sh = String(subHtml ?? '');
      if (sh !== last.sub) { last.sub = sh; el.sub.innerHTML = sh; }
    },
  };
}
