// Interface language: English (the source text) or French. The English text itself is the key, so code reads
//   t('Connect trainer')                          -> 'Connecter le home trainer' in French
//   t('Disconnect {name}?', { name: trainer.name }) placeholders in braces, same names in both languages
//   t('Heart rate@@gauge')                        the same English text with its own French (here a shorter one)
// The dictionaries (src/i18n/fr/*.json) and the workout / plan translations (src/i18n/fr-data/*.json) are merged by
// build.mjs into I18N_FR and I18N_FR_DATA right above this code. Static page text is translated by translateDom(),
// and a MutationObserver translates exact-match text that renders add later (a safety net, not a replacement for t()).
// The language is read before anything renders; changing it saves the setting and reloads the page.
const LANGS = { en: 'English', fr: 'Français' };
function resolveLang(pref) { return LANGS[pref] ? pref : /^fr\b/i.test((typeof navigator !== 'undefined' && navigator.language) || '') ? 'fr' : 'en'; }
const LANG = (() => { try { const s = JSON.parse(localStorage.getItem('erglab.settings') || '{}'); return resolveLang(s && s.lang); } catch { return resolveLang(''); } })();
const LOCALE = LANG === 'fr' ? 'fr-FR' : 'en-GB';
const I18N = LANG === 'fr' ? I18N_FR : null;
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const I18N_MISS = new Set(); // keys asked for but missing from the French dictionary (for checking coverage)
function t(s, v) {
  let r = s;
  if (I18N) { r = I18N[s] ?? I18N[norm(s)]; if (r == null) { r = s; if (/[A-Za-z]/.test(s)) I18N_MISS.add(s); } }
  if (r === s && s.includes('@@')) r = s.slice(0, s.indexOf('@@')); // context keys: 'Heart rate@@gauge' shows 'Heart rate' in English
  if (v) r = r.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);
  return r;
}
// the same t() under a name parts can look up without shadowing it (their own `const t` falls back to English in node tests)
const i18nT = t;
// French number formatting for display only (decimal comma); never feed the result back into maths
const tn = (x, d = 0) => (+x).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });

// Workouts and plans: swap in the French name / description / source / segment labels / plan texts in place
function i18nData(lib, plans) {
  if (LANG !== 'fr' || typeof I18N_FR_DATA === 'undefined') return;
  const D = I18N_FR_DATA, lbl = D.lbl || {};
  const segs = list => (list || []).forEach(s => { if (s && s.lbl && lbl[s.lbl]) s.lbl = lbl[s.lbl]; if (s && s.s) segs(s.s); });
  for (const w of lib) {
    const o = (D.w || {})[w.id];
    if (o) for (const k of ['name', 'desc', 'src']) if (o[k]) w[k] = o[k];
    segs(w.seg);
  }
  for (const p of plans) {
    const o = (D.p || {})[p.id]; if (!o) continue;
    p.levelKey = p.level; // the English level drives the badge colour
    for (const k of ['name', 'level', 'goal', 'desc', 'src']) if (o[k]) p[k] = o[k];
    if (Array.isArray(o.focus)) (p.weeks || []).forEach((wk, i) => { if (o.focus[i]) wk.focus = o.focus[i]; });
  }
}

// Static markup: text nodes whose (whitespace-collapsed) text is a key, the placeholder / title / aria-label /
// alt attributes, and elements marked data-i18n, whose whole inner HTML is one key (sentences with inline tags).
const I18N_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
function translateDom(root) {
  if (!I18N || !root) return;
  const els = root.nodeType === 1 ? [root, ...root.querySelectorAll('*')] : [];
  for (const el of els) {
    if (el.hasAttribute && el.hasAttribute('data-i18n') && !el.__i18n) {
      el.__i18n = 1; const k = norm(el.innerHTML), v = I18N[k]; if (v) el.innerHTML = v; else I18N_MISS.add(k);
    }
    for (const a of I18N_ATTRS) { const v0 = el.getAttribute && el.getAttribute(a), v = v0 && I18N[norm(v0)]; if (v && v !== v0) el.setAttribute(a, v); }
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentNode && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName) ? 2 : 1 });
  for (let n = root.nodeType === 3 ? root : w.nextNode(); n; n = w.nextNode()) translateText(n);
}
function translateText(n) {
  const s = n.nodeValue; if (!s || !/[A-Za-z]/.test(s)) return;
  const k = norm(s), v = I18N[k];
  if (v && v !== k) n.nodeValue = s.match(/^\s*/)[0] + v + s.match(/\s*$/)[0];
}
function i18nStart() {
  document.documentElement.lang = LANG;
  if (/[?&]i18n-debug/.test(location.search)) window.BTB_I18N_MISS = I18N_MISS; // coverage check: ?i18n-debug
  if (!I18N) return;
  translateDom(document.body);
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') { const v0 = m.target.getAttribute(m.attributeName), v = v0 && I18N[norm(v0)]; if (v && v !== v0) m.target.setAttribute(m.attributeName, v); continue; }
      for (const n of m.addedNodes) n.nodeType === 3 ? translateText(n) : n.nodeType === 1 && translateDom(n);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: I18N_ATTRS });
}
