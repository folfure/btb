/* =====================================================================
   THEMES + NEON GAUGES
   Globals: THEMES, applyTheme(name), themeCad(c), makeGauge(host, o) (replaces the template's makeGauge).
   Styling lives in parts/z1-theme.css (.ng* classes); colours that change at ride time go through
   one CSS custom property (--gc on the gauge card), so set() only touches a handful of attributes.
   ===================================================================== */
const THEMES = {
  neon: {
    label: 'Neon Miami',
    //   Z1 recovery  Z2 endurance Z3 tempo   Z4 threshold Z5 VO2max  Z6 anaerobic Z7 neuromuscular
    pz: ['#9a94c8', '#3d9bff', '#1ef2a6', '#ffd23f', '#ff8a2a', '#ff2e63', '#c13bff'],
    hz: ['#9a94c8', '#3d9bff', '#1ef2a6', '#ff8a2a', '#ff2e63'],
    //    <60        60-75      75-100     100-115    >115 rpm
    cad: ['#ff2e63', '#ff8a2a', '#1ef2a6', '#3d9bff', '#c13bff'],
    meta: '#0c0520',
  },
  classic: {
    label: 'Classic',
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
  return key;
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
