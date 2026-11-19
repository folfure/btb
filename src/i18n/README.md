# Translations (French)

The English text in the code is the key. `t('Connect trainer')` returns the French text when the interface is in
French, and the English text otherwise. Core: `i18n.js` (inlined at the top of the page script by `build.mjs`).

- `fr/*.json`: interface dictionaries, `{ "English text": "Texte français" }`, one file per area of the code. The
  build merges them; the same key may appear in two files only with the same translation.
- `fr-data/*.json`: workouts and plans, `{ "w": { "<workout id>": { "name", "desc", "src" } }, "lbl": { "<segment label>": "…" },
  "p": { "<plan id>": { "name", "level", "goal", "desc", "src", "focus": ["week 1 focus", …] } } }`.
- `node src/test/i18n.test.mjs` checks that every `t('…')` key and every static text in the page markup has a French
  entry, that `{placeholders}` match, and that every workout / plan / segment label is translated.

## How to mark text in code

- Every user-visible English string goes through `t()`: toasts, `confirm()`, HTML built in JS, titles, chart labels.
- Values go in `{braces}`: `t('Disconnect {name}?', { name: trainer.name })`, never `${…}` inside the key.
  Keep `esc()` on user values: `t('Delete {n}?', { n: esc(w.name) })`.
- A sentence with inline tags stays one key, tags included: `t('Ride in <b>Bluefy</b> on iPhone.')`.
- Same English, different French (e.g. a short gauge title): add a context after `@@`, `t('Heart rate@@gauge')`;
  English shows the part before `@@`.
- Plurals: two keys (`'{n} workout'`, `'{n} workouts'`) chosen in code.
- Static markup in `app.template.html` needs no code: text nodes and `placeholder` / `title` / `aria-label` / `alt`
  are translated when their text is a key. For a sentence with inline tags, add `data-i18n` to the element: its
  whole inner HTML (whitespace collapsed) is then the key.
- Dates: `toLocaleDateString(LOCALE, …)`. Numbers stay as they are (decimal point) unless only displayed: `tn(x, 1)`.
- Not translated: ids, storage keys, CSS classes, file formats read by other software (ZWO, TCX, ERG/MRC), units
  (W, bpm, rpm, km, kcal, kg, %), console messages, comments.

## French style

Informal **tu**, short and direct, like a coach. Typography: a non-breaking space before `: ; ! ?` is not needed
(plain space is fine on screens), French quotes not needed. Keep the app name **BTB** and **Bouge Ton Body**.

| English | French |
|---|---|
| workout | séance |
| ride (noun) / riding | sortie / rouler |
| plan / training plan | plan / plan d'entraînement |
| smart trainer / trainer | home trainer |
| heart rate / HR | fréquence cardiaque / FC |
| HR strap | ceinture cardio |
| power meter | capteur de puissance |
| cadence | cadence (rpm) |
| warm-up / cool-down | échauffement / retour au calme |
| interval / rest / recovery | intervalle / repos / récupération |
| steady / ramp / free ride | stable / rampe / sortie libre |
| sprint / max effort | sprint / effort max |
| slope / gradient | pente |
| power | puissance |
| target | cible |
| zone | zone |
| threshold | seuil |
| fitness / fatigue / form (CTL/ATL/TSB) | forme de fond / fatigue / fraîcheur |
| power curve | courbe de puissance |
| best efforts / records | meilleurs efforts / records |
| history | historique |
| settings | réglages |
| sign in / sign out | se connecter / se déconnecter |
| upload (to Strava) | envoyer (sur Strava) |
| connect / disconnect (a device) | connecter / déconnecter |
| weight / body weight | poids |
| calories | calories (kcal) |

Keep as is: FTP, ERG, TSS, NP, IF, W′ (W prime), CP, eFTP, VO2max, CTL, ATL, TSB, MAP, Zone 1-7, Sweet Spot,
Over-Under, Tempo, Strava, Bluetooth, ANT+, FE-C, FTMS, Bluefy, Zwift, Garmin.
Categories: Recovery → Récupération, Endurance → Endurance, Tempo → Tempo, Sweet Spot → Sweet Spot,
Threshold → Seuil, Over-Under → Over-Under, VO2max → VO2max, Anaerobic → Anaérobie, Sprint → Sprint,
Hills → Côtes, Test → Test, Mixed → Mixte, Custom → Perso.
Tabs: Workouts → Séances, Plans → Plans, Ride → Rouler, Build → Créer, History → Historique,
Progress → Progression, Settings → Réglages.
