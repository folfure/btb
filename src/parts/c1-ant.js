// ANT+ through a USB stick (WebUSB): ANT+ FE-C smart trainers (ERG + slope), ANT+ heart-rate straps and ANT+ power
// meters. Works in Chrome / Edge on Windows, macOS, Linux and Android (USB OTG). Not on iPhone / iPad (no WebUSB).
//
// Sticks: Garmin / Dynastream ANT USB2 (0FCF:1008), ANT USB-m (0FCF:1009) and their clones (CooSpo, Anself...), which
// expose one vendor interface with a bulk IN and a bulk OUT endpoint; the old ANT USB1 (0FCF:1004) is a CP210x
// USB-serial bridge and gets a 115200 8N1 UART setup first. One stick serves several channels at once
// (trainer + heart rate + power meter): AntStick hands out channel numbers.
//
// The ANT+ network key is NOT in this file: it is licensed to ANT+ adopters and may not be redistributed in public
// source. The rider pastes it once in Settings (ANT.settingsCard / ANT.bindSettings); it is kept in localStorage under
// 'erglab.antKey' on this device only (not one of the synced USER_KEYS).
//
// Public surface of AntFeC / AntHr / AntPower matches the Bluetooth Trainer / HrStrap classes: status, name, connected,
// connect(), disconnect(), setPower(w), setSim(grade), release(), canSim, cp, protocol ('ant'). Live data goes to the
// app's onPowerSample(w, 'ant'), onCadSample(rpm), onHrSample(bpm, src); status changes call updateConnUI().
// All app globals are reached through ANT.hooks (typeof-guarded), so the part also runs in Node for the tests.
// Tests: node src/test/ant.test.mjs
const ANT = (() => {
  // t() is the page's translation helper (i18n.js); the Node tests run this part without it: English, placeholders filled
  const t = typeof i18nT === 'function' ? i18nT : (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m) : s;
  const VENDOR = 0x0fcf;
  const PRODUCTS = { 0x1008: 'ANT USB2 stick', 0x1009: 'ANT USB-m stick', 0x1004: 'ANT USB stick' };
  const KEY_STORE = 'erglab.antKey';
  const MSG = {
    EVENT: 0x40, UNASSIGN: 0x41, ASSIGN: 0x42, PERIOD: 0x43, SEARCH_TIMEOUT: 0x44, RF: 0x45, NETKEY: 0x46, RESET: 0x4a,
    OPEN: 0x4b, CLOSE: 0x4c, REQUEST: 0x4d, BROADCAST: 0x4e, ACK: 0x4f, BURST: 0x50, CHANNEL_ID: 0x51, CAPS: 0x54,
    LP_SEARCH_TIMEOUT: 0x63, STARTUP: 0x6f, SERIAL_ERROR: 0xae,
  };
  // channel events (0x40 messages whose message-id byte is 1)
  const EV = { RX_SEARCH_TIMEOUT: 1, RX_FAIL: 2, TX: 3, TRANSFER_RX_FAILED: 4, TX_COMPLETED: 5, TX_FAILED: 6, CHANNEL_CLOSED: 7, RX_FAIL_GO_TO_SEARCH: 8, COLLISION: 9 };
  // ANT+ device profiles: device type, channel period (32768 / Hz), what to call it
  const PROFILE = {
    fec: { devType: 17, period: 8192, title: t('ANT+ trainer'), what: 'trainer' },
    power: { devType: 11, period: 8182, title: t('ANT+ power'), what: 'power meter' },
    hr: { devType: 120, period: 8070, title: t('ANT+ HR'), what: 'heart-rate strap' },
  };
  const RF = 57;          // 2457 MHz, the ANT+ frequency
  const SEARCH = 12;      // search timeout in 2.5 s units (30 s), then the stick closes the channel and we reopen it
  // timings (ms); the tests shorten them
  const T = { cmd: 1000, ack: 2000, reset: 1500, resend: 2000, tick: 500, lost: 5000, coast: 3000, idleClose: 1500, reopen: 500, retry: 3000 };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const u16 = v => [v & 0xff, (v >> 8) & 0xff];
  const now = () => performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hex = n => '0x' + n.toString(16).padStart(2, '0');
  const named = (name, message) => Object.assign(new Error(message), { name });

  /* ---------------- app hooks (globals of the page; absent in Node tests) ---------------- */
  const H = {
    power: (w, src) => { if (typeof onPowerSample === 'function') onPowerSample(w, src); },
    cad: rpm => { if (typeof onCadSample === 'function') onCadSample(rpm); },
    hr: (bpm, src) => { if (typeof onHrSample === 'function') onHrSample(bpm, src); },
    speed: kmh => { if (typeof live === 'object' && live) live.speed = kmh; },
    ui: msg => { if (typeof updateConnUI === 'function') { try { updateConnUI(msg); } catch (e) { console.warn(e); } } },
    toast: (m, ms) => { if (typeof toast === 'function') toast(m, ms); else console.log('[ANT]', m); },
    initAudio: () => { try { if (typeof initAudio === 'function') initAudio(); } catch { } },
    simOff: () => { if (typeof sim === 'object' && sim && sim.on && typeof sim.stop === 'function') { sim.stop(); H.toast(t('Simulator turned off: trainer connected')); } },
    applyControl: () => { try { if (typeof applyControl === 'function') applyControl(); } catch (e) { console.warn(e); } },
    riderKg: () => (typeof S === 'object' && S && S.weight > 0 ? S.weight : 75),
    needKey: () => { }, // the app can open Settings here
  };

  /* ---------------- ANT serial messages ---------------- */
  // [0xA4 sync, data length, message id, ...data, XOR of every byte before it]
  function frame(id, data = []) {
    const out = new Uint8Array(data.length + 4);
    out[0] = 0xa4; out[1] = data.length; out[2] = id; out.set(data, 3);
    let c = 0; for (let i = 0; i < out.length - 1; i++) c ^= out[i];
    out[out.length - 1] = c;
    return out;
  }
  // Byte stream -> { msgs: [{ id, data }], rest }. Skips noise and bad checksums; keeps an incomplete tail in rest.
  function parse(b) {
    const msgs = []; let i = 0;
    while (i < b.length) {
      if (b[i] !== 0xa4) { i++; continue; }
      if (i + 1 >= b.length) break;
      const len = b[i + 1];
      if (len < 1 || len > 40) { i++; continue; } // real ANT messages are 1..~20 data bytes
      if (i + len + 4 > b.length) break;           // wait for the rest
      let c = 0; for (let j = i; j < i + len + 3; j++) c ^= b[j];
      if (c !== b[i + len + 3]) { i++; continue; }
      msgs.push({ id: b[i + 2], data: b.slice(i + 3, i + 3 + len) });
      i += len + 4;
    }
    return { msgs, rest: b.slice(i) };
  }
  // The commands that set up and open one receive channel. The low-priority search (0x63) does not interrupt the
  // other open channels; sticks that don't know it get a normal 30 s search instead (see AntChannel.setup).
  function channelSetup(ch, { devType, period, devNum = 0, transType = 0, net = 0, search = SEARCH }) {
    return [
      [MSG.ASSIGN, [ch, 0x00, net]],                                        // 0x00 = bidirectional slave
      [MSG.CHANNEL_ID, [ch, ...u16(devNum), devType, transType]],           // device number 0 / trans type 0 = wildcard
      [MSG.LP_SEARCH_TIMEOUT, [ch, search]],
      [MSG.SEARCH_TIMEOUT, [ch, 0]],                                         // high-priority search off
      [MSG.PERIOD, [ch, ...u16(period)]],
      [MSG.RF, [ch, RF]],
      [MSG.OPEN, [ch]],
    ];
  }

  /* ---------------- network key (device-only setting) ---------------- */
  // Accepts "B9A521...", "B9 A5 21 ...", "0xB9, 0xA5, ..." etc. Returns 16 upper-case hex chars or null.
  function normKey(s) {
    const h = String(s == null ? '' : s).trim().replace(/0x/gi, '').replace(/[\s,:;._\-{}[\]()]/g, '');
    return /^[0-9a-f]{16}$/i.test(h) ? h.toUpperCase() : null;
  }
  function getKey() {
    try {
      const v = localStorage.getItem(KEY_STORE); if (!v) return '';
      let s = v; try { const j = JSON.parse(v); if (typeof j === 'string') s = j; } catch { }
      return normKey(s) || '';
    } catch { return ''; }
  }
  function setKey(input) {
    if (input == null || String(input).trim() === '') {
      try { localStorage.removeItem(KEY_STORE); } catch { }
      if (stick) stick.keySent = null;
      return { ok: true, cleared: true };
    }
    const k = normKey(input);
    if (!k) {
      const n = String(input).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '').length;
      return { ok: false, error: /[g-wyz]/i.test(String(input).replace(/0x/gi, '')) ? t('The key may only contain hex digits (0-9, A-F).') : t('The key must be 8 bytes = 16 hex digits (got {n}).', { n }) };
    }
    try { localStorage.setItem(KEY_STORE, JSON.stringify(k)); } catch { return { ok: false, error: t('Could not save: browser storage is blocked.') }; }
    if (stick) stick.keySent = null; // sent again before the next channel opens
    return { ok: true, key: k, warn: /^0+$/.test(k) ? t('Saved, but this is the public ANT network key (all zeros): ANT+ devices use the ANT+ network key.') : '' };
  }
  const keyBytes = k => Array.from({ length: 8 }, (_, i) => parseInt(k.slice(i * 2, i * 2 + 2), 16));

  /* ---------------- ANT+ data pages ---------------- */
  const fec = {
    targetPower: w => [0x31, 0xff, 0xff, 0xff, 0xff, 0xff, ...u16(clamp(Math.round(w * 4), 0, 16000))],          // page 49, 0.25 W
    trackResistance(grade, crr = 0.004) {                                                                        // page 51
      const g = clamp(Math.round((grade + 200) * 100), 0, 40000);                                               // 0.01 %, offset -200 %
      return [0x33, 0xff, 0xff, 0xff, 0xff, ...u16(g), crr == null ? 0xff : clamp(Math.round(crr / 0.00005), 0, 254)];
    },
    basicResistance: pct => [0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, clamp(Math.round(pct * 2), 0, 200)],     // page 48, 0.5 %
    userConfig(userKg = 75, bikeKg = 10, wheelM = 0.7) {                                                         // page 55
      const u = clamp(Math.round(userKg * 100), 0, 65534), bk = clamp(Math.round(bikeKg * 20), 0, 1000), wd = clamp(Math.round(wheelM * 100), 0, 254);
      return [0x37, ...u16(u), 0xff, 0x0f | ((bk & 0x0f) << 4), (bk >> 4) & 0xff, wd, 0x00];
    },
    requestPage: page => [0x46, 0xff, 0xff, 0xff, 0xff, 0x02, page & 0xff, 0x01],                               // page 70, send twice
    // grade -> basic resistance %, for trainers without simulation mode
    gradeToPct: g => clamp(5 + g * 4, 0, 100),
    parse(p) {
      switch (p[0]) {
        case 0x10: { // General FE Data
          const spd = p[4] | (p[5] << 8);
          return { page: 16, equipment: p[1] & 0x1f, elapsed: p[2] / 4, distance: p[3], speed: spd === 0xffff ? null : spd * 0.0036, hr: p[6] === 0xff || p[6] === 0 ? null : p[6], state: (p[7] >> 4) & 0x07 };
        }
        case 0x19: { // Specific Trainer / Stationary Bike Data
          const pw = p[5] | ((p[6] & 0x0f) << 8);
          return { page: 25, events: p[1], cadence: p[2] === 0xff ? null : p[2], acc: p[3] | (p[4] << 8), power: pw === 0xfff ? null : pw, trainerStatus: (p[6] >> 4) & 0x0f, target: p[7] & 0x03, state: (p[7] >> 4) & 0x07 };
        }
        case 0x36: return { page: 54, maxResistance: p[5] | (p[6] << 8), basic: !!(p[7] & 1), power: !!(p[7] & 2), sim: !!(p[7] & 4) };
        case 0x47: return { page: 71, lastCommand: p[1], seq: p[2], status: p[3] }; // 0 pass, 1 fail, 2 not supported, 3 rejected, 4 pending
        default: return common(p) || { page: p[0] };
      }
    },
  };
  // common pages 80 / 81 (every ANT+ profile)
  function common(p) {
    if (p[0] === 0x50) return { page: 80, hw: p[3], manufacturer: p[4] | (p[5] << 8), model: p[6] | (p[7] << 8) };
    if (p[0] === 0x51) return { page: 81, sw: p[3] + (p[2] !== 0xff ? p[2] / 100 : 0), serial: (p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24)) >>> 0 };
    return null;
  }
  const hr = { parse: p => { const b = p[7]; return { page: p[0] & 0x7f, toggle: p[0] >> 7, beatTime: (p[4] | (p[5] << 8)) / 1024, beats: p[6], hr: b > 0 && b < 255 ? b : null }; } };
  const power = {
    parse(p) {
      if (p[0] === 0x10) { const pw = p[6] | (p[7] << 8); return { page: 16, events: p[1], balance: p[2] === 0xff ? null : p[2], cadence: p[3] === 0xff ? null : p[3], acc: p[4] | (p[5] << 8), power: pw === 0xffff ? null : pw }; }
      return common(p) || { page: p[0] };
    },
  };
  // Average power since the previous message from the accumulated-power counters (8-bit event count, 16-bit watts):
  // robust to dropped messages and to both counters rolling over. Returns { w, st } (st = state for the next call).
  function accPower(prev, events, acc, inst, t = now()) {
    if (!prev) return { w: inst, st: { ev: events, acc, t, w: inst } };
    const de = (events - prev.ev + 256) & 0xff, da = (acc - prev.acc + 65536) & 0xffff;
    if (!de) { // no new power event: hold the last value, then 0 once the rider has stopped (coasting)
      const w = t - prev.t > T.coast ? 0 : prev.w;
      return { w, st: { ...prev, w } };
    }
    let w = da / de; if (!(w >= 0 && w <= 3000)) w = inst;
    w = w == null ? null : Math.round(w);
    return { w, st: { ev: events, acc, t, w } };
  }

  /* ---------------- the USB stick ---------------- */
  let stick = null;
  const getStick = () => stick || (stick = new AntStick());
  const isStick = d => d && d.vendorId === VENDOR;

  class AntStick {
    constructor() {
      this.dev = null; this.ready = false; this.gen = 0; this.iface = 0; this.epIn = 1; this.epOut = 1; this.packet = 64;
      this.buf = new Uint8Array(0); this.wq = Promise.resolve(); this.cq = Promise.resolve(); this.waiters = new Set();
      this.channels = []; this.maxChannels = 8; this.maxNetworks = 3; this.keySent = null; this.keyP = null;
      this.opening = null; this.closing = null; this.idleT = null; this.listening = false; this.lostOwners = new Set(); this.name = '';
    }
    get open() { return !!this.dev && this.ready; }
    // Open the stick: a stick this site was already allowed to use opens without a prompt; otherwise the browser's
    // USB chooser opens (needs the click that called connect()).
    ensure() {
      clearTimeout(this.idleT); this.idleT = null;
      if (this.open) return Promise.resolve(this);
      if (!this.opening) this.opening = (async () => {
        if (this.closing) await this.closing;
        const usb = typeof navigator !== 'undefined' && navigator.usb;
        if (!usb) throw named('NotSupportedError', 'WebUSB is not available in this browser');
        this.listen();
        let dev = null;
        try { const list = (await usb.getDevices()).filter(isStick); if (list.length === 1) dev = list[0]; } catch { }
        if (!dev) dev = await usb.requestDevice({ filters: [{ vendorId: VENDOR }] });
        await this.attach(dev);
        return this;
      })().finally(() => { this.opening = null; });
      return this.opening;
    }
    listen() {
      if (this.listening || !navigator.usb || !navigator.usb.addEventListener) return;
      this.listening = true;
      navigator.usb.addEventListener('disconnect', e => { if (this.dev && e.device === this.dev) this.onLost(new Error('ANT stick unplugged')); });
      navigator.usb.addEventListener('connect', e => {
        if (!isStick(e.device) || this.dev || !this.lostOwners.size) return;
        const owners = [...this.lostOwners]; this.lostOwners.clear();
        setTimeout(() => owners.forEach(o => o.resume()), 700); // replugged: pick up where we were
      });
    }
    async attach(dev) {
      const gen = ++this.gen;
      try {
        if (!dev.opened) await dev.open();
        if (!dev.configuration || dev.configuration.configurationValue !== 1) await dev.selectConfiguration(1);
        let iface = 0, epIn = 1, epOut = 1;
        for (const i of (dev.configuration && dev.configuration.interfaces) || []) {
          const eps = ((i.alternate || (i.alternates && i.alternates[0]) || {}).endpoints) || [];
          const ein = eps.find(e => e.direction === 'in' && e.type === 'bulk'), eout = eps.find(e => e.direction === 'out' && e.type === 'bulk');
          if (ein && eout) { iface = i.interfaceNumber; epIn = ein.endpointNumber; epOut = eout.endpointNumber; this.packet = ein.packetSize || 64; break; }
        }
        await dev.claimInterface(iface);
        if (dev.productId === 0x1004) await this.cp210x(dev, iface);
        Object.assign(this, { dev, iface, epIn, epOut, buf: new Uint8Array(0), keySent: null, keyP: null, wq: Promise.resolve(), cq: Promise.resolve() });
        this.name = PRODUCTS[dev.productId] || dev.productName || 'ANT stick';
        this.readLoop(gen);
        await this.resetStick();
        const caps = await this.cmd(MSG.REQUEST, [0, MSG.CAPS], MSG.CAPS);
        if (caps && caps.length >= 2 && caps[0] > 0) { this.maxChannels = caps[0]; this.maxNetworks = caps[1]; }
        this.ready = true;
      } catch (e) {
        if (gen === this.gen) { this.gen++; this.dev = null; this.ready = false; }
        try { await dev.close(); } catch { }
        throw e;
      }
    }
    // ANT USB1 (0FCF:1004) is a Silicon Labs CP210x USB-UART: enable it and set 115200 baud, 8N1
    async cp210x(dev, iface) {
      const ctl = (request, value, data) => dev.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request, value, index: iface }, data);
      await ctl(0x00, 0x0001); // IFC_ENABLE
      const baud = new Uint8Array(4); new DataView(baud.buffer).setUint32(0, 115200, true);
      await ctl(0x1e, 0, baud); // SET_BAUDRATE
      await ctl(0x03, 0x0800); // SET_LINE_CTL: 8 data bits, no parity, 1 stop bit
    }
    async readLoop(gen) {
      while (gen === this.gen && this.dev) {
        let r;
        try { r = await this.dev.transferIn(this.epIn, Math.max(64, this.packet)); }
        catch (e) { if (gen === this.gen) this.onLost(e); return; }
        if (gen !== this.gen) return;
        if (r.status === 'stall') { try { await this.dev.clearHalt('in', this.epIn); } catch { } continue; }
        if (r.data && r.data.byteLength) this.feed(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      }
    }
    feed(bytes) {
      const b = new Uint8Array(this.buf.length + bytes.length); b.set(this.buf); b.set(bytes, this.buf.length);
      const { msgs, rest } = parse(b);
      this.buf = rest.length > 256 ? new Uint8Array(0) : rest;
      for (const m of msgs) { try { this.dispatch(m); } catch (e) { console.warn('ANT dispatch', e); } }
    }
    dispatch(m) {
      for (const w of [...this.waiters]) if (w.pred(m)) { this.waiters.delete(w); clearTimeout(w.t); w.res(m); }
      const d = m.data;
      if ((m.id === MSG.BROADCAST || m.id === MSG.ACK || m.id === MSG.BURST) && d.length >= 9) { const c = this.chan(d[0] & 0x1f); if (c) c.onData(d.slice(1, 9), m.id); return; }
      if (m.id === MSG.EVENT && d.length >= 3) {
        const c = this.chan(d[0]); if (!c) return;
        if (d[1] === 1) c.onEvent(d[2]);
        else if ((d[1] === MSG.ACK) && d[2] !== 0) c.ackDone(false); // e.g. 0x1F transfer in progress
        return;
      }
      if (m.id === MSG.SERIAL_ERROR) console.warn('ANT stick: serial error', Array.from(d));
    }
    chan(n) { return this.channels.find(c => c.num === n && !c.dead) || null; }
    waitFor(pred, ms) {
      return new Promise(res => { const w = { pred, res }; w.t = setTimeout(() => { this.waiters.delete(w); res(null); }, ms); this.waiters.add(w); });
    }
    // writes are serialized: one USB transfer at a time
    write(id, data) {
      const f = frame(id, data);
      const run = async () => {
        const dev = this.dev; if (!dev) throw new Error(t('ANT stick is not open'));
        const r = await dev.transferOut(this.epOut, f);
        if (r && r.status === 'stall') { await dev.clearHalt('out', this.epOut); await dev.transferOut(this.epOut, f); }
      };
      const next = this.wq.then(run, run); this.wq = next.catch(() => { }); return next;
    }
    // One configuration command at a time, waiting for its answer: the response code (0 = ok) from a 0x40 response, or
    // the data of the message `expect` (for 0x4D requests). null = no answer in time.
    cmd(id, data, expect = null, ms = T.cmd) {
      const run = async () => {
        if (!this.dev) return null;
        const p = this.waitFor(m => (expect != null && m.id === expect && (expect !== MSG.CHANNEL_ID || m.data[0] === data[0]))
          || (m.id === MSG.EVENT && m.data[0] === data[0] && m.data[1] === id), ms);
        try { await this.write(id, data); } catch { return null; }
        const m = await p;
        if (!m) return null;
        if (m.id === MSG.EVENT) return expect != null ? null : m.data[2];
        return m.data;
      };
      const next = this.cq.then(run, run); this.cq = next.catch(() => { }); return next;
    }
    async resetStick() {
      const p = this.waitFor(m => m.id === MSG.STARTUP, T.reset);
      await this.write(MSG.RESET, [0]);
      await p; // some sticks don't report the startup message: carry on after the timeout
      await sleep(Math.min(150, T.reset));
      this.keySent = null;
    }
    ensureKey() {
      const key = getKey();
      if (!key) return Promise.reject(named('NoKeyError', t('No ANT+ network key saved. Add it in Settings › ANT+.')));
      if (this.keySent === key) return Promise.resolve();
      if (!this.keyP) this.keyP = (async () => {
        const r = await this.cmd(MSG.NETKEY, [0, ...keyBytes(key)]);
        if (r !== 0) throw new Error(t('The ANT stick did not accept the network key ({why})', { why: r == null ? t('no answer') : t('code {n}', { n: r }) }));
        this.keySent = key;
      })().finally(() => { this.keyP = null; });
      return this.keyP;
    }
    async addChannel(spec, owner) {
      await this.ensure();
      await this.ensureKey();
      let num = 0; while (num < this.maxChannels && this.channels.some(c => c.num === num)) num++;
      if (num >= this.maxChannels) throw new Error(t('All ANT channels of the stick are in use'));
      const ch = new AntChannel(this, num, spec, owner);
      this.channels.push(ch);
      try { await ch.setup(); }
      catch (e) { this.channels = this.channels.filter(c => c !== ch); try { await this.cmd(MSG.UNASSIGN, [num]); } catch { } this.releaseLater(); throw e; }
      return ch;
    }
    release(ch) { this.channels = this.channels.filter(c => c !== ch); this.lostOwners.delete(ch.owner); this.releaseLater(); }
    // when nothing uses the stick any more, let it go so other programs can use it
    releaseLater() {
      if (this.channels.length || !this.dev) return;
      clearTimeout(this.idleT); this.idleT = setTimeout(() => { if (!this.channels.length && !this.opening) this.close(); }, T.idleClose);
    }
    close() {
      clearTimeout(this.idleT); this.idleT = null;
      if (!this.dev) return Promise.resolve();
      if (!this.closing) this.closing = (async () => {
        const dev = this.dev;
        try { await Promise.race([this.write(MSG.RESET, [0]), sleep(300)]); } catch { } // stop the radio
        this.gen++; this.dev = null; this.ready = false; this.keySent = null;
        this.flushWaiters();
        try { await dev.releaseInterface(this.iface); } catch { }
        try { await dev.close(); } catch { }
      })().finally(() => { this.closing = null; });
      return this.closing;
    }
    flushWaiters() { for (const w of [...this.waiters]) { this.waiters.delete(w); clearTimeout(w.t); w.res(null); } }
    onLost(e) {
      if (!this.dev) return;
      console.warn('ANT stick lost', e);
      const dev = this.dev; this.gen++; this.dev = null; this.ready = false; this.keySent = null;
      try { Promise.resolve(dev.close()).catch(() => { }); } catch { }
      this.flushWaiters();
      const chans = this.channels; this.channels = [];
      let wanted = false;
      for (const c of chans) { c.dead = true; c.ackDone(false); if (c.owner && !c.owner.user) { wanted = true; this.lostOwners.add(c.owner); } }
      if (wanted) H.toast(t('ANT+ stick disconnected. Plug it back in to resume.'), 6000);
      for (const c of chans) if (c.owner) c.owner.onStickLost();
    }
  }

  /* ---------------- one ANT channel on the stick ---------------- */
  class AntChannel {
    constructor(stick, num, spec, owner) {
      this.stick = stick; this.num = num; this.spec = spec; this.owner = owner;
      this.devNum = spec.devNum || 0; this.transType = spec.transType || 0; this.ack = null; this.closing = false; this.dead = false;
    }
    async setup() {
      let lpFailed = false;
      for (const [id, data0] of channelSetup(this.num, { ...this.spec, devNum: this.devNum, transType: this.transType })) {
        let data = data0;
        if (id === MSG.SEARCH_TIMEOUT && lpFailed) data = [this.num, this.spec.search || SEARCH];
        const r = await this.stick.cmd(id, data);
        if (id === MSG.LP_SEARCH_TIMEOUT) { if (r !== 0) lpFailed = true; continue; }
        if (r !== 0) throw new Error(t('The ANT stick refused command {cmd} ({why})', { cmd: hex(id), why: r == null ? t('no answer') : t('code {n}', { n: r }) }));
      }
    }
    // after a search timeout closed the channel: reopen it, now locked to the device we were paired with
    async reopen() {
      if (this.dead || !this.stick.dev) return false;
      if (this.devNum) await this.stick.cmd(MSG.CHANNEL_ID, [this.num, ...u16(this.devNum), this.spec.devType, this.transType]);
      return (await this.stick.cmd(MSG.OPEN, [this.num])) === 0;
    }
    // the paired device's number (asks the stick for the channel id)
    async learnId() {
      const d = await this.stick.cmd(MSG.REQUEST, [this.num, MSG.CHANNEL_ID], MSG.CHANNEL_ID);
      if (d && d.length >= 5) { const n = d[1] | (d[2] << 8); if (n) { this.devNum = n; this.transType = d[4]; } return n; }
      return 0;
    }
    // acknowledged message to the device: true once it confirmed reception
    sendAck(page) {
      if (this.dead || !this.stick.dev) return Promise.resolve(false);
      this.ackDone(false);
      return new Promise(res => {
        const a = { res }; a.t = setTimeout(() => { if (this.ack === a) this.ackDone(false); }, T.ack); this.ack = a;
        this.stick.write(MSG.ACK, [this.num, ...page]).catch(() => { if (this.ack === a) this.ackDone(false); });
      });
    }
    ackDone(ok) { const a = this.ack; if (!a) return; this.ack = null; clearTimeout(a.t); a.res(ok); }
    onData(page, id) { if (!this.dead && this.owner) this.owner.onData(page, id, this); }
    onEvent(code) {
      if (code === EV.TX_COMPLETED) return this.ackDone(true);
      if (code === EV.TX_FAILED) return this.ackDone(false);
      if (code === EV.CHANNEL_CLOSED) { this.ackDone(false); if (this.closing) return; }
      if (!this.dead && this.owner) this.owner.onEvent(code);
    }
    async remove() {
      this.closing = true; this.ackDone(false);
      const s = this.stick;
      if (!this.dead && s.dev) {
        const closed = s.waitFor(m => m.id === MSG.EVENT && m.data[0] === this.num && m.data[1] === 1 && m.data[2] === EV.CHANNEL_CLOSED, 1000);
        const r = await s.cmd(MSG.CLOSE, [this.num]);
        if (r === 0) await closed;
        await s.cmd(MSG.UNASSIGN, [this.num]);
      }
      this.dead = true; s.release(this);
    }
  }

  /* ---------------- devices ---------------- */
  class AntDevice {
    constructor(kind) {
      this.kind = kind; this.prof = PROFILE[kind]; this.protocol = 'ant'; this.status = 'idle'; this.name = this.prof.title;
      this.ch = null; this.user = false; this.everData = false; this.lastData = 0; this.devNum = 0; this.transType = 0;
      this.timer = null; this.reopenT = null; this.info = {};
    }
    get connected() { return this.status === 'connected'; }
    get cp() { return false; }
    get canSim() { return false; }
    setPower() { } setSim() { } release() { }
    setStatus(s, msg) { this.status = s; H.ui(msg); }
    async connect() {
      if (!supported()) { H.toast(unsupportedMsg(), 8000); return; }
      if (!getKey()) { H.toast(t('Add your ANT+ network key in Settings › ANT+ first (the instructions are there).'), 7000); H.needKey(); return; }
      if (this.attaching) return; // already opening (USB chooser / channel setup)
      H.initAudio();
      if (this.ch) await this.drop();
      this.user = false; this.everData = false; this.devNum = 0; this.transType = 0; this.name = this.prof.title;
      this.setStatus('connecting');
      try { await this.attach(); }
      catch (e) {
        this.stopTimers(); this.ch = null; this.attaching = false;
        if (this.user) return;
        if (e && e.name === 'NotFoundError') { this.setStatus('idle'); return; } // chooser cancelled
        console.error(e); this.setStatus('error', e && e.message);
        if (e && e.name === 'NoKeyError') H.needKey();
        H.toast(explain(e), 9000);
      }
    }
    async attach() {
      this.attaching = true;
      try {
        const s = getStick();
        await s.ensure();
        if (this.user) return;
        const ch = await s.addChannel({ devType: this.prof.devType, period: this.prof.period, devNum: this.devNum, transType: this.transType }, this);
        if (this.user) { ch.remove().catch(() => { }); return; }
        this.ch = ch; this.lastData = now();
      } finally { this.attaching = false; }
      clearInterval(this.timer); this.timer = setInterval(() => this.tick(), T.tick);
    }
    resume() {
      if (this.user || this.ch) return;
      this.setStatus('reconnecting');
      this.attach().catch(e => { console.warn(e); if (!this.user) { this.setStatus('error', e && e.message); H.toast(explain(e), 7000); } });
    }
    stopTimers() { clearInterval(this.timer); this.timer = null; clearTimeout(this.reopenT); this.reopenT = null; }
    async drop() { this.stopTimers(); const ch = this.ch; this.ch = null; if (ch) await ch.remove().catch(() => { }); }
    disconnect() {
      this.user = true; this.stopTimers();
      const ch = this.ch; this.ch = null;
      if (ch) Promise.race([this.beforeClose(ch), sleep(1500)]).catch(() => { }).then(() => ch.remove()).catch(() => { });
      this.setStatus('idle');
    }
    beforeClose() { return Promise.resolve(); }
    onStickLost() { this.stopTimers(); this.ch = null; if (!this.user) this.setStatus('error', 'ANT stick disconnected'); }
    tick() {
      if (this.status === 'connected' && now() - this.lastData > T.lost) this.setStatus('reconnecting');
      this.onTick();
    }
    onTick() { }
    onData(page, id, ch = this.ch) {
      if (this.user || (this.ch && this.ch !== ch)) return;
      this.lastData = now();
      if (this.status !== 'connected') {
        const first = !this.everData; this.everData = true;
        this.setStatus('connected');
        this.onConnected(first);
        if (ch && !this.devNum) ch.learnId().then(n => { if (n && (this.ch === ch || !this.ch)) { this.devNum = n; this.transType = ch.transType; this.name = `${this.prof.title} ${n}`; H.ui(); } }).catch(() => { });
      }
      this.onPage(page);
    }
    onEvent(code) {
      if (code === EV.RX_FAIL_GO_TO_SEARCH) { if (this.status === 'connected') this.setStatus('reconnecting'); return; }
      if (code !== EV.CHANNEL_CLOSED || this.user || !this.ch) return;
      if (!this.everData) { // the first search found nothing
        this.drop(); this.setStatus('error', 'not found');
        const none = { fec: t('No ANT+ trainer found.'), power: t('No ANT+ power meter found.'), hr: t('No ANT+ heart-rate strap found.') }[this.kind];
        H.toast(`${none} ${this.wakeHint()} ${t('Check the ANT+ network key in Settings, and close other apps that use it.')}`, 9000);
        return;
      }
      if (this.status === 'connected') this.setStatus('reconnecting');
      clearTimeout(this.reopenT); this.reopenT = setTimeout(() => this.reopen(), T.reopen);
    }
    async reopen() {
      this.reopenT = null;
      const ch = this.ch; if (this.user || !ch) return;
      const ok = await ch.reopen().catch(() => false);
      if (!ok && this.ch === ch && !this.user) this.reopenT = setTimeout(() => this.reopen(), T.retry);
    }
    wakeHint() { return t('Make sure it is awake and near the stick.'); }
    onConnected() { }
    onPage() { }
  }

  // Smart trainer, ANT+ FE-C profile (device type 17): ERG via page 49, slope via page 51 (page 48 fallback).
  class AntFeC extends AntDevice {
    constructor() {
      super('fec');
      this.range = { min: 0, max: 2000, inc: 1 }; this.features = null; this.caps = null; this.hasFTMS = false;
      this.simUnsupported = false; this.mode = null; this.cmdPage = null; this.dirty = false; this.lastSent = 0;
      this.acking = false; this.extra = []; this.extraTries = 0; this.pw = null; this.feState = 0; this.trainerStatus = 0; this.targetFlag = 0; this.warned = {};
    }
    get cp() { return this.connected && !(this.caps && !this.caps.power && !this.caps.sim && !this.caps.basic); }
    get canSim() { return !(this.caps && !this.caps.sim && !this.caps.basic); }
    wakeHint() { return t('Pedal a few strokes to wake the trainer.'); }
    setPower(w) {
      w = clamp(Math.round(w), Math.max(0, this.range.min), this.range.max);
      this.mode = { kind: 'power', w }; this.command(fec.targetPower(w));
    }
    setSim(grade) {
      const g = clamp(Math.round(grade * 100) / 100, -10, 20);
      this.mode = { kind: 'sim', grade: g };
      this.command(this.simUnsupported ? fec.basicResistance(fec.gradeToPct(g)) : fec.trackResistance(g));
    }
    // leave ERG: flat road, or a light fixed resistance on trainers without simulation
    release() {
      if (!this.ch) return;
      if (this.caps && !this.caps.sim && this.caps.basic) { this.mode = { kind: 'res', pct: 5 }; this.command(fec.basicResistance(5)); }
      else this.setSim(0);
    }
    command(page) { this.cmdPage = page; this.dirty = true; this.pump(); }
    // send the pending one-shot pages, then the current target; the target is repeated every ~2 s
    async pump() {
      if (this.acking || !this.ch || !this.connected) return;
      const ch = this.ch; this.acking = true;
      try {
        while (this.ch === ch && this.connected) {
          const one = this.extra.length > 0;
          const page = one ? this.extra[0] : this.cmdPage && (this.dirty || now() - this.lastSent >= T.resend) ? this.cmdPage : null;
          if (!page) break;
          const ok = await ch.sendAck(page);
          if (this.ch !== ch) break;
          if (one) { if (ok || ++this.extraTries >= 3) { this.extra.shift(); this.extraTries = 0; } if (!ok) break; continue; }
          if (!ok) break; // retried on the next tick
          this.lastSent = now(); if (page === this.cmdPage) this.dirty = false;
        }
      } finally { this.acking = false; }
    }
    onTick() { if (this.connected) this.pump(); }
    beforeClose(ch) { return this.status === 'connected' ? ch.sendAck(this.caps && !this.caps.sim && this.caps.basic ? fec.basicResistance(0) : fec.trackResistance(0)) : Promise.resolve(); }
    onConnected(first) {
      this.pw = null; this.extraTries = 0; this.lastSent = 0;
      this.extra = [fec.userConfig(H.riderKg()), fec.requestPage(54)];
      if (this.cmdPage) this.dirty = true; // resend the target after a reconnect
      if (first) { H.simOff(); H.toast(t('{name} connected · ERG ready', { name: this.name })); }
      H.applyControl();
      this.pump();
    }
    onPage(p) {
      const d = fec.parse(p);
      switch (d.page) {
        case 16:
          if (d.speed != null) H.speed(d.speed);
          if (d.hr) H.hr(d.hr, 'trainer');
          this.feState = d.state; break;
        case 25: {
          const r = accPower(this.pw, d.events, d.acc, d.power); this.pw = r.st;
          if (r.w != null) H.power(r.w, 'ant');
          if (d.cadence != null) H.cad(d.cadence);
          this.trainerStatus = d.trainerStatus; this.targetFlag = d.target; this.feState = d.state;
          if ((d.trainerStatus & 4) && !this.warned.cfg) { this.warned.cfg = true; this.extra.push(fec.userConfig(H.riderKg())); this.pump(); } // user configuration required
          break;
        }
        case 54:
          this.caps = { basic: d.basic, power: d.power, sim: d.sim, maxResistance: d.maxResistance };
          if (!d.sim && d.basic && !this.simUnsupported) { this.simUnsupported = true; if (this.mode && this.mode.kind === 'sim') this.setSim(this.mode.grade); }
          if (!d.power && !this.warned.erg) { this.warned.erg = true; H.toast(t('This trainer does not report ERG (target power) over ANT+. Trying anyway.'), 6000); }
          H.ui(); break;
        case 71:
          if (d.status === 2 || d.status === 3) {
            if (d.lastCommand === 0x33 && !this.simUnsupported) { this.simUnsupported = true; if (this.mode && this.mode.kind === 'sim') this.setSim(this.mode.grade); }
            else if (d.lastCommand === 0x31 && !this.warned.rej) { this.warned.rej = true; H.toast(t('The trainer rejected the ERG power target over ANT+.'), 6000); }
          }
          break;
        case 80: this.info.manufacturer = d.manufacturer; this.info.model = d.model; this.info.hw = d.hw; break;
        case 81: this.info.sw = d.sw; this.info.serial = d.serial; break;
      }
    }
  }

  // ANT+ heart-rate strap (device type 120): computed heart rate is byte 7 of every page.
  class AntHr extends AntDevice {
    constructor() { super('hr'); }
    wakeHint() { return t('Wet the strap contacts and put it on.'); }
    onConnected(first) { if (first) H.toast(t('{name} connected', { name: this.name })); }
    onPage(p) { const d = hr.parse(p); if (d.hr) H.hr(d.hr, 'ant'); }
  }

  // ANT+ power meter (device type 11), read-only: power and cadence from page 16 (standard power-only).
  class AntPower extends AntDevice {
    constructor(src = 'antpower') { super('power'); this.src = src; this.pw = null; }
    wakeHint() { return t('Spin the cranks to wake the power meter.'); }
    onConnected(first) { this.pw = null; if (first) H.toast(t('{name} connected (power data only, no control)', { name: this.name }), 4000); }
    onPage(p) {
      const d = power.parse(p);
      if (d.page === 16) {
        const r = accPower(this.pw, d.events, d.acc, d.power); this.pw = r.st;
        if (r.w != null) H.power(r.w, this.src);
        if (d.cadence != null) H.cad(d.cadence);
      } else if (d.page === 80) { this.info.manufacturer = d.manufacturer; this.info.model = d.model; }
    }
  }

  /* ---------------- platform / errors ---------------- */
  function platform() {
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') + ' ' + String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '') : '';
    if (/iPhone|iPad|iPod/i.test(ua) || (/MacIntel/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Win/i.test(ua)) return 'win';
    if (/Mac/i.test(ua)) return 'mac';
    if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
    return '';
  }
  function supported() {
    return typeof navigator !== 'undefined' && !!navigator.usb && (typeof isSecureContext === 'undefined' || isSecureContext);
  }
  function unsupportedMsg() {
    const p = platform();
    if (p === 'ios') return t('ANT+ USB sticks can\'t be used on iPhone or iPad (Apple gives web pages no USB access). Use Bluetooth in Bluefy instead.');
    if (typeof navigator !== 'undefined' && navigator.usb && typeof isSecureContext !== 'undefined' && !isSecureContext) return t('ANT+ needs a secure page: open BTB over https:// or localhost.');
    return t('This browser can\'t use USB devices. For an ANT+ stick use Chrome or Edge (Windows, macOS, Linux, Android).');
  }
  function explain(e) {
    const m = String((e && e.message) || e || ''), n = e && e.name, p = platform();
    if (n === 'NoKeyError') return m;
    if (n === 'NotSupportedError') return unsupportedMsg();
    if (n === 'SecurityError' || /access denied/i.test(m)) {
      if (p === 'win') return t('Windows blocked access to the ANT+ stick. Install the WinUSB driver for it with Zadig (Settings › ANT+), then unplug and replug the stick.');
      if (p === 'linux') return t('Linux blocked access to the ANT+ stick. Add the udev rule from Settings › ANT+, then unplug and replug the stick.');
      return t('The browser was not allowed to open the ANT+ stick: {err}', { err: m });
    }
    if (/claim|busy|in use/i.test(m) || n === 'NetworkError' || n === 'InvalidStateError')
      return t('Could not open the ANT+ stick: another program is probably using it (Garmin Express, Zwift, another BTB tab). Close it, then unplug and replug the stick.') + (p === 'win' ? ' ' + t('On Windows the stick also needs the WinUSB driver (Settings › ANT+).') : '');
    return 'ANT+: ' + m;
  }

  /* ---------------- Settings card ---------------- */
  // Static HTML (no user data inside); ANT.bindSettings(root) wires it up. No inline handlers (CSP).
  function settingsCard() {
    const code = s => `<code>${s}</code>`;
    return `<div class="card pad ant-card" id="antCard">
  <div class="row"><h3>ANT+ <span class="dim ant-sub">${t('USB stick')}</span></h3><span class="spacer"></span><span class="badge" data-ant="badge"></span></div>
  <p class="muted ant-p">${t('Ride with an <b>ANT+ USB stick</b> (Garmin, CooSpo, Anself…) instead of Bluetooth: ANT+ FE-C smart trainers (ERG and slope), heart-rate straps and power meters, all on one stick. Chrome or Edge on Windows, macOS, Linux and Android (with a USB OTG adapter). Not on iPhone or iPad.')}</p>
  <div class="field">
    <label for="antKeyIn">${t('ANT+ network key')}</label>
    <div class="ant-keyrow">
      <input type="password" id="antKeyIn" data-ant="key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="80" placeholder="${t('16 hex digits (8 bytes)')}">
      <button class="btn sm" type="button" data-ant="show">${t('Show')}</button>
      <button class="btn sm primary" type="button" data-ant="save">${t('Save')}</button>
      <button class="btn sm" type="button" data-ant="clear">${t('Clear')}</button>
    </div>
    <span class="hint" data-ant="msg" role="status" aria-live="polite"></span>
  </div>
  <details class="ant-help">
    <summary>${t('Where do I get the key?')}</summary>
    <ol>
      <li>${t('Register for free as an <b>ANT+ Adopter</b> at <a href="https://www.thisisant.com/register/" target="_blank" rel="noopener noreferrer">thisisant.com</a> and sign in.')}</li>
      <li>${t('Open the <a href="https://www.thisisant.com/developer/ant-plus/ant-plus-basics/network-keys" target="_blank" rel="noopener noreferrer">ANT+ network keys</a> page and copy the <b>ANT+ Managed Network</b> key (8 bytes).')}</li>
      <li>${t('Paste it above (spaces, commas or 0x are fine) and tap <b>Save</b>.')}</li>
    </ol>
    <p>${t('The key is licensed to ANT+ adopters, so BTB can\'t include it for you. It is stored on <b>this device only</b> and is never synced to your account.')}</p>
  </details>
  <details class="ant-help">
    <summary>${t('Setting up the USB stick')}</summary>
    <ul>
      <li>${t('<b>Windows:</b> Chrome and Edge need the <b>WinUSB</b> driver for the stick. Install it with <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener noreferrer">Zadig</a>: Options › List All Devices, pick the ANT stick (USB ID 0FCF 1008 or 1009, e.g. "ANT USBStick2"), select <b>WinUSB</b>, Replace Driver, then replug the stick. This replaces the Garmin driver, so Garmin Express, Zwift and other ANT+ programs can\'t use that stick until you roll the driver back (Device Manager › the stick › Uninstall device, tick "delete the driver", replug).')}</li>
      <li>${t('<b>macOS:</b> works as is.')}</li>
      <li>${t('<b>Linux:</b> allow the browser to open the stick with a udev rule, e.g. {file} containing {rule}, then run {cmd} and replug the stick.', { file: code('/etc/udev/rules.d/51-ant-usb.rules'), rule: code('SUBSYSTEM=="usb", ATTRS{idVendor}=="0fcf", MODE="0666"'), cmd: code('sudo udevadm control --reload-rules') })}</li>
      <li>${t('<b>Android:</b> Chrome with a USB OTG adapter (USB-C or micro-USB). Allow access when Android asks.')}</li>
      <li>${t('<b>iPhone / iPad:</b> not possible (no USB access for web pages): use Bluetooth in Bluefy.')}</li>
    </ul>
    <p>${t('Only <b>one program</b> can use the stick at a time: close Garmin Express, Zwift and other BTB tabs first. The first time, BTB pairs with the first trainer / strap / power meter it hears, so keep other people\'s devices asleep or away.')}</p>
  </details>
</div>`;
  }
  function bindSettings(root = document) {
    const q = s => root.querySelector(`[data-ant="${s}"]`);
    const input = q('key'), msg = q('msg'), badge = q('badge'), save = q('save'), clear = q('clear'), show = q('show');
    if (!input || !save) return;
    const say = (text, tone) => { if (msg) { msg.textContent = text || ''; msg.className = 'hint' + (tone ? ' ant-' + tone : ''); } };
    const refresh = () => {
      const has = !!getKey(), ok = supported();
      if (badge) {
        badge.textContent = !ok ? t('not available here') : has ? (stick && stick.open ? t('stick connected') : t('key saved')) : t('key needed');
        badge.className = 'badge ' + (!ok ? 'ant-dim' : has ? 'ant-ok' : 'ant-warn');
      }
      input.placeholder = has ? t('Key saved on this device. Paste a new one to replace it') : t('16 hex digits (8 bytes)');
      if (clear) clear.disabled = !has;
    };
    save.onclick = () => {
      const r = setKey(input.value);
      if (!r.ok) { say(r.error, 'bad'); return; }
      if (r.cleared) { say(t('No key entered.'), 'warn'); refresh(); return; }
      input.value = ''; input.type = 'password'; if (show) show.textContent = t('Show');
      say(r.warn || (t('Saved on this device only (never synced).') + (stick && stick.channels.length ? ' ' + t('Reconnect your ANT+ devices to use it.') : '')), r.warn ? 'warn' : 'ok');
      refresh();
    };
    if (clear) clear.onclick = () => { setKey(''); input.value = ''; say(t('Key removed from this device.'), ''); refresh(); };
    if (show) show.onclick = () => { const hid = input.type === 'password'; input.type = hid ? 'text' : 'password'; show.textContent = hid ? t('Hide') : t('Show'); };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } };
    if (!supported()) say(unsupportedMsg(), 'warn');
    refresh();
  }

  return {
    VENDOR, PRODUCTS, MSG, EV, PROFILE, KEY_STORE, timing: T, hooks: H,
    supported, platform, unsupportedMsg, explain,
    getKey, setKey, normKey, hasKey: () => !!getKey(),
    frame, parse, channelSetup, fec, hr, power, accPower,
    settingsCard, bindSettings,
    get stick() { return getStick(); },
    AntStick, AntChannel, AntFeC, AntHr, AntPower,
  };
})();
const { AntStick, AntFeC, AntHr, AntPower } = ANT;
