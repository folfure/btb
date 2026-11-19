/* ---- ride-screen extras ----
   - from threshold (yellow) up, the zone colour glows out of the power gauge and sparks fly; from VO2max (orange)
     flames lick off the dial and embers spill over the screen; the dial shakes harder and harder up to
     neuromuscular (purple), where the colours go wild
   - a small cadence gauge in the corner of the power gauge, its target (90 rpm unless the step says otherwise) at the top
   - countdowns 15 → 0 before a hard effort ends and 10 → 0 before one starts, plus coach messages
   Called from the app: rideFxSet(p) and cadGaugeSet() on every render, rideCueTick() every tick, rideCueChange() on a new step. */

// ---------- flames, sparks and glow (a canvas over the whole ride grid) ----------
const RFX = { cv: null, cx: null, ps: [], raf: 0, on: false, p: null, ratio: 0, r: 0, last: 0, sprites: {}, accF: 0, accE: 0, shook: false };
const rfxReduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const rfxRGBA = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
// colours of the fire per zone, hottest first (a particle cools down through the list as it ages)
const RFX_PAL = {
  4: ['#fffbe0', '#ffe46b', '#f5c518'],
  5: ['#fff6c8', '#ffd34d', '#ff8a1f', '#ff4d1f', '#b8200f'],
  6: ['#fff0b0', '#ff9a2a', '#ff3b3b', '#d5133a', '#7a0a2a'],
  7: ['#ffffff', '#ff5ad8', '#b04dff', '#6a5bff', '#3df5ff', '#ffe14d', '#ff3b8d'],
};
function rfxSprite(col) { // a soft glowing blob, drawn once per colour and stamped with drawImage
  if (RFX.sprites[col]) return RFX.sprites[col];
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, rfxRGBA(col, 1)); g.addColorStop(0.3, rfxRGBA(col, 0.75)); g.addColorStop(0.65, rfxRGBA(col, 0.2)); g.addColorStop(1, rfxRGBA(col, 0));
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return (RFX.sprites[col] = c);
}
function rfxCanvas() {
  if (RFX.cv && RFX.cv.isConnected) return RFX.cv;
  const grid = $('#rideGrid'); if (!grid) return null;
  const cv = document.createElement('canvas'); cv.id = 'rideFx'; cv.setAttribute('aria-hidden', 'true');
  grid.appendChild(cv); RFX.cv = cv; RFX.cx = cv.getContext('2d'); return cv;
}
// called on every ride render with the smoothed power (null = no data)
function rideFxSet(p) {
  const cfg = S.rideFx[rideLayout()];
  RFX.on = !!(cfg && cfg.fx) && R.state === 'running' && p != null && $('#v-ride').classList.contains('on') && !rfxReduced();
  RFX.p = p; RFX.ratio = RFX.on ? p / S.ftp : 0;
  if ((RFX.on && RFX.ratio >= PZ[3].lo - 0.02) || RFX.ps.length || RFX.r > 0.5) rfxStart();
}
function rfxStart() { if (!RFX.raf && rfxCanvas()) { RFX.last = 0; RFX.raf = requestAnimationFrame(rfxFrame); } }
// where the dial sits on the canvas: the gauge SVG uses viewBox -4 -3 208 189, centre (100,100), outer ring radius 91
function rfxGeo() {
  const svg = $('#gPower svg.ng'); if (!svg || !RFX.cv) return null;
  const a = svg.getBoundingClientRect(), b = RFX.cv.getBoundingClientRect();
  if (!a.width || !a.height || !b.width) return null;
  const s = Math.min(a.width / 208, a.height / 189);
  return { s, x: a.left - b.left + (a.width - 208 * s) / 2 + 104 * s, y: a.top - b.top + (a.height - 189 * s) / 2 + 103 * s };
}
function rfxFrame(now) {
  RFX.raf = 0;
  const cv = RFX.cv, cx = RFX.cx; if (!cv || !cv.isConnected) return;
  if (!$('#v-ride').classList.contains('on')) { // left the ride screen: stop drawing until it is shown again
    RFX.on = false; RFX.r = 0; RFX.ps.length = 0; RFX.accF = RFX.accE = 0;
    const gp = $('#gPower'); if (gp && RFX.shook) { gp.style.transform = ''; RFX.shook = false; }
    return;
  }
  const dt = RFX.last ? Math.min(0.05, (now - RFX.last) / 1000) : 1 / 60; RFX.last = now;
  const box = cv.getBoundingClientRect(), dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, box.width, box.height);
  // ease towards the current intensity so the fire builds up and dies down instead of switching
  RFX.r += ((RFX.on ? RFX.ratio : 0) - RFX.r) * Math.min(1, dt * (RFX.on ? 3 : 5));
  const r = RFX.r, heat = clamp((r - PZ[3].lo) / 0.65, 0, 1), fire = clamp((r - PZ[4].lo) / (PZ[6].lo - PZ[4].lo), 0, 1);
  const zi = r >= PZ[6].lo ? 7 : r >= PZ[5].lo ? 6 : r >= PZ[4].lo ? 5 : 4, pal = RFX_PAL[zi];
  const g = rfxGeo(), gp = $('#gPower');
  const cap = box.width * box.height > 420000 ? 560 : 300;
  cx.globalCompositeOperation = 'lighter';
  if (g && heat > 0.001) {
    const s = Math.max(g.s, 1.15), col = PZ[zi - 1].col; // particle scale: never tiny, even on a small phone dial
    // the zone colour leaking out of the dial, breathing faster as it gets harder
    RFX.ph = ((RFX.ph || 0) + dt * 1000 / (260 - 150 * heat)) % (Math.PI * 2);
    const breathe = 0.5 + 0.5 * Math.sin(RFX.ph);
    const R0 = 70 * g.s, R1 = (112 + 70 * heat + 14 * breathe) * g.s + 30 * heat * (s - g.s + 1);
    const au = cx.createRadialGradient(g.x, g.y, R0, g.x, g.y, R1);
    au.addColorStop(0, rfxRGBA(col, 0)); au.addColorStop(0.18, rfxRGBA(col, 0.12 + 0.3 * heat + 0.08 * breathe)); au.addColorStop(1, rfxRGBA(col, 0));
    cx.fillStyle = au; cx.beginPath(); cx.arc(g.x, g.y, R1, 0, Math.PI * 2); cx.fill();
    // new particles: flames along the lit arc (thickest at the needle) from orange, sparks and embers from yellow
    const f = G.power && G.power.frac && RFX.p != null ? G.power.frac(RFX.p) : 0.6, aEnd = 135 + 270 * f;
    RFX.accF = fire > 0 ? RFX.accF + dt * (70 + 420 * fire) : 0;
    RFX.accE += dt * (6 + 34 * heat + 90 * fire);
    for (; RFX.accF >= 1 && RFX.ps.length < cap * 0.7; RFX.accF--) {
      const a = (Math.random() < 0.55 ? aEnd - Math.random() * 45 : 135 + Math.random() * Math.max(1, aEnd - 135)) * Math.PI / 180;
      const rr = 88 + Math.random() * 6, out = (20 + 90 * fire) * s * (0.4 + Math.random());
      RFX.ps.push({ k: 'f', x: g.x + Math.cos(a) * rr * g.s, y: g.y + Math.sin(a) * rr * g.s,
        vx: Math.cos(a) * out + (Math.random() - 0.5) * 18 * s, vy: Math.sin(a) * out - (10 + 40 * fire) * s,
        ay: -(70 + 170 * fire) * s, age: 0, life: 0.35 + Math.random() * (0.35 + 0.55 * fire), sz: (5 + 10 * fire) * s * (0.6 + Math.random() * 0.8),
        c: Math.random() < 0.3 ? 0 : 1 });
    }
    for (; RFX.accE >= 1 && RFX.ps.length < cap; RFX.accE--) {
      const a = (aEnd - Math.random() * 30 + (Math.random() < 0.2 ? -Math.random() * 180 : 0)) * Math.PI / 180, sp = (60 + 260 * heat + 260 * fire) * s * (0.4 + Math.random());
      RFX.ps.push({ k: 'e', x: g.x + Math.cos(a) * 92 * g.s, y: g.y + Math.sin(a) * 92 * g.s, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30 * s,
        ay: -(20 + 60 * fire) * s, age: 0, life: 0.6 + Math.random() * (0.8 + 1.4 * heat), sz: (1.4 + 2.2 * Math.random() + 2 * fire) * s, c: Math.floor(Math.random() * pal.length), w: Math.random() * 6 });
    }
    RFX.accF = Math.min(RFX.accF, 2); RFX.accE = Math.min(RFX.accE, 2); // full: drop the backlog instead of pouring it out later
  } else { RFX.accF = RFX.accE = 0; }
  // move and draw
  const ps = RFX.ps;
  for (let i = ps.length - 1; i >= 0; i--) {
    const q = ps[i]; q.age += dt;
    if (q.age >= q.life) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
    const k = q.age / q.life;
    q.vy += q.ay * dt; q.x += q.vx * dt; q.y += q.vy * dt;
    if (q.k === 'f') {
      q.vx *= 1 - 2.2 * dt; // flames lose their sideways push and rise
      const ci = Math.min(pal.length - 1, q.c + Math.floor(k * (pal.length - q.c))), sz = q.sz * (1 + 0.7 * k) * (1 - 0.45 * k * k);
      cx.globalAlpha = Math.pow(1 - k, 1.3) * 0.8;
      cx.drawImage(rfxSprite(zi === 7 ? pal[(q.c + Math.floor(now / 90)) % pal.length] : pal[ci]), q.x - sz, q.y - sz, sz * 2, sz * 2);
    } else {
      q.vx += Math.sin(now / 160 + q.w) * 30 * dt; // embers sway as they drift away
      const sz = q.sz * (1 - 0.5 * k);
      cx.globalAlpha = (1 - k) * 0.95;
      cx.drawImage(rfxSprite(zi === 7 ? pal[(q.c + Math.floor(now / 70)) % pal.length] : pal[q.c % pal.length]), q.x - sz * 2, q.y - sz * 2, sz * 4, sz * 4);
    }
  }
  cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over';
  // the dial shakes from orange, a little at first, violently at purple
  if (gp) {
    const amp = RFX.on && fire > 0 ? 0.5 + 6.5 * Math.pow(fire, 1.5) : 0;
    if (amp > 0.05) {
      const j = () => (Math.random() * 2 - 1) * amp;
      gp.style.transform = `translate(${j().toFixed(1)}px,${j().toFixed(1)}px) rotate(${(fire > 0.6 ? j() * 0.22 : 0).toFixed(2)}deg)`; RFX.shook = true;
    } else if (RFX.shook) { gp.style.transform = ''; RFX.shook = false; }
  }
  // keep going while the fire is wanted (it builds up from 0), still burning down, or particles are still flying
  if ((RFX.on && RFX.ratio >= PZ[3].lo - 0.05) || RFX.r > PZ[3].lo - 0.05 || ps.length) RFX.raf = requestAnimationFrame(rfxFrame);
  else { cx.clearRect(0, 0, box.width, box.height); if (gp && RFX.shook) { gp.style.transform = ''; RFX.shook = false; } }
}

// ---------- cadence mini gauge (in the corner of the power gauge) ----------
const CAD = { min: 40, max: 140, A0: 150, SW: 240, cx: 50, cy: 54, r: 36, el: null, last: '', tk: null };
function cadGaugeHtml() {
  const { A0, SW, cx, cy, r } = CAD, P = (a, rr) => { const q = a * Math.PI / 180; return [(cx + rr * Math.cos(q)).toFixed(2), (cy + rr * Math.sin(q)).toFixed(2)]; };
  const [x0, y0] = P(A0, r), [x1, y1] = P(A0 + SW, r), len = (r * SW * Math.PI / 180).toFixed(1);
  const d = `M${x0} ${y0}A${r} ${r} 0 1 1 ${x1} ${y1}`;
  return `<div class="gcad" id="gCad"><svg viewBox="0 0 100 92" role="img" aria-label="${esc(t('Cadence'))}">
    <path class="gc-tr" d="${d}"/>
    <path class="gc-v" d="${d}" stroke-dasharray="${len} ${len}" style="stroke-dashoffset:${len}"/>
    <g class="gc-tg" style="transform-origin:${cx}px ${cy}px"><path d="M${cx} ${cy - r - 7}V${cy - r + 7}"/></g><text class="gc-tt" x="${cx}" y="${cy - r - 9}" text-anchor="middle">90</text>
    <text class="gc-n num" x="${cx}" y="${cy + 8}" text-anchor="middle">–</text>
    <text class="gc-u" x="${cx}" y="${cy + 22}" text-anchor="middle">rpm</text></svg></div>`;
}
function cadGaugeSet(c, target) {
  const box = $('#gCad'); if (!box) return;
  if (CAD.el !== box) CAD.el = Object.assign(box, { _v: box.querySelector('.gc-v'), _n: box.querySelector('.gc-n'), _tg: box.querySelector('.gc-tg'), _tt: box.querySelector('.gc-tt') });
  const tc = clamp(Math.round(target || 90), CAD.min, CAD.max), ok = c != null && isFinite(c);
  const fr = v => clamp((v - CAD.min) / (CAD.max - CAD.min), 0, 1), len = CAD.r * CAD.SW * Math.PI / 180;
  if (tc !== CAD.tk) {
    CAD.tk = tc; const deg = CAD.A0 + CAD.SW * fr(tc), a = deg * Math.PI / 180, rr = CAD.r + 12, c = Math.cos(a);
    box._tg.style.transform = `rotate(${(deg - 270).toFixed(1)}deg)`;
    box._tt.setAttribute('x', (CAD.cx + rr * c).toFixed(1)); box._tt.setAttribute('y', (CAD.cy + rr * Math.sin(a) + 3).toFixed(1));
    box._tt.setAttribute('text-anchor', c < -0.3 ? 'end' : c > 0.3 ? 'start' : 'middle'); box._tt.textContent = tc;
  }
  const dlt = ok ? c - tc : 0, col = !ok ? '#555' : Math.abs(dlt) <= 5 ? '#2fbf71' : Math.abs(dlt) <= 10 ? '#f5c518' : dlt < 0 ? '#ff8a1f' : '#3d8bfd';
  const key = ok ? Math.round(c) + col : '–';
  if (key === CAD.last) return; CAD.last = key;
  box.style.setProperty('--cc', col);
  box._v.style.strokeDashoffset = ok ? (len * (1 - fr(c))).toFixed(1) : len.toFixed(1);
  box._n.textContent = ok ? String(Math.round(c)) : '–';
}

// ---------- countdowns and coach messages ----------
const CUE = { kind: '', k: 0, key: '', zeroT: 0, lastIdx: -1, coachT: 0, coachAt: 0, n: 0, hideT: 0 };
const cueHard = sg => !!sg && (sg.kind === 'free' || Math.max(sg.p0, sg.p1) * intensityK() >= PZ[3].lo);
// all-out test steps of 3 min or more are paced (same pacing guide as the interval card), shorter ones are sprints
const cuePaced = sg => !!sg && sg.kind === 'free' && sg.d >= 180;
const cuePaceW = sg => Math.round(S.ftp * (sg.est || (sg.d >= 1200 ? 1.03 : sg.d >= 480 ? 1.08 : sg.d >= 300 ? 1.15 : 1.25)));
const cueZi = sg => cuePaced(sg) ? PZ.indexOf(pZone(cuePaceW(sg) / S.ftp)) : sg.kind === 'free' ? 6 : PZ.indexOf(pZone(Math.max(sg.p0, sg.p1) * intensityK()));
const cueCol = sg => PZ[Math.max(0, cueZi(sg))].col;
const cueOn = () => { const cfg = S.rideFx[rideLayout()]; return !!(cfg && cfg.coach) && !R.freeRide && !!R.w; };
const rideCueActive = () => !!CUE.kind;
function cueEl(id, cls) {
  let e = document.getElementById(id);
  if (!e) { e = document.createElement('div'); e.id = id; e.className = cls; e.setAttribute('aria-live', 'polite'); document.body.appendChild(e); }
  return e;
}
function cueShow(kind, big, label, col, small = false) {
  const e = cueEl('rcue', 'rcue');
  const key = kind + '|' + big + '|' + label;
  if (CUE.key === key) return; CUE.key = key;
  e.innerHTML = `<b class="num${small ? ' sm' : ''}">${esc(String(big))}</b><span>${esc(label)}</span>`;
  e.style.setProperty('--cc', col); e.className = 'rcue on ' + kind;
  // sit just above the control bar (Pause, intensity…), whatever the layout, so no button is ever covered
  const bar = $('#rideMain .controls'), vh = document.documentElement.clientHeight || innerHeight;
  if (bar && bar.offsetParent) e.style.bottom = Math.max(8, Math.round(vh - bar.getBoundingClientRect().top + 10)) + 'px';
  void e.offsetWidth; e.classList.add('tick');
}
function cueHide() { CUE.kind = ''; CUE.key = ''; const e = document.getElementById('rcue'); if (e) e.className = 'rcue'; }
function coachSay(text, col, ms = 5200) {
  const host = $('#rideMain'); if (!host || !text) return;
  let e = $('#rcoach');
  if (!e) { e = document.createElement('div'); e.id = 'rcoach'; e.className = 'rcoach'; e.setAttribute('aria-live', 'polite'); host.appendChild(e); }
  e.textContent = text; e.style.setProperty('--cc', col || 'var(--accent, #ff2e88)');
  e.classList.remove('on'); void e.offsetWidth; e.classList.add('on');
  clearTimeout(CUE.coachT); CUE.coachT = setTimeout(() => e.classList.remove('on'), ms);
}
const COACH = {
  hard: () => [t('Smooth and strong.'), t('You own this interval.'), t('Breathe out, push on.'), t('Relax your shoulders, keep the power.'), t('Every pedal stroke counts.'),
    t('This is where you get stronger.'), t('Strong legs, calm mind.'), t('Hold the line!'), t('You’ve done harder than this.'), t('Stay focused, stay smooth.')],
  max: () => [t('Everything you’ve got!'), t('Empty the tank!'), t('Faster, faster!'), t('Bouge ton body!'), t('Go go go!'), t('Explode!')],
  prep: () => [t('Sit tall and take a deep breath.'), t('Drink now, the effort is coming.'), t('Loosen your legs and spin easy.'), t('Ready to fly? Get set.')],
  rest: () => [t('Well done! Spin easy and breathe.'), t('Great effort. Recover now.'), t('Nice work! Shake out your legs.')],
};
const coachPick = list => { const a = list(); return a[CUE.n++ % a.length]; };
const cueWatts = sg => cuePaced(sg) ? '≈' + cuePaceW(sg) + ' W' : sg.kind === 'free' ? 'MAX' : Math.round(sg.p0 * S.ftp * intensityK()) + ' W';
const cueSprint = sg => !!sg && sg.kind === 'free' && !cuePaced(sg);
// every tick while the ride runs
function rideCueTick() {
  if (!cueOn() || R.state !== 'running') { if (CUE.kind) cueHide(); return; }
  const seg = R.segs[R.idx], nxt = R.segs[R.idx + 1]; if (!seg) return;
  const now = performance.now(), left = seg.start + seg.d - R.t, k = Math.ceil(left - 1e-6);
  const h = cueHard(seg), hn = cueHard(nxt);
  let kind = '', N = 0;
  if (hn && (!h || cueZi(nxt) > cueZi(seg))) { kind = 'ready'; N = Math.min(10, Math.floor(seg.d) - 1); }
  else if (h && (!nxt || !hn || cueZi(nxt) < cueZi(seg))) { kind = 'end'; N = seg.d >= 30 ? 15 : Math.max(3, Math.floor(seg.d / 2)); }
  CUE.toHard = kind === 'end' && hn; // e.g. over-unders: the next step is easier but still hard
  if (kind && k >= 1 && k <= N) {
    if (CUE.kind !== kind && S.sound) beep(520, 0.18, 0.18); // the countdown starts
    CUE.kind = kind; CUE.k = k; CUE.zeroT = 0;
    if (kind === 'end') cueShow('end', k, !nxt ? t('Finish strong!') : CUE.toHard && k <= 5 ? t('Settle at {w}', { w: cueWatts(nxt) }) : k > 5 ? t('Hold on!') : t('Almost there!'), cueCol(seg));
    else cueShow('ready', k, cueSprint(nxt) ? t('Get ready: sprint!') : t('Get ready: {w}', { w: cueWatts(nxt) }), cueCol(nxt));
  } else if (CUE.kind && !CUE.zeroT) cueHide();
  else if (CUE.zeroT && now > CUE.zeroT) { CUE.zeroT = 0; cueHide(); }
  // coach messages: when a step starts, then every ~25 s during a hard step
  if (R.idx !== CUE.lastIdx) {
    const prev = R.segs[CUE.lastIdx]; CUE.lastIdx = R.idx;
    const closing = CUE.kind === 'zero'; // the countdown just ended with GO / 0 and its own words
    if (h) CUE.coachAt = now + (closing ? 3500 : 1600);
    else if (closing) CUE.coachAt = 0;
    else if (prev && cueHard(prev) && R.idx === R.segs.indexOf(prev) + 1) { coachSay(coachPick(COACH.rest), cueCol(prev)); CUE.coachAt = 0; }
    else if (hn && seg.d >= 25) { coachSay(t('Next: {w} for {d}.', { w: cueWatts(nxt), d: fmtSegDur(nxt.d) }) + ' ' + coachPick(COACH.prep), cueCol(nxt), 7000); CUE.coachAt = 0; }
    else CUE.coachAt = 0;
  } else if (h && CUE.coachAt && now >= CUE.coachAt && !CUE.kind && left > 8) {
    coachSay(cuePaced(seg) ? t('Pace it evenly: about {w}.', { w: cueWatts(seg) }) + ' ' + coachPick(COACH.hard) : coachPick(cueZi(seg) >= 5 ? COACH.max : COACH.hard), cueCol(seg));
    CUE.coachAt = left > 40 ? now + 25000 : 0;
  }
}
// a new step started: close the countdown with 0 / GO
function rideCueChange() {
  if (!cueOn() || !CUE.kind) return;
  const prev = R.segs[R.idx - 1], seg = R.segs[R.idx];
  if (CUE.kind === 'ready' && seg) { cueShow('go', t('GO!'), cueSprint(seg) ? t('Go go go!') : t('{w} now!', { w: cueWatts(seg) }), cueCol(seg), true); CUE.coachAt = performance.now() + 4000; }
  else if (CUE.kind === 'end' && prev) cueShow('zero', 0, CUE.toHard && seg ? t('{w} now!', { w: cueWatts(seg) }) : t('Done! Spin easy and breathe.'), cueCol(CUE.toHard && seg ? seg : prev));
  CUE.kind = 'zero'; CUE.zeroT = performance.now() + 1600;
}
function rideCueReset() { cueHide(); CUE.zeroT = 0; CUE.lastIdx = -1; CUE.coachAt = 0; const c = $('#rcoach'); if (c) c.classList.remove('on'); }
