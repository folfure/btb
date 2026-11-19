// BTB body metrics: age, BMR, max HR, ride calories, VO2max, weight trend / target, energy balance,
// eFTP / resting HR / VO2max history. Pure functions, no DOM, no globals except BODY (reads AN when present).
// Never throws: missing or odd inputs give null (scalars) or an empty / null-filled structure (series).
// Days are local calendar days 'YYYY-MM-DD'; day arithmetic runs on UTC day numbers so DST never shifts a day.
const BODY = (() => {
  const fin = v => { if ((typeof v !== 'number' && typeof v !== 'string') || v === '') return null; v = +v; return Number.isFinite(v) ? v : null; }; // numbers and numeric strings only
  const pos = v => { v = fin(v); return v != null && v > 0 ? v : null; };
  const r1 = x => Math.round(x * 10) / 10 + 0;
  const r2 = x => Math.round(x * 100) / 100 + 0; // + 0 turns -0 into 0
  const arr = a => Array.isArray(a) ? a : [];
  const obj = o => (o && typeof o === 'object') ? o : {};
  const safe = (fn, fb) => function () { try { return fn.apply(null, arguments); } catch (e) { return typeof fb === 'function' ? fb() : fb; } };

  // ---------- dates ----------
  const pad = x => String(x).padStart(2, '0');
  const keyOfLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function toDate(x) {
    if (x instanceof Date) return isNaN(x) ? null : x;
    if (typeof x === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x); // a bare day is a local day
      if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d) ? null : d; }
    }
    if (typeof x !== 'string' && typeof x !== 'number') return null;
    if (x === '') return null;
    const d = new Date(x); return isNaN(d) ? null : d;
  }
  const atDate = at => toDate(at) || new Date();
  // 'YYYY-MM-DD' -> UTC day number (null when not a real calendar day)
  function dayNum(k) {
    if (typeof k !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k); if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return Math.round(t / 864e5);
  }
  const numKey = n => { const d = new Date(n * 864e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const numOfDate = d => dayNum(keyOfLocal(d));
  const mondayNum = n => n - ((new Date(n * 864e5).getUTCDay() + 6) % 7);
  const localOfNum = n => { const d = new Date(n * 864e5); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  const weeksArg = (w, def) => { if (w === undefined) return def; w = fin(w); return w == null ? 0 : Math.max(0, Math.min(520, Math.floor(w))); };
  const daysArg = (v, def) => { if (v === undefined) return def; v = fin(v); return v == null ? 0 : Math.max(0, Math.min(3660, Math.floor(v))); };

  // ---------- person ----------
  function age(birthYear, at) {
    const by = fin(birthYear); if (by == null || by !== Math.floor(by)) return null;
    if (by < 1900 || by > new Date().getFullYear()) return null;
    const a = atDate(at).getFullYear() - by;
    return a >= 0 ? a : null;
  }
  function bmr(p) {
    p = obj(p);
    const kg = pos(p.kg), cm = pos(p.cm), a = pos(p.age);
    if (kg == null || cm == null || a == null) return null;
    const s = p.sex === 'm' ? 5 : p.sex === 'f' ? -161 : -78;
    const v = Math.round(10 * kg + 6.25 * cm - 5 * a + s);
    return v > 0 ? v : null;
  }
  function tanakaMaxHr(a) {
    a = pos(a); if (a == null || a > 130) return null;
    return Math.round(208 - 0.7 * a);
  }

  // ---------- calories ----------
  // mechanical work / ~24 % gross efficiency, kJ -> kcal (1 kJ = 0.239 kcal)
  function kcalPower(kj) { kj = pos(kj); return kj == null ? null : Math.round(kj / 0.24 * 0.239); }
  // Keytel et al. 2005 (J Sports Sci 23:289), kcal/min without VO2max
  function kcalHr(p) {
    p = obj(p);
    const hr = pos(p.avgHr), durS = pos(p.durS), kg = pos(p.kg), a = pos(p.age);
    if (hr == null || durS == null || kg == null || a == null || hr < 80 || hr > 250) return null;
    const m = (-55.0969 + 0.6309 * hr + 0.1988 * kg + 0.2017 * a) / 4.184;
    const f = (-20.4022 + 0.4472 * hr - 0.1263 * kg + 0.074 * a) / 4.184;
    const perMin = p.sex === 'm' ? m : p.sex === 'f' ? f : (m + f) / 2;
    const v = Math.round(perMin * durS / 60);
    return v > 0 ? v : null;
  }
  const NO_KCAL = () => ({ power: null, hr: null, best: null, src: null });
  function rideKcal(r, s) {
    if (!r || typeof r !== 'object') return NO_KCAL();
    s = obj(s);
    const when = toDate(r.date) || undefined;
    const power = kcalPower(r.kj);
    const hr = kcalHr({ avgHr: r.avgHr, durS: r.dur, kg: pos(r.wt) || pos(s.weight), age: age(s.birthYear, when), sex: s.sex });
    const src = power != null ? 'power' : hr != null ? 'hr' : null;
    return { power, hr, best: src === 'power' ? power : src === 'hr' ? hr : null, src };
  }
  function fatKg(kcal) { kcal = fin(kcal); return kcal == null ? null : r2(kcal / 7700); }

  // ---------- VO2max ----------
  // ACSM leg-cycling equation applied to the best 5-min power
  function vo2max(p5, kg) {
    p5 = pos(p5); kg = pos(kg); if (p5 == null || kg == null) return null;
    return r1(10.8 * p5 / kg + 7);
  }

  // ---------- weight ----------
  // valid entries as { n: day number, d, kg, rhr? }, sorted, one per day (the later one wins)
  function cleanLog(wlog) {
    const m = new Map();
    for (const e of arr(wlog)) {
      if (!e || typeof e !== 'object') continue;
      const n = dayNum(e.d), kg = pos(e.kg); if (n == null) continue;
      const rhr = pos(e.rhr);
      const o = { n, d: e.d, kg: kg != null && kg < 700 ? kg : null };
      if (rhr != null && rhr >= 20 && rhr <= 200) o.rhr = Math.round(rhr);
      m.set(n, o);
    }
    return [...m.values()].sort((a, b) => a.n - b.n);
  }
  const EMPTY_TREND = () => ({ pts: [], first: null, last: null, avg7: null, ratePerWeek: null, min: null, max: null });
  function weightTrend(wlog, opts) {
    opts = obj(opts);
    const days = daysArg(opts.days, 90), today = numOfDate(atDate(opts.at));
    const L = cleanLog(wlog).filter(e => e.kg != null && e.n <= today);
    if (!L.length) return EMPTY_TREND();
    const mean7 = n => { let s = 0, k = 0; for (const e of L) if (e.n <= n && e.n > n - 7) { s += e.kg; k++; } return k ? s / k : null; };
    const pts = []; let min = null, max = null;
    for (const e of L) {
      if (e.n <= today - days) continue;
      pts.push({ d: e.d, kg: e.kg, avg7: r2(mean7(e.n)) });
      if (min == null || e.kg < min) min = e.kg;
      if (max == null || e.kg > max) max = e.kg;
    }
    const lastE = L[L.length - 1], last = { d: lastE.d, kg: lastE.kg };
    const a7 = mean7(today);
    // least squares kg ~ day over the last 28 days
    const R = L.filter(e => e.n > today - 28);
    let ratePerWeek = null;
    if (R.length >= 2 && R[R.length - 1].n - R[0].n >= 5) {
      let mx = 0, my = 0; for (const e of R) { mx += e.n; my += e.kg; } mx /= R.length; my /= R.length;
      let sxy = 0, sxx = 0; for (const e of R) { sxy += (e.n - mx) * (e.kg - my); sxx += (e.n - mx) ** 2; }
      if (sxx > 0) ratePerWeek = r2(sxy / sxx * 7);
    }
    return { pts, first: { d: L[0].d, kg: L[0].kg }, last, avg7: a7 != null ? r2(a7) : last.kg, ratePerWeek, min, max };
  }
  // trend: weightTrend() result. Signed rates: negative = losing. remaining > 0 = still above the target.
  function targetPlan(p) {
    p = obj(p);
    const tw = pos(p.targetWeight); if (tw == null) return null;
    const t = obj(p.trend);
    const cur = pos(t.avg7) != null ? pos(t.avg7) : (t.last && pos(t.last.kg));
    if (cur == null) return null;
    const today = numOfDate(atDate(p.at));
    const start = pos(p.startKg) || (t.first && pos(t.first.kg)) || (arr(t.pts)[0] && pos(t.pts[0].kg)) || null;
    const rate = fin(t.ratePerWeek);
    const dir = Math.sign(tw - (start != null && Math.abs(start - tw) > 1e-9 ? start : cur)); // -1 = goal is to lose
    const reached = dir === 0 || (tw - cur) * dir <= 0.05;
    const tdn = dayNum(p.targetDate), daysLeft = tdn == null ? null : tdn - today;
    const requiredPerWeek = daysLeft != null && daysLeft > 0 ? (reached ? 0 : r2((tw - cur) / daysLeft * 7)) : null;
    let etaDate = null;
    if (reached) etaDate = numKey(today);
    else if (rate != null && rate !== 0 && Math.sign(rate) === Math.sign(tw - cur)) {
      const dd = (tw - cur) / rate * 7;
      if (dd >= 0 && dd <= 3650) etaDate = numKey(today + Math.ceil(dd));
    }
    let onTrack = null;
    if (reached) onTrack = true;
    else if (tdn != null) onTrack = daysLeft <= 0 ? false : etaDate ? etaDate <= p.targetDate : rate != null ? false : null;
    else onTrack = etaDate ? true : rate != null ? false : null;
    let pct = null;
    if (start != null) {
      pct = Math.abs(start - tw) < 1e-9 ? (reached ? 100 : 0) : Math.round(Math.max(0, Math.min(100, (start - cur) / (start - tw) * 100)));
    }
    return { remaining: r2(cur - tw), current: r2(cur), requiredPerWeek, etaDate, onTrack, pct };
  }
  function rhrSeries(wlog, days, at) {
    const dd = daysArg(days, 90), today = numOfDate(atDate(at));
    return cleanLog(wlog).filter(e => e.rhr != null && e.n <= today && e.n > today - dd).map(e => ({ d: e.d, rhr: e.rhr }));
  }

  // ---------- energy ----------
  function energy(rides, s, opts) {
    s = obj(s); opts = obj(opts);
    const days = daysArg(opts.days, 28), atD = atDate(opts.at), today = numOfDate(atD);
    const firstDay = today - days + 1, firstWk = mondayOf(today) - 7 * 7;
    const byDay = new Map(), byWk = new Map();
    for (const r of arr(rides)) {
      if (!r || typeof r !== 'object') continue;
      const d = toDate(r.date); if (!d) continue;
      const n = numOfDate(d); if (n == null || n > today || (n < firstDay && n < firstWk)) continue;
      const k = rideKcal(r, s).best || 0;
      byDay.set(n, (byDay.get(n) || 0) + k);
      const w = mondayOf(n), o = byWk.get(w) || { ride: 0, n: 0 }; o.ride += k; o.n++; byWk.set(w, o);
    }
    const log = cleanLog(s.wlog).filter(e => e.kg != null);
    const kgAt = n => { let kg = null; for (const e of log) { if (e.n > n) break; kg = e.kg; } return kg != null ? kg : pos(s.weight); };
    const bmrAt = n => bmr({ sex: s.sex, kg: kgAt(n), cm: s.height, age: age(s.birthYear, localOfNum(n)) });
    const out = []; let rideSum = 0, needSum = 0, needN = 0;
    for (let n = firstDay; n <= today; n++) {
      const ride = Math.round(byDay.get(n) || 0), b = bmrAt(n), need = b != null ? Math.round(b * 1.2 + ride) : null;
      rideSum += ride; if (need != null) { needSum += need; needN++; }
      out.push({ d: numKey(n), ride, bmr: b, need });
    }
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const w = mondayOf(today) - 7 * i, o = byWk.get(w);
      weeks.push({ wk: numKey(w), ride: o ? Math.round(o.ride) : 0, n: o ? o.n : 0 });
    }
    return {
      days: out, weeks, bmr: bmrAt(today),
      avgRidePerDay: days ? Math.round(rideSum / days) : null,
      avgNeed: needN ? Math.round(needSum / needN) : null,
    };
  }
  function mondayOf(n) { return mondayNum(n); }

  // ---------- history from rides (90-day rolling bests, weekly points) ----------
  const hasAN = () => typeof AN !== 'undefined' && AN && typeof AN.bestCurve === 'function';
  function weekly(rides, weeks, at, fn) {
    const w = weeksArg(weeks, 26), mon = mondayNum(numOfDate(atDate(at)));
    const R = arr(rides).filter(r => r && typeof r === 'object' && toDate(r.date));
    const out = [];
    for (let i = w - 1; i >= 0; i--) {
      const wk = mon - 7 * i, end = wk + 7; // window [end - 90 days, end): local midnights
      let v = null;
      try { if (hasAN()) v = fn(R, localOfNum(end - 90), localOfNum(end)); } catch (e) { v = null; }
      out.push({ wk: numKey(wk), v });
    }
    return out;
  }
  function eftpSeries(rides, weeks, at) {
    return weekly(rides, weeks, at, (R, a, b) => typeof AN.cpFit === 'function' ? AN.cpFit(AN.bestCurve(R, a, b).w) : null)
      .map(p => ({ wk: p.wk, eftp: p.v ? p.v.eftp : null, cp: p.v ? p.v.cp : null, wprime: p.v ? p.v.wprime : null }));
  }
  function vo2Series(rides, weeks, at) {
    return weekly(rides, weeks, at, (R, a, b) => {
      const i = arr(AN.MMP_DUR).indexOf(300); if (i < 0) return null;
      const p5 = pos(AN.bestCurve(R, a, b).w[i]); if (p5 == null) return null;
      let kg = null, t = -Infinity;
      for (const r of R) {
        const ts = toDate(r.date).getTime(), wt = pos(r.wt);
        if (wt != null && ts >= a.getTime() && ts < b.getTime() && ts > t) { t = ts; kg = wt; }
      }
      return vo2max(p5, kg);
    }).map(p => ({ wk: p.wk, vo2: p.v }));
  }

  return {
    age: safe(age, null), bmr: safe(bmr, null), tanakaMaxHr: safe(tanakaMaxHr, null),
    kcalPower: safe(kcalPower, null), kcalHr: safe(kcalHr, null), rideKcal: safe(rideKcal, NO_KCAL),
    vo2max: safe(vo2max, null), fatKg: safe(fatKg, null),
    weightTrend: safe(weightTrend, EMPTY_TREND), targetPlan: safe(targetPlan, null),
    energy: safe(energy, () => ({ days: [], weeks: [], bmr: null, avgRidePerDay: null, avgNeed: null })),
    eftpSeries: safe(eftpSeries, () => []), rhrSeries: safe(rhrSeries, () => []), vo2Series: safe(vo2Series, () => []),
  };
})();
