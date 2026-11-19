// Smoke test: both build variants produce one inline script that parses, has every part, and a matching CSP hash.
// Run: node src/test/build.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), build = join(here, '..', 'build.mjs');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) fails++; };
const variants = [
  ['local', {}],
  ['cloud', { ERGLAB_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', ERGLAB_SUPABASE_KEY: 'sb_publishable_test' }],
];
for (const [name, env] of variants) {
  const out = join(mkdtempSync(join(tmpdir(), 'erglab-')), 'index.html');
  execFileSync(process.execPath, [build, '--out', out], { env: { ...process.env, ERGLAB_SUPABASE_URL: '', ERGLAB_SUPABASE_KEY: '', ...env } });
  const html = readFileSync(out, 'utf8'), all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)], m = all.find(x => x[1].includes('function init()'));
  check(`${name}: app script found (+ error reporter)`, !!m && all.length === 2);
  check(`${name}: app script runs in its own scope`, !!m && /^\s*\(\(\) => \{/.test(m[1]) && /\}\)\(\);\s*$/.test(m[1]));
  try { new Function(m[1]); check(`${name}: script parses`, true); } catch (e) { check(`${name}: script parses`, false, e.message); }
  for (const g of ['const AN =', 'const BODY =', 'const ANUI =', 'const DEMO =', 'function makeGauge', 'function applyTheme', 'const TRAINER_PROTO =', 'const ANT =', 'const BTB_FONT =', 'function btbPath']) check(`${name}: has ${g}`, m[1].includes(g));
  check(`${name}: CSP hash matches every inline script`, all.every(x => html.includes(`'sha256-${createHash('sha256').update(x[1], 'utf8').digest('base64')}'`)));
  check(`${name}: LF line endings`, !html.includes('\r'));
}
console.log(fails ? `\n${fails} failed` : '\nall passed'); process.exit(fails ? 1 : 0);
