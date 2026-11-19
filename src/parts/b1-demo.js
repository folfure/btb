// Demo data: while the simulator is on, History and Progress show a generated rider (about 18 weeks of rides,
// a weight log and a body profile) so every analysis feature can be explored. Nothing here is ever stored,
// synced or uploaded: it lives in memory and disappears when the simulator is turned off.
const DEMO = (() => {
  let cache = null;
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const dk = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const pick = (rand, list) => list[Math.floor(rand() * list.length)];
  function workouts() {
    const lib = (typeof LIBRARY !== 'undefined' ? LIBRARY : []).filter(w => w && w.seg);
    const by = re => lib.filter(w => re.test(w.cat || '') && (() => { try { const t = expand(w).total; return t >= 1500 && t <= 7200; } catch { return false; } })());
    return { hard: by(/VO2max|Threshold|Over-Under|Anaerobic/), mid: by(/Sweet Spot|Tempo/), easy: by(/Endurance|Recovery/), test: lib.filter(w => /ramp/i.test(w.name) && w.cat === 'Test') };
  }
  // one ride: target from the real workout structure, power/HR/cadence from a simple rider model
  function ride(rand, w, date, ftp, kg, maxHr, restHr, fresh, trueFtp) {
    const { segs, total } = expand(w), n = Math.min(total, 7200);
    const p = new Array(n), hr = new Array(n), c = new Array(n), dd = new Array(n), tg = new Array(n);
    let h = restHr + 15, d = 0, si = 0, fade = 1;
    const ramp = /ramp/i.test(w.name), mapW = trueFtp * 1.33 * (0.97 + rand() * 0.06); // the rider's real 1-min ramp limit
    let end = n;
    for (let i = 0; i < n; i++) {
      while (si < segs.length - 1 && i >= segs[si].start + segs[si].d) si++;
      const s = segs[si], f = s.d ? (i - s.start) / s.d : 0;
      let frac = s.kind === 'ramp' ? s.p0 + (s.p1 - s.p0) * f : s.kind === 'free' ? (s.est || 1.6) : (s.p0 ?? 0.6);
      if (ramp && frac * ftp > mapW) { end = i; break; } // ramp test: the rider pops near MAP
      const t = Math.round(frac * ftp);
      if (frac > 1) fade = Math.max(0.93, fade - 0.00004 * (frac - 1) * 60); else fade = Math.min(1, fade + 0.0005);
      let pw = s.kind === 'free' ? trueFtp * 1.5 * (1.05 - 0.35 * f) : t * (frac > 1 && !ramp ? fade : 1) * (fresh ? 1.01 : 0.99);
      pw = Math.max(0, Math.round(pw * (1 + (rand() - 0.5) * 0.06) + (rand() - 0.5) * 6));
      if (s.kind !== 'free' && i > 30 && rand() < 0.002) pw = 0; // a short coast
      const pf = pw / ftp, ss = restHr + (maxHr - restHr) * Math.min(1, 0.22 + 0.62 * Math.pow(Math.min(pf, 1.3), 0.85)) + i / 60 * 0.06;
      h += (ss - h) / (pf > (hr[i - 1] || 0) ? 22 : 35);
      p[i] = pw; tg[i] = s.kind === 'free' ? 0 : t; hr[i] = Math.round(Math.min(maxHr, h + (rand() - 0.5) * 2));
      c[i] = pw ? Math.round((s.c || (s.kind === 'free' ? 105 : 88)) + (rand() - 0.5) * 6) : 0;
      d += typeof speedFromPower === 'function' ? speedFromPower(pw) : pw / 25; dd[i] = Math.round(d);
    }
    for (const a of [p, hr, c, dd, tg]) a.length = end;
    const st = { p, hr, c, dd, tg }, len = p.length || 1;
    const sum = a => a.reduce((x, y) => x + y, 0), hrs = hr.filter(Boolean), cs = c.filter(Boolean);
    const np = typeof AN !== 'undefined' ? AN.np(p) : Math.round(sum(p) / len), IF = +(np / ftp).toFixed(2);
    const r = {
      id: 'demo-' + date.getTime().toString(36), demo: true, date: date.toISOString(), name: w.name, wid: w.id, cat: w.cat, completed: true,
      dur: len, avgP: Math.round(sum(p) / len), np, maxP: Math.max(0, ...p), kj: Math.round(sum(p) / 1000),
      avgHr: hrs.length ? Math.round(sum(hrs) / hrs.length) : null, maxHr: hrs.length ? Math.max(...hrs) : null,
      avgC: cs.length ? Math.round(sum(cs) / cs.length) : null, ftp, dist: dd[len - 1] || 0, IF, tss: Math.round(len / 3600 * IF * IF * 100), wt: kg,
    };
    if (typeof AN !== 'undefined') try { r.an = AN.analyzeRide(st, { ftp, maxHr, weight: kg, wprime: 18000 }); } catch { }
    if (typeof preview === 'function') r.pv = preview(p);
    return { r, st };
  }
  function build() {
    const rand = rng(20261119), W = workouts(), rides = [], streams = new Map(), wlog = [];
    const now = new Date(), start = new Date(now); start.setHours(18, 0, 0, 0); start.setDate(start.getDate() - 7 * 18);
    const days = Math.round((now - start) / 864e5), maxHr = 182, rest0 = 56, born = now.getFullYear() - 44;
    let ftp = 210, kg0 = 61.6;
    for (let k = 0; k <= days; k++) {
      const date = new Date(start); date.setDate(start.getDate() + k);
      const prog = k / days, kg = +(kg0 - 2.6 * prog + Math.sin(k / 3) * 0.25 + (rand() - 0.5) * 0.3).toFixed(1), restHr = Math.round(rest0 - 4 * prog + (rand() - 0.5) * 3);
      if (rand() < 0.75 && k < days) wlog.push({ d: dk(date), kg, rhr: restHr });
      const dow = date.getDay(), week = Math.floor(k / 7), easyWeek = week % 4 === 3;
      if (date > now) break;
      let w = null;
      if (k % 42 === 0 && W.test.length) w = W.test[0];
      else if (dow === 2 && !easyWeek) w = pick(rand, W.hard);
      else if (dow === 4) w = pick(rand, easyWeek ? W.easy : W.mid);
      else if (dow === 6 || dow === 0 && rand() < 0.5) w = pick(rand, W.easy);
      if (!w || rand() < 0.08) continue;
      const at = new Date(date); at.setHours(dow === 6 || dow === 0 ? 9 : 18, Math.floor(rand() * 50), 0, 0);
      if (at > now) continue;
      const trueFtp = 214 + 32 * prog; // the rider gets fitter over the 18 weeks
      const { r, st } = ride(rand, w, at, ftp, kg, maxHr, restHr, easyWeek, trueFtp);
      if (/ramp/i.test(w.name) && r.an) { const m1 = AN.mmpCurve(st.p)[AN.MMP_DUR.indexOf(60)]; if (m1) ftp = Math.round(m1 * 0.75); r.name = w.name + ' (FTP → ' + ftp + ' W)'; }
      rides.unshift(r); streams.set(r.id, st);
    }
    const last = wlog[wlog.length - 1], target = new Date(now); target.setDate(target.getDate() + 70);
    const body = { sex: 'f', birthYear: born, height: 168, weight: last ? last.kg : 59, maxHr, restHr: last ? last.rhr : 52, ftp, wprime: 18000, targetWeight: 56, targetDate: dk(target), wlog };
    return { rides, streams, body };
  }
  const data = () => (cache ||= build());
  return {
    get active() { return typeof sim !== 'undefined' && sim.on; },
    rides() { return data().rides; },
    streams(id) { const st = data().streams.get(id); return st ? { ...st } : null; },
    body() { return data().body; },
  };
})();
// what the history and analytics views show: the user's own rides, plus the demo rider while the simulator is on
function viewHistory() { const own = load('erglab.history', []); return DEMO.active ? own.concat(DEMO.rides()).sort((a, b) => String(b.date).localeCompare(String(a.date))) : own; }
function viewS() { return DEMO.active ? Object.assign({}, S, DEMO.body()) : S; }
