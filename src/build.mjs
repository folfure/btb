// Builds the single self-contained ../index.html from app.template.html + data/*.json
// Usage: node src/build.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const tpl = readFileSync(join(here, 'app.template.html'), 'utf8');

const workouts = [];
for (const f of readdirSync(dataDir).filter(f => /^workouts.*\.json$/.test(f)).sort()) {
  workouts.push(...JSON.parse(readFileSync(join(dataDir, f), 'utf8')));
}
const plans = existsSync(join(dataDir, 'plans.json')) ? JSON.parse(readFileSync(join(dataDir, 'plans.json'), 'utf8')) : [];

// validation
const ids = new Set();
const errors = [];
const CATS = ['Recovery', 'Endurance', 'Tempo', 'Sweet Spot', 'Threshold', 'Over-Under', 'VO2max', 'Anaerobic', 'Sprint', 'Hills', 'Test', 'Mixed'];
const checkSeg = (s, w, depth = 0) => {
  if (!s || typeof s !== 'object') return errors.push(`${w.id}: bad segment`);
  if (s.t === 'x') { if (!(s.n >= 1) || !Array.isArray(s.s) || !s.s.length) errors.push(`${w.id}: bad repeat`); (s.s || []).forEach(c => checkSeg(c, w, depth + 1)); return; }
  if (!(s.d > 0)) errors.push(`${w.id}: segment without duration`);
  if (s.t === 's' && !(s.p > 0 && s.p < 3)) errors.push(`${w.id}: steady power ${s.p}`);
  if (s.t === 'r' && !(s.p0 > 0 && s.p1 > 0 && s.p0 < 3 && s.p1 < 3)) errors.push(`${w.id}: ramp power ${s.p0}-${s.p1}`);
  if (!['s', 'r', 'x', 'f'].includes(s.t)) errors.push(`${w.id}: unknown segment type ${s.t}`);
};
for (const w of workouts) {
  if (ids.has(w.id)) errors.push(`duplicate id ${w.id}`);
  ids.add(w.id);
  if (!CATS.includes(w.cat)) errors.push(`${w.id}: unknown category ${w.cat}`);
  if (!w.seg?.length) errors.push(`${w.id}: no segments`);
  (w.seg || []).forEach(s => checkSeg(s, w));
}
for (const p of plans) for (const wk of p.weeks || []) for (const id of wk.days || []) if (!ids.has(id)) errors.push(`plan ${p.id}: unknown workout ${id}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

const js = v => JSON.stringify(v).replace(/</g, '\\u003c');
const out = tpl
  .replace('/*__WORKOUTS__*/[]', () => js(workouts))
  .replace('/*__PLANS__*/[]', () => js(plans));
const target = join(here, '..', 'index.html');
writeFileSync(target, out);
console.log(`index.html: ${workouts.length} workouts, ${plans.length} plans, ${(out.length / 1024).toFixed(0)} KB`);
