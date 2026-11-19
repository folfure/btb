// BTB analysis engine (intervals.icu-style metrics). Pure functions, no DOM, no globals except AN.
// Uses the template's PZ / HZ zone tables when present (falls back to the same fractions otherwise).
// Never throws on odd input: bad samples (NaN, null, negative) count as 0, impossible results are null.
const AN = (() => {
  const VER = 2; // bump whenever the stored analysis layout changes (2: MMP_DUR gained 480 s)
  const MMP_DUR = [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 480, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200];
  const PZ_HI = [0.55, 0.75, 0.90, 1.05, 1.20, 1.50, 9];
  const HZ_HI = [0.60, 0.70, 0.80, 0.90, 9];
  const pHi = () => (typeof PZ !== 'undefined' && Array.isArray(PZ) && PZ.length === 7) ? PZ.map(z => +z.hi) : PZ_HI;
  const hHi = () => (typeof HZ !== 'undefined' && Array.isArray(HZ) && HZ.length === 5) ? HZ.map(z => +z.hi) : HZ_HI;
  const zoneIdx = (f, his) => { for (let i = 0; i < his.length; i++) if (f < his[i] - 1e-9) return i; return his.length - 1; };

  const num = v => { v = +v; return isFinite(v) && v > 0 ? v : 0; };
  // sanitized Float64Array copy of a stream (length n; missing/odd samples -> 0)
  const clean = (a, n) => {
    const o = new Float64Array(n);
    if (Array.isArray(a) || ArrayBuffer.isView(a)) { const m = Math.min(n, a.length); for (let i = 0; i < m; i++) o[i] = num(a[i]); }
    return o;
  };
  const arr = a => (Array.isArray(a) || ArrayBuffer.isView(a)) ? a : [];
  const r1 = x => Math.round(x * 10) / 10;
  const r2 = x => Math.round(x * 100) / 100;
  const posNum = v => { v = +v; return isFinite(v) && v > 0 ? v : 0; };

  // ---------- power curve ----------
  function mmpCurve(p) {
    p = arr(p); const n = p.length;
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + num(p[i]);
    return MMP_DUR.map(d => {
      if (d > n || n === 0) return null;
      let best = 0;
      for (let i = d; i <= n; i++) { const s = cs[i] - cs[i - d]; if (s > best) best = s; }
      return Math.round(best / d);
    });
  }

  // normalized power: 30 s rolling average (first value at 30 s), mean of 4th powers, 4th root
  function npOf(p, a, b) {
    const n = b - a; if (n < 30) return 0;
    let win = 0, sum4 = 0, cnt = 0;
    for (let i = a; i < b; i++) {
      win += p[i]; if (i - a >= 30) win -= p[i - 30];
      if (i - a >= 29) { const m = win / 30; sum4 += m * m * m * m; cnt++; }
    }
    return cnt ? Math.pow(sum4 / cnt, 0.25) : 0;
  }
  function np(p) { p = arr(p); const c = clean(p, p.length); return Math.round(npOf(c, 0, c.length)); }

  // ---------- W'bal (Skiba differential model) ----------
  function wbalRaw(p, cp, wp) {
    const n = p.length, o = new Float64Array(n); let w = wp;
    for (let i = 0; i < n; i++) {
      const x = p[i];
      if (x < cp) w += (cp - x) * (wp - w) / wp; else w -= (x - cp);
      o[i] = w;
    }
    return o;
  }
  function wbalSeries(p, cp, wprime) {
    p = arr(p); cp = posNum(cp); const wp = posNum(wprime) || 20000;
    if (!cp) return [];
    return Array.from(wbalRaw(clean(p, p.length), cp, wp), Math.round);
  }

  // ---------- range stats ----------
  function statsOf(P, H, C, T, D, a, b, hasT) {
    const d = b - a;
    let sp = 0, mx = 0, sh = 0, nh = 0, mh = 0, sc = 0, nc = 0, st = 0, nt = 0;
    for (let i = a; i < b; i++) {
      const x = P[i]; sp += x; if (x > mx) mx = x;
      const h = H[i]; if (h > 0) { sh += h; nh++; if (h > mh) mh = h; }
      const c = C[i]; if (c > 0) { sc += c; nc++; }
      if (hasT) { const t = T[i]; if (t > 0) { st += t; nt++; } }
    }
    const avgP = d > 0 ? Math.round(sp / d) : 0;
    let dist = 0;
    if (D && d > 0) { dist = Math.round(Math.max(0, D[b - 1] - (a > 0 ? D[a - 1] : 0))); }
    return {
      d, avgP, np: d >= 30 ? Math.round(npOf(P, a, b)) : avgP, maxP: Math.round(mx),
      avgHr: nh ? Math.round(sh / nh) : null, maxHr: nh ? Math.round(mh) : null,
      avgC: nc ? Math.round(sc / nc) : null, kj: Math.round(sp / 1000), tgt: nt ? Math.round(st / nt) : null, dist,
    };
  }
  // stats for seconds [a, b). np falls back to avgP when the range is shorter than 30 s.
  function rangeStats(st, a, b, ftp) { // ftp kept for API symmetry (not needed for these numbers)
    try {
      st = st || {}; const P0 = arr(st.p), n = P0.length;
      a = Math.max(0, Math.min(n, Math.floor(+a) || 0)); b = Math.max(a, Math.min(n, Math.floor(+b) || 0));
      const hasT = arr(st.tg).length > 0, hasD = arr(st.dd).length > 0;
      // the cumulative distance stream is monotone; clean() would zero gaps, so hold the last value instead
      return statsOf(clean(P0, n), clean(st.hr, n), clean(st.c, n), hasT ? clean(st.tg, n) : null, hasD ? holdCum(st.dd, n) : null, a, b, hasT);
    } catch (e) { return { d: 0, avgP: 0, np: 0, maxP: 0, avgHr: null, maxHr: null, avgC: null, kj: 0, tgt: null, dist: 0 }; }
  }
  function holdCum(a, n) {
    const o = new Float64Array(n); let last = 0; a = arr(a);
    for (let i = 0; i < n; i++) { const v = +a[i]; if (isFinite(v) && v >= last) last = v; o[i] = last; }
    return o;
  }

  // ---------- interval detection ----------
  // Piece: { s, e } (seconds [s, e)). Short pieces (<10 s) are merged into the neighbour whose level is closest.
  function mergeShort(pieces, level) {
    const out = []; let carry = null;
    for (let i = 0; i < pieces.length; i++) {
      let pc = pieces[i];
      if (carry) { pc = { s: carry.s, e: pc.e }; carry = null; }
      if (pc.e - pc.s >= 10) { out.push(pc); continue; }
      const prev = out[out.length - 1], next = pieces[i + 1];
      if (!prev && !next) { out.push(pc); continue; }
      if (prev && (!next || Math.abs(level(pc) - level(prev)) <= Math.abs(level(pc) - level(next)))) prev.e = pc.e;
      else carry = pc;
    }
    if (carry) { const prev = out[out.length - 1]; if (prev) prev.e = carry.e; else out.push(carry); }
    return out;
  }

  // Split the target stream into steady blocks and ramps (swinging-door piecewise-linear segmentation, O(n)).
  function targetPieces(T, n, ftp) {
    const tol = Math.max(2, 0.01 * ftp), pieces = [];
    let s = 0;
    while (s < n) {
      const free = !(T[s] > 0);
      let i = s + 1;
      if (free) { while (i < n && !(T[i] > 0)) i++; pieces.push({ s, e: i }); s = i; continue; }
      const v0 = T[s]; let lo = -Infinity, hi = Infinity;
      for (; i < n; i++) {
        if (!(T[i] > 0)) break;
        const dt = i - s;
        const l = Math.max(lo, (T[i] - tol - v0) / dt), h = Math.min(hi, (T[i] + tol - v0) / dt);
        if (l > h) break;
        lo = l; hi = h;
      }
      let cut = i;
      if (i < n && T[i] > 0 && Math.abs(T[i] - T[i - 1]) <= tol && i - s > 2) {
        // the door closed on a slope change, not a jump: put the corner where the level/slope really changed
        if (Math.abs(T[s + ((i - s) >> 1)] - v0) <= tol) { // level block (still at its level halfway) followed by a ramp: cut after the last sample at the block's level
          let j = i - 1; while (j > s && Math.abs(T[j] - v0) >= 0.5) j--; cut = j + 1;
        } else { // ramp followed by a flat block: cut at the start of the flat tail
          let j = i - 1; while (j - 1 > s && Math.abs(T[j - 1] - T[i - 1]) < 0.5) j--;
          if (i - j >= 2) cut = j;
        }
        if (cut <= s) cut = i;
      }
      pieces.push({ s, e: cut }); s = cut;
    }
    return pieces;
  }

  // free ride: 30 s centred-smoothed power >= 0.9 FTP for >= 30 s (exit below 0.8 FTP); edges refined on raw power
  function powerPieces(P, n, ftp) {
    const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + P[i];
    const sm = i => { const a = Math.max(0, i - 15), b = Math.min(n, i + 15); return (cs[b] - cs[a]) / (b - a); };
    const on = 0.9 * ftp, off = 0.8 * ftp, edge = 0.85 * ftp, efforts = [];
    let i = 0;
    while (i < n) {
      if (sm(i) < on) { i++; continue; }
      let a = i; while (i < n && sm(i) >= off) i++;
      let b = i;
      for (let k = 0; k < 20 && a > 0 && P[a - 1] >= edge; k++) a--;
      while (a < b && P[a] < edge) a++;
      for (let k = 0; k < 20 && b < n && P[b] >= edge; k++) b++;
      while (b > a && P[b - 1] < edge) b--;
      const lastE = efforts[efforts.length - 1];
      if (lastE && a <= lastE.e) { lastE.e = Math.max(lastE.e, b); continue; }
      if (b - a >= 30) efforts.push({ s: a, e: b });
      i = Math.max(i, b);
    }
    const pieces = []; let t = 0;
    for (const ef of efforts) { if (ef.s > t) pieces.push({ s: t, e: ef.s }); pieces.push(ef); t = ef.e; }
    if (t < n) pieces.push({ s: t, e: n });
    return pieces;
  }

  function detectIntervals(P, H, C, T, D, n, ftp, hasT) {
    if (!(ftp > 0) || n < 1) return [];
    const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + P[i];
    const avgPw = pc => (cs[pc.e] - cs[pc.s]) / Math.max(1, pc.e - pc.s);
    let pieces, level, kind;
    if (hasT) {
      const ct = new Float64Array(n + 1), cn = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) { ct[i + 1] = ct[i] + T[i]; cn[i + 1] = cn[i] + (T[i] > 0 ? 1 : 0); }
      const tAvg = pc => { const k = cn[pc.e] - cn[pc.s]; return k ? (ct[pc.e] - ct[pc.s]) / k : 0; };
      const freeFrac = pc => 1 - (cn[pc.e] - cn[pc.s]) / Math.max(1, pc.e - pc.s);
      level = pc => freeFrac(pc) > 0.5 ? -1 - avgPw(pc) / 1e4 : tAvg(pc); // free pieces sort apart from targets
      kind = pc => (freeFrac(pc) > 0.5 ? avgPw(pc) : tAvg(pc)) >= 0.85 * ftp ? 'work' : 'rec';
      pieces = mergeShort(targetPieces(T, n, ftp), level);
    } else {
      level = avgPw;
      kind = pc => avgPw(pc) >= 0.85 * ftp ? 'work' : 'rec';
      pieces = mergeShort(powerPieces(P, n, ftp), level);
    }
    pieces.forEach(pc => { pc.k = kind(pc); });
    if (pieces.length > 60) { // join neighbours of the same kind, then fold the shortest pieces away
      const j = [];
      for (const pc of pieces) { const l = j[j.length - 1]; if (l && l.k === pc.k) l.e = pc.e; else j.push(pc); }
      pieces = j;
      while (pieces.length > 60) {
        let m = 0; for (let i = 1; i < pieces.length; i++) if (pieces[i].e - pieces[i].s < pieces[m].e - pieces[m].s) m = i;
        const nb = m === 0 ? 1 : m === pieces.length - 1 ? m - 1 : (pieces[m - 1].e - pieces[m - 1].s >= pieces[m + 1].e - pieces[m + 1].s ? m - 1 : m + 1);
        const a = Math.min(m, nb); pieces[a] = { s: pieces[a].s, e: pieces[a + 1].e, k: null }; pieces.splice(a + 1, 1);
        pieces[a].k = kind(pieces[a]);
      }
    }
    return pieces.map(pc => {
      const r = statsOf(P, H, C, T, D, pc.s, pc.e, hasT);
      return { s: pc.s, d: pc.e - pc.s, k: pc.k, p: r.avgP, np: r.np, tgt: r.tgt, hr: r.avgHr, hrMax: r.maxHr, c: r.avgC };
    });
  }

  // ---------- one ride ----------
  function analyzeRide(st, ctx) {
    st = st || {}; ctx = ctx || {};
    const P0 = arr(st.p), n = P0.length;
    const ftp = posNum(ctx.ftp), maxHr = posNum(ctx.maxHr);
    const P = clean(P0, n), H = clean(st.hr, n), C = clean(st.c, n);
    const hasT = (() => { const t = arr(st.tg); for (let i = 0; i < Math.min(n, t.length); i++) if (num(t[i]) > 0) return true; return false; })();
    const T = hasT ? clean(st.tg, n) : null;
    const D = arr(st.dd).length ? holdCum(st.dd, n) : null;

    const tiz = [0, 0, 0, 0, 0, 0, 0]; let coast = 0, sumP = 0;
    const ph = pHi();
    for (let i = 0; i < n; i++) {
      const x = P[i]; sumP += x;
      if (x <= 0) { coast++; continue; }
      if (ftp) tiz[zoneIdx(x / ftp, ph)]++;
    }
    let thz = null, sh = 0, nh = 0;
    for (let i = 0; i < n; i++) if (H[i] > 0) { sh += H[i]; nh++; }
    if (nh && maxHr) { thz = [0, 0, 0, 0, 0]; const hh = hHi(); for (let i = 0; i < n; i++) if (H[i] > 0) thz[zoneIdx(H[i] / maxHr, hh)]++; }

    const npv = Math.round(npOf(P, 0, n)), avgP = n ? Math.round(sumP / n) : 0;
    const avgHr = nh ? sh / nh : 0;

    // aerobic decoupling: moving seconds (p > 0) split in two halves by count, ratio avgP/avgHr (HR > 0 seconds)
    let dec = null;
    if (nh >= 1200) {
      const mv = []; for (let i = 0; i < n; i++) if (P[i] > 0) mv.push(i);
      const half = mv.length >> 1;
      const ratio = (a, b) => { let sp = 0, s2 = 0, k = 0; for (let j = a; j < b; j++) { const i = mv[j]; sp += P[i]; if (H[i] > 0) { s2 += H[i]; k++; } } return k && b > a ? (sp / (b - a)) / (s2 / k) : 0; };
      const a1 = ratio(0, half), a2 = ratio(half, mv.length);
      if (a1 > 0 && a2 > 0) dec = r1((a1 - a2) / a1 * 100);
    }

    const cp = posNum(ctx.cp) || ftp, wp = posNum(ctx.wprime) || 20000;
    let wbalMin = null;
    if (cp && n) { const w = wbalRaw(P, cp, wp); let m = wp; for (let i = 0; i < n; i++) if (w[i] < m) m = w[i]; wbalMin = Math.round(m); }

    let ints = [];
    try { ints = detectIntervals(P, H, C, T, D, n, ftp, hasT); } catch (e) { ints = []; }

    return {
      v: VER, mmp: mmpCurve(P), tiz, coast, thz, np: npv, avgP,
      vi: avgP > 0 && npv > 0 ? r2(npv / avgP) : null,
      ef: avgHr > 0 && npv > 0 ? r2(npv / avgHr) : null,
      dec, wbalMin, ints,
    };
  }

  // ---------- critical power ----------
  // Least-squares fit of work = W' + CP * t over best efforts of 2-20 min (the classic 2-parameter model).
  // eFTP = 96 % of CP: CP from 2-20 min efforts sits a few % above a 60-min power (FTP); 0.96 matches
  // the usual "FTP ~ 95 % of a 20-min best" rule for typical W' values.
  function cpFit(curve) {
    curve = arr(curve); const xs = [], ys = [];
    for (let i = 0; i < MMP_DUR.length; i++) {
      const t = MMP_DUR[i], w = +curve[i];
      if (t >= 120 && t <= 1200 && isFinite(w) && w > 0) { xs.push(t); ys.push(w * t); }
    }
    const k = xs.length; if (k < 3) return null;
    let mx = 0, my = 0; for (let i = 0; i < k; i++) { mx += xs[i]; my += ys[i]; } mx /= k; my /= k;
    let sxy = 0, sxx = 0; for (let i = 0; i < k; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    if (!(sxx > 0)) return null;
    const cp = sxy / sxx, wprime = my - cp * mx;
    if (!(cp > 0) || !(wprime > 0) || !isFinite(cp) || !isFinite(wprime)) return null;
    return { cp: Math.round(cp), wprime: Math.round(wprime), eftp: Math.round(cp * 0.96), pts: k };
  }

  // ---------- dates ----------
  const pad = x => String(x).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function toDate(x) {
    if (x instanceof Date) return isNaN(x) ? null : x;
    if (typeof x === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x); // a bare day is a local day, not UTC midnight
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    if (x == null || x === '') return null;
    const d = new Date(x); return isNaN(d) ? null : d;
  }
  function dayKey(date) { const d = toDate(date); return d ? keyOf(d) : null; }
  const tsOf = x => { const d = toDate(x); return d ? d.getTime() : NaN; };
  const keyDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
  const mondayOf = d => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
  const rideList = rides => arr(rides).filter(r => r && typeof r === 'object' && toDate(r.date));

  // ---------- many rides ----------
  function bestCurve(rides, fromISO, toISO) {
    const L = MMP_DUR.length, w = Array(L).fill(null), id = Array(L).fill(null), date = Array(L).fill(null);
    const a = fromISO == null ? -Infinity : tsOf(fromISO), b = toISO == null ? Infinity : tsOf(toISO);
    for (const r of rideList(rides)) {
      const t = tsOf(r.date);
      if (!(t >= (isNaN(a) ? -Infinity : a) && t < (isNaN(b) ? Infinity : b))) continue;
      const m = r.an && arr(r.an.mmp); if (!m || !m.length) continue;
      for (let i = 0; i < L; i++) {
        const v = +m[i];
        if (m[i] != null && isFinite(v) && v > 0 && (w[i] == null || v > w[i])) { w[i] = v; id[i] = r.id == null ? null : String(r.id); date[i] = r.date; }
      }
    }
    return { w, id, date };
  }

  function fitnessSeries(rides, fromISO) {
    const byDay = new Map(); let first = null;
    for (const r of rideList(rides)) {
      const k = dayKey(r.date), t = +r.tss;
      byDay.set(k, (byDay.get(k) || 0) + (isFinite(t) && t > 0 ? t : 0));
      if (first == null || k < first) first = k;
    }
    const fromKey = fromISO == null ? null : dayKey(fromISO);
    const today = keyOf(new Date());
    let startKey = first;
    if (fromKey && (!startKey || fromKey < startKey)) startKey = fromKey;
    if (!startKey || startKey > today) return [];
    const out = []; let ctl = 0, atl = 0, d = keyDate(startKey);
    for (let guard = 0; guard < 40000; guard++) {
      const k = keyOf(d); if (k > today) break;
      const tss = byDay.get(k) || 0;
      ctl += (tss - ctl) / 42; atl += (tss - atl) / 7;
      if (!fromKey || k >= fromKey) out.push({ d: k, tss: r1(tss), ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) });
      d = addDays(d, 1);
    }
    return out;
  }

  function weekTotals(rides, weeks) {
    weeks = Math.max(0, Math.min(1000, Math.floor(+weeks) || 0));
    const mon = mondayOf(new Date()), out = [], idx = new Map();
    for (let i = weeks - 1; i >= 0; i--) {
      const k = keyOf(addDays(mon, -7 * i)); idx.set(k, out.length);
      out.push({ wk: k, n: 0, dur: 0, tss: 0, kj: 0, dist: 0, tiz: [0, 0, 0, 0, 0, 0, 0] });
    }
    const v = x => { x = +x; return isFinite(x) && x > 0 ? x : 0; };
    for (const r of rideList(rides)) {
      const j = idx.get(keyOf(mondayOf(toDate(r.date)))); if (j == null) continue;
      const o = out[j]; o.n++; o.dur += v(r.dur); o.tss += v(r.tss); o.kj += v(r.kj); o.dist += v(r.dist);
      const tz = r.an && arr(r.an.tiz); if (tz) for (let z = 0; z < 7; z++) o.tiz[z] += v(tz[z]);
    }
    for (const o of out) { o.dur = Math.round(o.dur); o.tss = Math.round(o.tss); o.kj = Math.round(o.kj); o.dist = Math.round(o.dist); }
    return out;
  }

  function zoneTotals(rides, fromISO) {
    const tiz = [0, 0, 0, 0, 0, 0, 0], thz = [0, 0, 0, 0, 0]; let n = 0;
    const a = fromISO == null ? -Infinity : tsOf(fromISO);
    const v = x => { x = +x; return isFinite(x) && x > 0 ? x : 0; };
    for (const r of rideList(rides)) {
      if (!(tsOf(r.date) >= (isNaN(a) ? -Infinity : a)) || !r.an) continue;
      n++;
      const tz = arr(r.an.tiz); for (let z = 0; z < 7; z++) tiz[z] += v(tz[z]);
      const hz = arr(r.an.thz); for (let z = 0; z < 5; z++) thz[z] += v(hz[z]);
    }
    return { tiz, thz, n };
  }

  return { VER, MMP_DUR, mmpCurve, np, analyzeRide, wbalSeries, rangeStats, cpFit, bestCurve, fitnessSeries, weekTotals, zoneTotals, dayKey };
})();
