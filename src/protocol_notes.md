# Elite Direto X + Web Bluetooth (FTMS ERG): implementation notes (researched 2026-11-18)

## 0. Main finding for the user's goal ("send the page to anyone; Chrome on iOS mainly; Windows Chrome too")

- **Chrome on iOS/iPadOS cannot use Web Bluetooth, and neither can any other iOS browser.** Every iOS browser runs on WebKit, and WebKit has no Web Bluetooth. Safari iOS is "not supported" through 27.x on caniuse. The Chromium implementation-status page lists iOS as "no implementation planned". As of June 2026 Apple allows alternative engines in the EU, but no Blink-based Chrome has shipped there ("none have been released to the public", Gigazine 2026-06-18). `navigator.bluetooth` is `undefined` in Chrome on iOS. The page has to detect this and tell the user what to do.
- **iOS workarounds (all third-party):**
  - **Bluefy** (PNN Soft, free, App Store id1492822055). This is a WKWebView browser that injects `navigator.bluetooth` and is the long-standing option. Its API coverage is incomplete and not documented. Some filter combinations were reported broken (W3C issue #624, 2024). Not verified: whether it has `writeValueWithResponse`, whether indications work, and whether it supports Wake Lock. Use feature detection and a `writeValue` fallback.
  - **WebBLE** (older iOS app from the Puck.js project).
  - **"beacio" / iOSWebBLE Safari extension** (new in 2026; the vendor docs say iOS 18+ Safari, free). It polyfills `navigator.bluetooth` in **Safari, not Chrome**. It is unverified and comes from a vendor source only.
- **Windows desktop Chrome or Edge: works.** Windows 10+ (1703+) with Chrome 70+ supports GATT, notifications and indications. The page must be served over HTTPS (see section 4).
- **Hosting:** the page must be top-level HTTPS, or a same-origin frame, or an iframe with `allow="bluetooth"` that is not sandboxed into an opaque origin. It is likely, though I have not verified it, that a claude.ai artifact viewer iframe does not grant `bluetooth`. Test it, and if it fails, host the page standalone (GitHub Pages, Netlify, etc.).

## 1. Elite Direto X: device facts

| Item | Finding | Confidence |
|---|---|---|
| FTMS 0x1826 (Fitness Machine, Indoor Bike) | **Yes.** The Elite Direto X manual lists "Bluetooth Smart FTMS: Fitness Machine - Indoor Bike service", which sends data and allows resistance control. DC Rainmaker's table shows FTMS = yes. | High |
| Cycling Power Service 0x1818 | **Yes** ("Bluetooth Smart Power Service": data only, no control). | High |
| Cycling Speed & Cadence 0x1816 | **Yes** ("Bluetooth Smart Speed&Cadence": data only). | High |
| Firmware requirement | No minimum version is documented. FTMS has been supported since launch (the original Direto in 2017 was the first FTMS trainer). Updates go through Elite's **Upgrado** app (a 2025 Elite post says Direto X updates were "coming that spring"). The Direto X is discontinued and was replaced by the Direto XR. | Medium |
| Elite proprietary BLE service | Older Elite products used a proprietary service. A UUID circulates (`347b0001-7635-408b-8918-8ff3949ce592`, the Elite custom base used by Sterzo), but **I could not confirm** that the Direto X exposes it or what it does. Do not depend on it. | Low |
| BLE central connections | **One only.** The manual says "Bluetooth Smart allows only one connection"; DC Rainmaker: "No, just one". Zwift, the Elite apps, TrainerRoad, Garmin and Apple TV must all be disconnected or closed, or the trainer is not available (it stops advertising, or the connection fails). ANT+ runs separately. | High |
| Max power / range | Depends on flywheel speed. DC Rainmaker: **2,100 W @ 40 km/h, 3,250 W @ 60 km/h**. Some retail listings give 1,400 W @ 40 km/h, which is a carry-over from the original Direto. Max simulated grade is 18%. Accuracy is ±1.5%. The manual says that outside the range "it delivers the closest possible max/min". **Read Supported Power Range 0x2AD8 at runtime and clamp targets to it.** Low targets can be impossible in a big gear at high flywheel speed (passive resistance floor), so advise a small chainring and moderate gear in ERG. | Medium-high |
| Heart rate in Indoor Bike Data | The trainer has **no HR receiver or bridging** (DCR: "Bridging or re-transmission: No"). Expect flag bit 9 = 0. **The rider needs a separate BLE HR strap** (service 0x180D), connected through its own `requestDevice` call. Still parse bit 9 when it is present. | Medium-high (inferred) |
| Cadence | It is **estimated** (not a crank sensor) and sent over FTMS and ANT+. DCR saw cadence spikes on ERG transitions. | High |
| ERG behaviour | ERG is driven by a screw/motor that moves magnets, so response is **slow (a few seconds)**. It overshoots or hunts on large steps: DCR saw a 150 W to 402 W step "keep hunting", and the 30/30s "wobbled too much". At **zero cadence the trainer struggles to set initial resistance** (Zwift forum, 2025). Rapid resistance swings can stall the actuator; Elite's fix is cleaning the motor screw thread. A user report says flooding the trainer with commands made it stop responding (TrainerDay). | High (reports) |
| "Request Control before every target" | **Not documented.** Per FTMS, control persists for the connection. Send Request Control once after connect, and resend only after result 0x05 (Control Not Permitted), Status 0xFF (Control Permission Lost), Reset, or a reconnect. | Medium |

Practical rules for the app:
- Send a target only when it changes. Do not resend at 1–4 Hz. For ramps, step at most about once per second.
- Serialize control-point writes: wait for the 0x80 indication, or a timeout of about 3 s, before the next write.
- Ask the rider to be pedalling before the first ERG target. Clamp targets to `[minPower, maxPower]` from 0x2AD8 and round to `minIncrement`.

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
- Speed on the Direto X is virtual (computed from flywheel), not wheel speed.

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
- ERG requires `(dv.getUint32(4, true) >> 3) & 1`. Machine Features bit 10 tells you whether the trainer reports HR (expect 0 on the Direto X).

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

Cadence from crank data: `rpm = 60 * 1024 * ΔcrankRevs / ΔeventTime`, with uint16 wrap (`(b - a + 65536) % 65536`). If Δtime == 0, keep the last value, and decay to 0 after about 2–3 s without new crank events. Whether the Direto X's CPS includes crank data (bit 5) is **not confirmed**, since its cadence is estimated, so check the flag at runtime. Note that you can only use CPS while connected to the same trainer: it is one device with one connection. Get it from the same GATT server by listing `'cycling_power'` in optionalServices.

### Heart Rate Measurement 0x2A37 (service 0x180D, notify; separate strap)

Flags uint8: **bit 0 = HR format (0 = uint8, 1 = uint16)**, bit 1 = sensor contact detected, bit 2 = sensor contact supported, bit 3 = Energy Expended present (uint16 kJ), bit 4 = RR-intervals present (uint16 each, 1/1024 s, oldest first, as many as fit). Order: flags, HR, [energy], [RR...].

## 4. Web Bluetooth platform support (Nov 2026)

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

### requestDevice for a Direto X

```js
const trainer = await navigator.bluetooth.requestDevice({
  filters: [
    { services: ['fitness_machine'] },   // 0x1826, matches if advertised
    { namePrefix: 'DIRETO' },             // case-sensitive; exact advertised name unverified
    { namePrefix: 'Direto' },
  ],
  optionalServices: ['fitness_machine', 'cycling_power', 'cycling_speed_and_cadence', 'device_information'],
});
const hrm = await navigator.bluetooth.requestDevice({   // separate button/gesture
  filters: [{ services: ['heart_rate'] }],
});
```

- Filters are OR'ed between entries and AND'ed within one entry.
- Services reached only through a name filter **must** be listed in `optionalServices`, or `getPrimaryService` throws.
- I could not confirm the Direto X's exact advertised name: it is probably "DIRETO X" followed by a serial, but unverified. The `services: [0x1826]` filter is the dependable one because the Direto X advertises FTMS. The `namePrefix` entries are a fallback. If neither shows the device, an `acceptAllDevices: true` debug fallback (with optionalServices) helps.
- A device already connected to another app (Zwift, Elite app, phone) will not show up or will fail to connect.

## 5. Screen Wake Lock API (`navigator.wakeLock.request('screen')`)

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
- Elite Direto X manual, protocols and power range: https://manualslib.es/manual/445879/Elite-Direto-X.html?page=42
- DC Rainmaker, Elite Direto X review (specs, 1 BT connection, ERG behaviour, estimated cadence): https://www.dcrainmaker.com/2019/09/elite-direto-trainer-review.html
- DC Rainmaker, original Direto (first FTMS trainer): https://dcrainmaker.com/2017/09/elite-direto-trainer-depth-review.html
- Elite firmware / Upgrado news: https://www.elite-it.com/en/news/even-more-elite-smart-trainers-now-speak-zwift-cog-and-click
- Zwift forum, ERG not working on Direto X (zero-cadence, actuator): https://forums.zwift.com/t/erg-not-working-on-elite-direto-x/636456
- TrainerRoad forum, Direto X Bluetooth ERG: https://www.trainerroad.com/forum/t/elite-direto-x-bluetooth-erg-mode/22936
- TrainerDay forum (command flooding): https://forums.trainerday.com/t/loosing-watts-not-matching-target-wahoo-ramps/41116
- Bluetooth SIG FTMS 1.0 spec page: https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/
- Bluetooth SIG GSS Indoor Bike Data: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.indoor_bike_data.yaml
- Bluetooth SIG GSS Supported Power Range: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.supported_power_range.yaml
- Bluetooth SIG GSS Cycling Power Measurement: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.cycling_power_measurement.yaml
- Bluetooth SIG GSS Heart Rate Measurement: https://bitbucket.org/bluetooth-SIG/public/raw/main/gss/org.bluetooth.characteristic.heart_rate_measurement.yaml
- pycycling FTMS parsers (control point, feature, status, indoor bike data): https://github.com/zacharyedwardbull/pycycling/tree/master/pycycling/ftms_parsers
- FTMS ICS (Supported Power Range mandatory with power target): https://files.bluetooth.com/download/ftms-ics-p4-pdf
- Chrome Web Bluetooth guide: https://developer.chrome.com/docs/capabilities/bluetooth
- Web Bluetooth implementation status: https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md
- caniuse Web Bluetooth: https://caniuse.com/web-bluetooth ; Wake Lock: https://caniuse.com/wake-lock
- MDN requestDevice: https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice
- MDN Permissions-Policy bluetooth: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/bluetooth
- WPT opaque-origin rejection: https://github-redirect.dependabot.com/mrego/wpt/commit/61e57be42dd05a4d459cca2cccac4b68cb659078
- Gigazine, Blink on iOS status (2026-06-18): https://gigazine.net/gsc_news/en/20260618-blink-on-ios
- WebKit bug, Web Bluetooth request: https://bugs.webkit.org/show_bug.cgi?id=238049
- Bluefy App Store: https://apps.apple.com/app/id1492822055
- beacio / iOSWebBLE Safari extension docs: https://webble-safari-extension.pages.dev/docs
