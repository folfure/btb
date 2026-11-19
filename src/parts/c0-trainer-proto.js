// Smart-trainer wire protocols: pure encoders / decoders, no DOM, no Bluetooth calls, no globals except TRAINER_PROTO.
// The stateful Trainer class (app.template.html) picks a protocol after connecting and uses these helpers:
//   FTMS (Bluetooth SIG Fitness Machine Service, 0x1826): the standard on current trainers.
//   Tacx FE-C over BLE: ANT+ FE-C data pages wrapped in ANT messages, sent over a Nordic-UART-style service.
//   Wahoo legacy: Cycling Power service + Wahoo's trainer control characteristic (KICKR / Snap / Core before FTMS).
//   Power meter: Cycling Power service only (read-only).
// Encoders return plain number arrays (bytes); decoders take a DataView, a typed array or a number array.
// See src/protocol_notes.md for the byte layouts and sources. src/test/protocols.test.mjs covers every helper.
const TRAINER_PROTO = (() => {
  const dvOf = x => x instanceof DataView ? x : ArrayBuffer.isView(x) ? new DataView(x.buffer, x.byteOffset, x.byteLength) : new DataView(Uint8Array.from(x).buffer);
  const bytesOf = x => x instanceof Uint8Array ? x : x instanceof DataView ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : Uint8Array.from(x);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const u16 = v => [v & 0xff, (v >> 8) & 0xff];

  const UUID = {
    FTMS: 0x1826, IBD: 0x2ad2, CP: 0x2ad9, STATUS: 0x2ada, FEAT: 0x2acc, PRANGE: 0x2ad8,
    CPS: 0x1818, CPM: 0x2a63, HRS: 0x180d, HRM: 0x2a37,
    FEC: '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e',      // Tacx FE-C over BLE service
    FEC_NOTIFY: '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e',   // trainer -> app (notify)
    FEC_WRITE: '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e',   // app -> trainer (write)
    WAHOO_CP: 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b', // Wahoo trainer control (write + indicate), inside the Cycling Power service
    WAHOO_SVC: 'a026ee01-0a7d-4ab3-97fa-f1500f9feb8b', // Wahoo vendor service (some firmware): only probed, never required
  };
  const NAMES = { ftms: 'FTMS', fec: 'Tacx FE-C', wahoo: 'Wahoo', cps: 'Power meter' };

  // Which protocol to drive, from what the connected device exposes. Prefer one that can control the trainer.
  // has: { ftms, ftmsCp (FTMS control point usable), fec, wahoo, cps }
  function pick(has) {
    if (has.ftms && has.ftmsCp) return 'ftms';
    if (has.fec) return 'fec';
    if (has.wahoo) return 'wahoo';
    if (has.ftms) return 'ftms'; // FTMS without a control point: data only
    if (has.cps) return 'cps';
    return null;
  }

  /* ---------------- FTMS ---------------- */
  const ftms = {
    RESULT: { 1: 'success', 2: 'not supported', 3: 'invalid parameter', 4: 'operation failed', 5: 'control not permitted' },
    requestControl: () => [0x00],
    reset: () => [0x01],
    start: () => [0x07],
    targetPower: w => [0x05, ...u16(clamp(Math.round(w), -32768, 32767))],
    // grade in %, wind m/s, Crr (unitless), Cw kg/m
    simulation: (grade, crr = 0.004, cw = 0.51, wind = 0) => {
      const g = clamp(Math.round(grade * 100), -32768, 32767), ws = clamp(Math.round(wind * 1000), -32768, 32767);
      return [0x11, ...u16(ws), ...u16(g), clamp(Math.round(crr * 10000), 0, 255), clamp(Math.round(cw * 100), 0, 255)];
    },
    // Fallback when simulation is not supported: map grade onto the resistance level (uint8, 0.1 units)
    resistanceForGrade: grade => [0x04, clamp(Math.round(20 + grade * 8), 0, 200)],
    parseFeatures(x) {
      const v = dvOf(x); if (v.byteLength < 8) return null;
      const machine = v.getUint32(0, true), target = v.getUint32(4, true);
      // power/sim/resistance: target-setting bits 3/13/2 (what can be controlled); powerData/hr: machine bits 14/10 (what is reported)
      return { machine, target, power: !!((target >> 3) & 1), sim: !!((target >> 13) & 1), resistance: !!((target >> 2) & 1), powerData: !!((machine >> 14) & 1), hr: !!((machine >> 10) & 1) };
    },
    parsePowerRange(x) {
      const v = dvOf(x); if (v.byteLength < 6) return null;
      const min = v.getInt16(0, true), max = v.getInt16(2, true), inc = v.getUint16(4, true);
      return max > min && max > 0 ? { min, max, inc: Math.max(1, inc) } : null;
    },
    // Control point indication: [0x80, requestOp, result]
    parseResponse(x) {
      const v = dvOf(x); if (v.byteLength < 3 || v.getUint8(0) !== 0x80) return null;
      return { op: v.getUint8(1), result: v.getUint8(2) };
    },
    // Fitness Machine Status: 0x01 reset, 0xFF control permission lost -> request control again and resend
    parseStatus(x) {
      const v = dvOf(x); if (!v.byteLength) return null;
      const op = v.getUint8(0);
      return { op, reset: op === 0x01, lost: op === 0xff };
    },
    // Indoor Bike Data. Fields absent from the packet are absent from the result.
    parseIndoorBikeData(x) {
      const v = dvOf(x), r = {};
      try {
        const f = v.getUint16(0, true); let o = 2;
        if (!(f & 0x0001)) { r.speed = v.getUint16(o, true) / 100; o += 2; } // km/h; bit 0 is inverted ("more data")
        if (f & 0x0002) o += 2;
        if (f & 0x0004) { r.cadence = v.getUint16(o, true) / 2; o += 2; }
        if (f & 0x0008) o += 2;
        if (f & 0x0010) { r.distance = v.getUint16(o, true) | (v.getUint8(o + 2) << 16); o += 3; }
        if (f & 0x0020) { // resistance level: sint16 in FTMS 1.0, uint8 in newer GSS; infer from the packet length
          const rest = (f & 0x40 ? 2 : 0) + (f & 0x80 ? 2 : 0) + (f & 0x100 ? 5 : 0) + (f & 0x200 ? 1 : 0) + (f & 0x400 ? 1 : 0) + (f & 0x800 ? 2 : 0) + (f & 0x1000 ? 2 : 0);
          o += (v.byteLength - o - rest) === 1 ? 1 : 2;
        }
        if (f & 0x0040) { r.power = v.getInt16(o, true); o += 2; }
        if (f & 0x0080) o += 2;
        if (f & 0x0100) o += 5;
        if (f & 0x0200) { const h = v.getUint8(o); if (h > 0 && h < 255) r.hr = h; o += 1; }
        if (f & 0x0400) o += 1;
        if (f & 0x0800) { r.elapsed = v.getUint16(o, true); o += 2; }
      } catch { /* partial packet: keep what was read */ }
      return r;
    },
  };

  /* ---------------- Cycling Power Measurement (0x2A63) ---------------- */
  const cps = {
    parseMeasurement(x) {
      const v = dvOf(x); if (v.byteLength < 4) return null;
      const f = v.getUint16(0, true), r = { power: v.getInt16(2, true), crank: null }; let o = 4;
      if (f & 0x01) o += 1; if (f & 0x04) o += 2; if (f & 0x10) o += 6;
      if ((f & 0x20) && v.byteLength >= o + 4) r.crank = { revs: v.getUint16(o, true), t: v.getUint16(o + 2, true) };
      return r;
    },
    // rpm between two crank samples (uint16 wrap, event time 1/1024 s); null when no new revolution
    cadence(prev, cur) {
      if (!prev || !cur) return null;
      const dr = (cur.revs - prev.revs + 65536) % 65536, dt = ((cur.t - prev.t + 65536) % 65536) / 1024;
      return dr > 0 && dt > 0 ? dr / dt * 60 : null;
    },
  };

  /* ---------------- Tacx FE-C over BLE (ANT messages) ---------------- */
  // ANT message: [0xA4 sync, length (=9: channel + 8-byte page), msg id, channel, page x8, XOR checksum]
  const fec = {
    SYNC: 0xa4, BROADCAST: 0x4e, ACK: 0x4f, CHANNEL: 5,
    checksum: bytes => { let c = 0; for (const b of bytes) c ^= b; return c; },
    wrap(page, msgId = 0x4f, channel = 5) {
      const p = Array.from(page); if (p.length !== 8) throw new Error('FE-C page must be 8 bytes');
      const m = [0xa4, 9, msgId, channel, ...p];
      return [...m, fec.checksum(m)];
    },
    // One ANT message -> { msgId, channel, page: number[8] } or null (bad sync / length / checksum)
    unwrap(x) {
      const b = bytesOf(x);
      if (b.length < 13 || b[0] !== 0xa4 || b[1] !== 9) return null;
      if (fec.checksum(b.subarray(0, 12)) !== b[12]) return null;
      return { msgId: b[2], channel: b[3], page: Array.from(b.subarray(4, 12)) };
    },
    // A notification can carry one message, several, or junk around them: return every valid data message.
    unwrapAll(x) {
      const b = bytesOf(x), out = [];
      for (let i = 0; i + 13 <= b.length; i++) {
        if (b[i] !== 0xa4) continue;
        const m = fec.unwrap(b.subarray(i, i + 13));
        if (m && (m.msgId === 0x4e || m.msgId === 0x4f)) { out.push(m); i += 12; }
      }
      return out;
    },
    // Page 49 (0x31) Target Power, 0.25 W units
    encodeTargetPower: w => [0x31, 0xff, 0xff, 0xff, 0xff, 0xff, ...u16(clamp(Math.round(w * 4), 0, 65532))],
    // Page 51 (0x33) Track Resistance: grade 0.01 % with +200 % offset; Crr in 5e-5 units (0xFF = trainer default)
    encodeTrackResistance(grade, crr = 0.004) {
      const g = clamp(Math.round((grade + 200) * 100), 0, 40000);
      const c = crr == null ? 0xff : clamp(Math.round(crr / 0.00005), 0, 254);
      return [0x33, 0xff, 0xff, 0xff, 0xff, ...u16(g), c];
    },
    // Page 48 (0x30) Basic Resistance: 0.5 % of the trainer's maximum resistance
    encodeBasicResistance: pct => [0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, clamp(Math.round(pct * 2), 0, 200)],
    // Page 50 (0x32) Wind Resistance: coefficient 0.01 kg/m, wind speed km/h offset 127, drafting factor 0.01
    encodeWindResistance: (cw = 0.51, windKmh = 0, draft = 1) =>
      [0x32, 0xff, 0xff, 0xff, 0xff, clamp(Math.round(cw * 100), 0, 254), clamp(Math.round(windKmh + 127), 0, 254), clamp(Math.round(draft * 100), 0, 100)],
    // Page 55 (0x37) User Configuration: user weight 0.01 kg, bike weight 0.05 kg (12 bit), wheel diameter 0.01 m
    encodeUserConfig(userKg = 75, bikeKg = 9, wheelM = 0.7) {
      const u = clamp(Math.round(userKg * 100), 0, 65534), bk = clamp(Math.round(bikeKg * 20), 0, 1000), wd = clamp(Math.round(wheelM * 100), 0, 254);
      return [0x37, ...u16(u), 0xff, 0x0f | ((bk & 0x0f) << 4), (bk >> 4) & 0xff, wd, 0x00];
    },
    // Page 70 (0x46) Request Data Page (e.g. 54 = FE capabilities): transmit twice, as a data page
    encodeRequestPage: page => [0x46, 0xff, 0xff, 0xff, 0xff, 0x02, page & 0xff, 0x01],
    // Decode one 8-byte FE-C data page.
    parsePage(x) {
      const p = bytesOf(x); if (p.length < 8) return null;
      switch (p[0]) {
        case 0x10: { // General FE Data
          const spd = p[4] | (p[5] << 8);
          return {
            page: 16, equipment: p[1], elapsed: p[2] / 4, distance: p[3], // elapsed rolls over at 64 s, distance at 256 m
            speed: spd === 0xffff ? null : spd * 3.6 / 1000, // 0.001 m/s -> km/h
            hr: p[6] === 0xff || p[6] === 0 ? null : p[6], hrSource: p[7] & 0x03,
            state: (p[7] >> 4) & 0x07,
          };
        }
        case 0x19: { // Specific Trainer / Stationary Bike Data
          const pw = p[5] | ((p[6] & 0x0f) << 8);
          return {
            page: 25, events: p[1], cadence: p[2] === 0xff ? null : p[2], accPower: p[3] | (p[4] << 8),
            power: pw === 0xfff ? null : pw, trainerStatus: (p[6] >> 4) & 0x0f,
            target: p[7] & 0x03, // 0 at target power, 1 speed too low, 2 speed too high, 3 undetermined
            state: (p[7] >> 4) & 0x07,
          };
        }
        case 0x36: // FE Capabilities
          return { page: 54, maxResistance: p[5] | (p[6] << 8), basic: !!(p[7] & 1), power: !!(p[7] & 2), sim: !!(p[7] & 4) };
        case 0x47: // Command Status (reply to the last control page)
          return { page: 71, lastCommand: p[1], seq: p[2], status: p[3] }; // status 0 pass, 1 fail, 2 not supported, 3 rejected, 4 pending, 255 none
        default: return { page: p[0] };
      }
    },
  };

  /* ---------------- Wahoo legacy trainer control (a026e005 in the Cycling Power service) ---------------- */
  // Opcodes as used by GoldenCheetah (BT40Device.cpp) and qdomyos-zwift (wahookickrsnapbike); response = [0x01 ok, op, ...]
  const wahoo = {
    OP: { UNLOCK: 0x20, RESISTANCE: 0x40, STANDARD: 0x41, ERG: 0x42, SIM: 0x43, CRR: 0x44, WIND_RES: 0x45, GRADE: 0x46, WIND_SPEED: 0x47, WHEEL: 0x48 },
    unlock: () => [0x20, 0xee, 0xfc],
    erg: w => [0x42, ...u16(clamp(Math.round(w), 0, 65535))],
    // Enter simulation mode: rider+bike weight kg x100, Crr x10000, wind resistance coefficient (kg/m) x1000
    simMode: (kg = 84, crr = 0.004, cw = 0.51) => [0x43, ...u16(clamp(Math.round(kg * 100), 0, 65535)), ...u16(clamp(Math.round(crr * 10000), 0, 65535)), ...u16(clamp(Math.round(cw * 1000), 0, 65535))],
    // Grade in %: -100 % .. +100 % mapped onto 0 .. 65535 with 0 % at 32767.5
    grade: g => [0x46, ...u16(Math.round((clamp(g / 100, -1, 1) + 1) * 65535 / 2))],
    windSpeed: ms => [0x47, ...u16(clamp(Math.round((ms + 32.768) * 1000), 0, 65535))],
    wheel: mm => [0x48, ...u16(clamp(Math.round(mm * 10), 0, 65535))],
    parseResponse(x) {
      const v = dvOf(x); if (v.byteLength < 2) return null;
      return { ok: v.getUint8(0) === 0x01, op: v.getUint8(1) };
    },
  };

  return { UUID, NAMES, pick, ftms, cps, fec, wahoo };
})();
