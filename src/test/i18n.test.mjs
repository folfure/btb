// French coverage: every t('…') key in the code and every static text of the page markup has a French entry with the
// same {placeholders}; every workout, segment label and plan is translated (once src/i18n/fr-data/ exists).
// Run: node src/test/i18n.test.mjs            (add --list to print every missing key)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), src = join(here, '..'), list = process.argv.includes('--list');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) fails++; };
const jsons = d => existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => [f, JSON.parse(readFileSync(join(d, f), 'utf8'))]) : [];
const FR = {}, conflicts = [];
for (const [f, o] of jsons(join(src, 'i18n', 'fr'))) for (const [k, v] of Object.entries(o)) { if (k in FR && FR[k] !== v) conflicts.push(`${f}: ${k}`); FR[k] = v; }
check('no conflicting duplicate keys', !conflicts.length, conflicts.slice(0, 5).join(' | '));
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const has = k => k in FR || norm(k) in FR;
const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const bad = Object.entries(FR).filter(([k, v]) => typeof v !== 'string' || !v.trim() || ph(k) !== ph(v)).map(([k]) => k);
check('translations non-empty with the same {placeholders}', !bad.length, bad.slice(0, 5).map(k => JSON.stringify(k)).join(' | '));

// t('…') keys in the code
const files = ['app.template.html', ...readdirSync(join(src, 'parts')).filter(f => f.endsWith('.js')).map(f => 'parts/' + f)];
const keyRe = /(?<![\w.$])t\(\s*('(?:[^'\x5c]|\x5c[\s\S])*'|"(?:[^"\x5c]|\x5c[\s\S])*"|`(?:[^`\x5c]|\x5c[\s\S])*`)/g;
const missing = new Map(), dyn = [];
let nKeys = 0;
for (const f of files) {
  const s = readFileSync(join(src, f), 'utf8');
  for (const m of s.matchAll(keyRe)) {
    const lit = m[1], line = s.slice(0, m.index).split('\n').length;
    if (lit[0] === '`' && lit.includes('${')) { dyn.push(`${f}:${line}`); continue; }
    let k; try { k = new Function('return ' + lit)(); } catch { dyn.push(`${f}:${line} (unparsable)`); continue; }
    nKeys++; if (!has(k)) missing.set(k, `${f}:${line}`);
  }
}
check(`no \${…} inside t() keys`, !dyn.length, dyn.slice(0, 8).join(' '));
check(`all ${nKeys} t() keys translated`, !missing.size, `${missing.size} missing` + (missing.size ? ': ' + [...missing].slice(0, list ? 1e9 : 6).map(([k, w]) => `${w} ${JSON.stringify(k).slice(0, 90)}`).join('\n     ') : ''));

// static markup of the page (before the inline script): text nodes, a few attributes, data-i18n elements
{
  const html = readFileSync(join(src, 'app.template.html'), 'utf8'), b0 = html.indexOf('<body'), body = html.slice(b0, html.indexOf('<script>', b0)); // the app script after <body> (not the error reporter in <head>)
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'param', 'track', 'use', 'path', 'rect', 'circle', 'line', 'stop', 'polyline', 'polygon', 'ellipse']);
  const SKIP = new Set(['script', 'style', 'svg', 'pattern', 'defs']);
  const stack = [], miss = [];
  const tokRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of body.matchAll(tokRe)) {
    if (m[0].startsWith('<!--')) continue;
    const skipping = stack.some(e => e.skip || e.i18n);
    if (m[5] != null) { const txt = norm(m[5].replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')); if (!skipping && /[A-Za-z]{2}/.test(txt) && !has(txt)) miss.push(txt); continue; }
    const [, close, tag0, attrs, selfClose] = m, tag = tag0.toLowerCase();
    if (close) { const i = stack.map(e => e.tag).lastIndexOf(tag); if (i >= 0) { const e = stack[i]; if (e.i18n && !stack.slice(0, i).some(x => x.skip || x.i18n)) { const inner = norm(body.slice(e.start, m.index)); if (!has(inner)) miss.push('[data-i18n] ' + inner); } stack.length = i; } continue; }
    if (!skipping) for (const a of attrs.matchAll(/\b(placeholder|title|aria-label|alt)="([^"]*)"/g)) if (/[A-Za-z]{2}/.test(a[2]) && !has(a[2])) miss.push(`[${a[1]}] ${a[2]}`);
    if (VOID.has(tag) || selfClose) continue;
    stack.push({ tag, skip: SKIP.has(tag), i18n: /\sdata-i18n\b/.test(attrs), start: m.index + m[0].length });
  }
  check('all static page text translated', !miss.length, `${miss.length} missing` + (miss.length ? ': ' + miss.slice(0, list ? 1e9 : 6).map(s => JSON.stringify(s).slice(0, 100)).join('\n     ') : ''));
}

// workouts, segment labels and plans
const dataDir = join(src, 'i18n', 'fr-data');
if (existsSync(dataDir)) {
  const D = { w: {}, p: {}, lbl: {} };
  for (const [, o] of jsons(dataDir)) for (const k of ['w', 'p', 'lbl']) Object.assign(D[k], o[k] || {});
  const W = readdirSync(join(src, 'data')).filter(f => /^workouts.*\.json$/.test(f)).flatMap(f => JSON.parse(readFileSync(join(src, 'data', f), 'utf8')));
  const P = JSON.parse(readFileSync(join(src, 'data', 'plans.json'), 'utf8'));
  const labels = new Set(), walk = l => (l || []).forEach(s => { if (s.lbl) labels.add(s.lbl); walk(s.s); });
  W.forEach(w => walk(w.seg));
  const wm = W.filter(w => !(D.w[w.id] && D.w[w.id].name && D.w[w.id].desc && (!w.src || D.w[w.id].src))).map(w => w.id);
  check(`all ${W.length} workouts translated (name, description, source)`, !wm.length, wm.slice(0, 8).join(' '));
  const lm = [...labels].filter(l => !D.lbl[l]);
  check(`all ${labels.size} segment labels translated`, !lm.length, lm.slice(0, 8).map(l => JSON.stringify(l)).join(' '));
  const pm = P.filter(p => { const o = D.p[p.id]; return !o || ['name', 'level', 'goal', 'desc'].some(k => p[k] && !o[k]) || (p.src && !o.src) || !Array.isArray(o.focus) || o.focus.length !== (p.weeks || []).length || o.focus.some((f, i) => p.weeks[i].focus && !f); }).map(p => p.id);
  check(`all ${P.length} plans translated (texts + every week's focus)`, !pm.length, pm.join(' '));
  const ramp = W.filter(w => /ramp/i.test(w.name) && D.w[w.id] && !/ramp/i.test(D.w[w.id].name)).map(w => w.id);
  check('ramp-test names still contain "ramp" (code detects ramp tests by name)', !ramp.length, ramp.join(' '));
} else console.log('skip workouts / plans (no src/i18n/fr-data yet)');
console.log(fails ? `\n${fails} failed` : '\nall passed'); process.exit(fails ? 1 : 0);
