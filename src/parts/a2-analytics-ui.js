// ERGlab analytics UI (intervals.icu-style): the Progress tab (renderProgress) and the per-ride analysis overlay
// (openRideAnalysis). Hand-written canvas charts (devicePixelRatio aware, pointer events, tooltips), no libraries.
// Needs AN (a1-analysis.js) and the app helpers: esc, fmtTime, load, store, toast, S, PZ, HZ, rideStreams,
// saveSettings/afterSettings. Globals: renderProgress, openRideAnalysis, ANUI (everything else lives inside ANUI).

function renderProgress() { ANUI.renderProgress(); }
async function openRideAnalysis(rideId) { return ANUI.openRide(rideId); }

const ANUI = (() => {
  const DAY = 864e5;
  const KEY_DUR = [5, 15, 30, 60, 300, 600, 1200, 3600]; // AN.MMP_DUR has no 8 min (480 s): 10 min instead
  const CURVE_TICKS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
  const prefs = Object.assign({ fit: 90, wk: 12, per: 90, zper: 42, unit: 'w', sm: 3 }, load('erglab.anui', {}));
  prefs.ser = Object.assign({ p: true, t: true, hr: true, c: true, wb: false }, prefs.ser || {});
  const savePrefs = () => store('erglab.anui', prefs);
  const wprimeOf = () => (typeof S !== 'undefined' && S.wprime > 0 ? +S.wprime : 20000);

  /* ---------- formatting ---------- */
  const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
  const fx = (v, d = 0) => v == null || !isFinite(v) ? '–' : (+v).toFixed(d);
  const sgn = (v, d = 1) => { if (v == null || !isFinite(v)) return '–'; const s = Math.abs(v).toFixed(d); return (+s === 0 ? '' : v > 0 ? '+' : '−') + s; };
  function durLbl(s) {
    s = Math.round(s);
    if (s < 60) return s + 's';
    if (s < 3600) { const m = Math.floor(s / 60), x = s % 60; return x ? `${m}m${x}s` : `${m}m`; }
    const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }
  const hrs = s => s >= 3600 ? (s / 3600).toFixed(1) + 'h' : Math.round(s / 60) + 'm';
  const hm = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`; };
  const isoAgo = d => new Date(Date.now() - d * DAY).toISOString();
  const keyDate = k => { const a = String(k).split('-'); return new Date(+a[0], a[1] - 1, +a[2]); };
  const fD = (d, o) => d.toLocaleDateString(undefined, o || { day: 'numeric', month: 'short' });
  const fDay = iso => fD(new Date(iso), { day: 'numeric', month: 'short', year: '2-digit' });
  const fLong = iso => { const d = new Date(iso); return fD(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  const FORM = [
    { lo: 25, name: 'Transition', v: '--an-f1' },
    { lo: 5, name: 'Fresh', v: '--an-f2' },
    { lo: -10, name: 'Grey zone', v: '--an-f3' },
    { lo: -30, name: 'Optimal', v: '--an-f4' },
    { lo: -Infinity, name: 'High risk', v: '--an-f5' },
  ];
  const formIdx = t => { for (let i = 0; i < FORM.length; i++) if (t > FORM[i].lo) return i; return 4; };
  const pzIdx = f => { for (let i = 0; i < PZ.length; i++) if (f < PZ[i].hi - 1e-9) return i; return PZ.length - 1; };

  /* ---------- colours (canvas needs concrete colours: resolve CSS variables at render time) ---------- */
  let probe = null; const rgbaMemo = new Map();
  function rgba(c, a) {
    const k = c + '|' + a; let v = rgbaMemo.get(k); if (v) return v;
    probe = probe || document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000'; probe.fillStyle = c; const s = String(probe.fillStyle);
    if (s[0] === '#') { const n = parseInt(s.slice(1, 7), 16); v = `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
    else { const m = s.match(/[\d.]+/g) || [0, 0, 0]; v = `rgba(${m[0]},${m[1]},${m[2]},${+(a * (m[3] != null ? +m[3] : 1)).toFixed(3)})`; }
    if (rgbaMemo.size > 800) rgbaMemo.clear(); rgbaMemo.set(k, v); return v;
  }
  function resolveCol(c, node, depth = 0) {
    c = String(c || '').trim();
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(c);
    if (!m || depth > 6) return c || '#888';
    const v = getComputedStyle(node || document.documentElement).getPropertyValue(m[1]).trim();
    return resolveCol(v || m[2] || '#888', node, depth + 1);
  }
  function palette(node) {
    const cs = getComputedStyle(node);
    const g = (n, fb) => resolveCol(cs.getPropertyValue(n).trim() || fb, node);
    return {
      power: g('--an-power', '#ff9f2e'), curve: g('--an-curve', '#ff8a1f'), hr: g('--an-hr', '#ff4d6d'), cad: g('--an-cad', '#4cc2ff'), tgt: g('--an-tgt', '#e9edf5'),
      ctl: g('--an-ctl', '#4cc2ff'), atl: g('--an-atl', '#d65cff'), wbal: g('--an-wbal', '#8f7bff'), cmp: g('--an-cmp', '#8c96ab'),
      text: g('--text', '#e9edf5'), muted: g('--muted', '#8c96ab'), dim: g('--dim', '#5d667a'), line: g('--line', '#242d40'), line2: g('--line2', '#2f3a52'),
      panel: g('--panel', '#121823'), accent: g('--accent', '#4cc2ff'), ok: g('--ok', '#2fbf71'), warn: g('--warn', '#f5c518'), bad: g('--bad', '#ff4d4d'),
      f: FORM.map(f => g(f.v, '#888')),
      pz: PZ.map(z => resolveCol(z.col, node)), hz: HZ.map(z => resolveCol(z.col, node)),
      font: cs.fontFamily || 'system-ui, sans-serif',
    };
  }

  /* ---------- canvas chart core ---------- */
  const live = new Set();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(ents => {
    for (const e of ents) { const ch = e.target._anx; if (!ch) continue; clearTimeout(ch.rt); if (ch.lastW < 0) requestAnimationFrame(ch.fit); else ch.rt = setTimeout(ch.fit, 120); }
  }) : null;
  let winT = 0;
  const sweep = () => { for (const ch of live) if (!ch.wrap.isConnected) { live.delete(ch); if (ro) ro.unobserve(ch.wrap); } };
  window.addEventListener('resize', () => { clearTimeout(winT); winT = setTimeout(() => { sweep(); live.forEach(ch => ch.fit()); }, 150); });
  document.addEventListener('pointerdown', e => { for (const ch of live) if (ch.hovering && !ch.wrap.contains(e.target)) ch.unhover(); }, true);

  // o: { height: number | w => number, draw(ch), hover(ch, x, y) -> tooltip html | null, under(ch), down/move/up/tap/dbl/cancel }
  function mkChart(host, o) {
    sweep();
    const wrap = document.createElement('div'); wrap.className = 'anx-cv';
    const c = document.createElement('canvas'), oc = document.createElement('canvas'); oc.className = 'anx-ovc';
    const tip = document.createElement('div'); tip.className = 'anx-tip'; tip.setAttribute('aria-hidden', 'true');
    wrap.append(c, oc, tip); host.replaceChildren(wrap);
    const ch = { wrap, c, oc, tip, ctx: c.getContext('2d'), octx: oc.getContext('2d'), w: 0, h: 0, lastW: -1, o, hovering: false, ptype: 'mouse', hx: null, hy: null };
    wrap._anx = ch;
    ch.font = (sz, wt) => `${wt || 600} ${sz}px ${ch.P.font}`;
    ch.render = () => {
      const w = Math.floor(wrap.clientWidth); if (!w) { ch.lastW = -1; return; }
      const h = Math.round(typeof o.height === 'function' ? o.height(w) : o.height);
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      for (const cv of [c, oc]) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
      wrap.style.height = h + 'px';
      ch.w = w; ch.h = h; ch.lastW = w; ch.mob = w < 560;
      ch.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ch.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ch.P = palette(wrap);
      ch.ctx.clearRect(0, 0, w, h);
      ch.ctx.font = ch.font(10.5); ch.ctx.textBaseline = 'middle';
      o.draw(ch);
      ch.redrawOv();
    };
    ch.fit = () => { const w = Math.floor(wrap.clientWidth); if (w && w !== ch.lastW) ch.render(); };
    const hover = (x, y) => {
      if (!ch.w) return;
      ch.octx.clearRect(0, 0, ch.w, ch.h); if (o.under) o.under(ch);
      const html = o.hover ? o.hover(ch, x, y) : null;
      if (html) { ch.hovering = true; ch.showTip(html, x, y); } else { ch.hovering = false; tip.style.display = 'none'; }
    };
    ch.redrawOv = () => {
      if (!ch.w) return;
      if (ch.hovering && ch.hx != null) hover(ch.hx, ch.hy);
      else { ch.octx.clearRect(0, 0, ch.w, ch.h); if (o.under) o.under(ch); }
    };
    ch.unhover = () => { ch.hovering = false; ch.hx = null; tip.style.display = 'none'; ch.redrawOv(); };
    ch.showTip = (html, x, y) => {
      if (tip._h !== html) { tip.innerHTML = html; tip._h = html; }
      tip.style.display = 'block';
      const tw = tip.offsetWidth, th = tip.offsetHeight, touch = ch.ptype !== 'mouse', W = ch.w;
      let left, top;
      if (touch) { // keep it above the finger
        top = y - th - 30; left = clampN(x - tw / 2, 0, Math.max(0, W - tw));
        if (top < 0) { top = clampN(y - th / 2, 0, Math.max(0, ch.h - th)); left = x + 30 + tw <= W ? x + 30 : Math.max(0, x - 30 - tw); }
      } else {
        left = x + 16; if (left + tw > W) left = x - 16 - tw; if (left < 0) left = clampN(x - tw / 2, 0, Math.max(0, W - tw));
        top = clampN(y - th / 2, 0, Math.max(0, ch.h - th));
      }
      tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
    };
    const pos = e => { const r = oc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    oc.addEventListener('pointerdown', e => {
      ch.ptype = e.pointerType || 'mouse'; const [x, y] = pos(e); ch.hx = x; ch.hy = y; ch.down = { x, y };
      if (o.down) o.down(ch, x, y, e); hover(x, y);
    });
    oc.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') ch.ptype = 'mouse';
      const [x, y] = pos(e); ch.hx = x; ch.hy = y; if (o.move) o.move(ch, x, y, e); hover(x, y);
    });
    oc.addEventListener('pointerup', e => {
      const [x, y] = pos(e), d = ch.down; ch.down = null;
      const tap = !!d && Math.hypot(x - d.x, y - d.y) < 8;
      if (o.up) o.up(ch, x, y, e, tap); if (tap && o.tap) o.tap(ch, x, y, e);
    });
    oc.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !ch.down) ch.unhover(); });
    oc.addEventListener('pointercancel', () => { ch.down = null; if (o.cancel) o.cancel(ch); ch.unhover(); });
    oc.addEventListener('dblclick', e => { if (o.dbl) o.dbl(ch, e); });
    oc.addEventListener('contextmenu', e => { if (ch.ptype !== 'mouse') e.preventDefault(); });
    live.add(ch); if (ro) ro.observe(wrap);
    ch.render();
    return ch;
  }

  // "nice" axis with exactly n steps: top = n * step >= max
  function niceAxis(max, n) {
    const raw = Math.max(max, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    return { step, top: step * n, n };
  }
  // free step count: smallest nice step for ~n steps, top rounded up to a whole step
  function niceAuto(max, n) {
    const raw = Math.max(max, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p, k = Math.max(1, Math.ceil(max / step - 1e-9));
    return { step, top: step * k, n: k };
  }
  function topRounded(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h); ctx.closePath();
  }
  function rounded(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hline(ctx, x0, x1, y, col, dash) {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1; if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5); ctx.stroke(); ctx.restore();
  }
  function vline(ctx, x, y0, y1, col, dash) {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1; if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, y0); ctx.lineTo(Math.round(x) + .5, y1); ctx.stroke(); ctx.restore();
  }
  function text(ctx, s, x, y, col, align, base) { ctx.fillStyle = col; ctx.textAlign = align || 'left'; ctx.textBaseline = base || 'middle'; ctx.fillText(s, x, y); }
  function dot(ctx, x, y, col, ring, r = 4) {
    ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 7); ctx.fillStyle = ring; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = col; ctx.fill();
  }
  const trow = (col, k, v, extra) => `<div class="r">${col ? `<i style="background:${col}"></i>` : '<i class="e"></i>'}<span>${k}</span><b>${v}</b>${extra || ''}</div>`;

  /* ---------- shared HTML bits ---------- */
  const seg = (key, opts, cur) => `<div class="anx-seg" role="group" data-k="${key}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  function bindSeg(root, key, fn) {
    root.querySelectorAll(`.anx-seg[data-k="${key}"] button`).forEach(b => b.addEventListener('click', () => {
      b.parentNode.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); fn(b.dataset.v);
    }));
  }
  function zoneBars(secs, zones, kind, ref, one) {
    const tot = (secs || []).reduce((a, b) => a + (+b || 0), 0);
    if (!tot) return `<div class="anx-none">No ${kind === 'hr' ? 'heart-rate' : 'power'} data${one ? '' : ' in this period'}.</div>`;
    const mx = Math.max(...secs);
    const rng = (z, i) => {
      if (!ref) return '';
      const lo = Math.round(z.lo * ref), hi = Math.round(z.hi * ref), u = kind === 'hr' ? 'bpm' : 'W';
      return i === zones.length - 1 ? `&gt; ${lo} ${u}` : i === 0 ? `&lt; ${hi} ${u}` : `${lo}–${hi} ${u}`;
    };
    return `<div class="anx-zstack">${zones.map((z, i) => secs[i] > 0 ? `<i style="width:${(secs[i] / tot * 100).toFixed(2)}%;background:${z.col}" title="${esc(z.n)} ${Math.round(secs[i] / tot * 100)}%"></i>` : '').join('')}</div>
      <div class="anx-zrows">${zones.map((z, i) => { const pc = secs[i] / tot * 100; return `<div class="anx-zrow${secs[i] ? '' : ' nil'}">
        <span class="zn" style="color:${z.col}">${esc(z.n)}</span><span class="zl">${esc(z.name)}<em>${rng(z, i)}</em></span>
        <span class="zm"><i style="width:${mx ? (secs[i] / mx * 100).toFixed(1) : 0}%;background:${z.col}"></i></span>
        <span class="zt num">${secs[i] ? fmtTime(secs[i]) : '–'}</span><span class="zp num">${pc >= 0.5 ? Math.round(pc) + '%' : secs[i] ? '<1%' : ''}</span></div>`; }).join('')}</div>`;
  }
  function polarization(tiz) {
    const t = tiz.reduce((a, b) => a + b, 0); if (!t) return '';
    const low = (tiz[0] + tiz[1]) / t * 100, mid = (tiz[2] + tiz[3]) / t * 100, high = (tiz[4] + tiz[5] + tiz[6]) / t * 100;
    const kind = low >= 70 && high > mid ? ['Polarized', 'Mostly easy with hard efforts on top, little in the middle.']
      : low >= mid && mid >= high ? ['Pyramidal', 'Lots of easy riding, less tempo/threshold, least above threshold.']
        : mid > low ? ['Threshold-heavy', 'More time at tempo/threshold than easy: watch fatigue.'] : ['Mixed', 'An even spread across intensities.'];
    const part = (lbl, v, col) => `<div class="pp"><span class="k">${lbl}</span><b class="num">${Math.round(v)}%</b><span class="pbar"><i style="width:${v.toFixed(1)}%;background:${col}"></i></span></div>`;
    return `<div class="anx-polar"><div class="ph"><span class="anx-pill">${kind[0]}</span><span class="muted">${kind[1]}</span></div>
      <div class="pg">${part('Low · Z1–2', low, PZ[1].col)}${part('Mid · Z3–4', mid, PZ[3].col)}${part('High · Z5+', high, PZ[5].col)}</div></div>`;
  }

  /* ======================================================================
     PROGRESS TAB
     ====================================================================== */
  let PG = null; // state of the rendered progress page

  function renderProgressImpl() {
    const root = document.getElementById('progress'); if (!root) return;
    root.classList.add('anx');
    if (!root._anxBound) {
      root._anxBound = true;
      root.addEventListener('click', e => { const t = e.target.closest('[data-ride]'); if (t && t.dataset.ride && root.contains(t)) openRideAnalysis(t.dataset.ride); });
    }
    if (typeof AN === 'undefined') { root.innerHTML = '<div class="card pad anx-empty"><h3>Analytics unavailable</h3><p class="muted">The analysis module did not load.</p></div>'; return; }
    const rides = load('erglab.history', []).filter(r => r && r.date && !isNaN(new Date(r.date)));
    if (!rides.length) { root.innerHTML = emptyHTML(); return; }
    const withAn = rides.filter(r => r.an && Array.isArray(r.an.mmp) && r.an.mmp.length);
    const byId = {}; rides.forEach(r => byId[r.id] = r);
    const all = AN.fitnessSeries(rides, null) || [];
    PG = { root, rides, withAn, byId, all };
    root.innerHTML = `
      <div class="anx-kpis" id="anxKpis"></div>
      <section class="card anx-card"><div class="anx-ch"><div><h3>Fitness &amp; form</h3><p>Fitness (CTL, 42-day load), fatigue (ATL, 7-day) and form (TSB = CTL − ATL).</p></div>
        ${seg('fit', [[42, '6w'], [90, '3m'], [182, '6m'], [365, '1y'], [0, 'All']], prefs.fit)}</div>
        <div class="anx-legend"><span><i style="background:var(--an-ctl)"></i>Fitness</span><span><i style="background:var(--an-atl)"></i>Fatigue</span><span><i class="dot" style="background:var(--muted)"></i>Daily TSS</span><span><i style="background:var(--an-f4)"></i>Form</span></div>
        <div class="anx-chart" id="anxFit"></div></section>
      <section class="card anx-card"><div class="anx-ch"><div><h3>Weekly load</h3><p>TSS per week, split by time in power zones. Labels: hours ridden.</p></div>
        ${seg('wk', [[12, '12w'], [26, '26w'], [52, '52w']], prefs.wk)}</div>
        <div class="anx-chart" id="anxWk"></div></section>
      <section class="card anx-card"><div class="anx-ch"><div><h3>Power curve</h3><p id="anxPcSub">Best average power for every duration.</p></div>
        <div class="anx-ctl">${seg('per', [[42, '42d'], [90, '90d'], [365, '1y'], [0, 'All']], prefs.per)}${seg('unit', [['w', 'W'], ['wkg', 'W/kg']], prefs.unit)}</div></div>
        <div class="anx-legend" id="anxPcLeg"></div>
        <div class="anx-chart" id="anxPc"></div><div class="anx-foot" id="anxPcFoot"></div></section>
      <div class="anx-grid2">
        <section class="card anx-card"><div class="anx-ch"><div><h3>Time in zones</h3><p id="anxZSub"></p></div>${seg('zper', [[7, '7d'], [42, '42d'], [90, '90d'], [365, '1y'], [0, 'All']], prefs.zper)}</div>
          <div id="anxZones"></div></section>
        <section class="card anx-card"><div class="anx-ch"><div><h3>Records</h3><p>Best efforts: last 90 days and all time. Tap one to open the ride.</p></div></div>
          <div id="anxRec"></div></section>
      </div>`;
    renderKpis(); renderFit(); renderWeeks(); renderCurve(); renderZones(); renderRecords();
    bindSeg(root, 'fit', v => { prefs.fit = +v; savePrefs(); renderFit(); });
    bindSeg(root, 'wk', v => { prefs.wk = +v; savePrefs(); renderWeeks(); });
    bindSeg(root, 'per', v => { prefs.per = +v; savePrefs(); renderCurve(); });
    bindSeg(root, 'unit', v => { prefs.unit = v; savePrefs(); renderCurve(); });
    bindSeg(root, 'zper', v => { prefs.zper = +v; savePrefs(); renderZones(); });
  }

  function emptyHTML() {
    const it = (t, d) => `<li><b>${t}</b><span>${d}</span></li>`;
    return `<div class="card anx-empty">
      <svg viewBox="0 0 120 64" class="anx-eart" aria-hidden="true"><path d="M4 54 L22 40 L34 46 L52 22 L66 32 L84 12 L98 20 L116 6" fill="none" stroke="var(--an-ctl)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 58 L22 52 L34 56 L52 40 L66 50 L84 30 L98 42 L116 26" fill="none" stroke="var(--an-atl)" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round" opacity=".7"/></svg>
      <h3>Your progress shows up here</h3>
      <p class="muted">Ride any workout or a free ride and save it. After your first rides you'll see:</p>
      <ul>${it('Fitness, fatigue &amp; form', 'Training load over time, and whether you are fresh or overreaching.')}${it('Weekly load', 'TSS and hours per week, coloured by intensity.')}${it('Power curve &amp; eFTP', 'Your best power for 1 s to 2 h, a Critical Power fit and an FTP estimate.')}${it('Time in zones', 'How your training is distributed, power and heart rate.')}${it('Records', 'Best 5 s to 60 min efforts, with the ride they came from.')}</ul>
      <button class="btn primary" data-goto="workouts">Find a workout</button></div>`;
  }

  /* ---- KPI strip ---- */
  function renderKpis() {
    const { all, withAn, rides, root } = PG;
    const el = root.querySelector('#anxKpis');
    const last = all[all.length - 1] || { ctl: 0, atl: 0, tsb: 0 };
    const wk = all[all.length - 8] || all[0] || { ctl: 0 };
    const ramp = last.ctl - wk.ctl;
    const fi = formIdx(last.tsb), fz = FORM[fi];
    const best90 = AN.bestCurve(withAn, isoAgo(90), null);
    const fit = AN.cpFit(best90.w);
    const weeks = AN.weekTotals(rides, 2), lw = weeks[0], tw = weeks[1];
    const spark = (key, n = 42) => {
      const s = all.slice(-n); if (s.length < 2) return '';
      let mn = Infinity, mx = -Infinity; s.forEach(e => { mn = Math.min(mn, e[key]); mx = Math.max(mx, e[key]); });
      if (mx - mn < 1) { mx += .5; mn -= .5; }
      const pts = s.map((e, i) => `${(i / (s.length - 1) * 100).toFixed(1)},${(28 - (e[key] - mn) / (mx - mn) * 24).toFixed(1)}`);
      return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="M0,30 L${pts.join(' L')} L100,30 Z" class="sf"/><path d="M${pts.join(' L')}" class="sl"/></svg>`;
    };
    const diff = fit ? fit.eftp - S.ftp : 0;
    const pctWk = lw.tss ? Math.min(100, tw.tss / lw.tss * 100) : (tw.tss ? 100 : 0);
    el.innerHTML = `
      <div class="card anx-kpi" style="--k:var(--an-ctl)"><div class="k">Fitness <span>CTL</span></div><div class="v num">${fx(last.ctl, 0)}</div>
        <div class="s num">${sgn(ramp)} <span class="dim">ramp / 7 d</span>${ramp > 8 ? ' <b class="warn">steep</b>' : ''}</div>${spark('ctl')}</div>
      <div class="card anx-kpi" style="--k:var(--an-atl)"><div class="k">Fatigue <span>ATL</span></div><div class="v num">${fx(last.atl, 0)}</div>
        <div class="s num">${sgn(last.atl - wk.atl)} <span class="dim">vs 7 d ago</span></div>${spark('atl')}</div>
      <div class="card anx-kpi" style="--k:var(${fz.v})"><div class="k">Form <span>TSB</span></div><div class="v num">${sgn(last.tsb, 0)}</div>
        <div class="s"><span class="anx-pill" style="color:var(${fz.v})">${fz.name}</span></div>${spark('tsb')}</div>
      <div class="card anx-kpi" style="--k:var(--an-curve)"><div class="k">eFTP <span>90 d</span></div>
        ${fit ? `<div class="v num">${fit.eftp}<small>W</small></div><div class="s num">${(fit.eftp / S.weight).toFixed(2)} W/kg · <span class="${diff > 0 ? 'up' : diff < 0 ? 'down' : 'dim'}">${sgn(diff, 0)} W</span> <span class="dim">vs FTP ${S.ftp}</span></div>
          ${Math.abs(diff) >= 2 ? `<button class="btn sm anx-useftp" data-v="${fit.eftp}">Use as FTP</button>` : '<div class="s dim">matches your FTP</div>'}`
        : `<div class="v num dim">–</div><div class="s dim">Needs hard 2–20 min efforts in the last 90 days.</div>`}</div>
      <div class="card anx-kpi" style="--k:var(--an-wbal)"><div class="k">W′ <span>anaerobic</span></div>
        ${fit ? `<div class="v num">${(fit.wprime / 1000).toFixed(1)}<small>kJ</small></div><div class="s num">CP <b>${fit.cp} W</b> <span class="dim">· fit of ${fit.pts} bests</span></div>` : `<div class="v num dim">–</div><div class="s dim">Estimated with eFTP.</div>`}</div>
      <div class="card anx-kpi" style="--k:var(--accent)"><div class="k">This week</div><div class="v num">${tw.tss}<small>TSS</small></div>
        <div class="s num">${hm(tw.dur)} · ${tw.n} ride${tw.n === 1 ? '' : 's'} <span class="dim">· last wk ${lw.tss} / ${hm(lw.dur)}</span></div>
        <div class="wbar"><i style="width:${pctWk.toFixed(1)}%"></i></div></div>`;
    const b = el.querySelector('.anx-useftp');
    if (b) b.addEventListener('click', () => {
      const v = +b.dataset.v; if (!(v > 0)) return;
      S.ftp = v; saveSettings(); if (typeof afterSettings === 'function') afterSettings();
      toast(`FTP set to ${v} W (eFTP from your 90-day power curve)`);
      renderProgressImpl();
    });
  }

  /* ---- fitness chart ---- */
  function renderFit() {
    const { all, rides, root } = PG;
    const fromKey = prefs.fit ? AN.dayKey(new Date(Date.now() - prefs.fit * DAY)) : null;
    const ser = fromKey ? all.filter(e => e.d >= fromKey) : all;
    const byDay = {};
    rides.forEach(r => { const k = AN.dayKey(r.date); (byDay[k] || (byDay[k] = [])).push(r); });
    const host = root.querySelector('#anxFit');
    if (ser.length < 2) { host.innerHTML = '<div class="anx-none">Not enough days yet: ride a few more times to see a trend.</div>'; return; }
    mkChart(host, { height: w => w < 560 ? 250 : 320, draw: ch => drawFitness(ch, ser, byDay), hover: (ch, x, y) => hoverFitness(ch, x, y, ser, byDay) });
  }
  function drawFitness(ch, ser, byDay) {
    const { ctx, w, h, P } = ch, n = ser.length;
    const L = 30, R = ch.mob ? 28 : 36, T = 10, B = 20, gap = 16;
    const pw = w - L - R, avail = h - T - B - gap, th = Math.round(avail * 0.66), bt = T + th + gap, bh = avail - th;
    const X = i => L + i / (n - 1) * pw;
    let mx = 10, mt = 60, tlo = 0, thi = 0;
    for (const e of ser) { mx = Math.max(mx, e.ctl, e.atl); mt = Math.max(mt, e.tss); tlo = Math.min(tlo, e.tsb); thi = Math.max(thi, e.tsb); }
    const ya = niceAxis(mx * 1.05, 4), ta = niceAxis(mt * 1.08, 4);
    const Y = v => T + th - v / ya.top * th, YT = v => T + th - v / ta.top * th;
    const lo = Math.min(-40, Math.floor((tlo - 5) / 10) * 10), hi = Math.max(30, Math.ceil((thi + 5) / 10) * 10);
    const YB = v => bt + (hi - v) / (hi - lo) * bh;
    ch.g = { L, R, T, pw, th, bt, bh, X, Y, YB, n };
    ctx.font = ch.font(10);
    // grid + axes (top panel)
    for (let k = 0; k <= ya.n; k++) {
      const v = ya.step * k, y = Y(v);
      hline(ctx, L, L + pw, y, k ? rgba(P.line, .9) : P.line2);
      text(ctx, fx(v, 0), L - 6, y, P.dim, 'right');
      text(ctx, fx(ta.step * k, 0), L + pw + 5, y, rgba(P.muted, .75), 'left');
    }
    text(ctx, 'TSS', L + pw + 5, T - 2 + 0, rgba(P.muted, .6), 'left', 'top');
    // x ticks
    const dx = pw / (n - 1), ticks = [];
    if (n <= 120) {
      const k = Math.max(1, Math.ceil(58 / (7 * dx))); let c = 0;
      ser.forEach((e, i) => { if (keyDate(e.d).getDay() === 1) { if (c % k === 0) ticks.push([i, fD(keyDate(e.d))]); c++; } });
    } else {
      const k = Math.max(1, Math.ceil(46 / (30.4 * dx))); let c = 0;
      ser.forEach((e, i) => { const d = keyDate(e.d); if (d.getDate() === 1) { if (c % k === 0) ticks.push([i, d.getMonth() ? fD(d, { month: 'short' }) : fD(d, { month: 'short', year: '2-digit' })]); c++; } });
    }
    ticks.forEach(([i, s]) => { const x = X(i); vline(ctx, x, T, T + th, rgba(P.line, .55)); vline(ctx, x, bt, bt + bh, rgba(P.line, .55)); text(ctx, s, x, h - B / 2 + 1, P.dim, 'center'); });
    // form bands (bottom panel)
    const bands = [[hi, 25], [25, 5], [5, -10], [-10, -30], [-30, lo]];
    bands.forEach(([a, b], i) => {
      const y0 = YB(a), y1 = YB(b); if (y1 - y0 < 0.5) return;
      ctx.fillStyle = rgba(P.f[i], .10); ctx.fillRect(L, y0, pw, y1 - y0);
      if (y1 - y0 >= 11 && !ch.mob) { ctx.font = ch.font(9.5, 650); text(ctx, FORM[i].name, L + pw - 6, (y0 + y1) / 2, rgba(P.f[i], .75), 'right'); }
    });
    ctx.font = ch.font(10);
    hline(ctx, L, L + pw, YB(0), P.line2);
    [hi > 25 ? 25 : null, 0, -30].forEach(v => { if (v != null) text(ctx, (v > 0 ? '+' : '') + v, L - 6, YB(v), P.dim, 'right'); });
    // daily TSS dots (right scale)
    const rr = ch.mob ? 2.2 : 2.8;
    ser.forEach((e, i) => {
      if (!(e.tss > 0)) return;
      const day = byDay[e.d] || []; let IF = 0; day.forEach(r => { IF = Math.max(IF, +r.IF || (r.np && r.ftp ? r.np / r.ftp : 0)); });
      ctx.beginPath(); ctx.arc(X(i), YT(e.tss), rr, 0, 7); ctx.fillStyle = IF ? rgba(P.pz[pzIdx(IF)], .85) : rgba(P.muted, .7); ctx.fill();
    });
    // CTL area + line
    const grad = ctx.createLinearGradient(0, T, 0, T + th); grad.addColorStop(0, rgba(P.ctl, .34)); grad.addColorStop(1, rgba(P.ctl, .02));
    ctx.beginPath(); ctx.moveTo(X(0), T + th); ser.forEach((e, i) => ctx.lineTo(X(i), Y(e.ctl))); ctx.lineTo(X(n - 1), T + th); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ser.forEach((e, i) => i ? ctx.lineTo(X(i), Y(e.ctl)) : ctx.moveTo(X(i), Y(e.ctl))); ctx.strokeStyle = P.ctl; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.beginPath(); ser.forEach((e, i) => i ? ctx.lineTo(X(i), Y(e.atl)) : ctx.moveTo(X(i), Y(e.atl))); ctx.strokeStyle = rgba(P.atl, .9); ctx.lineWidth = 1.4; ctx.stroke();
    // TSB: bars when there's room, else a zone-coloured line
    const z0 = YB(0);
    if (dx >= 3) {
      const bw = Math.max(1.5, Math.min(8, dx * 0.62));
      ser.forEach((e, i) => { const y = YB(e.tsb); ctx.fillStyle = rgba(P.f[formIdx(e.tsb)], .85); ctx.fillRect(X(i) - bw / 2, Math.min(y, z0), bw, Math.max(1, Math.abs(y - z0))); });
    } else {
      ctx.lineWidth = 1.6;
      for (let i = 1; i < n; i++) { ctx.beginPath(); ctx.moveTo(X(i - 1), YB(ser[i - 1].tsb)); ctx.lineTo(X(i), YB(ser[i].tsb)); ctx.strokeStyle = P.f[formIdx(ser[i].tsb)]; ctx.stroke(); }
    }
    // labels
    ctx.font = ch.font(9.5, 700);
    text(ctx, 'FORM', L + 4, bt + 7, rgba(P.muted, .7), 'left');
  }
  function hoverFitness(ch, x, y, ser, byDay) {
    const g = ch.g; if (!g) return null;
    const i = clampN(Math.round((x - g.L) / g.pw * (g.n - 1)), 0, g.n - 1), e = ser[i], xx = g.X(i), c = ch.octx, P = ch.P;
    vline(c, xx, g.T, g.bt + g.bh, rgba(P.text, .35));
    dot(c, xx, g.Y(e.ctl), P.ctl, P.panel); dot(c, xx, g.Y(e.atl), P.atl, P.panel, 3); dot(c, xx, g.YB(e.tsb), P.f[formIdx(e.tsb)], P.panel, 3);
    const fz = FORM[formIdx(e.tsb)], rides = byDay[e.d] || [];
    return `<div class="t">${fD(keyDate(e.d), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>
      ${trow(P.ctl, 'Fitness', fx(e.ctl, 1))}${trow(P.atl, 'Fatigue', fx(e.atl, 1))}${trow(P.f[formIdx(e.tsb)], 'Form', sgn(e.tsb, 1), `<em style="color:var(${fz.v})">${fz.name}</em>`)}
      ${e.tss ? trow(null, 'Load', Math.round(e.tss) + ' TSS') : ''}${rides.slice(0, 4).map(r => `<div class="n">${esc(r.name)} <span>${r.tss || 0} TSS</span></div>`).join('')}`;
  }

  /* ---- weekly load ---- */
  function renderWeeks() {
    const { rides, root } = PG;
    const W = AN.weekTotals(rides, prefs.wk);
    mkChart(root.querySelector('#anxWk'), { height: w => w < 560 ? 200 : 230, draw: ch => drawWeeks(ch, W), hover: (ch, x, y) => hoverWeeks(ch, x, W) });
  }
  function drawWeeks(ch, W) {
    const { ctx, w, h, P } = ch, n = W.length;
    const L = 34, R = 8, T = 20, B = 20, pw = w - L - R, ph = h - T - B, slot = pw / n, bw = Math.max(3, Math.min(40, slot * 0.66));
    let mx = 50; W.forEach(x => mx = Math.max(mx, x.tss));
    const ya = niceAuto(mx * 1.04, 4), Y = v => T + ph - v / ya.top * ph;
    ch.g = { L, T, ph, pw, slot, n };
    ctx.font = ch.font(10);
    for (let k = 0; k <= ya.n; k++) { const v = ya.step * k; hline(ctx, L, L + pw, Y(v), k ? P.line : P.line2); text(ctx, fx(v, 0), L - 6, Y(v), P.dim, 'right'); }
    const done = W.slice(0, -1).filter(x => x.n);
    const avg = done.length ? done.reduce((a, x) => a + x.tss, 0) / done.length : 0;
    const k = Math.max(1, Math.ceil(54 / slot));
    W.forEach((x, i) => {
      const cx = L + i * slot + slot / 2, x0 = cx - bw / 2, cur = i === n - 1;
      if ((n - 1 - i) % k === 0) { const s = cur ? 'This wk' : fD(keyDate(x.wk)), hw = ctx.measureText(s).width / 2; text(ctx, s, clampN(cx, hw + 2, w - hw - 2), h - B / 2 + 1, cur ? P.muted : P.dim, 'center'); }
      if (!(x.tss > 0)) return;
      const top = Y(x.tss), tot = x.tiz.reduce((a, b) => a + b, 0);
      ctx.save(); ctx.globalAlpha = cur ? 0.62 : 1;
      topRounded(ctx, x0, top, bw, Y(0) - top, Math.min(5, bw / 3)); ctx.clip();
      if (tot > 0) {
        let acc = 0;
        for (let z = 0; z < 7; z++) {
          if (!x.tiz[z]) continue; const v = x.tss * x.tiz[z] / tot;
          ctx.fillStyle = P.pz[z]; ctx.fillRect(x0, Y(acc + v), bw, Y(acc) - Y(acc + v) + 0.6); acc += v;
        }
      } else { ctx.fillStyle = rgba(P.accent, .8); ctx.fillRect(x0, top, bw, Y(0) - top); }
      ctx.restore();
      if (cur) { ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = rgba(P.text, .5); topRounded(ctx, x0 + .5, top + .5, bw - 1, Y(0) - top - 1, Math.min(5, bw / 3)); ctx.stroke(); ctx.restore(); }
      if (slot >= 26 && x.dur) { ctx.font = ch.font(9.5, 650); text(ctx, hrs(x.dur), cx, top - 7, P.muted, 'center'); ctx.font = ch.font(10); }
    });
    if (avg > 0) {
      const y = Y(avg); hline(ctx, L, L + pw, y, rgba(P.text, .45), [4, 4]);
      ctx.font = ch.font(9.5, 700); const s = `avg ${Math.round(avg)}`, tw = ctx.measureText(s).width;
      ctx.fillStyle = rgba(P.panel, .85); ctx.fillRect(L + 2, y - 15, tw + 8, 13); text(ctx, s, L + 6, y - 8.5, P.muted, 'left');
    }
  }
  function hoverWeeks(ch, x, W) {
    const g = ch.g; if (!g) return null;
    const i = clampN(Math.floor((x - g.L) / g.slot), 0, g.n - 1), wk = W[i], P = ch.P;
    ch.octx.fillStyle = rgba(P.text, .06); ch.octx.fillRect(g.L + i * g.slot, g.T - 14, g.slot, g.ph + 14);
    const tot = wk.tiz.reduce((a, b) => a + b, 0), end = new Date(keyDate(wk.wk).getTime() + 6 * DAY);
    return `<div class="t">${fD(keyDate(wk.wk))} – ${fD(end)}${i === g.n - 1 ? ' <span>this week</span>' : ''}</div>
      ${trow(null, 'Rides', wk.n)}${trow(null, 'Load', wk.tss + ' TSS')}${trow(null, 'Time', hm(wk.dur))}${trow(null, 'Work', wk.kj + ' kJ')}${wk.dist ? trow(null, 'Distance', (wk.dist / 1000).toFixed(1) + ' km') : ''}
      ${tot ? `<div class="zb">${PZ.map((z, k) => wk.tiz[k] ? `<i style="width:${(wk.tiz[k] / tot * 100).toFixed(1)}%;background:${z.col}"></i>` : '').join('')}</div>` : ''}`;
  }

  /* ---- power curve (shared by Progress and the ride page) ---- */
  // C: { series: [{ v: [], col, dash, lw, fill, name }], fit, fitScale, unit, marks: [{ i, col }], tip(i, ch) -> html, pick(i) }
  function drawCurve(ch, C) {
    const { ctx, w, h, P } = ch, D = AN.MMP_DUR;
    let last = 0, mx = 0;
    C.series.forEach(s => s.v.forEach((v, i) => { if (v != null) { if (i > last) last = i; if (v > mx) mx = v; } }));
    const tmax = Math.max(60, D[last]);
    const L = C.unit === 'wkg' ? 34 : 38, R = 10, T = 12, B = 20, pw = w - L - R, ph = h - T - B, lx = Math.log(tmax);
    const X = t => L + Math.log(t) / lx * pw;
    const ya = niceAuto(Math.max(mx, 1) * 1.04, ch.mob ? 4 : 5), Y = v => T + ph - v / ya.top * ph;
    ch.g = { L, T, pw, ph, X, Y, tmax, lx };
    ctx.font = ch.font(10);
    for (let k = 0; k <= ya.n; k++) { const v = ya.step * k; hline(ctx, L, L + pw, Y(v), k ? P.line : P.line2); text(ctx, C.unit === 'wkg' ? fx(v, ya.step < 1 ? 1 : 0) : fx(v, 0), L - 6, Y(v), P.dim, 'right'); }
    let lastX = -99;
    CURVE_TICKS.filter(t => t <= tmax * 1.001).forEach(t => {
      const x = X(t); vline(ctx, x, T, T + ph, rgba(P.line, .7));
      if (x - lastX >= (ch.mob ? 26 : 30)) { text(ctx, durLbl(t), clampN(x, L + 6, L + pw - 8), h - B / 2 + 1, P.dim, 'center'); lastX = x; }
    });
    // CP model
    if (C.fit) {
      ctx.save(); ctx.beginPath(); let first = true;
      for (let k = 0; k <= 60; k++) {
        const t = Math.exp(Math.log(60) + (lx - Math.log(60)) * k / 60), v = (C.fit.cp + C.fit.wprime / t) / (C.fitScale || 1);
        if (Y(v) < T) continue; first ? ctx.moveTo(X(t), Y(v)) : ctx.lineTo(X(t), Y(v)); first = false;
      }
      ctx.setLineDash([2, 4]); ctx.lineCap = 'round'; ctx.strokeStyle = rgba(P.text, .55); ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore();
    }
    // series, back to front
    for (let si = C.series.length - 1; si >= 0; si--) {
      const s = C.series[si], col = P[s.col] || s.col;
      const pts = []; s.v.forEach((v, i) => { if (v != null && D[i] <= tmax) pts.push([X(D[i]), Y(v)]); });
      if (pts.length < 2) continue;
      if (s.fill) {
        const g = ctx.createLinearGradient(0, T, 0, T + ph); g.addColorStop(0, rgba(col, .30)); g.addColorStop(1, rgba(col, .02));
        ctx.beginPath(); ctx.moveTo(pts[0][0], T + ph); pts.forEach(p => ctx.lineTo(p[0], p[1])); ctx.lineTo(pts[pts.length - 1][0], T + ph); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
      ctx.save(); ctx.beginPath(); pts.forEach((p, k) => k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      if (s.dash) ctx.setLineDash(s.dash); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = s.dash ? rgba(col, .85) : col; ctx.lineWidth = s.lw || 2; ctx.stroke(); ctx.restore();
    }
    (C.marks || []).forEach(m => { const v = C.series[0].v[m.i]; if (v == null) return; const x = X(D[m.i]), y = Y(v); ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fillStyle = P.panel; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = P[m.col] || m.col; ctx.stroke(); });
  }
  function curveIdx(ch, x, C) {
    const g = ch.g, D = AN.MMP_DUR; if (!g) return -1;
    const lt = clampN((x - g.L) / g.pw, 0, 1) * g.lx; let best = -1, bd = Infinity;
    D.forEach((t, i) => { if (t > g.tmax * 1.001 || !C.series.some(s => s.v[i] != null)) return; const d = Math.abs(Math.log(t) - lt); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function curveChart(host, C, height) {
    let lastTap = -1;
    return mkChart(host, {
      height: height || (w => w < 560 ? 250 : 310),
      draw: ch => drawCurve(ch, C),
      hover(ch, x) {
        const i = curveIdx(ch, x, C); if (i < 0) return null;
        const g = ch.g, P = ch.P, xx = g.X(AN.MMP_DUR[i]);
        vline(ch.octx, xx, g.T, g.T + g.ph, rgba(P.text, .35));
        C.series.forEach(s => { const v = s.v[i]; if (v != null) dot(ch.octx, xx, g.Y(v), P[s.col] || s.col, P.panel, s.dash ? 3 : 4); });
        ch.ci = i;
        return C.tip(i, ch);
      },
      tap(ch, x, y, e) {
        const i = curveIdx(ch, x, C); if (i < 0 || !C.pick) return;
        if (e.pointerType === 'mouse' || lastTap === i) { lastTap = -1; C.pick(i); } else lastTap = i;
      },
    });
  }

  function renderCurve() {
    const { withAn, byId, root } = PG, per = prefs.per, unit = prefs.unit;
    const from = per ? isoAgo(per) : null;
    const cur = AN.bestCurve(withAn, from, null);
    const prev = per ? AN.bestCurve(withAn, isoAgo(per * 2), from) : null;
    const kg = id => (byId[id] && +byId[id].wt) || S.weight;
    const conv = b => b.w.map((v, i) => v == null ? null : unit === 'wkg' ? v / kg(b.id[i]) : v);
    const fit = AN.cpFit(cur.w);
    const host = root.querySelector('#anxPc'), foot = root.querySelector('#anxPcFoot'), leg = root.querySelector('#anxPcLeg');
    if (!cur.w.some(v => v != null)) {
      host.innerHTML = `<div class="anx-none">${withAn.length ? 'No rides with power data in this period.' : 'No analysed rides yet: the power curve appears once rides with per-second data are analysed.'}</div>`;
      foot.innerHTML = ''; leg.innerHTML = ''; return;
    }
    const perName = per ? (per === 365 ? 'last year' : `last ${per} days`) : 'all time';
    const series = [{ v: conv(cur), col: 'curve', lw: 2.6, fill: true, name: perName }];
    if (prev && prev.w.some(v => v != null)) series.push({ v: conv(prev), col: 'cmp', dash: [5, 4], lw: 1.6, name: 'previous ' + (per === 365 ? 'year' : per + ' days') });
    leg.innerHTML = `<span><i style="background:var(--an-curve)"></i>${esc(perName)}</span>${series[1] ? `<span><i class="dash" style="color:var(--an-cmp)"></i>${esc(series[1].name)}</span>` : ''}${fit ? '<span><i class="dot2"></i>CP model</span>' : ''}`;
    const u = unit === 'wkg' ? 'W/kg' : 'W', fmtV = v => unit === 'wkg' ? fx(v, 2) : fx(v, 0);
    curveChart(host, {
      series, unit, fit, fitScale: unit === 'wkg' ? S.weight : 1,
      tip(i, ch) {
        const P = ch.P, t = AN.MMP_DUR[i], id = cur.id[i], r = id && byId[id], w = cur.w[i];
        let s = `<div class="t">${durLbl(t)} best</div>`;
        if (w != null) s += trow(P.curve, unit === 'wkg' ? 'W/kg' : 'Power', `${fmtV(series[0].v[i])} ${u}`, `<em>${unit === 'wkg' ? Math.round(w) + ' W' : (w / kg(id)).toFixed(2) + ' W/kg'}</em>`);
        if (series[1] && series[1].v[i] != null) { const d = w != null ? series[0].v[i] - series[1].v[i] : null; s += trow(P.cmp, 'Previous', `${fmtV(series[1].v[i])} ${u}`, d != null ? `<em class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${fmtV(Math.abs(d))}</em>` : ''); }
        if (fit && t >= 60) s += trow(null, 'CP model', `${fmtV((fit.cp + fit.wprime / t) / (unit === 'wkg' ? S.weight : 1))} ${u}`);
        if (r) s += `<div class="n">${esc(r.name)} <span>${fDay(r.date)}</span></div><div class="h">${ch.ptype === 'mouse' ? 'Click' : 'Tap again'} to open the ride</div>`;
        return s;
      },
      pick(i) { const id = cur.id[i]; if (id) openRideAnalysis(id); },
    });
    foot.innerHTML = fit
      ? `<span>CP <b class="num">${fit.cp} W</b></span><span>W′ <b class="num">${(fit.wprime / 1000).toFixed(1)} kJ</b></span><span>eFTP <b class="num">${fit.eftp} W</b> <span class="dim">(${(fit.eftp / S.weight).toFixed(2)} W/kg)</span></span><span class="dim">2-parameter fit of the ${fit.pts} best efforts between 2 and 20 min</span>`
      : '<span class="dim">Critical Power fit needs best efforts between 2 and 20 minutes in this period.</span>';
  }

  /* ---- time in zones ---- */
  function renderZones() {
    const { withAn, root } = PG, per = prefs.zper;
    const zt = AN.zoneTotals(withAn, per ? isoAgo(per) : null);
    const tp = zt.tiz.reduce((a, b) => a + b, 0), th = zt.thz.reduce((a, b) => a + b, 0);
    root.querySelector('#anxZSub').textContent = zt.n ? `${zt.n} ride${zt.n === 1 ? '' : 's'} · ${hm(tp)} pedalling${th ? ` · ${hm(th)} with heart rate` : ''}` : 'No analysed rides in this period.';
    root.querySelector('#anxZones').innerHTML = `<div class="anx-zh">Power zones <span class="dim">· FTP ${S.ftp} W</span></div>${zoneBars(zt.tiz, PZ, 'p', S.ftp)}${polarization(zt.tiz)}
      <div class="anx-zh" style="margin-top:16px">Heart-rate zones <span class="dim">· max ${S.maxHr} bpm</span></div>${zoneBars(zt.thz, HZ, 'hr', S.maxHr)}`;
  }

  /* ---- records ---- */
  function renderRecords() {
    const { withAn, byId, root } = PG, el = root.querySelector('#anxRec');
    if (!withAn.length) { el.innerHTML = '<div class="anx-none">Records appear once rides with per-second data are analysed.</div>'; return; }
    const b90 = AN.bestCurve(withAn, isoAgo(90), null), ball = AN.bestCurve(withAn, null, null);
    const cell = (b, i, star) => {
      const v = b.w[i]; if (v == null) return '<td class="nil">–</td>';
      const r = byId[b.id[i]], kg = (r && +r.wt) || S.weight;
      return `<td data-ride="${esc(b.id[i] || '')}" tabindex="0"><b class="num">${Math.round(v)}</b><span class="u">W</span>${star ? '<span class="pb" title="All-time best">PB</span>' : ''}<div class="sub num">${(v / kg).toFixed(2)} W/kg · ${b.date[i] ? fDay(b.date[i]) : ''}</div></td>`;
    };
    el.innerHTML = `<table class="anx-tbl anx-rec"><thead><tr><th>Duration</th><th>Last 90 days</th><th>All time</th></tr></thead><tbody>${KEY_DUR.map(d => {
      const i = AN.MMP_DUR.indexOf(d); if (i < 0) return '';
      return `<tr><td class="d">${durLbl(d)}</td>${cell(b90, i, b90.w[i] != null && b90.id[i] === ball.id[i])}${cell(ball, i, false)}</tr>`;
    }).join('')}</tbody></table>`;
    el.querySelectorAll('td[data-ride]').forEach(td => td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRideAnalysis(td.dataset.ride); } }));
  }

  /* ======================================================================
     RIDE ANALYSIS OVERLAY
     ====================================================================== */
  let ov = null;
  const onKey = e => { if (e.key === 'Escape' && ov) { e.preventDefault(); closeRide(); } };
  function closeRide() {
    if (!ov) return;
    ov.remove(); ov = null;
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('anx-lock');
    sweep();
    if (closeRide.focus && closeRide.focus.focus) { try { closeRide.focus.focus({ preventScroll: true }); } catch (e) { } }
  }

  async function openRide(id) {
    const hist = load('erglab.history', []);
    const r = hist.find(x => x.id === id);
    if (!r) { toast('Ride not found'); return; }
    if (ov) closeRide();
    closeRide.focus = document.activeElement;
    const node = document.createElement('div');
    node.id = 'rideAn'; node.className = 'anx anx-ov'; node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', 'Ride analysis: ' + (r.name || 'ride'));
    const cc = typeof CAT_COL !== 'undefined' && r.cat ? CAT_COL[r.cat] : null;
    node.innerHTML = `<div class="anx-ovbar"><button class="anx-x" type="button" aria-label="Close analysis"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Back</span></button>
      <div class="anx-ovt"><b>${esc(r.name || 'Ride')}</b><span>${fLong(r.date)}</span></div>
      <div class="anx-ovb">${r.completed ? '<span class="badge" style="color:var(--ok)">Completed</span>' : '<span class="badge" style="color:var(--muted)">Ended early</span>'}${cc ? `<span class="badge anx-catb" style="color:${cc}">${esc(r.cat)}</span>` : ''}</div></div>
      <div class="anx-ovbody"><div class="anx-loading"><i class="anx-spin"></i><span>Loading ride data…</span></div></div>`;
    document.body.appendChild(node); document.body.classList.add('anx-lock');
    ov = node;
    node.querySelector('.anx-x').addEventListener('click', closeRide);
    document.addEventListener('keydown', onKey);
    try { node.querySelector('.anx-x').focus({ preventScroll: true }); } catch (e) { }
    let raw = null, err = null;
    try { raw = await rideStreams(r); } catch (e) { err = e; }
    if (ov !== node) return; // closed or replaced while loading
    try { renderRidePage(node.querySelector('.anx-ovbody'), r, raw, err, hist); }
    catch (e) { console.error(e); node.querySelector('.anx-ovbody').innerHTML = `<div class="card pad anx-none">Could not analyse this ride: ${esc(e.message)}</div>`; }
  }

  function prepStreams(s) {
    const n = s.p.length;
    const fix = (a, fb) => { const o = new Array(n); for (let i = 0; i < n; i++) { const v = a && a[i] != null ? +a[i] : fb; o[i] = isFinite(v) && v > 0 ? v : 0; } return o; };
    return { p: fix(s.p, 0), hr: fix(s.hr, 0), c: fix(s.c, 0), tg: fix(s.tg, 0), dd: Array.isArray(s.dd) ? s.dd : null };
  }

  function renderRidePage(body, r, raw, err, hist) {
    const ftp = +r.ftp || S.ftp, kg = +r.wt || S.weight, wp = wprimeOf();
    const st = raw && Array.isArray(raw.p) && raw.p.length > 1 ? prepStreams(raw) : null;
    let an = r.an && Array.isArray(r.an.mmp) && r.an.mmp.length ? r.an : null;
    if (!an && st) { try { an = AN.analyzeRide(st, { ftp, maxHr: S.maxHr, weight: kg, wprime: wp }); } catch (e) { console.warn('analysis', e); } }
    const mmp = an ? an.mmp : [];
    const peak = d => { const i = AN.MMP_DUR.indexOf(d); return i >= 0 && mmp[i] != null ? mmp[i] : null; };
    const tile = (k, v, u, sub, cls) => `<div class="card anx-tile${cls ? ' ' + cls : ''}"><div class="k">${k}</div><div class="v num">${v}${u ? `<small>${u}</small>` : ''}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    const dec = an && an.dec != null ? an.dec : null;
    const wbMin = an && an.wbalMin != null ? an.wbalMin : null;
    const np = (an && an.np) || r.np, IF = r.IF || (np && ftp ? +(np / ftp).toFixed(2) : null);
    const pk = [[5, '5s'], [60, '1m'], [300, '5m'], [1200, '20m']].map(([d, l]) => peak(d) != null ? `<span><em>${l}</em>${peak(d)}</span>` : '').join('');
    const stats = [
      tile('Duration', fmtTime(r.dur), '', an && an.coast ? `${fmtTime(an.coast)} coasting` : ''),
      tile('Distance', fx((r.dist || 0) / 1000, 1), 'km'),
      tile('Avg power', fx(r.avgP), 'W', `${fx(r.avgP / kg, 2)} W/kg`),
      tile('Norm. power', fx(np), 'W', `${fx(np / kg, 2)} W/kg`),
      tile('Max power', fx(r.maxP), 'W'),
      tile('Intensity', fx(IF, 2), 'IF', `FTP ${ftp} W`),
      tile('Load', fx(r.tss), 'TSS', `${fx(r.kj)} kJ ≈ kcal`),
      tile('Variability', an && an.vi != null ? fx(an.vi, 2) : '–', 'VI', an && an.vi ? (an.vi <= 1.05 ? 'steady' : an.vi <= 1.15 ? 'variable' : 'very variable') : ''),
      tile('Efficiency', an && an.ef != null ? fx(an.ef, 2) : '–', 'EF', 'NP ÷ avg HR'),
      tile('Pw:HR drift', dec != null ? fx(dec, 1) : '–', dec != null ? '%' : '', dec == null ? 'needs 20 min with HR' : dec < 5 ? 'well coupled' : dec < 10 ? 'some drift' : 'strong drift', dec == null ? '' : dec < 5 ? 'good' : dec < 10 ? 'meh' : 'bad'),
      tile('Heart rate', r.avgHr ? fx(r.avgHr) : '–', r.avgHr ? 'bpm' : '', r.maxHr ? `max ${r.maxHr} bpm` : ''),
      tile('Cadence', r.avgC ? fx(r.avgC) : '–', r.avgC ? 'rpm' : ''),
      tile('W′bal low', wbMin != null ? fx(Math.max(0, wbMin) / 1000, 1) : '–', wbMin != null ? 'kJ' : '', wbMin != null ? `${Math.round(Math.max(0, wbMin) / wp * 100)}% of W′ left` : '', wbMin != null && wbMin / wp < 0.1 ? 'bad' : ''),
      pk ? `<div class="card anx-tile wide"><div class="k">Peak power</div><div class="anx-peaks num">${pk}</div></div>` : '',
    ].join('');
    let html = `<div class="anx-ride">
      <div class="anx-meta">${r.cat ? `<span>${esc(r.cat)}</span>` : ''}<span>FTP ${ftp} W</span><span>${fx(kg, 1)} kg</span>${an && an.ints ? `<span>${an.ints.filter(x => x.k === 'work').length} work intervals</span>` : ''}</div>
      <div class="anx-tiles">${stats}</div>`;
    if (!st) {
      html += `<div class="card anx-card anx-nodata"><h3>Summary only</h3><p class="muted">${esc(err && err.message ? err.message : 'No per-second data is stored for this ride')}. The detailed chart, intervals and selection stats need the second-by-second recording${an ? '; the stored analysis below is still available' : ''}.</p>${r.pv && r.pv.length ? `<div class="anx-pv">${pvSVG(r.pv, ftp)}</div>` : ''}</div>`;
    } else {
      html += `<section class="card anx-card anx-streamc"><div class="anx-ch"><div><h3>Power &amp; heart rate</h3><p class="anx-hint">${matchMedia('(pointer:coarse)').matches ? 'Touch to inspect · long-press and drag to select a range' : 'Hover to inspect · drag to select a range · double-click to reset zoom'}</p></div>
          <div class="anx-ctl">${seg('sm', [[1, 'Raw'], [3, '3s'], [10, '10s'], [30, '30s']], prefs.sm)}</div></div>
        <div class="anx-togs" id="anxTogs"></div>
        <div class="anx-chart" id="anxStream"></div>
        <div class="anx-selp" id="anxSel"></div></section>`;
    }
    if (an && an.ints && an.ints.length) html += `<section class="card anx-card"><div class="anx-ch"><div><h3>Intervals</h3><p>${st ? 'Tap a row to select it on the chart.' : 'Detected from the recording.'}</p></div></div><div class="anx-tblw" id="anxInts"></div></section>`;
    if (an) html += `<div class="anx-grid2"><section class="card anx-card"><div class="anx-ch"><div><h3>Power zones</h3><p>Time pedalling in each zone · FTP ${ftp} W</p></div></div>${zoneBars(an.tiz || [], PZ, 'p', ftp, true)}</section>
      <section class="card anx-card"><div class="anx-ch"><div><h3>Heart-rate zones</h3><p>Max HR ${S.maxHr} bpm</p></div></div>${zoneBars(an.thz || [], HZ, 'hr', S.maxHr, true)}</section></div>
      <section class="card anx-card"><div class="anx-ch"><div><h3>Power curve</h3><p>This ride vs your best of the 90 days before it.</p></div></div>
        <div class="anx-legend"><span><i style="background:var(--an-curve)"></i>This ride</span><span><i class="dash" style="color:var(--an-cmp)"></i>90-day best before</span><span><i class="ring" style="color:var(--warn)"></i>All-time PB</span><span><i class="ring" style="color:var(--an-ctl)"></i>90-day PB</span></div>
        <div class="anx-chart" id="anxRc"></div><div class="anx-pbs" id="anxPbs"></div></section>`;
    html += '</div>';
    body.innerHTML = html;

    // ---- ride power curve with PBs
    if (an) {
      const others = hist.filter(x => x.id !== r.id && x.an && Array.isArray(x.an.mmp));
      const t0 = new Date(r.date).getTime();
      const b90 = AN.bestCurve(others, new Date(t0 - 90 * DAY).toISOString(), r.date), ball = AN.bestCurve(others, null, r.date);
      const prior = ball.w.some(v => v != null);
      const marks = [], pbs = [];
      mmp.forEach((v, i) => {
        if (v == null || !prior) return;
        if (ball.w[i] == null || v > ball.w[i]) { marks.push({ i, col: 'warn' }); pbs.push({ i, all: true, v, was: ball.w[i] }); }
        else if (b90.w[i] == null || v > b90.w[i]) { marks.push({ i, col: 'ctl' }); pbs.push({ i, all: false, v, was: b90.w[i] }); }
      });
      const byId = {}; hist.forEach(x => byId[x.id] = x);
      const series = [{ v: mmp.slice(), col: 'curve', lw: 2.6, fill: true }];
      if (b90.w.some(v => v != null)) series.push({ v: b90.w.slice(), col: 'cmp', dash: [5, 4], lw: 1.6 });
      if (mmp.some(v => v != null)) {
        curveChart(body.querySelector('#anxRc'), {
          series, unit: 'w', marks,
          tip(i, ch) {
            const P = ch.P, v = mmp[i], b = b90.w[i];
            let s = `<div class="t">${durLbl(AN.MMP_DUR[i])}</div>`;
            if (v != null) s += trow(P.curve, 'This ride', `${v} W`, `<em>${(v / kg).toFixed(2)} W/kg</em>`);
            if (b != null) { const o = byId[b90.id[i]]; s += trow(P.cmp, '90-day best', `${b} W`, v != null ? `<em class="${v >= b ? 'up' : 'down'}">${v >= b ? '+' : '−'}${Math.abs(v - b)}</em>` : '') + (o ? `<div class="n">${esc(o.name)} <span>${fDay(o.date)}</span></div>` : ''); }
            const pb = pbs.find(p => p.i === i); if (pb) s += `<div class="pbt ${pb.all ? 'all' : ''}">${pb.all ? 'All-time PB' : '90-day PB'}</div>`;
            return s;
          },
        }, w => w < 560 ? 220 : 270);
      } else body.querySelector('#anxRc').innerHTML = '<div class="anx-none">No power recorded.</div>';
      const pbEl = body.querySelector('#anxPbs');
      if (!prior) pbEl.innerHTML = '<span class="dim">Your first analysed ride: every duration is a baseline for future PBs.</span>';
      else if (!pbs.length) pbEl.innerHTML = '<span class="dim">No new bests on this ride.</span>';
      else {
        const keyFirst = pbs.filter(p => KEY_DUR.includes(AN.MMP_DUR[p.i])), rest = pbs.filter(p => !KEY_DUR.includes(AN.MMP_DUR[p.i]));
        const chip = p => `<span class="anx-pb ${p.all ? 'all' : ''}"><b>${durLbl(AN.MMP_DUR[p.i])}</b> ${p.v} W${p.was ? ` <em>+${p.v - p.was}</em>` : ''}</span>`;
        const shown = (keyFirst.length ? keyFirst : rest).slice(0, 10), more = pbs.length - shown.length;
        pbEl.innerHTML = `<span class="lbl">${pbs.some(p => p.all) ? 'New PBs' : 'New 90-day bests'}</span>${shown.map(chip).join('')}${more > 0 ? `<span class="dim">+${more} more durations</span>` : ''}`;
      }
    }

    if (!st) { if (an && an.ints && an.ints.length) renderIntsTable(body, an, ftp, null); return; }

    // ---- main stream chart
    const D = {
      st, n: st.p.length, ftp, kg, wp, an, ints: (an && an.ints) || [], view: [0, st.p.length], sel: null, selInt: -1, cache: {}, wb: null,
      hasT: st.tg.some(v => v > 0), hasHr: st.hr.some(v => v > 0), hasC: st.c.some(v => v > 0),
    };
    let hlo = Infinity, hhi = 0, cmx = 0; for (let i = 0; i < D.n; i++) { const h = st.hr[i]; if (h > 0) { if (h < hlo) hlo = h; if (h > hhi) hhi = h; } if (st.c[i] > cmx) cmx = st.c[i]; }
    D.hLo = D.hasHr ? Math.max(30, Math.floor((hlo - 8) / 10) * 10) : 60; D.hHi = D.hasHr ? Math.ceil((hhi + 4) / 10) * 10 : 200;
    if (D.hHi - D.hLo < 40) D.hLo = D.hHi - 40;
    D.cMax = Math.max(120, Math.ceil(cmx / 10) * 10) * 1.25;
    D.smooth = k => {
      k = +k || 1; if (k <= 1) return st.p; if (D.cache[k]) return D.cache[k];
      const n = D.n, cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + st.p[i];
      const hk = Math.floor(k / 2), o = new Float32Array(n);
      for (let i = 0; i < n; i++) { const a = Math.max(0, i - hk), b = Math.min(n, i - hk + k); o[i] = (cs[b] - cs[a]) / Math.max(1, b - a); }
      return (D.cache[k] = o);
    };
    D.wbal = () => D.wb || (D.wb = AN.wbalSeries(st.p, ftp, wp));
    const togs = body.querySelector('#anxTogs');
    const TG = [['p', 'Power', '--an-power', true], ['t', 'Target', '--an-tgt', D.hasT], ['hr', 'Heart rate', '--an-hr', D.hasHr], ['c', 'Cadence', '--an-cad', D.hasC], ['wb', 'W′bal', '--an-wbal', true]];
    togs.innerHTML = TG.filter(t => t[3]).map(([k, l, v]) => `<button type="button" class="anx-tog${prefs.ser[k] ? ' on' : ''}" data-s="${k}" style="--c:var(${v})" aria-pressed="${!!prefs.ser[k]}"><i></i>${l}</button>`).join('')
      + '<button type="button" class="btn sm ghost anx-reset hidden">Reset zoom</button>';
    const chart = streamChart(body.querySelector('#anxStream'), D);
    D.chart = chart;
    togs.querySelectorAll('.anx-tog').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.s; prefs.ser[k] = !prefs.ser[k]; savePrefs(); b.classList.toggle('on', prefs.ser[k]); b.setAttribute('aria-pressed', String(prefs.ser[k])); chart.render();
    }));
    const resetBtn = togs.querySelector('.anx-reset');
    D.setView = (a, b) => { D.view = [a, b]; resetBtn.classList.toggle('hidden', a === 0 && b === D.n); chart.render(); if (D.onSel) D.onSel(); };
    resetBtn.addEventListener('click', () => D.setView(0, D.n));
    bindSeg(body, 'sm', v => { prefs.sm = +v; savePrefs(); chart.render(); });
    const selEl = body.querySelector('#anxSel');
    D.onSel = () => renderSel(selEl, D);
    renderSel(selEl, D);
    if (D.ints.length) renderIntsTable(body, an, ftp, D);
  }

  function pvSVG(pv, ftp) {
    const W = 600, H = 70, n = pv.length, mx = Math.max(ftp * 1.4, ...pv) * 1.05;
    let d = `M0 ${H}`; pv.forEach((v, i) => { d += ` L${(i / (n - 1) * W).toFixed(1)} ${(H - v / mx * H).toFixed(1)}`; }); d += ` L${W} ${H} Z`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" fill="var(--an-power)" fill-opacity=".35" stroke="var(--an-power)" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  /* ---- the stream chart ---- */
  function streamChart(host, D) {
    const st = D.st;
    let drag = null;
    const geo = ch => ch.g;
    const tAt = (ch, x) => { const g = geo(ch); return clampN(Math.floor(g.v0 + (x - g.L) / g.pw * g.span), g.v0, g.v1 - 1); };
    const intAt = t => D.ints.findIndex(iv => t >= iv.s && t < iv.s + iv.d);
    function selectRange(a, b, intIdx) {
      a = clampN(Math.round(a), 0, D.n); b = clampN(Math.round(b), 0, D.n); if (b < a) [a, b] = [b, a];
      D.sel = b - a >= 3 ? [a, b] : null; D.selInt = D.sel ? (intIdx == null ? -1 : intIdx) : -1;
      if (D.sel && (a < D.view[0] || b > D.view[1])) D.setView(0, D.n);
      D.onSel && D.onSel(); D.chart && D.chart.redrawOv();
    }
    D.selectRange = selectRange;
    return mkChart(host, {
      height: w => w < 560 ? 290 : 400,
      draw(ch) {
        const { ctx, w, h, P } = ch, ser = prefs.ser;
        const [v0, v1] = D.view, span = Math.max(1, v1 - v0);
        const L = 40, R = ch.mob ? (D.hasHr ? 30 : 8) : (D.hasHr || D.hasC ? 66 : 10), T = 22, B = 20, pw = w - L - R, ph = h - T - B, base = T + ph;
        const X = t => L + (t - v0) / span * pw;
        const pa = D.smooth(prefs.sm), tg = st.tg, hr = st.hr, cd = st.c;
        const nb = Math.max(1, Math.min(span, Math.floor(pw / 2)));
        const bx = new Float32Array(nb + 1), bA = new Float32Array(nb), bMn = new Float32Array(nb), bMx = new Float32Array(nb), bT = new Float32Array(nb), bH = new Float32Array(nb), bC = new Float32Array(nb);
        let pmax = 0;
        for (let i = 0; i < nb; i++) {
          const s0 = v0 + Math.floor(i * span / nb), s1 = Math.max(s0 + 1, v0 + Math.floor((i + 1) * span / nb));
          let sp = 0, mn = Infinity, mx = 0, stt = 0, nt = 0, sh = 0, nh = 0, sc = 0, nc = 0;
          for (let k = s0; k < s1; k++) {
            const v = pa[k]; sp += v; if (v < mn) mn = v; if (v > mx) mx = v;
            const t = tg[k]; if (t > 0) { stt += t; nt++; }
            const hh = hr[k]; if (hh > 0) { sh += hh; nh++; }
            const c = cd[k]; if (c > 0) { sc += c; nc++; }
          }
          const k = s1 - s0; bx[i] = X(s0); bA[i] = sp / k; bMn[i] = mn; bMx[i] = mx;
          bT[i] = nt > k / 2 ? stt / nt : NaN; bH[i] = nh ? sh / nh : NaN; bC[i] = nc > k / 3 ? sc / nc : NaN;
          if (mx > pmax) pmax = mx; if (bT[i] > pmax) pmax = bT[i];
        }
        bx[nb] = X(Math.min(v1, v0 + span));
        const ya = niceAuto(Math.max(pmax, D.ftp * 1.2) * 1.03, ch.mob ? 4 : 5), yP = v => base - v / ya.top * ph;
        const yH = v => base - (v - D.hLo) / (D.hHi - D.hLo) * ph, yC = v => base - v / D.cMax * ph, yW = v => base - clampN(v / D.wp, 0, 1) * ph;
        ch.g = { L, R, T, B, pw, ph, base, v0, v1, span, X, yP, yH, yC, yW, pa };
        ctx.font = ch.font(10);
        // grid + left axis
        for (let k = 0; k <= ya.n; k++) { const v = ya.step * k; hline(ctx, L, L + pw, yP(v), k ? P.line : P.line2); text(ctx, fx(v, 0), L - 6, yP(v), P.dim, 'right'); }
        text(ctx, 'W', L - 6, T - 9, P.dim, 'right');
        // right axes
        if (D.hasHr && (ser.hr || !D.hasC)) {
          for (let k = 0; k <= 4; k++) { const v = D.hLo + (D.hHi - D.hLo) * k / 4; text(ctx, fx(v, 0), L + pw + 6, yH(v), rgba(P.hr, ser.hr ? .9 : .35), 'left'); }
          text(ctx, 'bpm', L + pw + 6, T - 9, rgba(P.hr, .8), 'left');
        }
        if (!ch.mob && D.hasC) {
          const cx = L + pw + (D.hasHr ? 38 : 6);
          for (let k = 0; k <= 4; k++) { const v = Math.round(D.cMax * k / 4 / 10) * 10; text(ctx, String(v), cx, yC(v), rgba(P.cad, ser.c ? .9 : .35), 'left'); }
          text(ctx, 'rpm', cx, T - 9, rgba(P.cad, .8), 'left');
        }
        // x axis
        const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 14400];
        const stp = steps.find(s => s / span * pw >= (ch.mob ? 58 : 70)) || 14400;
        for (let t = Math.ceil(v0 / stp) * stp; t <= v1; t += stp) { const x = X(t); vline(ctx, x, T, base, rgba(P.line, .6)); if (x > L + 12 && x < L + pw - 12) text(ctx, fmtTime(t), x, h - B / 2 + 1, P.dim, 'center'); }
        // work intervals: shading + strip
        ctx.save(); ctx.beginPath(); ctx.rect(L, 0, pw, h); ctx.clip();
        D.ints.forEach(iv => {
          const x0 = X(iv.s), x1 = X(iv.s + iv.d); if (x1 < L || x0 > L + pw) return;
          const work = iv.k === 'work', col = work ? P.pz[pzIdx((iv.tgt || iv.p) / D.ftp)] : P.line2;
          if (work) { ctx.fillStyle = rgba(P.text, .035); ctx.fillRect(x0, T, x1 - x0, ph); }
          rounded(ctx, x0 + 0.5, 5, Math.max(1, x1 - x0 - 1), 10, 3); ctx.fillStyle = work ? rgba(col, .9) : rgba(col, .8); ctx.fill();
        });
        ctx.restore();
        // FTP reference
        hline(ctx, L, L + pw, yP(D.ftp), rgba(P.text, .28), [3, 4]);
        ctx.font = ch.font(9.5, 700); text(ctx, 'FTP', L + 4, yP(D.ftp) - 7, rgba(P.text, .45), 'left'); ctx.font = ch.font(10);
        ctx.save(); ctx.beginPath(); ctx.rect(L, T - 2, pw, ph + 2); ctx.clip();
        if (ser.p) {
          // min/max envelope (visible when buckets hold several seconds)
          if (span / nb > 1.5) {
            ctx.beginPath(); ctx.moveTo(bx[0], yP(bMx[0]));
            for (let i = 0; i < nb; i++) { ctx.lineTo(bx[i], yP(bMx[i])); ctx.lineTo(bx[i + 1], yP(bMx[i])); }
            for (let i = nb - 1; i >= 0; i--) { ctx.lineTo(bx[i + 1], yP(bMn[i])); ctx.lineTo(bx[i], yP(bMn[i])); }
            ctx.closePath(); ctx.fillStyle = rgba(P.power, .16); ctx.fill();
          }
          // zone-coloured area, one path per zone
          const paths = P.pz.map(() => new Path2D()), used = new Array(P.pz.length).fill(false);
          for (let i = 0; i < nb; i++) {
            const v = bA[i]; if (!(v > 0)) continue; const z = pzIdx(v / D.ftp), y = yP(v);
            paths[z].rect(bx[i], y, bx[i + 1] - bx[i] + 0.6, base - y); used[z] = true;
          }
          P.pz.forEach((c, z) => { if (!used[z]) return; const g = ctx.createLinearGradient(0, T, 0, base); g.addColorStop(0, rgba(c, .95)); g.addColorStop(1, rgba(c, .38)); ctx.fillStyle = g; ctx.fill(paths[z]); });
          ctx.beginPath(); for (let i = 0; i < nb; i++) { const y = yP(bA[i]); i ? ctx.lineTo(bx[i], y) : ctx.moveTo(bx[i], y); ctx.lineTo(bx[i + 1], y); }
          ctx.strokeStyle = rgba(P.power, .95); ctx.lineWidth = 1.1; ctx.lineJoin = 'round'; ctx.stroke();
        }
        const pathOf = (arr, Y, step) => {
          ctx.beginPath(); let on = false;
          for (let i = 0; i < nb; i++) {
            const v = arr[i]; if (!(v > 0) || isNaN(v)) { on = false; continue; }
            const y = Y(v); if (!on) { ctx.moveTo(step ? bx[i] : (bx[i] + bx[i + 1]) / 2, y); on = true; } else ctx.lineTo(step ? bx[i] : (bx[i] + bx[i + 1]) / 2, y);
            if (step) ctx.lineTo(bx[i + 1], y);
          }
        };
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        if (ser.wb) {
          const wb = D.wbal(), a = new Float32Array(nb);
          for (let i = 0; i < nb; i++) { const s0 = v0 + Math.floor(i * span / nb), s1 = Math.max(s0 + 1, v0 + Math.floor((i + 1) * span / nb)); let m = Infinity; for (let k = s0; k < s1; k++) if (wb[k] < m) m = wb[k]; a[i] = Math.max(1, m); }
          pathOf(a, yW, false); ctx.strokeStyle = P.wbal; ctx.lineWidth = 1.8; ctx.stroke();
        }
        if (ser.c && D.hasC) { pathOf(bC, yC, false); ctx.strokeStyle = rgba(P.cad, .8); ctx.lineWidth = 1.1; ctx.stroke(); }
        if (ser.hr && D.hasHr) { pathOf(bH, yH, false); ctx.strokeStyle = P.hr; ctx.lineWidth = 1.7; ctx.stroke(); }
        if (ser.t && D.hasT) { ctx.save(); pathOf(bT, yP, true); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 4; ctx.stroke(); ctx.setLineDash([6, 4]); ctx.lineCap = 'butt'; ctx.strokeStyle = P.tgt; ctx.lineWidth = 2; ctx.stroke(); ctx.restore(); }
        ctx.restore();
      },
      under(ch) {
        const g = ch.g; if (!g) return;
        const c = ch.octx, P = ch.P;
        if (D.selInt >= 0 && D.ints[D.selInt]) { const iv = D.ints[D.selInt], x0 = g.X(iv.s), x1 = g.X(iv.s + iv.d); c.save(); c.lineWidth = 2; c.strokeStyle = P.text; rounded(c, x0 + .5, 4, Math.max(2, x1 - x0 - 1), 12, 3); c.stroke(); c.restore(); }
        if (!D.sel) return;
        const x0 = clampN(g.X(D.sel[0]), g.L, g.L + g.pw), x1 = clampN(g.X(D.sel[1]), g.L, g.L + g.pw); if (x1 - x0 < 0.5) return;
        c.fillStyle = rgba(P.accent, .14); c.fillRect(x0, g.T, x1 - x0, g.ph);
        vline(c, x0, g.T, g.base, rgba(P.accent, .9)); vline(c, x1, g.T, g.base, rgba(P.accent, .9));
      },
      hover(ch, x, y) {
        const g = ch.g; if (!g || x < g.L - 4 || x > g.L + g.pw + 4) return null;
        const t = tAt(ch, x), xx = g.X(t + 0.5), c = ch.octx, P = ch.P, ser = prefs.ser;
        vline(c, xx, g.T, g.base, rgba(P.text, .45));
        const pv = g.pa[t], tv = st.tg[t], hv = st.hr[t], cv = st.c[t];
        if (ser.wb) dot(c, xx, g.yW(D.wbal()[t]), P.wbal, P.panel, 3);
        if (ser.c && cv > 0) dot(c, xx, g.yC(cv), P.cad, P.panel, 3);
        if (ser.hr && hv > 0) dot(c, xx, g.yH(hv), P.hr, P.panel, 3);
        if (ser.p) dot(c, xx, g.yP(pv), P.power, P.panel, 4);
        const zi = pzIdx(pv / D.ftp), ii = intAt(t), iv = D.ints[ii];
        let s = `<div class="t">${fmtTime(t)}${iv ? ` <span>#${ii + 1} ${iv.k === 'work' ? 'work' : 'recovery'}</span>` : ''}</div>`;
        s += trow(P.power, 'Power', `${Math.round(pv)} W`, `<em style="color:${PZ[zi].col}">${PZ[zi].n}</em>`);
        if (D.hasT && tv > 0) s += trow(P.tgt, 'Target', `${Math.round(tv)} W`, `<em>${Math.round(pv / tv * 100)}%</em>`);
        if (D.hasHr) s += trow(P.hr, 'Heart rate', hv > 0 ? `${Math.round(hv)} bpm` : '–');
        if (D.hasC) s += trow(P.cad, 'Cadence', cv > 0 ? `${Math.round(cv)} rpm` : '–');
        if (ser.wb) { const wb = D.wbal()[t]; s += trow(P.wbal, 'W′bal', `${(wb / 1000).toFixed(1)} kJ`, `<em>${Math.round(wb / D.wp * 100)}%</em>`); }
        if (D.sel && drag && drag.sel) s += `<div class="h">Selection ${fmtTime(D.sel[1] - D.sel[0])}</div>`;
        return s;
      },
      down(ch, x, y, e) {
        const g = ch.g; if (!g) return;
        const t0 = tAt(ch, x);
        if (e.pointerType === 'mouse') {
          if (e.button !== 0) return;
          drag = { x0: x, t0, sel: false, mouse: true };
          try { ch.oc.setPointerCapture(e.pointerId); } catch (er) { }
        } else {
          drag = { x0: x, y0: y, t0, sel: false, mouse: false };
          drag.lp = setTimeout(() => { if (!drag) return; drag.sel = true; D.sel = [t0, t0 + 1]; D.selInt = -1; ch.wrap.classList.add('selecting'); if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) { try { navigator.vibrate(12); } catch (er) { } } ch.redrawOv(); }, 420);
        }
      },
      move(ch, x, y) {
        if (!drag) return;
        if (!drag.mouse && !drag.sel && Math.hypot(x - drag.x0, y - drag.y0) > 9) { clearTimeout(drag.lp); }
        if (drag.mouse && !drag.sel && Math.abs(x - drag.x0) > 4) { drag.sel = true; D.selInt = -1; }
        if (drag.sel) { const t = tAt(ch, x); D.sel = t >= drag.t0 ? [drag.t0, t + 1] : [t, drag.t0 + 1]; }
      },
      up(ch, x, y) {
        if (!drag) return;
        clearTimeout(drag.lp); ch.wrap.classList.remove('selecting');
        const d = drag; drag = null;
        if (d.sel && D.sel) { selectRange(D.sel[0], D.sel[1], null); if (ch.ptype !== 'mouse') ch.unhover(); }
      },
      tap(ch, x, y) {
        const g = ch.g; if (!g) return;
        if (y < g.T - 1) { const i = intAt(tAt(ch, x)); if (i >= 0) { const iv = D.ints[i]; selectRange(iv.s, iv.s + iv.d, i); markRow(i); } }
      },
      cancel(ch) { if (drag) clearTimeout(drag.lp); drag = null; ch.wrap.classList.remove('selecting'); },
      dbl() { D.sel = null; D.selInt = -1; D.onSel && D.onSel(); markRow(-1); D.setView(0, D.n); },
    });
    function markRow(i) { const tb = document.getElementById('anxInts'); if (tb) tb.querySelectorAll('tr[data-i]').forEach(tr => tr.classList.toggle('on', +tr.dataset.i === i)); }
  }

  function renderSel(el, D) {
    if (!D.sel) {
      el.innerHTML = `<div class="anx-selhint">${matchMedia('(pointer:coarse)').matches ? 'Long-press the chart and drag' : 'Drag across the chart'} to analyse a range${D.ints.length ? ', or pick an interval in the strip above the chart or in the table' : ''}.</div>`;
      return;
    }
    const [a, b] = D.sel, rs = AN.rangeStats(D.st, a, b, D.ftp), iv = D.selInt >= 0 ? D.ints[D.selInt] : null;
    const pct = rs.tgt ? Math.round(rs.avgP / rs.tgt * 100) : null;
    const item = (k, v, u, s) => `<div class="si"><span class="k">${k}</span><b class="num">${v}<small>${u || ''}</small></b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    const zoomed = D.view[0] <= a && D.view[1] >= b && D.view[1] - D.view[0] <= (b - a) * 1.25 + 40;
    el.innerHTML = `<div class="anx-selh"><div><b>${iv ? `Interval ${D.selInt + 1} · ${iv.k === 'work' ? 'work' : 'recovery'}` : 'Selection'}</b><span class="num">${fmtTime(a)} → ${fmtTime(b)} · ${fmtTime(rs.d)}</span></div>
      <div class="row">${zoomed ? '' : '<button type="button" class="btn sm" data-a="zoom">Zoom in</button>'}<button type="button" class="btn sm ghost" data-a="clear" aria-label="Clear selection">Clear</button></div></div>
      <div class="anx-selg">${item('Avg power', rs.avgP, ' W', `${(rs.avgP / D.kg).toFixed(2)} W/kg · ${Math.round(rs.avgP / D.ftp * 100)}% FTP`)}${item('Norm. power', rs.np, ' W')}${item('Max power', rs.maxP, ' W')}
      ${rs.tgt ? item('Target', rs.tgt, ' W', `<span class="${pct >= 95 && pct <= 105 ? 'good' : pct >= 90 && pct <= 110 ? 'meh' : 'bad'}">${pct}% compliance</span>`) : ''}
      ${rs.avgHr ? item('Heart rate', rs.avgHr, ' bpm', `max ${rs.maxHr}`) : ''}${rs.avgC ? item('Cadence', rs.avgC, ' rpm') : ''}${item('Work', rs.kj, ' kJ')}${rs.dist ? item('Distance', (rs.dist / 1000).toFixed(2), ' km') : ''}
      ${rs.avgHr ? item('Pw:HR', (rs.avgP / rs.avgHr).toFixed(2), '', 'W per beat') : ''}</div>`;
    el.querySelector('[data-a="clear"]').addEventListener('click', () => { D.sel = null; D.selInt = -1; renderSel(el, D); D.chart.redrawOv(); const tb = document.getElementById('anxInts'); if (tb) tb.querySelectorAll('tr.on').forEach(tr => tr.classList.remove('on')); });
    const z = el.querySelector('[data-a="zoom"]'); if (z) z.addEventListener('click', () => { const pad = Math.max(0, Math.round((b - a) * 0.04)); D.setView(Math.max(0, a - pad), Math.min(D.n, Math.max(b + pad, a + 20))); });
  }

  function renderIntsTable(body, an, ftp, D) {
    const el = body.querySelector('#anxInts'); if (!el) return;
    const hasT = an.ints.some(iv => iv.tgt > 0);
    const comp = (p, t) => { if (!hasT) return ''; if (!t) return '<td class="dim">–</td>'; const pc = Math.round(p / t * 100); return `<td class="num ${pc >= 95 && pc <= 105 ? 'good' : pc >= 90 && pc <= 110 ? 'meh' : 'bad'}">${pc}%</td>`; };
    el.innerHTML = `<table class="anx-tbl anx-ints"><thead><tr><th>#</th><th>Start</th><th>Time</th><th>Avg</th>${hasT ? '<th>Target</th><th>%</th>' : ''}<th>NP</th><th>HR</th><th>Max HR</th><th>Cad</th></tr></thead><tbody>${an.ints.map((iv, i) => {
      const z = PZ[pzIdx((iv.tgt || iv.p) / ftp)];
      return `<tr data-i="${i}" class="${iv.k === 'work' ? 'work' : 'rec'}" ${D ? 'tabindex="0"' : ''}><td><span class="ib" style="background:${iv.k === 'work' ? z.col : 'var(--line2)'}"></span>${i + 1}</td><td class="num">${fmtTime(iv.s)}</td><td class="num">${fmtTime(iv.d)}</td>
        <td class="num"><b>${fx(iv.p)}</b> <span class="dim">W</span></td>${hasT ? `<td class="num">${iv.tgt ? iv.tgt + ' W' : '<span class="dim">–</span>'}</td>` : ''}${comp(iv.p, iv.tgt)}<td class="num">${fx(iv.np)}</td>
        <td class="num">${iv.hr ? iv.hr : '<span class="dim">–</span>'}</td><td class="num">${iv.hrMax ? iv.hrMax : '<span class="dim">–</span>'}</td><td class="num">${iv.c ? iv.c : '<span class="dim">–</span>'}</td></tr>`;
    }).join('')}</tbody></table>`;
    if (!D) return;
    const pick = tr => {
      const i = +tr.dataset.i, iv = an.ints[i]; el.querySelectorAll('tr.on').forEach(x => x.classList.remove('on')); tr.classList.add('on');
      D.selectRange(iv.s, iv.s + iv.d, i);
      const c = body.querySelector('.anx-streamc'); if (c) { const r = c.getBoundingClientRect(); if (r.top < 60 || r.top > window.innerHeight * 0.5) c.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); }
    };
    el.querySelectorAll('tr[data-i]').forEach(tr => {
      tr.addEventListener('click', () => pick(tr));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(tr); } });
    });
  }

  // touch selection: stop the page from scrolling while a long-press drag selects a range
  document.addEventListener('touchmove', e => { const w = e.target && e.target.closest && e.target.closest('.anx-cv.selecting'); if (w) e.preventDefault(); }, { passive: false });

  return { renderProgress: renderProgressImpl, openRide, closeRide, mkChart, durLbl };
})();
