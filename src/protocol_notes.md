# Smart trainers + Web Bluetooth: protocol notes (researched 2026-11-18, generalised 2026-11-19)

How BTB talks to an indoor trainer, for any brand. "Connect trainer" opens the browser's Bluetooth chooser with
service filters only (no brand or name filters), connects, then picks the protocol from what the device exposes:

| Order | Protocol | How it is detected | Control | Adapter |
|---|---|---|---|---|
| 1 | **FTMS** (Bluetooth SIG Fitness Machine Service) | service `0x1826` with control point `0x2AD9` | ERG (target power), simulation (grade), resistance | `FtmsTrainer` |
| 2 | **Tacx FE-C over BLE** | service `6e40fec1-b5a3-f393-e0a9-e50e24dcca9e` | ERG (page 49), simulation (page 51), basic resistance (page 48) | `FecTrainer` |
| 3 | **Wahoo legacy** | characteristic `a026e005-0a7d-4ab3-97fa-f1500f9feb8b` in Cycling Power `0x1818` | ERG (`0x42`), simulation (`0x43` + `0x46`) | `WahooTrainer` |
| 4 | FTMS without a control point | `0x1826` only | none (data only) | `FtmsTrainer` with `cp = null` |
| 5 | **Power meter** (Cycling Power only) | `0x1818` only | none: power + cadence read-only, the app says ERG is not available | `ReadOnlyTrainer` |

Current firmware on almost every trainer sold since about 2019 speaks FTMS; the Tacx and Wahoo paths are for older
firmware that was never updated. ANT+ FE-C (USB stick, section 7) is a separate connection path in `parts/c1-ant.js`.

Code map: byte encoders/decoders are pure helpers in `src/parts/c0-trainer-proto.js` (`TRAINER_PROTO`), unit-tested in
`src/test/protocols.test.mjs`, which also drives the `Trainer` class against fake FTMS / FE-C / Wahoo / power-meter
devices. The stateful `Trainer` class in `src/app.template.html` owns the connection, the one-command-in-flight queue,
~1 command/s throttling, back-off on rejected targets and reconnects; one small adapter per protocol turns
`{ kind: 'power', w }` / `{ kind: 'sim', grade }` into bytes. `trainer.protocol` is `'FTMS' | 'Tacx FE-C' | 'Wahoo' |
'Power meter'`, `trainer.name` is the advertised device name, `trainer.cp` is truthy when the trainer can be controlled.

## 0. Platform: where Web Bluetooth works

- **Chrome on iOS/iPadOS cannot use Web Bluetooth, and neither can any other iOS browser.** Every iOS browser runs on WebKit, and WebKit has no Web Bluetooth. Safari iOS is "not supported" through 27.x on caniuse. The Chromium implementation-status page lists iOS as "no implementation planned". As of June 2026 Apple allows alternative engines in the EU, but no Blink-based Chrome has shipped there ("none have been released to the public", Gigazine 2026-06-18). `navigator.bluetooth` is `undefined` in Chrome on iOS. The page has to detect this and tell the user what to do.
- **iOS workarounds (all third-party):**
  - **Bluefy** (PNN Soft, free, App Store id1492822055). This is a WKWebView browser that injects `navigator.bluetooth` and is the long-standing option. Its API coverage is incomplete and not documented. Some filter combinations were reported broken (W3C issue #624, 2024). Not verified: whether it has `writeValueWithResponse`, whether indications work, and whether it supports Wake Lock. Use feature detection and a `writeValue` fallback.
  - **WebBLE** (older iOS app from the Puck.js project).
  - **"beacio" / iOSWebBLE Safari extension** (new in 2026; the vendor docs say iOS 18+ Safari, free). It polyfills `navigator.bluetooth` in **Safari, not Chrome**. It is unverified and comes from a vendor source only.
- **Windows desktop Chrome or Edge: works.** Windows 10+ (1703+) with Chrome 70+ supports GATT, notifications and indications. The page must be served over HTTPS (see section 8).
- **Hosting:** the page must be top-level HTTPS, or a same-origin frame, or an iframe with `allow="bluetooth"` that is not sandboxed into an opaque origin. It is likely, though I have not verified it, that a claude.ai artifact viewer iframe does not grant `bluetooth`. Test it, and if it fails, host the page standalone (GitHub Pages, Netlify, etc.).

## 1. Quirks shared by every brand (handled generically)

| Quirk | What the app does |
|---|---|
| **One Bluetooth controller at a time.** Trainers accept a single BLE central; Zwift, MyWhoosh, the maker's app, a head unit or Apple TV holding the connection hides the trainer or makes the connection fail. ANT+ is separate. | Help text tells the rider to close other apps. On FTMS, Status `0xFF` (Control Permission Lost) triggers a toast and a new Request Control; repeated losses ask the rider to close the other app. |
| **Control must be requested again after a reset.** Some FTMS trainers reset themselves (Status `0x01`) after a stop or a spin-down, or answer `0x05` Control Not Permitted. | Status `0x01`/`0xFF`: Request Control after 1.5 s and resend the target. A `0x05` reply: Request Control once and resend. |
| **No control-point indications.** Some bridges (notably on iOS) never deliver the `0x80` reply. | Each command waits up to 2.5 s; after two silent timeouts with no reply ever seen, the app switches to write-confirmed mode (300 ms). Same logic for Wahoo replies. Tacx FE-C has no per-write reply over BLE, so a successful write counts as done. |
| **Power range.** Every trainer has a minimum, a maximum and a step. | FTMS: Supported Power Range `0x2AD8` is read; targets are clamped to it and rounded to its increment. Other protocols: 0-2000 W. |
| **Command flooding.** Trainers stall or stop responding when flooded (field reports). | A target is sent only when it changes (and again after 20 s), at most about 1 command/s, strictly one in flight. Rejected targets back off for 5 s. |
| **Magnet-brake vs direct-drive ERG response.** Direct-drive trainers with an electromagnetic brake settle in 1-3 s. Trainers whose magnets are moved by a motor (and wheel-on units) take several seconds and overshoot or hunt on big steps. | ERG tips in the help text (small chainring, start pedalling first); the ride engine soft-starts and ramps instead of stepping. |
| **Zero cadence.** In ERG the brake cannot build resistance at 0 rpm; some trainers start up stiff or lock. | Ready / paused states use an easy ERG load (45-50 % FTP); release goes to 0 % grade (or FTMS Reset when simulation is unsupported). |
| **Simulation not supported** (some FTMS trainers, FE-C trainers without page 51). | FTMS reply `0x02` to op `0x11`: fall back to Set Target Resistance (`0x04`), else Reset. FE-C capabilities page 54 without the simulation bit, or Command Status page 71 "not supported" for page 51: Basic Resistance page 48. |
| **Power only on the Cycling Power service.** Some FTMS trainers leave power out of Indoor Bike Data (Machine Feature bit 14 clear). | The app then also subscribes to `0x2A63` and uses it for whatever Indoor Bike Data lacks. |
| **Heart rate relayed by the trainer.** Many trainers forward a paired strap. | FTMS Indoor Bike Data bit 9 and FE-C page 16 byte 6 feed the HR gauge; a directly connected strap always wins, so a separate strap is optional. |
| **Estimated cadence.** Many trainers estimate cadence from flywheel speed changes; it can spike on ERG transitions or read 0 for a few seconds at the start. | Cadence is shown as received; Cycling Power crank cadence decays to 0 after 3 s without a new revolution. |

## 2. FTMS byte layouts (all little-endian)

UUIDs: service `0x1826`; Indoor Bike Data `0x2AD2` (notify); Training Status `0x2AD3`; Supported Resistance Level Range `0x2AD6` (read); Supported Power Range `0x2AD8` (read); Fitness Machine Control Point `0x2AD9` (write + **indicate**); Fitness Machine Status `0x2ADA` (notify); Fitness Machine Feature `0x2ACC` (read). Web Bluetooth names: `'fitness_machine'`, `'indoor_bike_data'`, `'fitness_machine_control_point'`, `'fitness_machine_feature'`, `'supported_power_range'`, `'fitness_machine_status'`. Numeric `0x2AD2`-style values also work.

### 2.1 Indoor Bike Data 0x2AD2 (notify)

Flags are uint16. The fields follow **in this order**, each present only when its flag bit says so:

| Bit | Flag | Field(s) | Type | Unit / resolution |
|---|---|---|---|---|
| 0 | **More Data** (inverted!) | Instantaneous Speed: present when **bit0 == 0** | uint16 | 0.01 km/h |
| 1 | Average Speed present | Average Speed | uint16 | 0.01 km/h |
| 2 | Instantaneous Cadence present | Instantaneous Cadence | uint16 | **0.5 rpm** (rpm = v/2) |
| 3 | Average Cadence present | Average Cadence | uint16 | 0.5 rpm |
| 4 | Total Distance present | Total Distance | **uint24** | 1 m |
| 5 | Resistance Level present | Resistance Level | **sint16 per FTMS 1.0** (see caveat) | unitless, 1 |
| 6 | Instantaneous Power present | Instantaneous Power | sint16 | 1 W |
| 7 | Average Power present | Average Power | sint16 | 1 W |
| 8 | Expended Energy present | Total Energy uint16 (kcal), Energy/Hour uint16 (kcal/h), Energy/Minute uint8 (kcal/min) | 5 bytes total | 1 kcal |
| 9 | Heart Rate present | Heart Rate | uint8 | 1 bpm |
| 10 | Metabolic Equivalent present | MET | uint8 | 0.1 |
| 11 | Elapsed Time present | Elapsed Time | uint16 | 1 s |
| 12 | Remaining Time present | Remaining Time | uint16 | 1 s |
| 13–15 | reserved | | | |

- **The More Data bit is inverted.** Bit 0 = 1 means "more data follows in a later notification", and in that case Instantaneous Speed is **absent**. A large record may be split across several notifications, so merge fields from consecutive packets into one state object and do not assume every packet carries power.
- **Resistance Level caveat:** the FTMS 1.0 spec and common implementations (pycycling) treat it as **sint16 (2 bytes)**, but the current Bluetooth SIG GSS YAML lists it as **uint8 (1 byte)**. A wrong guess shifts power and every later field. Make the parser robust: compute the expected length with 2 bytes for resistance, and if `byteLength` is exactly 1 less, use 1 byte. Values are unknown 0xFFFF/0xFF fields; treat sentinel values as "not available".
- Speed on most trainers is virtual (computed from the flywheel and power), not wheel speed.

Parser sketch:
```js
function parseIndoorBikeData(dv) {
  let o = 0; const f = dv.getUint16(o, true); o += 2; const r = {};
  if (!(f & 0x0001)) { r.speedKmh = dv.getUint16(o, true) / 100; o += 2; }
  if (f & 0x0002) { r.avgSpeedKmh = dv.getUint16(o, true) / 100; o += 2; }
  if (f & 0x0004) { r.cadenceRpm = dv.getUint16(o, true) / 2; o += 2; }
  if (f & 0x0008) { r.avgCadenceRpm = dv.getUint16(o, true) / 2; o += 2; }
  if (f & 0x0010) { r.distanceM = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16); o += 3; }
  if (f & 0x0020) { /* see resistance caveat */ const rest = expectedRest(f & ~0x003F); const resLen = (dv.byteLength - o - rest) === 1 ? 1 : 2;
                    r.resistance = resLen === 2 ? dv.getInt16(o, true) : dv.getUint8(o); o += resLen; }
  if (f & 0x0040) { r.powerW = dv.getInt16(o, true); o += 2; }
  if (f & 0x0080) { r.avgPowerW = dv.getInt16(o, true); o += 2; }
  if (f & 0x0100) { r.totalKcal = dv.getUint16(o, true); r.kcalPerHour = dv.getUint16(o + 2, true); r.kcalPerMin = dv.getUint8(o + 4); o += 5; }
  if (f & 0x0200) { r.hr = dv.getUint8(o); o += 1; }
  if (f & 0x0400) { r.met = dv.getUint8(o) / 10; o += 1; }
  if (f & 0x0800) { r.elapsedS = dv.getUint16(o, true); o += 2; }
  if (f & 0x1000) { r.remainingS = dv.getUint16(o, true); o += 2; }
  return r;
}
// expectedRest(flags) = byte count of fields after resistance: 2*(b6)+2*(b7)+5*(b8)+1*(b9)+1*(b10)+2*(b11)+2*(b12)
```

### 2.2 Fitness Machine Control Point 0x2AD9 (write with response + indicate)

**Before the first write, call `startNotifications()` on 0x2AD9.** On an indicate-only characteristic this enables indications. Without them the server rejects writes with an ATT error, "CCCD Improperly Configured" (0xFD, from the Common Profile and Service Error Codes).

| Op | Name | Parameter (LE) |
|---|---|---|
| 0x00 | Request Control | none |
| 0x01 | Reset | none |
| 0x02 | Set Target Speed | uint16, 0.01 km/h |
| 0x03 | Set Target Inclination | sint16, 0.1 % |
| 0x04 | Set Target Resistance Level | **uint8, resolution 0.1** (send level×10) in FTMS 1.0 (newer spec text may say sint16; uncertain) |
| 0x05 | **Set Target Power** | **sint16, 1 W** → `[0x05, w & 0xFF, (w >> 8) & 0xFF]` |
| 0x06 | Set Target Heart Rate | uint8 bpm |
| 0x07 | Start or Resume | none |
| 0x08 | Stop or Pause | uint8: **0x01 = stop, 0x02 = pause** |
| 0x09–0x10 | Targeted energy, steps, strides, distance (uint24), time, HR zone times | (not needed) |
| 0x11 | **Set Indoor Bike Simulation Parameters** | wind speed **sint16, 0.001 m/s**; grade **sint16, 0.01 %**; Crr **uint8, 0.0001**; Cw **uint8, 0.01 kg/m** (6 bytes) |
| 0x12 | Set Wheel Circumference | uint16, 0.1 mm |
| 0x13 | Spin Down Control | uint8: 0x01 start, 0x02 ignore |
| 0x14 | Set Targeted Cadence | uint16, 0.5 rpm per spec (pycycling sends 1 byte, which is a known bug there) |
| **0x80** | **Response Code** (indicated) | `[0x80, requestOpCode, result, ...optional params]` |

Result codes: **0x01 Success, 0x02 Op Code Not Supported, 0x03 Invalid Parameter, 0x04 Operation Failed, 0x05 Control Not Permitted.** (Spec names: "Not Supported", "Invalid Parameter", "Operation Failed", "Control Not Permitted".)

Recommended ERG sequence:
1. `connect()`, then get the service, then read **Feature 0x2ACC**. Check that target-setting bit 3 (Power Target Setting) is set.
2. Read **Supported Power Range 0x2AD8**.
3. `startNotifications()` on **0x2AD9** (indications), **0x2ADA** (status) and **0x2AD2** (bike data).
4. Write `[0x00]` (Request Control) and await `80 00 01`.
5. Optionally write `[0x07]` (Start/Resume) and await `80 07 xx`. Tolerate 0x02 or 0x04; not every trainer needs it.
6. Write `[0x05, lo, hi]` and await `80 05 01`. Expect Fitness Machine Status `08 lo hi` (Target Power Changed).
7. Leaving ERG: either send a simulation command (0x11, grade 0) or a low resistance (0x04). On exit send Stop/Pause `[0x08, 0x01]` or Reset `[0x01]` (Reset also releases control).

Write with `characteristic.writeValueWithResponse(bytes)` (Chrome 85+). Fall back to `writeValue` (deprecated) when it is missing, for example in Bluefy. Keep **one GATT operation in flight at a time**: Chrome rejects concurrent operations with "GATT operation already in progress". FTMS servers also reject a new control-point write while one is pending (ATT 0xFE, "Procedure Already In Progress"). Use a promise queue plus a roughly 3 s indication timeout.

### 2.3 Fitness Machine Feature 0x2ACC (read, 8 bytes)

There are two uint32 values: Fitness Machine Features (bytes 0–3) and Target Setting Features (bytes 4–7).

- **Machine Features bits:** 0 avg speed, 1 cadence, 2 total distance, 3 inclination, 4 elevation gain, 5 pace, 6 step count, 7 resistance level, 8 stride count, 9 expended energy, **10 heart rate measurement**, 11 MET, 12 elapsed time, 13 remaining time, **14 power measurement**, 15 force on belt & power output, 16 user data retention.
- **Target Setting bits:** 0 speed, 1 inclination, **2 resistance**, **3 power**, 4 heart rate, 5 targeted expended energy, 6 steps, 7 strides, 8 distance, 9 training time, 10/11/12 time in 2/3/5 HR zones, **13 indoor bike simulation parameters**, 14 wheel circumference, 15 spin-down control, 16 targeted cadence.
- ERG requires `(dv.getUint32(4, true) >> 3) & 1`. Machine Features bit 10 tells you whether the trainer reports HR (many trainers relay a paired HR strap; bit 9 in Indoor Bike Data is the per-packet truth).

### 2.4 Supported Power Range 0x2AD8 (read, 6 bytes)

`minPower sint16 W, maxPower sint16 W, minIncrement uint16 W`. Per the FTMS ICS this characteristic is mandatory when the Power Target bit is set. (pycycling reads these as unsigned; use signed.)

Supported Resistance Level Range 0x2AD6: `min sint16, max sint16, increment uint16`, resolution 0.1.

### 2.5 Fitness Machine Status 0x2ADA (notify)

`[opCode, ...params]`: 0x01 Reset; **0x02 Stopped/Paused by user** (uint8 1 = stop, 2 = pause); 0x03 Stopped by safety key; **0x04 Started/Resumed by user**; 0x05 Target speed changed (uint16 0.01 km/h); 0x06 Target incline changed (sint16 0.1%); 0x07 Target resistance changed (uint8 0.1); **0x08 Target Power Changed (sint16 W)**; 0x09 Target HR changed (uint8); 0x0A–0x11 targeted-value changes; **0x12 Indoor Bike Simulation Parameters Changed** (same 6-byte layout as op 0x11); 0x13 Wheel circumference changed; 0x14 Spin-down status; 0x15 Targeted cadence changed; **0xFF Control Permission Lost** (re-request control).

## 3. Fallback / auxiliary characteristics

### Cycling Power Measurement 0x2A63 (service 0x1818, notify)

Flags uint16, then **Instantaneous Power sint16 W (always present)**, then optional fields in this order:

| Bit | Field | Size |
|---|---|---|
| 0 | Pedal Power Balance (uint8, 0.5%) | 1 (bit 1 = balance reference left) |
| 2 | Accumulated Torque (uint16, 1/32 Nm) | 2 (bit 3 = source crank/wheel) |
| 4 | Wheel Revolution Data: cumulative wheel revs **uint32**, last wheel event time uint16 **1/2048 s** | 6 |
| **5** | **Crank Revolution Data: cumulative crank revs uint16, last crank event time uint16 1/1024 s** | 4 |
| 6 | Extreme force magnitudes (2× sint16 N) | 4 |
| 7 | Extreme torque magnitudes (2× sint16, 1/32 Nm) | 4 |
| 8 | Extreme angles (2× uint12 packed) | 3 |
| 9 / 10 | Top / Bottom dead spot angle (uint16 deg) | 2 each |
| 11 | Accumulated energy (uint16 kJ) | 2 |
| 12 | Offset compensation indicator (flag only) | 0 |

Cadence from crank data: `rpm = 60 * 1024 * ΔcrankRevs / ΔeventTime`, with uint16 wrap (`(b - a + 65536) % 65536`). If Δtime == 0, keep the last value, and decay to 0 after about 2–3 s without new crank events. Many trainers estimate cadence and send no crank data (bit 5) on CPS, so check the flag at runtime. Note that you can only use CPS while connected to the same trainer: it is one device with one connection. Get it from the same GATT server by listing `'cycling_power'` in optionalServices.

### Heart Rate Measurement 0x2A37 (service 0x180D, notify; separate strap)

Flags uint8: **bit 0 = HR format (0 = uint8, 1 = uint16)**, bit 1 = sensor contact detected, bit 2 = sensor contact supported, bit 3 = Energy Expended present (uint16 kJ), bit 4 = RR-intervals present (uint16 each, 1/1024 s, oldest first, as many as fit). Order: flags, HR, [energy], [RR...].

## 4. Tacx FE-C over BLE (older Tacx firmware without FTMS)

Tacx Neo, Neo 2/2T, Flux, Flux S/2, Vortex, Genius and Bushido smart trainers shipped a proprietary BLE service that
tunnels ANT+ FE-C data pages. Firmware from about 2020 onwards adds FTMS; the app prefers FTMS when both exist.

- Service `6e40fec1-b5a3-f393-e0a9-e50e24dcca9e` (a Nordic-UART-style layout):
  - `6e40fec2-…` (notify): trainer to app, ANT broadcast messages carrying FE-C data pages.
  - `6e40fec3-…` (write / write without response): app to trainer, ANT acknowledged messages carrying control pages.
    GoldenCheetah writes without response; BTB does the same when the characteristic allows it.
- **ANT message framing** (one per notification / write, 13 bytes):
  `[0xA4 sync, 0x09 length, msgId, channel, page[8], checksum]`, checksum = XOR of the 12 preceding bytes.
  `msgId` 0x4E = broadcast data (what the trainer sends), 0x4F = acknowledged data (what apps send). The channel byte
  is 5 in GoldenCheetah; it is a leftover of the ANT framing over BLE. `unwrapAll` scans a notification for every valid
  message, so concatenated or prefixed notifications still parse.

Control pages (app to trainer):

| Page | Bytes after the page number | Notes |
|---|---|---|
| 48 `0x30` Basic Resistance | 6x `0xFF`, total resistance uint8 in 0.5 % of max | used when simulation is not supported |
| 49 `0x31` **Target Power** | 5x `0xFF`, power uint16 LE in **0.25 W** | ERG: 200 W is `20 03` |
| 50 `0x32` Wind Resistance | 4x `0xFF`, wind coefficient 0.01 kg/m, wind speed km/h + 127, drafting factor 0.01 | not sent (defaults are fine) |
| 51 `0x33` **Track Resistance** | 4x `0xFF`, grade uint16 LE in **0.01 % with +200 % offset**, Crr uint8 in 5e-5 (`0xFF` = default 0.004) | slope: 5 % is `14 50 50` |
| 55 `0x37` User Configuration | user weight uint16 0.01 kg, reserved `0xFF`, wheel-diameter offset (4 bit) + bike weight (12 bit, 0.05 kg), wheel diameter 0.01 m, gear ratio 0.03 | sent once at connect (rider weight + 9 kg bike) |
| 70 `0x46` Request Data Page | 4x `0xFF`, transmission count, requested page, command type `0x01` | asks for page 54 at connect |

Data pages (trainer to app):

| Page | Fields used |
|---|---|
| 16 `0x10` General FE Data | equipment type (25 = trainer), elapsed time 0.25 s (rolls over at 64 s), distance m (rolls over at 256), **speed uint16 0.001 m/s**, **heart rate** (`0xFF` = none), capabilities / FE state |
| 25 `0x19` Specific Trainer Data | update counter, **cadence** rpm (`0xFF` = none), accumulated power, **instant power, 12 bit** (byte 5 + low nibble of byte 6, `0xFFF` = none), trainer status, target-power flag (0 at target, 1 speed too low, 2 too high) |
| 54 `0x36` FE Capabilities | max resistance N; bit 0 basic resistance, bit 1 target power, bit 2 simulation |
| 71 `0x47` Command Status | last command page, sequence, status (0 pass, 1 fail, 2 not supported, 3 rejected, 4 pending) |

## 5. Wahoo legacy trainer control (older KICKR / KICKR Snap / KICKR Core firmware without FTMS)

Before Wahoo added FTMS (2020-2021 firmware), KICKRs were controlled through a private characteristic inside the
standard Cycling Power service. Wahoo never published it; the layout below is the reverse-engineered one used by
GoldenCheetah (`BT40Device.cpp`) and qdomyos-zwift (`wahookickrsnapbike`), which agree on every opcode and scaling.

- Characteristic `a026e005-0a7d-4ab3-97fa-f1500f9feb8b` (write + **indicate**) in service `0x1818`. Power and crank
  cadence come from the normal Cycling Power Measurement `0x2A63`. Some firmware also has the vendor service
  `a026ee01-…`; BTB probes it only as a fallback location for the characteristic.
- Enable indications first (CCCD `02 00`), then:

| Op | Name | Parameters (LE) |
|---|---|---|
| `0x20` | **Unlock** | `EE FC` (sent once after connecting) |
| `0x40` | Resistance mode | uint16 `(1 - r) x 16383`, r 0..1 |
| `0x41` | Standard (level) mode | uint8 level |
| `0x42` | **ERG mode** | uint16 watts |
| `0x43` | **Simulation mode** | rider+bike weight uint16 kg x100, Crr uint16 x10000, wind resistance coefficient uint16 kg/m x1000 |
| `0x44` / `0x45` | Sim Crr / wind resistance | uint16 as above |
| `0x46` | **Sim grade** | uint16 `(grade/100 + 1) x 65535/2`, grade clamped to +-100 % (0 % = `0x8000`) |
| `0x47` | Sim wind speed | uint16 `(m/s + 32.768) x 1000` |
| `0x48` | Wheel circumference | uint16 mm x 10 |

- Replies arrive as indications `[0x01 = success, opcode, ...]` (qdomyos-zwift: ERG reply `01 42 01 00 lo hi`).
  BTB matches replies by opcode and treats any first byte other than `0x01` as a failure.
- A grade only applies in simulation mode, so the app sends `0x43` before the first `0x46` after ERG; `0x42` switches
  back to ERG. On disconnect it sends simulation mode + grade 0 so the flywheel spins freely.
- **Unverified on hardware:** that every pre-FTMS firmware needs (and accepts) the unlock; one community note mentions
  a plain `0x00` instead. Both code bases above send `20 EE FC`.

## 6. Power meters and data-only devices

A device with only the Cycling Power service (a pedal / crank power meter, or a trainer with a power sensor but no
control) connects read-only: power from `0x2A63`, cadence from its crank data when present. The app says "power data
only, ERG is not available on this device" and never sends control commands. An FTMS device without a control point is
handled the same way.

## 7. ANT+ FE-C (overview)

ANT+ FE-C uses the same data pages as section 4, sent over ANT radio instead of BLE: a USB ANT stick, a slave channel
with device type **17** (fitness equipment), channel period **8192** (4 Hz), RF frequency 57 (2457 MHz) and the ANT+
network key (licensed to ANT+ adopters, not public). The app opens a channel, receives pages 16 / 25 broadcast by the
trainer and sends pages 48-51 as acknowledged messages (`0x4F`), retrying when the acknowledgement fails. Unlike
Bluetooth, ANT+ allows several receivers at once (a head unit can listen while the app controls). In the browser it
needs WebUSB (Chrome / Edge on desktop and Android, not iOS). Implementation: `src/parts/c1-ant.js`.

## 8. Web Bluetooth platform support (Nov 2026)

| Platform | Status |
|---|---|
| Chrome / Edge / Opera on **Windows 10+** | Supported (GATT since Chrome 56; notifications/descriptors on Windows since **Chrome 70**). Do not pair the trainer in Windows Settings; let Chrome's chooser handle it. |
| Chrome / Edge on **macOS** | Supported (Chrome 56+). macOS must grant Chrome Bluetooth permission (System Settings > Privacy & Security > Bluetooth). |
| Chrome on **ChromeOS** | Supported. |
| Chrome on **Linux** | "Partially implemented and not supported": needs `chrome://flags/#enable-experimental-web-platform-features` and BlueZ 5.41+. |
| **Chrome Android** (6.0+) | Supported. Needs Bluetooth on, plus the Nearby-devices permission (Android 12+) or Location (older). Samsung Internet 6.2+ is supported too. |
| **iOS / iPadOS: Safari, Chrome, Edge, Firefox** | **Not supported** (WebKit). Workarounds: Bluefy, WebBLE, or the beacio/iOSWebBLE Safari extension (see section 0). |
| Firefox (all), Safari macOS | Not supported (Mozilla's standards position calls it "harmful"). |

- **Secure context required:** HTTPS, or `http://localhost` / `127.0.0.1` for development.
- **`file://` in Chrome on Windows: uncertain, so do not rely on it.** Chrome treats file: pages as a secure context, but their origin is opaque. The Web Bluetooth tests require `requestDevice()` to throw a `SecurityError` when the top-level origin is opaque, so expect failure. Use `python -m http.server`, then `http://localhost:8000`, or HTTPS hosting.
- **`requestDevice()` needs a user gesture** (transient activation): call it straight from a click or tap handler, with no `await` before it.
- **iframes:** Permissions Policy feature `bluetooth`, default allowlist `'self'`. A cross-origin iframe needs `<iframe allow="bluetooth">`, and the parent's `Permissions-Policy` header must not exclude it. A **sandboxed iframe without `allow-same-origin`** has an opaque origin, so `requestDevice()` and `getDevices()` reject with `SecurityError`; `getAvailability()` resolves `false` when the feature is blocked by policy. Embedded viewers such as the claude.ai artifact frame are likely blocked (unverified). Detect this and offer an "open in a new tab" link, or host the page standalone.
- **Reconnect:** keep the `BluetoothDevice` object and, on `gattserverdisconnected`, call `device.gatt.connect()` again (no gesture needed in the same page session, with backoff). `navigator.bluetooth.getDevices()` for reconnecting after a reload is still flag-gated or partial in Chrome. Do not depend on it.

### requestDevice for any trainer

```js
const dev = await navigator.bluetooth.requestDevice({
  filters: [                                          // service filters only: any brand that advertises one of them
    { services: [0x1826] },                           // FTMS
    { services: [0x1818] },                           // Cycling Power (Wahoo legacy, power meters, most trainers)
    { services: ['6e40fec1-b5a3-f393-e0a9-e50e24dcca9e'] }, // Tacx FE-C over BLE
  ],
  optionalServices: [0x1826, 0x1818, '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e', 'a026ee01-0a7d-4ab3-97fa-f1500f9feb8b',
    0x180d, 'device_information', 'battery_service'],
});
const hrm = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] }); // separate button / gesture
```

- Filters are OR'ed between entries and AND'ed within one entry. 128-bit UUIDs must be lowercase.
- Every service the app reads must be in `filters` or `optionalServices`, or `getPrimaryService` throws `SecurityError`.
- A device already connected to another app (Zwift, the maker's app, a phone) will not show up or will fail to connect.

## 9. Screen Wake Lock API (`navigator.wakeLock.request('screen')`)

| Platform | Support |
|---|---|
| Chrome / Edge desktop (Win/mac/Linux/ChromeOS) | 84+ |
| Chrome Android | 84+ |
| Safari macOS / **Safari iOS** | **16.4+** |
| **Chrome/Edge/Firefox on iOS** | Same as iOS Safari (WebKit), so iOS 16.4+ |
| Firefox desktop | 126+ |
| Samsung Internet | 14+ |
| Bluefy (WKWebView) | **Unknown**. Feature-detect, and fall back to a muted looping inline `<video playsinline>` (NoSleep.js technique) or tell the user to change Auto-Lock. |

- Secure context only. Permissions Policy feature `screen-wake-lock` (default `'self'`).
- The lock is released automatically when the page is hidden (tab switch or screen off), so re-request it on `visibilitychange` when `document.visibilityState === 'visible'`.
- The request can reject with `NotAllowedError` (for example in battery saver or when the document is not visible), so wrap it in try/catch.
- There are reports that wake lock was unreliable in iOS home-screen (standalone) web apps before iOS 18.4. I did not verify this.

## Sources
- Bluetooth SIG FTMS 1.0 spec page: https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/
- FTMS ICS (Supported Power Range mandatory with power target): https://files.bluetooth.com/download/ftms-ics-p4-pdf
- Bluetooth SIG GSS Indoor Bike Data: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.indoor_bike_data.yaml
- Bluetooth SIG GSS Supported Power Range: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.supported_power_range.yaml
- Bluetooth SIG GSS Cycling Power Measurement: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.cycling_power_measurement.yaml
- Bluetooth SIG GSS Heart Rate Measurement: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.heart_rate_measurement.yaml
- pycycling FTMS parsers (control point, feature, status, indoor bike data): https://github.com/zacharyedwardbull/pycycling/tree/master/pycycling/ftms_parsers
- GoldenCheetah BT40Device.cpp (Tacx FE-C BLE UUIDs and writes; Wahoo opcodes 0x42/0x43/0x46/0x47/0x48 and their scaling): https://github.com/GoldenCheetah/GoldenCheetah/blob/master/src/Train/BT40Device.cpp
- GoldenCheetah ANTMessage.cpp (ANT framing + checksum, FE-C page 49/50/51 encoders, page 16/25 decoding): https://github.com/GoldenCheetah/GoldenCheetah/blob/master/src/ANT/ANTMessage.cpp
- qdomyos-zwift Wahoo KICKR driver (unlock `20 EE FC`, opcode table 0x20/0x40-0x48, reply format `01 op ...`, init order): https://github.com/cagnulein/qdomyos-zwift/tree/master/src/devices/wahookickrsnapbike
- ANT+ Fitness Equipment device profile (pages 16, 25, 48-51, 54, 55, 70, 71; free registration): https://www.thisisant.com/developer/resources/downloads/
- Zwift Insider, one trainer connected via legacy ANT+, ANT+ FE-C and Bluetooth FTMS: https://zwiftinsider.com/wahoo-kickr-tests-connecting-via-legacy-ant-ant-fe-c-and-bluetooth-ftms/
- TrainerDay forum (trainers stalling when flooded with commands): https://forums.trainerday.com/t/loosing-watts-not-matching-target-wahoo-ramps/41116
- Chrome Web Bluetooth guide: https://developer.chrome.com/docs/capabilities/bluetooth
- Web Bluetooth implementation status: https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md
- caniuse Web Bluetooth: https://caniuse.com/web-bluetooth ; Wake Lock: https://caniuse.com/wake-lock
- MDN requestDevice: https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice
- MDN Permissions-Policy bluetooth: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/bluetooth
- Gigazine, Blink on iOS status (2026-06-18): https://gigazine.net/gsc_news/en/20260618-blink-on-ios
- WebKit bug, Web Bluetooth request: https://bugs.webkit.org/show_bug.cgi?id=238049
- Bluefy App Store: https://apps.apple.com/app/id1492822055
- beacio / iOSWebBLE Safari extension docs: https://webble-safari-extension.pages.dev/docs
