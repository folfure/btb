// Builds the single self-contained ../index.html from app.template.html + data/*.json
// Usage: node src/build.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
// src/parts/*.css and *.js (theme, gauges, analysis, analytics views) are inlined into the template, sorted by
// file name, so the output stays one self-contained HTML file.
const partsDir = join(here, 'parts');
const parts = ext => existsSync(partsDir) ? readdirSync(partsDir).filter(f => f.endsWith(ext)).sort()
  .map(f => `/* ---- parts/${f} ---- */\n` + readFileSync(join(partsDir, f), 'utf8').replace(/<\/(script|style)/gi, '<\\/$1')).join('\n') : '';
const tpl = readFileSync(join(here, 'app.template.html'), 'utf8')
  .replace('/*__PARTS_CSS__*/', () => parts('.css'))
  .replace('/*__PARTS_JS__*/', () => parts('.js'))
  // Browsers turn CRLF into LF before hashing an inline script for the CSP, so the output must be LF-only
  // (Windows editors save CRLF) or the script hash won't match and the page stays blank.
  .replace(/\r\n?/g, '\n');

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

// Cloud (Supabase) config: from env (GitHub Actions variables) or the git-ignored src/cloud.config.json.
// Only the project URL and the PUBLISHABLE key may ever go into the page.
let fileCfg = {};
const cfgPath = join(here, 'cloud.config.json');
if (existsSync(cfgPath)) fileCfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const cloud = {
  url: String(process.env.ERGLAB_SUPABASE_URL || fileCfg.url || '').trim().replace(/\/+$/, ''),
  key: String(process.env.ERGLAB_SUPABASE_KEY || fileCfg.key || '').trim(),
};
if (cloud.url || cloud.key) {
  if (!cloud.url || !cloud.key) { console.error('Both the Supabase URL and the publishable key are needed'); process.exit(1); }
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(cloud.url) && !(process.env.ERGLAB_ALLOW_CUSTOM_URL && /^https:\/\/[a-z0-9.-]+$/i.test(cloud.url))) { console.error('Supabase URL must look like https://<20-char-ref>.supabase.co (set ERGLAB_ALLOW_CUSTOM_URL=1 for a custom domain)'); process.exit(1); }
  if (/^sb_secret_/i.test(cloud.key)) { console.error('REFUSING TO BUILD: that is a Supabase SECRET key. Use the publishable key (sb_publishable_…).'); process.exit(1); }
  if (/^eyJ/.test(cloud.key)) { // legacy JWT key: make sure it is the anon one
    try { const role = JSON.parse(Buffer.from(cloud.key.split('.')[1], 'base64url').toString()).role; if (role !== 'anon') { console.error(`REFUSING TO BUILD: legacy key has role "${role}", only the anon key may be public.`); process.exit(1); } }
    catch { console.error('Unreadable Supabase key'); process.exit(1); }
  } else if (!/^sb_publishable_/.test(cloud.key)) { console.error('Supabase key must be the publishable key (sb_publishable_…)'); process.exit(1); }
}

// The committed repo-root index.html is the local-only build. A cloud build goes to dist/ unless --out is given,
// so the Supabase project settings never end up in a file that gets committed.
const outArg = process.argv.indexOf('--out');
const rootIndex = resolve(join(here, '..', 'index.html'));
const target = resolve(outArg > 0 ? process.argv[outArg + 1] : (cloud.url ? join(here, '..', 'dist', 'index.html') : rootIndex));
if (cloud.url && target === rootIndex) { console.error('Refusing to write a cloud build over the committed index.html; use --out dist/index.html'); process.exit(1); }
// Hosted builds (anything but the committed single file) also get a web app manifest + icons, so the page can be
// installed: "Add to Home Screen" on iPhone/iPad, "Install" in desktop Chrome/Edge.
const pwa = target !== rootIndex;

const js = v => JSON.stringify(v).replace(/</g, '\\u003c');
let out = tpl
  .replace('/*__WORKOUTS__*/[]', () => js(workouts))
  .replace('/*__PLANS__*/[]', () => js(plans))
  .replace(/\/\*__CLOUD__\*\/\{[^}]*\}/, () => js(cloud));

// Content-Security-Policy: only this page's own inline scripts (by hash) and the pinned supabase-js may run,
// and the page may only talk to the configured Supabase project and Strava.
const inline = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!inline.length) { console.error('inline script not found'); process.exit(1); }
const hashes = inline.map(m => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`).join(' ');
const connect = cloud.url ? `${cloud.url} https://www.strava.com` : 'https: http://localhost:* http://127.0.0.1:*';
const csp = [
  "default-src 'none'",
  `script-src ${hashes}${cloud.url ? ' https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js' : ''}`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  ...(pwa ? ["manifest-src 'self'"] : []),
  "media-src blob: mediastream:",
  `connect-src ${connect}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
out = out.replace('<!--__CSP__-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
out = out.replace(/<!--__PWA__-->\r?\n?/, pwa ? '<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">\n' : '');

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out);
if (pwa) {
  const dir = dirname(target);
  for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) copyFileSync(join(here, 'assets', f), join(dir, f));
  writeFileSync(join(dir, 'manifest.webmanifest'), JSON.stringify({
    id: './', name: 'BTB – Bouge Ton Body', short_name: 'BTB',
    description: 'Bouge Ton Body: structured indoor cycling workouts with ERG control for smart trainers.',
    start_url: './', scope: './', display: 'standalone', orientation: 'any',
    background_color: '#0a0d13', theme_color: '#0a0d13', lang: 'en', categories: ['sports', 'health', 'fitness'],
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 1));
}
console.log(`${target}: ${workouts.length} workouts, ${plans.length} plans, ${(out.length / 1024).toFixed(0)} KB, cloud ${cloud.url ? 'ON (' + cloud.url + ')' : 'off (local-only)'}`);
