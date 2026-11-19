// Tests for the smart-trainer protocols: the pure helpers in src/parts/c0-trainer-proto.js, and the Trainer class
// from app.template.html driven against fake Bluetooth devices (FTMS, Tacx FE-C, Wahoo legacy, power meter).
// Run: node src/test/protocols.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const protoSrc = readFileSync(join(here, '..', 'parts', 'c0-trainer-proto.js'), 'utf8');
const P = new Function(`${protoSrc}\nreturn TRAINER_PROTO;`)();

let fails = 0, count = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xor = a => a.reduce((c, b) => c ^ b, 0);
const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join(' ');

/* ---------------- pure helpers ---------------- */
test('pick: prefers a protocol that can control the trainer', () => {
  assert.equal(P.pick({ ftms: true, ftmsCp: true, fec: true, wahoo: true, cps: true }), 'ftms');
  assert.equal(P.pick({ ftms: true, ftmsCp: false, fec: true, cps: true }), 'fec');
  assert.equal(P.pick({ ftms: false, fec: false, wahoo: true, cps: true }), 'wahoo');
  assert.equal(P.pick({ ftms: true, ftmsCp: false, cps: true }), 'ftms');
  assert.equal(P.pick({ cps: true }), 'cps');
  assert.equal(P.pick({}), null);
  assert.deepEqual(P.NAMES, { ftms: 'FTMS', fec: 'Tacx FE-C', wahoo: 'Wahoo', cps: 'Power meter' });
});

test('FTMS: control point commands', () => {
  assert.deepEqual(P.ftms.requestControl(), [0x00]);
  assert.deepEqual(P.ftms.reset(), [0x01]);
  assert.deepEqual(P.ftms.start(), [0x07]);
  assert.deepEqual(P.ftms.targetPower(250), [0x05, 0xfa, 0x00]);
  assert.deepEqual(P.ftms.targetPower(1234), [0x05, 0xd2, 0x04]);
  assert.deepEqual(P.ftms.simulation(3.5), [0x11, 0, 0, 0x5e, 0x01, 40, 51]);
  assert.deepEqual(P.ftms.simulation(-2), [0x11, 0, 0, 0x38, 0xff, 40, 51]);
  assert.deepEqual(P.ftms.simulation(0, 0.005, 0.6, 1.5), [0x11, 0xdc, 0x05, 0, 0, 50, 60]);
  assert.deepEqual(P.ftms.resistanceForGrade(5), [0x04, 60]);
  assert.deepEqual(P.ftms.resistanceForGrade(-10), [0x04, 0]);
});

test('FTMS: features, power range, replies, status', () => {
  const feat = P.ftms.parseFeatures([0x02, 0x44, 0x00, 0x00, 0x08, 0x20, 0x00, 0x00]); // machine: cadence, power data, hr; target: power, sim
  assert.equal(feat.power, true); assert.equal(feat.sim, true); assert.equal(feat.resistance, false);
  assert.equal(feat.powerData, true); assert.equal(feat.hr, true);
  assert.equal(P.ftms.parseFeatures([1, 2, 3]), null);
  assert.deepEqual(P.ftms.parsePowerRange([0x00, 0x00, 0xdc, 0x05, 0x01, 0x00]), { min: 0, max: 1500, inc: 1 });
  assert.deepEqual(P.ftms.parsePowerRange([0x00, 0x00, 0x20, 0x08, 0x00, 0x00]), { min: 0, max: 2080, inc: 1 }); // inc 0 -> 1
  assert.equal(P.ftms.parsePowerRange([0x00, 0x00, 0x00, 0x00, 0x01, 0x00]), null);
  assert.deepEqual(P.ftms.parseResponse([0x80, 0x05, 0x01]), { op: 5, result: 1 });
  assert.equal(P.ftms.parseResponse([0x08, 0xfa, 0x00]), null);
  assert.deepEqual(P.ftms.parseStatus([0xff]), { op: 0xff, reset: false, lost: true });
  assert.deepEqual(P.ftms.parseStatus([0x01]), { op: 1, reset: true, lost: false });
});

test('FTMS: Indoor Bike Data', () => {
  // flags 0x0244: speed (bit 0 clear), cadence, power, heart rate
  assert.deepEqual(P.ftms.parseIndoorBikeData([0x44, 0x02, 0x10, 0x0e, 0xb4, 0x00, 0xfa, 0x00, 0x8c]), { speed: 36, cadence: 90, power: 250, hr: 140 });
  // more-data bit set: no speed; resistance as uint8 (newer GSS) before power
  assert.deepEqual(P.ftms.parseIndoorBikeData([0x75, 0x00, 0xa0, 0x00, 0x10, 0x27, 0x00, 0x05, 0x2c, 0x01]), { cadence: 80, distance: 10000, power: 300 });
  // same with sint16 resistance (FTMS 1.0)
  assert.deepEqual(P.ftms.parseIndoorBikeData([0x75, 0x00, 0xa0, 0x00, 0x10, 0x27, 0x00, 0x05, 0x00, 0x2c, 0x01]), { cadence: 80, distance: 10000, power: 300 });
  // truncated packet keeps what was read, HR 0 is ignored
  assert.deepEqual(P.ftms.parseIndoorBikeData([0x44, 0x02, 0x10, 0x0e, 0xb4]), { speed: 36 });
  assert.deepEqual(P.ftms.parseIndoorBikeData(new DataView(Uint8Array.from([0x41, 0x02, 0x64, 0x00, 0x00]).buffer)), { power: 100 });
});

test('Cycling Power Measurement + crank cadence', () => {
  const m = P.cps.parseMeasurement([0x20, 0x00, 0xc8, 0x00, 0x0a, 0x00, 0x00, 0x04]); // crank data: 10 revs at 1024/1024 s
  assert.deepEqual(m, { power: 200, crank: { revs: 10, t: 1024 } });
  assert.equal(P.cps.parseMeasurement([0x00, 0x00, 0x96, 0x00]).power, 150);
  assert.equal(P.cps.parseMeasurement([0x00, 0x00, 0x96, 0x00]).crank, null);
  // wheel data (bit 4) before crank data
  assert.deepEqual(P.cps.parseMeasurement([0x30, 0x00, 0x64, 0x00, 1, 0, 0, 0, 0, 0, 0x05, 0x00, 0x00, 0x08]).crank, { revs: 5, t: 2048 });
  assert.equal(P.cps.cadence({ revs: 10, t: 1024 }, { revs: 11, t: 1024 + 683 }).toFixed(0), '90');
  assert.equal(Math.round(P.cps.cadence({ revs: 65535, t: 65000 }, { revs: 0, t: (65000 + 683) % 65536 })), 90); // wrap
  assert.equal(Math.round(P.cps.cadence({ revs: 65535, t: 65200 }, { revs: 1, t: (65200 + 1366) % 65536 })), 90); // both wrap
  assert.equal(P.cps.cadence({ revs: 10, t: 1024 }, { revs: 10, t: 1024 }), null);
  assert.equal(P.cps.cadence(null, { revs: 1, t: 1 }), null);
});

test('FE-C: ANT message wrap / unwrap / checksum', () => {
  const page = [0x31, 0xff, 0xff, 0xff, 0xff, 0xff, 0x20, 0x03];
  const msg = P.fec.wrap(page);
  assert.equal(msg.length, 13);
  assert.deepEqual(msg.slice(0, 4), [0xa4, 0x09, 0x4f, 0x05]);
  assert.equal(msg[12], xor(msg.slice(0, 12)));
  assert.equal(hex(msg), 'a4 09 4f 05 31 ff ff ff ff ff 20 03 ' + xor([0xa4, 0x09, 0x4f, 0x05, 0x31, 0xff, 0xff, 0xff, 0xff, 0xff, 0x20, 0x03]).toString(16).padStart(2, '0'));
  assert.deepEqual(P.fec.unwrap(msg), { msgId: 0x4f, channel: 5, page });
  assert.deepEqual(P.fec.wrap(page, 0x4e, 3).slice(2, 4), [0x4e, 3]);
  const bad = msg.slice(); bad[12] ^= 1; assert.equal(P.fec.unwrap(bad), null);
  assert.equal(P.fec.unwrap(msg.slice(0, 12)), null);
  assert.throws(() => P.fec.wrap([1, 2, 3]));
  // two messages in one notification, with junk in front
  const p16 = [0x10, 25, 40, 100, 0x10, 0x27, 0x8c, 0x01];
  const both = [0x00, 0xa4, ...P.fec.wrap(p16, 0x4e), ...msg];
  assert.deepEqual(P.fec.unwrapAll(both).map(m => m.page[0]), [0x10, 0x31]);
  assert.deepEqual(P.fec.unwrapAll(Uint8Array.from(both)).length, 2);
});

test('FE-C: control pages', () => {
  assert.deepEqual(P.fec.encodeTargetPower(200), [0x31, 0xff, 0xff, 0xff, 0xff, 0xff, 0x20, 0x03]); // 800 x 0.25 W
  assert.deepEqual(P.fec.encodeTargetPower(-5).slice(6), [0, 0]);
  assert.deepEqual(P.fec.encodeTrackResistance(5), [0x33, 0xff, 0xff, 0xff, 0xff, 0x14, 0x50, 80]); // 20500 = (5+200)*100
  assert.deepEqual(P.fec.encodeTrackResistance(-3.5, null), [0x33, 0xff, 0xff, 0xff, 0xff, 0xc2, 0x4c, 0xff]); // 19650
  assert.deepEqual(P.fec.encodeTrackResistance(0).slice(5, 7), [0x20, 0x4e]); // 20000
  assert.deepEqual(P.fec.encodeWindResistance(0.51, 0, 1), [0x32, 0xff, 0xff, 0xff, 0xff, 51, 127, 100]);
  assert.deepEqual(P.fec.encodeBasicResistance(25), [0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 50]);
  assert.deepEqual(P.fec.encodeBasicResistance(120)[7], 200);
  // user 75 kg = 7500 = 0x1d4c; bike 9 kg = 180 x 0.05 kg = 0x0b4 -> LSN 4 in byte 4 high nibble, 0x0b in byte 5; wheel 0.7 m = 70
  assert.deepEqual(P.fec.encodeUserConfig(75, 9, 0.7), [0x37, 0x4c, 0x1d, 0xff, 0x4f, 0x0b, 70, 0x00]);
  assert.deepEqual(P.fec.encodeRequestPage(54), [0x46, 0xff, 0xff, 0xff, 0xff, 0x02, 54, 0x01]);
});

test('FE-C: data pages', () => {
  assert.deepEqual(P.fec.parsePage([0x10, 25, 40, 100, 0x10, 0x27, 0x8c, 0x31]),
    { page: 16, equipment: 25, elapsed: 10, distance: 100, speed: 36, hr: 140, hrSource: 1, state: 3 });
  assert.equal(P.fec.parsePage([0x10, 25, 0, 0, 0xff, 0xff, 0xff, 0x00]).speed, null);
  assert.equal(P.fec.parsePage([0x10, 25, 0, 0, 0, 0, 0xff, 0x00]).hr, null);
  // power 0x123 = 291 W (12 bit), cadence 92, status nibble 0x2, target flag 0 (at target), state 3 (in use)
  assert.deepEqual(P.fec.parsePage([0x19, 7, 92, 0x34, 0x12, 0x23, 0x21, 0x30]),
    { page: 25, events: 7, cadence: 92, accPower: 0x1234, power: 291, trainerStatus: 2, target: 0, state: 3 });
  const inval = P.fec.parsePage([0x19, 0, 0xff, 0, 0, 0xff, 0x0f, 0x03]);
  assert.equal(inval.power, null); assert.equal(inval.cadence, null); assert.equal(inval.target, 3);
  assert.deepEqual(P.fec.parsePage([0x36, 0xff, 0xff, 0xff, 0xff, 0xe8, 0x03, 0x07]), { page: 54, maxResistance: 1000, basic: true, power: true, sim: true });
  assert.deepEqual(P.fec.parsePage([0x47, 0x33, 4, 2, 0xff, 0xff, 0xff, 0xff]), { page: 71, lastCommand: 0x33, seq: 4, status: 2 });
  assert.deepEqual(P.fec.parsePage([0x50, 0, 0, 0, 0, 0, 0, 0]), { page: 0x50 });
  assert.equal(P.fec.parsePage([0x10, 1]), null);
});

test('Wahoo legacy commands and replies', () => {
  assert.deepEqual(P.wahoo.unlock(), [0x20, 0xee, 0xfc]);
  assert.deepEqual(P.wahoo.erg(250), [0x42, 0xfa, 0x00]);
  assert.deepEqual(P.wahoo.erg(1500), [0x42, 0xdc, 0x05]);
  assert.deepEqual(P.wahoo.grade(0), [0x46, 0x00, 0x80]);   // 32768
  assert.deepEqual(P.wahoo.grade(5), [0x46, 0x66, 0x86]);   // 34406
  assert.deepEqual(P.wahoo.grade(-5), [0x46, 0x99, 0x79]);  // 31129
  assert.deepEqual(P.wahoo.grade(150), [0x46, 0xff, 0xff]); // clamped to +100 %
  assert.deepEqual(P.wahoo.simMode(84, 0.004, 0.51), [0x43, 0xd0, 0x20, 0x28, 0x00, 0xfe, 0x01]); // 8400, 40, 510
  assert.deepEqual(P.wahoo.windSpeed(0), [0x47, 0x00, 0x80]);
  assert.deepEqual(P.wahoo.wheel(2096), [0x48, 0xe0, 0x51]);
  assert.deepEqual(P.wahoo.parseResponse([0x01, 0x42, 0x01, 0x00, 0xfa, 0x00]), { ok: true, op: 0x42 });
  assert.deepEqual(P.wahoo.parseResponse([0x02, 0x46]), { ok: false, op: 0x46 });
  assert.equal(P.wahoo.parseResponse([0x01]), null);
});

/* ---------------- Trainer class against fake devices ---------------- */
const tpl = readFileSync(join(here, '..', 'app.template.html'), 'utf8');
const a = tpl.indexOf('/* =====================================================================\n   BLUETOOTH: smart trainer'), b = tpl.indexOf('class HrStrap {');
assert.ok(a > 0 && b > a, 'trainer region not found in app.template.html');
const trainerSrc = tpl.slice(a, b);

const key = u => String(u).toLowerCase();
class FakeChar {
  constructor(uuid, o = {}) {
    this.uuid = key(uuid); this.o = o; this.hs = []; this.writes = []; this.value = o.value || [];
    this.properties = { read: true, write: o.write !== false, writeWithoutResponse: !!o.wwr, notify: true, indicate: true };
  }
  addEventListener(t, h) { this.hs.push(h); }
  removeEventListener(t, h) { this.hs = this.hs.filter(x => x !== h); }
  async startNotifications() { this.notifying = true; return this; }
  async readValue() { return new DataView(Uint8Array.from(this.value).buffer); }
  async writeValueWithResponse(d) { this.writes.push({ bytes: [...d], noResp: false }); this.o.onWrite?.(this, [...d]); }
  async writeValueWithoutResponse(d) { this.writes.push({ bytes: [...d], noResp: true }); this.o.onWrite?.(this, [...d]); }
  notify(bytes) { const ev = { target: { value: new DataView(Uint8Array.from(bytes).buffer) } }; for (const h of [...this.hs]) h(ev); }
}
function fakeDevice(name, services) { // services: { uuid: [FakeChar] }
  const svcs = Object.fromEntries(Object.entries(services).map(([u, cs]) => [key(u), {
    getCharacteristic: async c => { const f = cs.find(x => x.uuid === key(c)); if (!f) throw Object.assign(new Error('no char'), { name: 'NotFoundError' }); return f; },
  }]));
  const dev = {
    name, hs: [], addEventListener(t, h) { this.hs.push(h); }, removeEventListener(t, h) { this.hs = this.hs.filter(x => x !== h); },
    gatt: {
      connected: false,
      async connect() { this.connected = true; return { getPrimaryService: async u => { const s = svcs[key(u)]; if (!s) throw Object.assign(new Error('no service'), { name: 'NotFoundError' }); return s; } }; },
      disconnect() { this.connected = false; dev.hs.forEach(h => h()); },
    },
  };
  return dev;
}
function makeEnv(dev) {
  const env = { toasts: [], requests: [], applyCalls: 0 };
  const stubs = {
    toast: (m) => env.toasts.push(m), updateConnUI: () => { }, showBtHelp: () => { }, initAudio: () => { }, nudgeTick: () => { },
    applyControl: () => { env.applyCalls++; }, clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    S: { weight: 75 }, sim: { on: false, stop() { } }, hrm: { connected: false },
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m) : s, // English, as the page shows it without French
    hasBt: () => true, TRAINER_NAMES: ['DIRETO', 'KICKR'],
    navigator: { bluetooth: { requestDevice: async opts => { env.requests.push(opts); return dev; } } },
  };
  const names = Object.keys(stubs);
  const out = new Function(...names, `${protoSrc}\n${trainerSrc}\nreturn { trainer: new Trainer(), live };`)(...names.map(n => stubs[n]));
  return Object.assign(env, out);
}
const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(10); } };
const ftmsReply = (ch, bytes) => setTimeout(() => ch.notify([0x80, bytes[0], 0x01]), 5);

test('Trainer: requestDevice lists every protocol, plus trainer names; "show all" accepts any device', async () => {
  const dev = fakeDevice('X', { 0x1818: [new FakeChar(0x2a63)] });
  const env = makeEnv(dev);
  await env.trainer.connect();
  const r = env.requests[0], svc = r.filters.filter(f => f.services), names = r.filters.filter(f => f.namePrefix);
  assert.deepEqual(svc.map(f => f.services[0]), [0x1826, 0x1818, P.UUID.FEC], 'one service filter per protocol');
  assert.ok(names.length && names.every(f => !f.services && typeof f.namePrefix === 'string'), 'name filters only widen the list');
  assert.ok(r.filters.every(f => f.services || f.namePrefix), 'no empty filter');
  const opt = [0x1826, 0x1818, P.UUID.FEC, P.UUID.WAHOO_SVC, 0x180d, 'device_information', 'battery_service'];
  for (const u of opt) assert.ok(r.optionalServices.includes(u), 'optional ' + u);
  await env.trainer.connect(true);
  const all = env.requests[1];
  assert.equal(all.acceptAllDevices, true); assert.equal(all.filters, undefined);
  for (const u of opt) assert.ok(all.optionalServices.includes(u), 'all: optional ' + u);
});

test('Trainer: FTMS ERG + simulation, power range clamp, trainer HR', async () => {
  const cp = new FakeChar(0x2ad9, { onWrite: ftmsReply }), ibd = new FakeChar(0x2ad2), st = new FakeChar(0x2ada);
  const dev = fakeDevice('Smart Trainer 1', {
    0x1826: [cp, ibd, st, new FakeChar(0x2acc, { value: [0x02, 0x44, 0, 0, 0x08, 0x20, 0, 0] }), new FakeChar(0x2ad8, { value: [0, 0, 0xe8, 0x03, 0x05, 0x00] })],
    0x1818: [new FakeChar(0x2a63)],
  });
  const env = makeEnv(dev), t = env.trainer;
  await t.connect();
  assert.equal(t.protocol, 'FTMS'); assert.equal(t.name, 'Smart Trainer 1'); assert.ok(t.connected && t.canControl && t.canSim);
  assert.deepEqual(cp.writes.map(w => w.bytes), [[0x00], [0x07]]);
  assert.ok(env.toasts.some(m => m.includes('FTMS') && m.includes('ERG ready')));
  t.setPower(1502); // clamped to 1000 W, rounded to 5 W steps
  await until(() => cp.writes.length >= 3);
  assert.deepEqual(cp.writes[2].bytes, [0x05, 0xe8, 0x03]);
  t.setSim(4);
  await until(() => cp.writes.length >= 4);
  assert.deepEqual(cp.writes[3].bytes, [0x11, 0, 0, 0x90, 0x01, 40, 51]);
  ibd.notify([0x44, 0x02, 0x10, 0x0e, 0xb4, 0x00, 0xfa, 0x00, 0x8c]);
  assert.equal(env.live.power, 250); assert.equal(env.live.cadence, 90); assert.equal(env.live.hr, 140); assert.equal(env.live.speed, 36);
  // trainer reset (status 0x01) -> request control again after 1.5 s
  st.notify([0x01]);
  await until(() => cp.writes.some((w, i) => i > 3 && w.bytes[0] === 0x00), 3000);
  t.disconnect();
  await until(() => cp.writes.at(-1).bytes[0] === 0x01, 2000); // reset releases ERG on disconnect
  assert.equal(t.status, 'idle');
});

test('Trainer: FTMS without control point falls back to Tacx FE-C when present', async () => {
  const fecTx = new FakeChar(P.UUID.FEC_WRITE, { wwr: true }), fecRx = new FakeChar(P.UUID.FEC_NOTIFY);
  const dev = fakeDevice('Tacx Neo', { 0x1826: [new FakeChar(0x2ad2)], [P.UUID.FEC]: [fecTx, fecRx], 0x1818: [new FakeChar(0x2a63)] });
  const env = makeEnv(dev), t = env.trainer;
  await t.connect();
  assert.equal(t.protocol, 'Tacx FE-C');
  assert.ok(env.toasts.some(m => m.includes('Tacx FE-C') && m.includes('ERG ready')));
  // start(): user configuration (page 55) and a request for the capabilities page (54), written without response
  assert.deepEqual(fecTx.writes.map(w => P.fec.unwrap(w.bytes).page[0]), [0x37, 0x46]);
  assert.ok(fecTx.writes.every(w => w.noResp));
  t.setPower(200);
  await until(() => fecTx.writes.length >= 3);
  assert.deepEqual(P.fec.unwrap(fecTx.writes[2].bytes).page, P.fec.encodeTargetPower(200));
  t.setSim(5);
  await until(() => fecTx.writes.length >= 4);
  assert.deepEqual(P.fec.unwrap(fecTx.writes[3].bytes).page, P.fec.encodeTrackResistance(5));
  fecRx.notify(P.fec.wrap([0x19, 1, 85, 0, 0, 0x2c, 0x01, 0x30], 0x4e)); // 300 W, 85 rpm
  fecRx.notify(P.fec.wrap([0x10, 25, 0, 0, 0x10, 0x27, 0x96, 0x31], 0x4e)); // 36 km/h, HR 150
  assert.equal(env.live.power, 300); assert.equal(env.live.cadence, 85); assert.equal(env.live.speed, 36); assert.equal(env.live.hr, 150);
  // capabilities without simulation -> grades become basic resistance
  fecRx.notify(P.fec.wrap([0x36, 0xff, 0xff, 0xff, 0xff, 0xe8, 0x03, 0x03], 0x4e));
  assert.equal(t.canSim, false);
  t.setSim(2);
  await until(() => fecTx.writes.length >= 5);
  assert.equal(P.fec.unwrap(fecTx.writes[4].bytes).page[0], 0x30);
  t.disconnect();
});

test('Trainer: Wahoo legacy unlock, ERG, simulation', async () => {
  const wcp = new FakeChar(P.UUID.WAHOO_CP, { onWrite: (ch, b) => setTimeout(() => ch.notify([0x01, b[0]]), 5) }), cpm = new FakeChar(0x2a63);
  const dev = fakeDevice('KICKR 1234', { 0x1818: [cpm, wcp] });
  const env = makeEnv(dev), t = env.trainer;
  await t.connect();
  assert.equal(t.protocol, 'Wahoo'); assert.ok(t.canControl);
  assert.deepEqual(wcp.writes[0].bytes, [0x20, 0xee, 0xfc]);
  t.setPower(180);
  await until(() => wcp.writes.length >= 2);
  assert.deepEqual(wcp.writes[1].bytes, [0x42, 180, 0]);
  t.setSim(5);
  await until(() => wcp.writes.some(w => w.bytes[0] === 0x46));
  assert.deepEqual(wcp.writes.slice(2).map(w => w.bytes[0]), [0x43, 0x46]);
  assert.deepEqual(wcp.writes.at(-1).bytes, P.wahoo.grade(5));
  cpm.notify([0x20, 0x00, 0xc8, 0x00, 0x0a, 0x00, 0x00, 0x04]);
  assert.equal(env.live.power, 200);
  t.disconnect();
});

test('Trainer: power meter is read-only with a clear message', async () => {
  const cpm = new FakeChar(0x2a63);
  const dev = fakeDevice('PM', { 0x1818: [cpm] });
  const env = makeEnv(dev), t = env.trainer;
  await t.connect();
  assert.equal(t.protocol, 'Power meter'); assert.equal(t.canControl, false); assert.ok(t.connected);
  assert.ok(env.toasts.some(m => /ERG is not available/.test(m)));
  t.setPower(200); t.release(); // no-ops
  cpm.notify([0x20, 0x00, 0x96, 0x00, 0x0a, 0x00, 0x00, 0x04]);
  cpm.notify([0x20, 0x00, 0x96, 0x00, 0x0b, 0x00, 0xab, 0x06]); // +1 rev in 683/1024 s = 90 rpm
  assert.equal(env.live.power, 150); assert.equal(env.live.cadence, 90);
});

test('Trainer: FTMS trainer that never indicates switches to write-confirmed mode', async () => {
  const cp = new FakeChar(0x2ad9); // never replies
  const dev = fakeDevice('Quiet', { 0x1826: [cp, new FakeChar(0x2ad2)] });
  const env = makeEnv(dev), t = env.trainer;
  const conn = t.connect();
  await until(() => cp.writes.length >= 1); t.ackTimeout = 50; // setup resets it to 2500: shorten it once connecting began
  await conn;
  assert.equal(t.protocol, 'FTMS'); assert.ok(t.canControl);
  t.setPower(150); await until(() => cp.writes.some(w => w.bytes[0] === 5) && !t.kicking);
  t.setPower(160); await until(() => t.ackTimeout === 300, 4000);
  assert.deepEqual(cp.writes.filter(w => w.bytes[0] === 5).map(w => w.bytes[1]), [150, 160]);
  t.disconnect();
});

test('Trainer: reconnects after an unexpected drop and detects the protocol again', async () => {
  const cp = new FakeChar(0x2ad9, { onWrite: ftmsReply }), ibd = new FakeChar(0x2ad2);
  const dev = fakeDevice('Drop', { 0x1826: [cp, ibd] });
  const env = makeEnv(dev), t = env.trainer;
  await t.connect();
  dev.gatt.disconnect(); // unexpected
  assert.equal(t.status, 'reconnecting');
  await until(() => t.connected, 4000);
  assert.equal(t.protocol, 'FTMS');
  assert.equal(ibd.hs.length, 1, 'old listeners are removed on reconnect');
  t.disconnect();
});

for (const [name, fn] of tests) {
  count++;
  try { await fn(); console.log('ok  ', name); }
  catch (e) { fails++; console.log('FAIL', name, '\n     ', e.message); }
}
console.log(fails ? `\n${fails} of ${count} failed` : `\nall ${count} passed`);
setTimeout(() => process.exit(fails ? 1 : 0), 50);
