// Tests for src/parts/c1-ant.js (ANT+ over a USB stick). Run: node src/test/ant.test.mjs
// The part is evaluated with new Function and a stubbed navigator.usb / localStorage; a fake stick answers the
// ANT commands the way the ANT message protocol document describes. No real hardware involved.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'parts', 'c1-ant.js'), 'utf8');

/* ---------- stubs ---------- */
const mem = new Map();
const localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const usbListeners = {};
const usb = {
  devices: [], chooser: null,
  async getDevices() { return this.devices.filter(d => d.permitted); },
  async requestDevice(opts) { this.lastFilters = opts.filters; const d = this.chooser; if (!d) { const e = new Error('No device selected.'); e.name = 'NotFoundError'; throw e; } d.permitted = true; return d; },
  addEventListener(t, f) { (usbListeners[t] ||= []).push(f); },
};
const navigator = { usb, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', platform: 'Win32', maxTouchPoints: 0 };
const ANT = new Function('navigator', 'localStorage', 'isSecureContext', `${src}\nreturn ANT;`)(navigator, localStorage, true);
Object.assign(ANT.timing, { cmd: 200, ack: 300, reset: 60, resend: 150, tick: 40, lost: 1000, coast: 3000, idleClose: 60, reopen: 20, retry: 100 });

const calls = { power: [], cad: [], hr: [], speed: [], toast: [], ui: 0, apply: 0, needKey: 0 };
Object.assign(ANT.hooks, {
  power: (w, s) => calls.power.push([w, s]), cad: r => calls.cad.push(r), hr: (b, s) => calls.hr.push([b, s]), speed: k => calls.speed.push(k),
  toast: m => calls.toast.push(m), ui: () => calls.ui++, applyControl: () => calls.apply++, needKey: () => calls.needKey++, riderKg: () => 70, initAudio: () => { }, simOff: () => { },
});

const frame = (id, data) => Array.from(ANT.frame(id, data));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 1500, what = 'condition') => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await wait(5); } };

// A fake ANT USB-m stick: answers every command with RESPONSE_NO_ERROR, the reset with a startup message,
// requests with the requested message, acknowledged data with EVENT_TRANSFER_TX_COMPLETED.
class FakeStick {
  constructor({ productId = 0x1009, lp = true } = {}) {
    Object.assign(this, { vendorId: 0x0fcf, productId, productName: 'ANT USB-m Stick', opened: false, configuration: null, out: [], inq: [], waiting: null, lp, ackCode: 5, permitted: false, devNum: { 0: 12345, 1: 4242 } });
  }
  async open() { this.opened = true; }
  async selectConfiguration(n) {
    this.configuration = { configurationValue: n, interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [
      { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 64 }, { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 }] } }] };
  }
  async claimInterface(i) { this.claimed = i; }
  async releaseInterface() { this.claimed = null; }
  async clearHalt() { }
  async close() { this.opened = false; const w = this.waiting; this.waiting = null; if (w) w.rej(Object.assign(new Error('closed'), { name: 'AbortError' })); }
  async transferOut(ep, data) { const f = Uint8Array.from(data); this.out.push(Array.from(f)); setTimeout(() => this.answer(f), 1); return { status: 'ok', bytesWritten: f.length }; }
  transferIn() {
    if (this.inq.length) return Promise.resolve(this.mk(this.inq.shift()));
    return new Promise((res, rej) => { this.waiting = { res: b => res(this.mk(b)), rej }; });
  }
  mk(b) { const u = Uint8Array.from(b); return { status: 'ok', data: new DataView(u.buffer) }; }
  push(...frames) { const b = frames.flat(); if (this.waiting) { const w = this.waiting; this.waiting = null; w.res(b); } else this.inq.push(b); }
  answer(f) {
    const id = f[2], d = Array.from(f.slice(3, 3 + f[1]));
    if (id === 0x4a) return this.push(frame(0x6f, [0x20]));
    if (id === 0x4d && d[1] === 0x54) return this.push(frame(0x54, [8, 3, 0x00, 0xba, 0x36, 0x00]));
    if (id === 0x4d && d[1] === 0x51) { const n = this.devNum[d[0]] || 1; return this.push(frame(0x51, [d[0], n & 0xff, n >> 8, 17, 5])); }
    if (id === 0x4f) return this.push(frame(0x40, [d[0], 1, this.ackCode]));
    if (id === 0x4e) return;
    if (id === 0x63 && !this.lp) return this.push(frame(0x40, [d[0], id, 0x28])); // INVALID_MESSAGE on old sticks
    this.push(frame(0x40, [d[0], id, 0]));
    if (id === 0x4c) this.push(frame(0x40, [d[0], 1, 7])); // EVENT_CHANNEL_CLOSED
  }
  sent(id) { return this.out.filter(f => f[2] === id).map(f => f.slice(3, 3 + f[1])); }
  bcast(ch, page) { this.push(frame(0x4e, [ch, ...page])); }
}

let fails = 0, n = 0;
async function test(name, fn) {
  n++;
  try { await fn(); console.log('ok  ', name); }
  catch (e) { fails++; console.log('FAIL', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e); }
}
const KEY = '0123456789ABCDEF'; // a dummy key: the real ANT+ key is never in the repo

/* ---------- pure helpers ---------- */
await test('frame: sync, length, id, data, XOR checksum', () => {
  assert.deepEqual(frame(0x4a, [0]), [0xa4, 0x01, 0x4a, 0x00, 0xef]); // reset
  assert.deepEqual(frame(0x42, [0, 0, 0]), [0xa4, 0x03, 0x42, 0x00, 0x00, 0x00, 0xe5]); // assign channel 0
  const f = frame(0x4f, [3, 0x31, 255, 255, 255, 255, 255, 0xe8, 0x03]);
  assert.equal(f.length, 13); assert.equal(f.slice(0, -1).reduce((a, b) => a ^ b, 0), f[12]);
});
await test('parse: noise, two messages in one transfer, bad checksum, split message', () => {
  const a = frame(0x4e, [0, 1, 2, 3, 4, 5, 6, 7, 8]), b = frame(0x40, [0, 1, 5]);
  const bad = frame(0x40, [1, 1, 6]); bad[bad.length - 1] ^= 0xff;
  let r = ANT.parse(Uint8Array.from([0, 0x13, ...a, ...bad, ...b, ...a.slice(0, 5)]));
  assert.deepEqual(r.msgs.map(m => m.id), [0x4e, 0x40]);
  assert.deepEqual(Array.from(r.msgs[0].data), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(r.msgs[1].data), [0, 1, 5]);
  assert.equal(r.rest.length, 5);
  r = ANT.parse(Uint8Array.from([...r.rest, ...a.slice(5)]));
  assert.equal(r.msgs.length, 1); assert.equal(r.rest.length, 0);
});
await test('channel setup sequences (FE-C / power / HR)', () => {
  const seq = (ch, k) => ANT.channelSetup(ch, ANT.PROFILE[k]).map(([id, d]) => [id, ...d]);
  assert.deepEqual(seq(0, 'fec'), [[0x42, 0, 0, 0], [0x51, 0, 0, 0, 17, 0], [0x63, 0, 12], [0x44, 0, 0], [0x43, 0, 0x00, 0x20], [0x45, 0, 57], [0x4b, 0]]);
  assert.deepEqual(seq(1, 'hr').filter(m => [0x51, 0x43].includes(m[0])), [[0x51, 1, 0, 0, 120, 0], [0x43, 1, 0x86, 0x1f]]); // 8070
  assert.deepEqual(seq(2, 'power').filter(m => [0x51, 0x43].includes(m[0])), [[0x51, 2, 0, 0, 11, 0], [0x43, 2, 0xf6, 0x1f]]); // 8182
  assert.deepEqual(ANT.channelSetup(0, { ...ANT.PROFILE.fec, devNum: 12345, transType: 5 })[1], [0x51, [0, 0x39, 0x30, 17, 5]]);
});
await test('FE-C control pages: 49 target power, 51 track resistance, 48 basic resistance, 55 user config, 70 request', () => {
  assert.deepEqual(ANT.fec.targetPower(250), [0x31, 255, 255, 255, 255, 255, 0xe8, 0x03]); // 1000 x 0.25 W
  assert.deepEqual(ANT.fec.targetPower(0.5).slice(6), [2, 0]);
  assert.deepEqual(ANT.fec.targetPower(-20).slice(6), [0, 0]);
  assert.deepEqual(ANT.fec.trackResistance(5), [0x33, 255, 255, 255, 255, 0x14, 0x50, 80]); // (5+200)/0.01 = 20500
  assert.deepEqual(ANT.fec.trackResistance(-3.5).slice(5, 7), [0xc2, 0x4c]); // 19650
  assert.deepEqual(ANT.fec.trackResistance(0).slice(5, 7), [0x20, 0x4e]); // 20000
  assert.deepEqual(ANT.fec.basicResistance(50), [0x30, 255, 255, 255, 255, 255, 255, 100]);
  assert.deepEqual(ANT.fec.userConfig(70, 10, 0.7), [0x37, 0x58, 0x1b, 0xff, 0x8f, 0x0c, 70, 0]); // 7000; bike 200 = 0x0C8
  assert.deepEqual(ANT.fec.requestPage(54), [0x46, 255, 255, 255, 255, 2, 54, 1]);
});
await test('FE-C page 16 (general) and 25 (trainer) parsing', () => {
  const g = ANT.fec.parse([0x10, 25, 40, 100, 0x8d, 0x20, 142, 0x34]);
  assert.equal(g.page, 16); assert.equal(g.equipment, 25); assert.equal(g.distance, 100); assert.equal(g.hr, 142); assert.equal(g.state, 3);
  assert.ok(Math.abs(g.speed - 30.0) < 0.01, 'speed 8.333 m/s = 30 km/h');
  assert.equal(ANT.fec.parse([0x10, 25, 0, 0, 0xff, 0xff, 0xff, 0x20]).speed, null);
  assert.equal(ANT.fec.parse([0x10, 25, 0, 0, 0, 0, 0xff, 0x20]).hr, null);
  const t = ANT.fec.parse([0x19, 7, 92, 0x34, 0x12, 0x2c, 0x21, 0x31]); // power 0x12C = 300 W, status nibble 2
  assert.deepEqual([t.page, t.events, t.cadence, t.acc, t.power, t.trainerStatus, t.target, t.state], [25, 7, 92, 0x1234, 300, 2, 1, 3]);
  assert.equal(ANT.fec.parse([0x19, 0, 0xff, 0, 0, 0xff, 0x0f, 0]).power, null);
  assert.equal(ANT.fec.parse([0x19, 0, 0xff, 0, 0, 0xff, 0x0f, 0]).cadence, null);
  assert.deepEqual(ANT.fec.parse([0x36, 255, 255, 255, 255, 0xe8, 0x03, 0x07]), { page: 54, maxResistance: 1000, basic: true, power: true, sim: true });
  assert.deepEqual(ANT.fec.parse([0x47, 0x33, 1, 2, 255, 255, 255, 255]), { page: 71, lastCommand: 0x33, seq: 1, status: 2 });
  assert.deepEqual(ANT.fec.parse([0x50, 255, 255, 3, 0x20, 0x00, 0x34, 0x12]), { page: 80, hw: 3, manufacturer: 32, model: 0x1234 });
});
await test('accumulated power: average over events, both counters rolling over, coasting', () => {
  let r = ANT.accPower(null, 250, 65400, 210, 0); assert.equal(r.w, 210);
  r = ANT.accPower(r.st, 4, 1200, 999, 1000); assert.equal(r.w, 134); // 10 events, 1336 W -> 133.6
  r = ANT.accPower(r.st, 4, 1200, 999, 1500); assert.equal(r.w, 134); // same event: hold
  r = ANT.accPower(r.st, 4, 1200, 0, 5000); assert.equal(r.w, 0);    // no new event for > 3 s: coasting
  r = ANT.accPower(r.st, 5, 1450, 260, 5250); assert.equal(r.w, 250);
});
await test('HR and power-meter pages', () => {
  assert.equal(ANT.hr.parse([0x84, 255, 255, 255, 0x10, 0x20, 17, 148]).hr, 148);
  assert.equal(ANT.hr.parse([0x84, 255, 255, 255, 0x10, 0x20, 17, 148]).page, 4);
  assert.equal(ANT.hr.parse([0x00, 255, 255, 255, 0, 0, 0, 0]).hr, null);
  const p = ANT.power.parse([0x10, 9, 0xff, 85, 0x10, 0x27, 0xfa, 0x00]);
  assert.deepEqual([p.events, p.cadence, p.acc, p.power, p.balance], [9, 85, 10000, 250, null]);
});
await test('network key: validation, formats, stored only under erglab.antKey', () => {
  assert.equal(ANT.getKey(), '');
  assert.equal(ANT.setKey('12 34').ok, false);
  assert.match(ANT.setKey('0123456789ABCDEZ').error, /hex/);
  assert.equal(ANT.setKey('0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef').key, KEY);
  assert.equal(ANT.setKey('01 23 45 67 89 ab cd ef').key, KEY);
  assert.equal(ANT.getKey(), KEY);
  assert.deepEqual([...mem.keys()], ['erglab.antKey']);
  assert.equal(JSON.parse(mem.get('erglab.antKey')), KEY); // JSON like the app's store()/load()
  assert.match(ANT.setKey('0000000000000000').warn, /public/);
  assert.equal(ANT.setKey('').cleared, true); assert.equal(ANT.getKey(), '');
  mem.set('erglab.antKey', KEY); assert.equal(ANT.getKey(), KEY); // raw value tolerated
  mem.delete('erglab.antKey');
});
await test('no key: connect() asks for it and opens nothing', async () => {
  const t = new ANT.AntFeC(); await t.connect();
  assert.equal(t.status, 'idle'); assert.equal(calls.needKey, 1); assert.match(calls.toast.at(-1), /network key/);
});
await test('settings card: static markup, no inline handlers, no key inside', () => {
  const h = ANT.settingsCard();
  assert.ok(!/\son[a-z]+=/i.test(h), 'no inline on* handlers (CSP)');
  assert.ok(/type="password"/.test(h) && /data-ant="save"/.test(h) && /data-ant="clear"/.test(h));
  assert.ok(/Zadig/.test(h) && /udev/.test(h) && /OTG/.test(h) && /one program/.test(h) && /thisisant\.com/.test(h));
  assert.ok(!/[0-9a-f]{2}[\s,]+[0-9a-f]{2}[\s,]+[0-9a-f]{2}[\s,]+[0-9a-f]{2}[\s,]+[0-9a-f]{2}/i.test(h), 'no key-like byte list');
  assert.ok(!/elite|direto/i.test(src), 'no brand-specific trainer mentions');
});

await test('settings binder: save validates and stores, clear removes, show toggles', () => {
  const els = Object.fromEntries(['key', 'msg', 'badge', 'save', 'clear', 'show'].map(k => [k, { value: '', type: k === 'key' ? 'password' : '', textContent: '', className: '', disabled: false, placeholder: '' }]));
  els.save.click = () => els.save.onclick();
  ANT.bindSettings({ querySelector: s => els[s.match(/data-ant="(\w+)"/)[1]] });
  assert.equal(els.badge.textContent, 'key needed'); assert.equal(els.clear.disabled, true);
  els.key.value = 'abc'; els.save.onclick(); assert.match(els.msg.textContent, /16 hex/); assert.match(els.msg.className, /ant-bad/); assert.equal(ANT.getKey(), '');
  els.show.onclick(); assert.equal(els.key.type, 'text');
  els.key.value = '01:23:45:67:89:AB:CD:EF'; els.key.onkeydown({ key: 'Enter', preventDefault() { } });
  assert.equal(ANT.getKey(), KEY); assert.equal(els.key.value, ''); assert.equal(els.key.type, 'password'); assert.equal(els.badge.textContent, 'key saved');
  els.clear.onclick(); assert.equal(ANT.getKey(), ''); assert.equal(els.badge.textContent, 'key needed');
});

/* ---------- stick + channels against the fake stick ---------- */
ANT.setKey(KEY);
const stick = new FakeStick(); usb.devices.push(stick); usb.chooser = stick;
const fecT = new ANT.AntFeC(), hrm = new ANT.AntHr();

await test('FE-C connect: USB chooser, reset, capabilities, network key, channel 0 setup', async () => {
  await fecT.connect();
  assert.deepEqual(usb.lastFilters, [{ vendorId: 0x0fcf }]);
  assert.equal(stick.claimed, 0); assert.equal(stick.configuration.configurationValue, 1);
  const ids = stick.out.map(f => f[2]);
  assert.deepEqual(ids, [0x4a, 0x4d, 0x46, 0x42, 0x51, 0x63, 0x44, 0x43, 0x45, 0x4b]);
  assert.deepEqual(stick.sent(0x46)[0], [0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  assert.deepEqual(stick.sent(0x51)[0], [0, 0, 0, 17, 0]);
  assert.deepEqual(stick.sent(0x43)[0], [0, 0x00, 0x20]);
  assert.equal(fecT.status, 'connecting'); assert.equal(fecT.connected, false); assert.equal(fecT.cp, false);
});
await test('FE-C data: connected on first page, power/cadence/speed/HR hooks, device number learned', async () => {
  stick.bcast(0, [0x10, 25, 4, 10, 0x8d, 0x20, 131, 0x30]);
  await until(() => fecT.connected, 500, 'connected');
  stick.bcast(0, [0x19, 10, 90, 0x00, 0x10, 200, 0x00, 0x30]);
  stick.bcast(0, [0x19, 12, 91, 0x20, 0x13, 0x90, 0x01, 0x30]); // +800 W over 2 events = 400 W avg
  await until(() => calls.power.length >= 2 && fecT.name.endsWith('12345'), 800, 'power + name');
  assert.deepEqual(calls.power, [[200, 'ant'], [400, 'ant']]);
  assert.deepEqual(calls.cad, [90, 91]);
  assert.deepEqual(calls.hr, [[131, 'trainer']]);
  assert.ok(Math.abs(calls.speed[0] - 30) < 0.01);
  assert.equal(fecT.name, 'ANT+ trainer 12345');
  assert.equal(fecT.cp, true); assert.ok(calls.apply >= 1, 'applyControl called on connect');
  await until(() => stick.sent(0x4f).length >= 2, 800, 'user config + capability request');
  const acks = stick.sent(0x4f);
  assert.deepEqual(acks[0], [0, 0x37, 0x58, 0x1b, 0xff, 0x8f, 0x0c, 70, 0]); // 70 kg rider
  assert.deepEqual(acks[1], [0, 0x46, 255, 255, 255, 255, 2, 54, 1]);
});
await test('ERG: setPower sends acknowledged page 49 and repeats it about every resend period', async () => {
  stick.out.length = 0;
  fecT.setPower(237);
  await until(() => stick.sent(0x4f).length >= 1, 500, 'page 49');
  assert.deepEqual(stick.sent(0x4f)[0], [0, 0x31, 255, 255, 255, 255, 255, 0xb4, 0x03]); // 948 x 0.25 W
  await wait(400);
  stick.bcast(0, [0x10, 25, 4, 10, 0x8d, 0x20, 131, 0x30]); // keep the channel alive
  const n49 = stick.sent(0x4f).filter(p => p[1] === 0x31).length;
  assert.ok(n49 >= 2 && n49 <= 5, `resent ${n49} times in ~400 ms with a 150 ms period`);
});
await test('slope: page 51; capabilities without simulation switch to page 48', async () => {
  stick.out.length = 0;
  fecT.setSim(4.5);
  await until(() => stick.sent(0x4f).some(p => p[1] === 0x33), 500, 'page 51');
  assert.deepEqual(stick.sent(0x4f).find(p => p[1] === 0x33), [0, 0x33, 255, 255, 255, 255, 0xe2, 0x4f, 80]); // 20450
  stick.bcast(0, [0x36, 255, 255, 255, 255, 0xe8, 0x03, 0x03]); // basic + power, no sim
  await until(() => stick.sent(0x4f).some(p => p[1] === 0x30), 500, 'page 48');
  assert.deepEqual(stick.sent(0x4f).find(p => p[1] === 0x30), [0, 0x30, 255, 255, 255, 255, 255, 255, 46]); // 5 + 4.5*4 = 23 %
  assert.equal(fecT.canSim, true); // still steerable through basic resistance
  stick.out.length = 0; fecT.release();
  await until(() => stick.sent(0x4f).some(p => p[1] === 0x30 && p[8] === 10), 500, 'release = 5 % resistance');
});
await test('failed acknowledged message is retried', async () => {
  stick.ackCode = 6; stick.out.length = 0;
  fecT.setPower(150);
  await wait(150);
  stick.ackCode = 5;
  await until(() => stick.sent(0x4f).filter(p => p[1] === 0x31).length >= 2, 800, 'retry');
  await until(() => !fecT.dirty, 500, 'confirmed');
});
await test('HR strap on the same stick: channel 1, device type 120, no new reset or chooser', async () => {
  stick.out.length = 0; usb.chooser = null; // a chooser would throw NotFoundError
  await hrm.connect();
  assert.equal(hrm.status, 'connecting');
  assert.deepEqual(stick.out.map(f => f[2]), [0x42, 0x51, 0x63, 0x44, 0x43, 0x45, 0x4b]);
  assert.deepEqual(stick.sent(0x51)[0], [1, 0, 0, 120, 0]);
  assert.deepEqual(stick.sent(0x43)[0], [1, 0x86, 0x1f]);
  calls.hr.length = 0;
  stick.bcast(1, [0x04, 255, 255, 255, 0x00, 0x04, 12, 156]);
  await until(() => hrm.connected && calls.hr.length, 500, 'hr');
  assert.deepEqual(calls.hr, [[156, 'ant']]);
});
await test('lost signal: search timeout closes the channel, reopened locked to the paired device', async () => {
  stick.out.length = 0;
  stick.push(frame(0x40, [0, 1, 8])); // EVENT_RX_FAIL_GO_TO_SEARCH
  await until(() => fecT.status === 'reconnecting', 300, 'reconnecting');
  stick.push(frame(0x40, [0, 1, 1]), frame(0x40, [0, 1, 7])); // search timeout, channel closed
  await until(() => stick.sent(0x4b).length, 500, 'reopen');
  assert.deepEqual(stick.sent(0x51)[0], [0, 0x39, 0x30, 17, 5]);
  assert.deepEqual(stick.sent(0x4b)[0], [0]);
  stick.out.length = 0;
  stick.bcast(0, [0x10, 25, 4, 10, 0x8d, 0x20, 131, 0x30]);
  await until(() => fecT.connected, 300, 'connected again');
  await until(() => stick.sent(0x4f).some(p => p[1] === 0x31), 600, 'target resent after reconnect');
});
await test('disconnect: release page, close + unassign the channel; stick closed when unused', async () => {
  stick.out.length = 0;
  fecT.disconnect();
  assert.equal(fecT.status, 'idle');
  await until(() => stick.sent(0x41).length, 800, 'unassign 0');
  assert.deepEqual(stick.sent(0x4f)[0].slice(0, 2), [0, 0x30]); // trainer without sim mode: 0 % basic resistance
  assert.deepEqual(stick.sent(0x4c)[0], [0]); assert.deepEqual(stick.sent(0x41)[0], [0]);
  assert.ok(stick.opened, 'still open for the HR strap');
  hrm.disconnect();
  await until(() => !stick.opened, 800, 'stick closed');
  assert.deepEqual(stick.sent(0x41).at(-1), [1]);
});
await test('first search finds nothing: error status and a hint', async () => {
  usb.chooser = stick; calls.toast.length = 0;
  const pm = new ANT.AntPower();
  await pm.connect();
  assert.equal(pm.status, 'connecting');
  stick.push(frame(0x40, [0, 1, 1]), frame(0x40, [0, 1, 7]));
  await until(() => pm.status === 'error', 500, 'error');
  assert.match(calls.toast.at(-1), /No ANT\+ power meter found/);
  await until(() => !stick.opened, 800, 'stick closed');
});
await test('power meter: page 16 power + cadence; old stick without low-priority search', async () => {
  const old = new FakeStick({ lp: false }); usb.devices.length = 0; usb.devices.push(old); usb.chooser = old;
  const pm = new ANT.AntPower(); calls.power.length = 0; calls.cad.length = 0;
  await pm.connect();
  assert.deepEqual(old.sent(0x44)[0], [0, 12], 'falls back to a 30 s high-priority search');
  old.bcast(0, [0x10, 1, 0xff, 80, 0x00, 0x00, 0xc8, 0x00]);
  old.bcast(0, [0x10, 2, 0xff, 82, 0xd2, 0x00, 0xd2, 0x00]);
  await until(() => calls.power.length >= 2, 500, 'power');
  assert.deepEqual(calls.power, [[200, 'antpower'], [210, 'antpower']]); assert.deepEqual(calls.cad, [80, 82]);
  assert.equal(pm.cp, false); pm.setPower(200); pm.release();
  pm.disconnect(); await until(() => !old.opened, 800, 'closed');
});
await test('stick unplugged: devices go to error, resume when it is plugged back in', async () => {
  const s = new FakeStick(); usb.devices.length = 0; usb.devices.push(s); usb.chooser = s;
  const t = new ANT.AntFeC(); await t.connect();
  s.bcast(0, [0x10, 25, 4, 10, 0x8d, 0x20, 131, 0x30]);
  await until(() => t.connected, 300, 'connected');
  calls.toast.length = 0;
  usbListeners.disconnect.forEach(f => f({ device: s })); await s.close();
  assert.equal(t.status, 'error'); assert.match(calls.toast.at(-1), /Plug it back in/);
  s.out.length = 0; usb.chooser = null;
  usbListeners.connect.forEach(f => f({ device: s }));
  await until(() => s.sent(0x4b).length, 2000, 'reopened after replug');
  assert.equal(t.status, 'reconnecting');
  assert.deepEqual(s.sent(0x51)[0], [0, 0x39, 0x30, 17, 5], 'same trainer again');
  t.disconnect(); await until(() => !s.opened, 1500, 'closed');
});
await test('errors are explained (Windows driver, busy stick)', () => {
  assert.match(ANT.explain(Object.assign(new Error("Failed to execute 'open' on 'USBDevice': Access denied."), { name: 'SecurityError' })), /Zadig/);
  assert.match(ANT.explain(Object.assign(new Error('Unable to claim interface.'), { name: 'NetworkError' })), /another program/);
});

console.log(fails ? `\n${fails} of ${n} failed` : `\nall ${n} passed`);
process.exit(fails ? 1 : 0);
