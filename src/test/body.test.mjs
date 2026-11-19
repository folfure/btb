// Tests for src/parts/a3-body.js (with a1-analysis.js). Run: node src/test/body.test.mjs
// Both parts are evaluated with new Function in one scope (node:vm makes arrays slow and cross-realm).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const part = f => readFileSync(join(here, '..', 'parts', f), 'utf8');
// zone tables copied from app.template.html
const STUB = `
const PZ = [
  { n: 'Z1', name: 'Active recovery', lo: 0, hi: 0.55, col: '#8b95a7' },
  { n: 'Z2', name: 'Endurance', lo: 0.55, hi: 0.75, col: '#3d8bfd' },
  { n: 'Z3', name: 'Tempo', lo: 0.75, hi: 0.90, col: '#2fbf71' },
  { n: 'Z4', name: 'Threshold', lo: 0.90, hi: 1.05, col: '#f5c518' },
  { n: 'Z5', name: 'VO2max', lo: 1.05, hi: 1.20, col: '#ff8a1f' },
  { n: 'Z6', name: 'Anaerobic', lo: 1.20, hi: 1.50, col: '#ff3b3b' },
  { n: 'Z7', name: 'Neuromuscular', lo: 1.50, hi: 9, col: '#b04dff' },
];
const HZ = [
  { n: 'Z1', name: 'Recovery', lo: 0, hi: 0.60, col: '#8b95a7' },
  { n: 'Z2', name: 'Endurance', lo: 0.60, hi: 0.70, col: '#3d8bfd' },
  { n: 'Z3', name: 'Aerobic', lo: 0.70, hi: 0.80, col: '#2fbf71' },
  { n: 'Z4', name: 'Threshold', lo: 0.80, hi: 0.90, col: '#ff8a1f' },
  { n: 'Z5', name: 'Maximum', lo: 0.90, hi: 9, col: '#ff3b3b' },
];`;
const { AN, BODY } = new Function(`${STUB}\n${part('a1-analysis.js')}\n${part('a3-body.js')}\nreturn { AN, BODY };`)();
// BODY alone (no AN in scope) for the guard
const BODY_NOAN = new Function(`${part('a3-body.js')}\nreturn BODY;`)();

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
};
const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);
const pad = x => String(x).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const AT = new Date(2026, 10, 19, 12); // Thu 2026-11-19, fixed "now"
const dayAt = (k, h = 12) => new Date(AT.getFullYear(), AT.getMonth(), AT.getDate() - k, h);
const keyAgo = k => key(dayAt(k));

// ---------- person ----------
test('age: years at a date; out-of-range birth years -> null', () => {
  assert.equal(BODY.age(1982, AT), 44);
  assert.equal(BODY.age(1982, new Date(2000, 0, 1)), 18);
  assert.equal(BODY.age(1982, '2026-01-01'), 44);
  assert.equal(typeof BODY.age(1990), 'number');
  assert.equal(BODY.age(1899, AT), null);
  assert.equal(BODY.age(new Date().getFullYear() + 1), null);
  assert.equal(BODY.age(0), null);
  assert.equal(BODY.age(1982.5, AT), null);
  assert.equal(BODY.age(1982, new Date(1970, 0, 1)), null, 'born after the reference date');
});
test('bmr: Mifflin-St Jeor', () => {
  // 10*60 + 6.25*168 - 5*44 - 161 = 600 + 1050 - 220 - 161 = 1269
  assert.equal(BODY.bmr({ sex: 'f', kg: 60, cm: 168, age: 44 }), 1269);
  // 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
  assert.equal(BODY.bmr({ sex: 'm', kg: 80, cm: 180, age: 30 }), 1780);
  // unknown sex: -78 (midpoint of +5 / -161)
  assert.equal(BODY.bmr({ sex: '', kg: 80, cm: 180, age: 30 }), 1697);
  assert.equal(BODY.bmr({ sex: 'm', kg: 80, cm: 0, age: 30 }), null);
  assert.equal(BODY.bmr({ sex: 'm', kg: 80, cm: 180 }), null);
});
test('tanakaMaxHr', () => {
  assert.equal(BODY.tanakaMaxHr(44), 177); // 208 - 30.8 = 177.2
  assert.equal(BODY.tanakaMaxHr(20), 194);
  assert.equal(BODY.tanakaMaxHr(null), null);
  assert.equal(BODY.tanakaMaxHr(-3), null);
});

// ---------- calories ----------
test('kcalPower: kJ / 0.24 * 0.239', () => {
  near(BODY.kcalPower(600), 598, 1);
  assert.equal(BODY.kcalPower(1000), 996); // 4166.67 * 0.239 = 995.83
  assert.equal(BODY.kcalPower(0), null);
  assert.equal(BODY.kcalPower('x'), null);
});
test('kcalHr: Keytel 2005', () => {
  // female, HR 140, 60 kg, 44 y, 60 min: (-20.4022 + 62.608 - 7.578 + 3.256) / 4.184 = 37.8838 / 4.184 = 9.0544 /min -> 543.3
  assert.equal(BODY.kcalHr({ avgHr: 140, durS: 3600, kg: 60, age: 44, sex: 'f' }), 543);
  // male, HR 150, 80 kg, 30 y, 30 min: (-55.0969 + 94.635 + 15.904 + 6.051) / 4.184 = 61.4931 / 4.184 = 14.6972 /min -> 440.9
  assert.equal(BODY.kcalHr({ avgHr: 150, durS: 1800, kg: 80, age: 30, sex: 'm' }), 441);
  // unknown sex = mean of both: female same inputs 30 min: (-20.4022 + 67.08 - 10.104 + 2.22) / 4.184 = 38.7938/4.184 = 9.2719 /min
  // -> (14.6972 + 9.2719) / 2 * 30 = 359.5
  near(BODY.kcalHr({ avgHr: 150, durS: 1800, kg: 80, age: 30, sex: '' }), 359.5, 0.6);
  assert.equal(BODY.kcalHr({ avgHr: 79, durS: 3600, kg: 60, age: 44, sex: 'f' }), null, 'HR < 80');
  assert.equal(BODY.kcalHr({ avgHr: 140, durS: 3600, kg: 60, sex: 'f' }), null, 'no age');
  assert.equal(BODY.kcalHr({ avgHr: 140, durS: 0, kg: 60, age: 44 }), null, 'no duration');
});
test('rideKcal: power preferred, HR fallback, weight/age from ride + settings', () => {
  const S = { sex: 'f', birthYear: 1982, weight: 60 };
  const r = { id: 1, date: dayAt(1).toISOString(), dur: 3600, kj: 600, avgHr: 140 };
  const k = BODY.rideKcal(r, S);
  assert.equal(k.src, 'power'); near(k.power, 598, 1); assert.equal(k.best, k.power); assert.equal(k.hr, 543);
  const k2 = BODY.rideKcal({ ...r, kj: 0 }, S);
  assert.equal(k2.src, 'hr'); assert.equal(k2.best, 543); assert.equal(k2.power, null);
  // r.wt beats S.weight
  assert.equal(BODY.rideKcal({ ...r, kj: 0, wt: 80 }, S).hr, BODY.kcalHr({ avgHr: 140, durS: 3600, kg: 80, age: 44, sex: 'f' }));
  // age at ride date: a 2000 ride with birthYear 1982 -> age 18
  assert.equal(BODY.rideKcal({ ...r, kj: 0, date: '2000-06-01T10:00:00Z' }, S).hr, BODY.kcalHr({ avgHr: 140, durS: 3600, kg: 60, age: 18, sex: 'f' }));
  const k3 = BODY.rideKcal({ ...r, kj: 0 }, { weight: 60 }); // no birth year -> no HR estimate
  assert.deepEqual(k3, { power: null, hr: null, best: null, src: null });
});
test('fatKg', () => {
  assert.equal(BODY.fatKg(7700), 1);
  assert.equal(BODY.fatKg(1000), 0.13);
  assert.equal(BODY.fatKg(-3850), -0.5);
  assert.equal(BODY.fatKg(null), null);
  assert.ok(Object.is(BODY.fatKg(-1), 0), 'no negative zero');
});
test('vo2max: ACSM 10.8 * W / kg + 7', () => {
  assert.equal(BODY.vo2max(300, 60), 61);
  assert.equal(BODY.vo2max(250, 75), 43);
  assert.equal(BODY.vo2max(280, 70), 50.2);
  assert.equal(BODY.vo2max(300, 0), null);
});

// ---------- weight ----------
// daily weights falling 0.4 kg/week from 60 kg, 56 days back to today (plus small noise)
const noise = i => [0.1, -0.1, 0.05, -0.05, 0, 0.08, -0.08][i % 7];
const WLOG = [];
for (let k = 56; k >= 0; k--) WLOG.push({ d: keyAgo(k), kg: +(60 - 0.4 / 7 * (56 - k) + noise(k)).toFixed(2), ...(k % 2 ? {} : { rhr: 50 + (k % 5) }) });

test('weightTrend: window, 7-day mean, rate', () => {
  const t = BODY.weightTrend(WLOG, { days: 90, at: AT });
  assert.equal(t.pts.length, 57);
  assert.deepEqual(t.last, { d: key(AT), kg: WLOG[56].kg });
  assert.deepEqual(t.first, { d: WLOG[0].d, kg: WLOG[0].kg });
  const last7 = WLOG.slice(-7).map(e => e.kg);
  near(t.avg7, last7.reduce((s, x) => s + x, 0) / 7, 0.006);
  near(t.pts[56].avg7, t.avg7, 0.006, 'last point avg7');
  assert.equal(t.pts[0].avg7, WLOG[0].kg, 'first point avg7 = itself');
  near(t.ratePerWeek, -0.4, 0.05);
  assert.equal(t.max, Math.max(...WLOG.map(e => e.kg)));
  assert.equal(t.min, Math.min(...WLOG.map(e => e.kg)));
  // a 14-day window
  const t2 = BODY.weightTrend(WLOG, { days: 14, at: AT });
  assert.equal(t2.pts.length, 14); assert.equal(t2.pts[0].d, keyAgo(13));
  // reference date in the past ignores later entries
  const t3 = BODY.weightTrend(WLOG, { at: dayAt(10) });
  assert.equal(t3.last.d, keyAgo(10));
});
test('weightTrend: unsorted / duplicate / sparse input', () => {
  const t = BODY.weightTrend([{ d: keyAgo(1), kg: 70 }, { d: keyAgo(20), kg: 71 }, { d: keyAgo(1), kg: 69 }, { d: 'bad', kg: 5 }, null, { d: keyAgo(3), kg: 'x' }], { at: AT });
  assert.equal(t.pts.length, 2);
  assert.deepEqual(t.last, { d: keyAgo(1), kg: 69 }, 'later duplicate wins');
  assert.equal(t.avg7, 69, 'only one entry in the last 7 days');
  near(t.ratePerWeek, -2 / 19 * 7, 0.01);
  // 2 entries less than 5 days apart: no rate; nothing in the last 7 days: avg7 = last
  const t2 = BODY.weightTrend([{ d: keyAgo(12), kg: 70 }, { d: keyAgo(10), kg: 69 }], { at: AT });
  assert.equal(t2.ratePerWeek, null); assert.equal(t2.avg7, 69);
});
test('targetPlan: 60 -> 56 kg', () => {
  const trend = BODY.weightTrend(WLOG, { at: AT });
  const cur = trend.avg7; // ~56.97
  const tp = BODY.targetPlan({ trend, targetWeight: 56, targetDate: key(dayAt(-28)), at: AT });
  near(tp.remaining, cur - 56, 0.01);
  assert.ok(tp.remaining > 0.8 && tp.remaining < 1.2, 'remaining ' + tp.remaining);
  near(tp.requiredPerWeek, (56 - cur) / 4, 0.01); // 4 weeks left, negative = lose
  // ETA: remaining / 0.4 kg per week ~ 2.4 weeks
  const etaDays = (new Date(tp.etaDate + 'T12:00:00') - AT) / 864e5;
  near(etaDays, tp.remaining / -trend.ratePerWeek * 7, 1.5);
  assert.ok(tp.etaDate <= key(dayAt(-28)));
  assert.equal(tp.onTrack, true);
  near(tp.pct, (60 - cur) / 4 * 100, 2);
  // a 1-week deadline cannot be met at 0.4 kg/week
  const tp2 = BODY.targetPlan({ trend, targetWeight: 56, targetDate: key(dayAt(-7)), at: AT });
  assert.equal(tp2.onTrack, false); assert.ok(tp2.requiredPerWeek < -0.8);
  // no date: no requiredPerWeek, on track because moving toward the target
  const tp3 = BODY.targetPlan({ trend, targetWeight: 56, targetDate: '', at: AT });
  assert.equal(tp3.requiredPerWeek, null); assert.equal(tp3.onTrack, true); assert.ok(tp3.etaDate);
  // date in the past
  const tp4 = BODY.targetPlan({ trend, targetWeight: 56, targetDate: keyAgo(3), at: AT });
  assert.equal(tp4.requiredPerWeek, null); assert.equal(tp4.onTrack, false);
  // gaining weight toward a higher target: moving away -> no ETA
  const tp5 = BODY.targetPlan({ trend, targetWeight: 62, at: AT });
  assert.equal(tp5.etaDate, null); assert.equal(tp5.onTrack, false); assert.ok(tp5.remaining < 0);
  // reached
  const tp6 = BODY.targetPlan({ trend, targetWeight: 57.5, at: AT });
  assert.equal(tp6.onTrack, true); assert.equal(tp6.pct, 100); assert.equal(tp6.etaDate, key(AT));
  // no target
  assert.equal(BODY.targetPlan({ trend, targetWeight: 0 }), null);
  assert.equal(BODY.targetPlan({ trend: BODY.weightTrend([]), targetWeight: 56 }), null);
});
test('rhrSeries', () => {
  const r = BODY.rhrSeries(WLOG, 90, AT);
  assert.equal(r.length, 29);
  assert.deepEqual(r[r.length - 1], { d: key(AT), rhr: 50 });
  assert.equal(BODY.rhrSeries(WLOG, 7, AT).length, 4);
});

// ---------- energy ----------
test('energy: days, weeks, bmr, need', () => {
  const S = { sex: 'f', birthYear: 1982, height: 168, weight: 60, wlog: [] };
  const rides = [
    { id: 'a', date: dayAt(0, 8).toISOString(), dur: 3600, kj: 600, avgHr: 140 },
    { id: 'b', date: dayAt(0, 18).toISOString(), dur: 1800, kj: 300 },
    { id: 'c', date: dayAt(10).toISOString(), dur: 3600, kj: 0, avgHr: 140 }, // HR estimate 543
    { id: 'd', date: dayAt(40).toISOString(), dur: 3600, kj: 1000 }, // outside 28 days, inside 8 weeks
    { id: 'e', date: dayAt(-2).toISOString(), dur: 3600, kj: 1000 }, // future: ignored
  ];
  const e = BODY.energy(rides, S, { days: 28, at: AT });
  assert.equal(e.days.length, 28);
  assert.equal(e.days[27].d, key(AT)); assert.equal(e.days[0].d, keyAgo(27));
  const today = e.days[27];
  assert.equal(today.ride, 598 + 299);
  assert.equal(today.bmr, 1269);
  assert.equal(today.need, Math.round(1269 * 1.2 + 897));
  assert.equal(e.days[17].ride, 543);
  assert.equal(e.days[16].need, Math.round(1269 * 1.2));
  assert.equal(e.bmr, 1269);
  assert.equal(e.avgRidePerDay, Math.round((897 + 543) / 28));
  assert.equal(e.avgNeed, Math.round(1269 * 1.2 + (897 + 543) / 28));
  assert.equal(e.weeks.length, 8);
  assert.equal(e.weeks[7].wk, '2026-11-16'); assert.equal(e.weeks[0].wk, '2026-09-28');
  assert.deepEqual(e.weeks[7], { wk: '2026-11-16', ride: 897, n: 2 });
  assert.equal(e.weeks.reduce((s, w) => s + w.n, 0), 4);
  // weight from the log on each day
  const e2 = BODY.energy([], { ...S, wlog: [{ d: keyAgo(5), kg: 70 }] }, { days: 28, at: AT });
  assert.equal(e2.days[27].bmr, 1369); assert.equal(e2.days[0].bmr, 1269, 'before the first log entry: S.weight');
  // no height: bmr / need null, ride still counted
  const e3 = BODY.energy(rides, { weight: 60 }, { at: AT });
  assert.equal(e3.bmr, null); assert.equal(e3.days[27].need, null); assert.equal(e3.days[27].ride, 897); assert.equal(e3.avgNeed, null);
});

// ---------- history ----------
// MMP from a 2-parameter CP model (CP 260 W, W' 20 kJ)
const mmpOf = (cp, wp) => AN.MMP_DUR.map(t => t <= 7200 ? Math.round(cp + wp / t) : null);
test('eftpSeries: 90-day rolling CP fit per week', () => {
  const rides = [{ id: 'x', date: dayAt(30).toISOString(), dur: 3600, an: { mmp: mmpOf(260, 20000) } }];
  const s = BODY.eftpSeries(rides, 26, AT);
  assert.equal(s.length, 26);
  assert.equal(s[25].wk, '2026-11-16');
  near(s[25].cp, 260, 2); near(s[25].wprime, 20000, 400); near(s[25].eftp, Math.round(260 * 0.96), 2);
  // weeks ending before the ride: nothing
  assert.equal(s[0].eftp, null); assert.equal(s[0].cp, null); assert.equal(s[0].wprime, null);
  // a ride more than 90 days before the week end drops out
  const s2 = BODY.eftpSeries([{ ...rides[0], date: dayAt(120).toISOString() }], 26, AT);
  assert.equal(s2[25].eftp, null);
  assert.ok(s2.some(p => p.eftp != null));
  // better ride later wins
  const s3 = BODY.eftpSeries([...rides, { id: 'y', date: dayAt(5).toISOString(), an: { mmp: mmpOf(300, 20000) } }], 4, AT);
  assert.equal(s3.length, 4); near(s3[3].cp, 300, 2);
  // AN missing: null points, no throw
  const s4 = BODY_NOAN.eftpSeries(rides, 3, AT);
  assert.deepEqual(s4.map(p => p.eftp), [null, null, null]);
});
test('vo2Series: 90-day best 5-min power / latest ride weight', () => {
  const m = AN.MMP_DUR.map(t => t === 300 ? 300 : 200);
  const rides = [
    { id: 1, date: dayAt(20).toISOString(), an: { mmp: m }, wt: 60 },
    { id: 2, date: dayAt(60).toISOString(), an: { mmp: m.map(x => x - 50) }, wt: 65 },
  ];
  const s = BODY.vo2Series(rides, 26, AT);
  assert.equal(s.length, 26);
  assert.equal(s[25].vo2, 61);
  assert.equal(s[0].vo2, null);
  const s2 = BODY.vo2Series([{ ...rides[0], wt: undefined }], 2, AT);
  assert.deepEqual(s2.map(p => p.vo2), [null, null], 'no weight in the window');
  assert.deepEqual(BODY_NOAN.vo2Series(rides, 2, AT).map(p => p.vo2), [null, null]);
});

// ---------- garbage ----------
test('every function survives garbage input', () => {
  const junk = [undefined, null, NaN, Infinity, -1, 0, '', 'abc', {}, [], [null, 1, 'x', {}], true, () => 1, Symbol('s'), new Date(NaN), { d: 3, kg: {} }];
  const scalar = ['age', 'bmr', 'tanakaMaxHr', 'kcalPower', 'kcalHr', 'vo2max', 'fatKg', 'targetPlan'];
  for (const f of Object.keys(BODY)) {
    for (const a of junk) for (const b of junk) {
      let v;
      assert.doesNotThrow(() => { v = BODY[f](a, b, a); }, `${f}(${String(a)}, ${String(b)})`);
      const legit = (f === 'age' && a === undefined) || (f === 'fatKg' && typeof a === 'number' && isFinite(a)); // age(undefined) = unknown -> null anyway; fatKg(0 / -1) is a real number
      if (scalar.includes(f) && !legit) assert.equal(v, null, `${f}(${String(a)}, ${String(b)}) -> ${v}`);
    }
  }
  assert.deepEqual(BODY.rideKcal(null, null), { power: null, hr: null, best: null, src: null });
  assert.deepEqual(BODY.weightTrend('x'), { pts: [], first: null, last: null, avg7: null, ratePerWeek: null, min: null, max: null });
  assert.deepEqual(BODY.rhrSeries({}), []);
  assert.deepEqual(BODY.eftpSeries(null, 0), []);
  assert.equal(BODY.eftpSeries(null).length, 26);
  assert.ok(BODY.eftpSeries('junk', 3).every(p => p.eftp === null));
  assert.ok(BODY.vo2Series([{ date: 'x' }, { date: AT.toISOString(), an: { mmp: 'x' } }], 3).every(p => p.vo2 === null));
  const e = BODY.energy('x', 'y', 'z');
  assert.equal(e.days.length, 28); assert.equal(e.weeks.length, 8); assert.equal(e.bmr, null);
  assert.ok(e.days.every(d => d.ride === 0 && d.need === null));
  // weird rides do not break the sum
  const e2 = BODY.energy([null, 1, { date: 'nope', kj: 5 }, { date: AT.toISOString(), kj: 'x', avgHr: 'y' }, { date: AT.toISOString(), kj: 600 }], {}, { at: AT });
  assert.equal(e2.days[27].ride, 598);
  // a cyclic object
  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => BODY.weightTrend([cyc]));
  // a getter that throws
  const evil = { get kg() { throw new Error('boom'); }, d: keyAgo(1) };
  assert.doesNotThrow(() => BODY.weightTrend([evil]));
  assert.doesNotThrow(() => BODY.energy([{ get date() { throw new Error('boom'); } }], {}));
});
test('performance: 1000 rides, 26 weeks', () => {
  const rides = [];
  for (let i = 0; i < 1000; i++) rides.push({ id: i, date: dayAt(i % 365).toISOString(), kj: 500, dur: 3600, wt: 70, an: { mmp: mmpOf(200 + (i % 50), 18000) } });
  const t0 = performance.now();
  BODY.eftpSeries(rides, 26, AT); BODY.vo2Series(rides, 26, AT); BODY.energy(rides, { sex: 'm', birthYear: 1980, height: 180, weight: 70 }, { at: AT });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, ms + ' ms');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
