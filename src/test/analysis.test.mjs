// Tests for src/parts/a1-analysis.js. Run: node src/test/analysis.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'parts', 'a1-analysis.js'), 'utf8');
const ctx = vm.createContext({});
// zone tables copied from app.template.html
vm.runInContext(`
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
];
${src}
globalThis.AN = AN;`, ctx, { filename: 'a1-analysis.js' });
const AN = ctx.AN;
// vm arrays come from another realm: normalize before deepStrictEqual
const plain = x => JSON.parse(JSON.stringify(x));

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
};
const fill = (n, v) => Array(n).fill(v);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);
const di = d => AN.MMP_DUR.indexOf(d);
const sum = a => a.reduce((s, x) => s + x, 0);
const pad = x => String(x).padStart(2, '0');
const localKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (k, h = 12) => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate() - k, h); };

const FTP = 250;
const CTX = { ftp: FTP, maxHr: 190, weight: 75 };

// ---------- mmp / np ----------
test('mmpCurve: constant 200 W -> all 200 up to ride length, null beyond', () => {
  const m = plain(AN.mmpCurve(fill(3600, 200)));
  AN.MMP_DUR.forEach((d, i) => assert.equal(m[i], d <= 3600 ? 200 : null, `dur ${d}`));
});
test('mmpCurve: 300 W x 60 s inside 100 W', () => {
  const p = [...fill(600, 100), ...fill(60, 300), ...fill(600, 100)];
  const m = AN.mmpCurve(p);
  assert.equal(m[di(60)], 300); assert.equal(m[di(1)], 300); assert.equal(m[di(30)], 300);
  assert.equal(m[di(120)], 200); // 60 s @300 + 60 s @100
});
test('mmpCurve: empty / odd samples', () => {
  assert.deepEqual(plain(AN.mmpCurve([])), fill(AN.MMP_DUR.length, null));
  assert.deepEqual(plain(AN.mmpCurve(null)), fill(AN.MMP_DUR.length, null));
  const m = AN.mmpCurve([NaN, null, 100, undefined, -50, 'x']);
  assert.equal(m[di(1)], 100); assert.equal(m[di(5)], 20); assert.equal(m[di(8)], null);
});
test('np: constant power = that power; <30 s = 0', () => {
  assert.equal(AN.np(fill(1200, 237)), 237);
  assert.equal(AN.np(fill(29, 300)), 0);
  assert.equal(AN.np([]), 0);
  assert.ok(AN.np([...fill(600, 100), ...fill(600, 300)]) > 200, 'np above average for variable power');
});

// ---------- analyzeRide basics ----------
test('analyzeRide: tiz sums to non-zero seconds, coast counts zeros', () => {
  const p = [...fill(100, 0), ...fill(300, 100), ...fill(300, 200), ...fill(300, 280), ...fill(50, 500)];
  const an = AN.analyzeRide({ p }, CTX);
  assert.equal(an.v, AN.VER);
  assert.equal(an.coast, 100);
  assert.equal(sum(an.tiz), p.length - 100);
  assert.deepEqual(plain(an.tiz), [300, 0, 300, 0, 300, 0, 50]); // 100=Z1 0.4, 200=Z3 0.8, 280=Z5 1.12, 500=Z7 2.0
  assert.equal(an.thz, null); assert.equal(an.ef, null); assert.equal(an.dec, null);
  assert.equal(an.avgP, Math.round(sum(p) / p.length));
  assert.equal(an.mmp.length, AN.MMP_DUR.length);
});
test('analyzeRide: thz, ef, vi', () => {
  const n = 1800, p = fill(n, 200), hr = fill(n, 150);
  hr[0] = 0; hr[1] = NaN;
  const an = AN.analyzeRide({ p, hr }, CTX);
  assert.equal(sum(an.thz), n - 2);
  assert.equal(an.thz[2], n - 2); // 150/190 = 0.79 -> Z3
  assert.equal(an.vi, 1); assert.equal(an.np, 200);
  near(an.ef, 200 / 150, 0.01, 'ef');
});
test('analyzeRide: decoupling sign (HR drifts up -> positive)', () => {
  const n = 3600, p = fill(n, 200), hr = Array.from({ length: n }, (_, i) => 130 + 20 * i / n);
  const an = AN.analyzeRide({ p, hr }, CTX);
  assert.ok(an.dec > 0, 'dec ' + an.dec);
  near(an.dec, (1 - 135 / 145) * 100, 0.3, 'dec');
  const flat = AN.analyzeRide({ p, hr: fill(n, 140) }, CTX);
  assert.equal(flat.dec, 0);
  const down = AN.analyzeRide({ p, hr: Array.from({ length: n }, (_, i) => 150 - 20 * i / n) }, CTX);
  assert.ok(down.dec < 0);
  const short = AN.analyzeRide({ p: fill(1000, 200), hr: fill(1000, 140) }, CTX);
  assert.equal(short.dec, null);
});
test("W'bal: CP+100 W for 100 s from 20000 J -> ~10000 J; recovery refills", () => {
  const p = [...fill(100, 350), ...fill(600, 100)];
  const w = AN.wbalSeries(p, 250, 20000);
  assert.equal(w.length, p.length);
  near(w[99], 10000, 1, 'after effort');
  assert.ok(w[699] > w[99] + 5000 && w[699] <= 20000, 'refill ' + w[699]);
  for (let i = 101; i < w.length; i++) assert.ok(w[i] >= w[i - 1]);
  const an = AN.analyzeRide({ p }, { ftp: 250 });
  near(an.wbalMin, 10000, 1, 'wbalMin');
  const an2 = AN.analyzeRide({ p }, { ftp: 200, cp: 250, wprime: 15000 });
  near(an2.wbalMin, 5000, 1, 'cp/wprime from ctx');
  assert.deepEqual(plain(AN.wbalSeries(p, 0, 20000)), []);
});

// ---------- intervals ----------
function structured() {
  // 10 min warm-up ramp 100->200 W, 3 x (4 min @ 1.15 FTP / 3 min @ 0.5 FTP), 5 min cool-down @ 0.4
  const tg = [], p = [];
  for (let i = 0; i < 600; i++) tg.push(Math.round(100 + 100 * i / 600));
  for (let r = 0; r < 3; r++) { tg.push(...fill(240, Math.round(1.15 * FTP))); tg.push(...fill(180, Math.round(0.5 * FTP))); }
  tg.push(...fill(300, 0.4 * FTP));
  // power follows the target with noise and a few seconds of lag
  for (let i = 0; i < tg.length; i++) p.push(Math.max(0, Math.round(tg[Math.max(0, i - 3)] + 8 * Math.sin(i * 1.7))));
  return { p, tg, hr: fill(tg.length, 140), c: fill(tg.length, 90), dd: Array.from({ length: tg.length }, (_, i) => i * 8) };
}
test('intervals with target stream: ramp + 3 x (4 min / 3 min)', () => {
  const st = structured();
  const an = AN.analyzeRide(st, CTX);
  const work = an.ints.filter(x => x.k === 'work');
  assert.equal(work.length, 3, JSON.stringify(an.ints.map(x => [x.s, x.d, x.k])));
  work.forEach((w, r) => { assert.equal(w.s, 600 + r * 420); assert.equal(w.d, 240); assert.equal(w.tgt, 288); near(w.p, 288, 4); });
  assert.equal(an.ints[0].s, 0); assert.equal(an.ints[0].d, 600); assert.equal(an.ints[0].k, 'rec'); // ramp stays one piece
  assert.equal(an.ints.length, 8);
  assert.equal(sum(an.ints.map(x => x.d)), st.p.length);
  const w0 = work[0]; assert.equal(w0.hr, 140); assert.equal(w0.hrMax, 140); assert.equal(w0.c, 90);
});
test('intervals with targets: ramp into a steady block keeps the corner close', () => {
  const tg = [...Array.from({ length: 300 }, (_, i) => Math.round(120 + 60 * i / 300)), ...fill(600, 180), ...fill(300, 270), ...fill(300, 0)];
  const p = tg.map((t, i) => (t || 260));
  const an = AN.analyzeRide({ p, tg }, CTX);
  const kinds = an.ints.map(x => [x.s, x.d, x.k]);
  assert.equal(an.ints.length, 4, JSON.stringify(kinds));
  near(an.ints[1].s, 300, 3, 'corner');
  assert.equal(an.ints[1].k, 'rec'); assert.equal(an.ints[2].s, 900); assert.equal(an.ints[2].d, 300); assert.equal(an.ints[2].k, 'work');
  assert.equal(an.ints[3].s, 1200); assert.equal(an.ints[3].k, 'work'); // free/max piece judged by power (260 >= 0.85*250)
  assert.equal(an.ints[3].tgt, null);
});
test('intervals with targets: level block into a ramp, ramp into a level block', () => {
  const tg = [...fill(300, 150), ...Array.from({ length: 300 }, (_, i) => Math.round(150 + 100 * i / 300)), ...fill(300, 250)];
  const an = AN.analyzeRide({ p: tg.slice(), tg }, CTX);
  assert.equal(an.ints.length, 3, JSON.stringify(an.ints.map(x => [x.s, x.d, x.k])));
  near(an.ints[1].s, 300, 3, 'level->ramp corner'); near(an.ints[2].s, 600, 3, 'ramp->level corner');
  assert.equal(an.ints[2].k, 'work');
});
test('intervals without targets: power-based efforts', () => {
  const p = [...fill(600, 130), ...fill(300, 290), ...fill(300, 120), ...fill(300, 280), ...fill(20, 0), ...fill(600, 140), ...fill(20, 400), ...fill(300, 130)];
  const an = AN.analyzeRide({ p, hr: fill(p.length, 0) }, CTX);
  const work = an.ints.filter(x => x.k === 'work');
  assert.equal(work.length, 2, JSON.stringify(an.ints.map(x => [x.s, x.d, x.k])));
  assert.equal(work[0].s, 600); assert.equal(work[0].d, 300); assert.equal(work[0].p, 290);
  assert.equal(work[1].s, 1200); assert.equal(work[1].d, 300);
  assert.equal(work[0].hr, null); assert.equal(work[0].tgt, null);
  assert.equal(sum(an.ints.map(x => x.d)), p.length);
  assert.ok(an.ints.every(x => x.d >= 10));
});
test('intervals: at most 60', () => {
  const tg = []; for (let r = 0; r < 100; r++) { tg.push(...fill(30, 300)); tg.push(...fill(30, 120)); }
  const an = AN.analyzeRide({ p: tg.slice(), tg }, CTX);
  assert.ok(an.ints.length <= 60 && an.ints.length > 0, String(an.ints.length));
  assert.equal(sum(an.ints.map(x => x.d)), tg.length);
});
test('rangeStats', () => {
  const st = structured();
  const r = AN.rangeStats(st, 600, 840, FTP);
  assert.equal(r.d, 240); assert.equal(r.tgt, 288); assert.equal(r.avgHr, 140); assert.equal(r.maxHr, 140); assert.equal(r.avgC, 90);
  assert.equal(r.dist, 240 * 8);
  near(r.avgP, 288, 4); assert.ok(r.np >= r.avgP); assert.ok(r.maxP >= r.avgP);
  const e = AN.rangeStats({ p: [] }, 0, 10, FTP);
  assert.equal(e.d, 0); assert.equal(e.avgHr, null);
  assert.equal(AN.rangeStats({ p: [100, 200] }, 0, 2).np, 150); // short range: np = avg
});

// ---------- critical power ----------
test('cpFit recovers CP=250, W′=20000 within 1%', () => {
  const curve = AN.MMP_DUR.map(t => Math.round(250 + 20000 / t));
  const f = AN.cpFit(curve);
  near(f.cp, 250, 2.5, 'cp'); near(f.wprime, 20000, 200, 'wprime');
  assert.equal(f.eftp, Math.round(f.cp * 0.96)); assert.equal(f.pts, 9); // 120..1200 s
  assert.equal(AN.cpFit([]), null);
  assert.equal(AN.cpFit(AN.MMP_DUR.map(t => t <= 180 ? 300 : null)), null);
  assert.equal(AN.cpFit(null), null);
});

// ---------- multi-ride ----------
test('bestCurve: elementwise max with date filtering', () => {
  const L = AN.MMP_DUR.length;
  const rides = [
    { id: 'c', date: '2026-03-10T10:00:00.000Z', an: { mmp: fill(L, 300) } },
    { id: 'b', date: '2026-02-10T10:00:00.000Z', an: { mmp: [900, ...fill(L - 1, 250)] } },
    { id: 'a', date: '2026-01-10T10:00:00.000Z', an: { mmp: [...fill(L - 1, 280), null] } },
    { id: 'x', date: '2026-02-11T10:00:00.000Z' }, // no analysis
  ];
  const all = AN.bestCurve(rides, null, null);
  assert.equal(all.w[0], 900); assert.equal(all.id[0], 'b'); assert.equal(all.w[5], 300); assert.equal(all.id[5], 'c');
  const early = AN.bestCurve(rides, null, '2026-03-01');
  assert.equal(early.w[5], 280); assert.equal(early.id[5], 'a'); assert.equal(early.w[L - 1], 250); assert.equal(early.date[L - 1], rides[1].date);
  const feb = AN.bestCurve(rides, '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
  assert.equal(feb.w[1], 250); assert.equal(feb.id[1], 'b');
  const none = AN.bestCurve(rides, '2027-01-01', null);
  assert.deepEqual(plain(none.w), fill(L, null));
  assert.deepEqual(plain(AN.bestCurve([], null, null).id), fill(L, null));
});
test('fitnessSeries: 100 TSS/day for 200 days -> CTL ~100, TSB ~0', () => {
  const rides = []; for (let k = 199; k >= 0; k--) rides.push({ id: 'r' + k, date: daysAgo(k).toISOString(), tss: 100 });
  const s = AN.fitnessSeries(rides);
  assert.equal(s.length, 200);
  assert.equal(s[0].d, localKey(daysAgo(199))); assert.equal(s[199].d, localKey(new Date()));
  const last = s[s.length - 1];
  near(last.ctl, 99.2, 0.2, 'ctl'); near(last.atl, 100, 0.1, 'atl'); near(last.tsb, 0, 1, 'tsb');
  assert.equal(last.tss, 100);
  assert.equal(s[0].ctl, 2.4); assert.equal(s[0].atl, 14.3); assert.equal(s[0].tsb, -11.9);
  // later fromISO: same values, still seeded from the first ride
  const from = localKey(daysAgo(30));
  const s2 = AN.fitnessSeries(rides, from);
  assert.equal(s2.length, 31); assert.equal(s2[0].d, from);
  assert.deepEqual(plain(s2[0]), plain(s.find(x => x.d === from)));
  assert.ok(s2[0].ctl > 90);
  // earlier fromISO: zero days before the first ride
  const s3 = AN.fitnessSeries([{ date: daysAgo(5).toISOString(), tss: 50 }], localKey(daysAgo(10)));
  assert.equal(s3.length, 11); assert.equal(s3[0].ctl, 0); assert.equal(s3[5].tss, 50);
  assert.deepEqual(plain(AN.fitnessSeries([])), []);
  assert.equal(AN.fitnessSeries([{ date: 'garbage', tss: 10 }, { date: daysAgo(0).toISOString(), tss: NaN }]).length, 1);
});
test('weekTotals: Monday start, oldest first, empty weeks present', () => {
  const now = new Date(), dow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const at = (weeksBack, dayInWeek) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * weeksBack + dayInWeek, 9);
  const rides = [
    { date: at(0, 0).toISOString(), dur: 3600, tss: 60, kj: 700, dist: 30000, an: { tiz: [1, 2, 3, 4, 5, 6, 7] } },
    { date: at(2, 6).toISOString(), dur: 1800, tss: 30, kj: 350, dist: 15000 }, // Sunday -> belongs to that week's Monday
    { date: at(2, 0).toISOString(), dur: 1800, tss: 30, kj: 350, dist: 15000, an: { tiz: [10, 0, 0, 0, 0, 0, 0] } },
    { date: at(9, 0).toISOString(), dur: 999, tss: 9 }, // outside the window
  ];
  const w = AN.weekTotals(rides, 4);
  assert.equal(w.length, 4);
  assert.equal(w[3].wk, localKey(monday)); assert.equal(w[0].wk, localKey(at(3, 0)));
  w.forEach(x => assert.equal(new Date(x.wk + 'T12:00:00').getDay(), 1));
  assert.equal(w[3].n, 1); assert.equal(w[3].tss, 60); assert.deepEqual(plain(w[3].tiz), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(w[1].n, 2); assert.equal(w[1].dur, 3600); assert.equal(w[1].dist, 30000); assert.equal(w[1].tiz[0], 10);
  assert.equal(w[0].n, 0); assert.equal(w[2].n, 0); assert.equal(w[2].dur, 0);
  assert.deepEqual(plain(AN.weekTotals(null, 0)), []);
});
test('zoneTotals', () => {
  const rides = [
    { date: '2026-05-02T10:00:00Z', an: { tiz: [1, 1, 1, 1, 1, 1, 1], thz: [2, 2, 2, 2, 2] } },
    { date: '2026-05-01T10:00:00Z', an: { tiz: [1, 0, 0, 0, 0, 0, 0], thz: null } },
    { date: '2026-04-01T10:00:00Z', an: { tiz: [100, 0, 0, 0, 0, 0, 0] } },
    { date: '2026-05-03T10:00:00Z' },
  ];
  const z = AN.zoneTotals(rides, '2026-04-15T00:00:00Z');
  assert.deepEqual(plain(z), { tiz: [2, 1, 1, 1, 1, 1, 1], thz: [2, 2, 2, 2, 2], n: 2 });
  assert.equal(AN.zoneTotals(rides, null).tiz[0], 102);
});
test('dayKey: local dates', () => {
  assert.equal(AN.dayKey('2026-03-05'), '2026-03-05');
  assert.equal(AN.dayKey(new Date(2026, 0, 31, 23, 59)), '2026-01-31');
  assert.equal(AN.dayKey(new Date(2026, 0, 31, 0, 1).toISOString()), '2026-01-31');
  assert.equal(AN.dayKey('nope'), null); assert.equal(AN.dayKey(null), null);
});

// ---------- edge cases ----------
test('edge cases never throw', () => {
  const L = AN.MMP_DUR.length;
  for (const st of [{}, null, { p: [] }, { p: fill(100, 0) }, { p: [NaN, null, undefined, 'a', -5] }, { p: fill(50, 200), hr: null, c: 'x', tg: [null, 0] }]) {
    const an = AN.analyzeRide(st, CTX);
    assert.equal(an.mmp.length, L); assert.equal(an.tiz.length, 7); assert.equal(an.thz, null);
    assert.ok(Array.isArray(an.ints));
  }
  const z = AN.analyzeRide({ p: fill(100, 0) }, CTX);
  assert.equal(z.coast, 100); assert.equal(z.np, 0); assert.equal(z.vi, null); assert.equal(sum(z.tiz), 0);
  assert.equal(z.wbalMin, 20000);
  const nf = AN.analyzeRide({ p: fill(100, 200) }, {});
  assert.deepEqual(plain(nf.tiz), [0, 0, 0, 0, 0, 0, 0]); assert.equal(nf.wbalMin, null); assert.deepEqual(plain(nf.ints), []);
  const nan = AN.analyzeRide({ p: [NaN, 100, null, 100], hr: [NaN, 150, null, 150] }, CTX);
  assert.equal(nan.coast, 2); assert.equal(nan.avgP, 50); assert.equal(sum(nan.thz), 2);
  assert.equal(AN.analyzeRide(undefined, undefined).ints.length, 0);
});

// ---------- performance ----------
test('performance: 4 h ride fast (node:vm cross-realm arrays are ~8x slower than a browser; ~16 ms in-realm)', () => {
  const n = 14400, p = new Array(n), hr = new Array(n), c = new Array(n), tg = new Array(n), dd = new Array(n);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const t = (i % 600) < 240 ? 290 : 150; tg[i] = t;
    p[i] = Math.round(t + 15 * Math.sin(i * 0.9)); hr[i] = 120 + (i / n) * 30; c[i] = 90; d += 8; dd[i] = d;
  }
  AN.analyzeRide({ p, hr, c, tg, dd }, CTX); // warm up JIT
  const runs = 5, t0 = performance.now();
  for (let k = 0; k < runs; k++) AN.analyzeRide({ p, hr, c, tg, dd }, CTX);
  const ms = (performance.now() - t0) / runs;
  console.log(`     analyzeRide(14400 s): ${ms.toFixed(1)} ms`);
  assert.ok(ms < 400, ms + ' ms');
  const ms2 = (() => { const t = performance.now(); AN.analyzeRide({ p, hr, c, dd }, CTX); return performance.now() - t; })();
  assert.ok(ms2 < 400, 'free ride ' + ms2 + ' ms');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
