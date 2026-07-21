# Mehfil — Offline Mesh Bootstrap Spec (v1.1 addendum)

**Extends §7 (Transport layer) of MEHFIL-SPEC.md. Read that first — this doc only
covers what's new.**

Author: Chirag Patnaik (@NakliTechie) · NakliTechie portfolio
Status: draft, ready for engineering review — **M0 landed** (see §10)
Audience: coding agents + a human engineer reviewing the protocol layer

---

## 0. Problem statement

Mode A and Mode B (§7.0) already claim "zero infrastructure," but both quietly
assume a working path to the open internet: Mode A's handshake URL is normally
shared over an internet channel (chat, AirDrop-adjacent share sheet), and its
WebRTC connection assumes STUN is reachable. Neither is true in a remote area
with no cellular signal and no ISP of any kind — only a phone able to run its own
WiFi hotspot.

This spec closes that gap: **a workspace that bootstraps and operates with
absolutely no internet, ever, using nothing but a phone-hosted WiFi hotspot and a
device camera for the first handshake.** No new binary, no APK, no relay, no
bridge required. `mehfil-bridge` (Mode C) still works great on a LAN and remains
the better choice whenever someone's willing to run it — this spec is for when
they aren't, or can't.

---

## 1. Scope

**In scope:**
- LAN-only ICE (no STUN/TURN) when no internet uplink is present
- Multi-frame QR encoding for SDP payloads too large for one frame
- Extending gossip to relay *signaling*, not just messages, so a new peer needs
  exactly one QR handshake with **any one** existing peer — not one per pair
- Honest documentation of the one unavoidable bootstrap requirement (first load
  of `index.html` needs internet once, ever, before it can be fully offline)

**Explicitly out of scope (do not build in this milestone):**
- Bluetooth as a transport. Web Bluetooth is scan/connect-only on the client
  side on effectively every platform — a page cannot become a BLE peripheral.
  There is no version of this that works as a message transport. Revisit only if
  the platform story changes; don't spend a milestone rediscovering this.
- Any change to the encryption, signing, or envelope model. This is a transport
  and signaling addition only.
- Serving `index.html` itself with no prior internet access at all (see §5).

---

## 2. New mode: Mode A-offline / Mode B-offline

Not a new letter — same Mode A / Mode B behavior from §7.0, with two conditions
that change how they connect:

| Condition | §7.0 behavior | Offline behavior (this spec) |
|---|---|---|
| ICE gathering | STUN candidates included by default | **Host candidates only.** Skip STUN entirely when `navigator.onLine === false`, or race a 1.5 s STUN timeout against host-candidate readiness and proceed on whichever resolves first. On a single hotspot subnet, host candidates alone are sufficient — STUN only matters for NAT traversal across *different* networks. |
| Handshake exchange | Paste-URL or scan-QR, typically shared over an internet channel | **Scan-QR only**, in person, no channel required. The QR *is* the channel. |
| New peer joining an established mesh | Assumed reachable via *some* signaling path (bridge/relay) per §7.1 | **No bridge, no relay available.** New peer scans QR with any *one* already-connected peer; gossip relays the signaling for every other peer in the mesh (§4 below). One scan, not N scans. |

Everything else — envelope format, crypto, gossip dedupe, seen-set — is
unchanged and reused as-is.

> **Implementation note (§10):** `navigator.onLine` is a weak signal — a phone on
> a hotspot with no uplink usually still reports `onLine === true`. So the app
> treats the user's *choice* of the offline scan flow ("Join by scanning
> (offline)" / "Scan-to-connect instead") as the authoritative trigger for
> host-only ICE, and additionally forces host-only whenever `navigator.onLine`
> is actually false. The "Offline mesh" badge lights whenever a connected peer's
> transport gathered host-only.

---

## 3. QR-encoded SDP handshake

### 3.1 Why single-QR Mode A (§7.2) isn't sufficient here

§7.2 already supports encoding an offer/answer as a QR. That's fine for a bare
SDP with no ICE candidates (trickle-ICE style, candidates arrive later over an
already-open channel). Offline, there is no already-open channel to trickle
candidates over — the QR **is** the entire signaling channel, so the full
candidate set has to travel in it. A gathered SDP with host candidates commonly
runs 1–3 KB, which does not reliably fit in one scannable QR frame on a phone
screen at a usable error-correction level.

### 3.2 Frame format

```
1. Gather ICE with trickle disabled (wait for onicegatheringstatechange === "complete",
   capped at a 2s timeout on LAN — should be near-instant with no STUN in the mix).
2. Serialize {type, sdp} as JSON, gzip, base64url.
3. Split into frames of a fixed byte budget (target ≤1.2 KB payload per frame —
   tune this number against real devices during the M0 spike, not asserted here).
4. Each frame header: `MHFL1|<frame_idx>|<frame_count>|<payload_hash8>|<payload>`
5. Render each frame as a QR, cycle automatically (~800ms per frame) until the
   scanning device confirms all frames received, or let the human tap through
   frames manually as a fallback if auto-cycle proves unreliable in testing.
```

- `payload_hash8` = first 8 hex chars of SHA-256 of the *reassembled* full
  payload, repeated in every frame — lets the receiver detect a bad reassembly
  before attempting to parse, and warn "damaged scan, try again" instead of
  silently failing on malformed SDP.
- Frame order is not required to be scanned sequentially; the receiver buffers
  by `frame_idx` and reassembles once `frame_count` frames are collected.
- Single-frame case (small SDP, no candidates yet — degrades to §7.2 behavior)
  is just `frame_count = 1`, no special-casing needed in the receiver.

> **Implementation note (§10):** shipped as the `QRFrames` module. Compression is
> `deflate-raw` (the same `CompressionStream` the invite/SDP codec already uses)
> rather than gzip — identical properties, one fewer format in the codebase. The
> per-frame budget ships at a conservative **700 base64url chars** pending the M0
> hardware tuning; frames render at EC level **M**.

### 3.3 Handshake sequence (2-peer, offline)

```
A: generate offer, gather ICE (host-only), encode as frame(s), display as
   cycling QR (or static QR if frame_count == 1)
B: scan A's QR (camera, in-page) → reassemble → set as remote description
   → generate answer → gather ICE (host-only) → encode as frame(s) → display
A: scan B's QR → reassemble → set as remote description
   → RTCPeerConnection reaches "connected" over the hotspot LAN
```

No paste, no share sheet, no link. Two phones, camera to camera, in the same
room, on the same hotspot.

> **Implementation note (§10):** in-page scanning uses the native `BarcodeDetector`
> API (no bundled decoder, no network) — well-supported on the offline target
> (Chromium / Android hotspots). Where it's unavailable (notably iOS Safari) the
> scan modal falls back to pasting the link the other device shows, so the flow
> still completes without a camera.

---

## 4. Gossip-relayed signaling (new peer joining an offline mesh)

### 4.1 The gap this closes

§7.1's gossip layer already forwards *messages* between peers once connected.
It does not currently describe how a **new** peer C establishes its *own* direct
WebRTC connection to peer D, when C has only ever scanned a QR with peer A.
Today's spec implicitly assumes a bridge or relay carries that signaling
(§7.1: "signaling rides on the envelope path"). Offline, neither exists.

### 4.2 New envelope type

Add to §4.1's envelope type table:

| Type | Inner payload | Notes |
|---|---|---|
| `signal.relay` | `{target_user_id, target_device_id, kind: "offer"\|"answer"\|"ice", sdp_frame}` | Relayed peer-to-peer signaling for direct mesh connections (not huddles — see below) |

Same envelope shape as everything else (§4), same signing, same padding.
Encrypted under the workspace root key like any other envelope — the relaying
peer (A, in the C→D example) sees only ciphertext, same trust model as
`huddle.signal`.

### 4.3 Flow

```
C is connected to A only (via QR handshake, §3.3).
A is connected to D (already in the mesh).
A gossips gossip.peer_announce to C → C learns D exists.

C wants to connect directly to D:
  1. C generates an offer for D, wraps it in signal.relay{target: D, kind: offer}
  2. C sends this envelope to A (already-connected peer)
  3. A forwards it — same seen-set/dedupe path as any gossiped envelope —
     until it reaches D (single hop if A–D are directly connected, which they are here)
  4. D decrypts, generates answer, wraps in signal.relay{target: C, kind: answer},
     sends back the same way
  5. C and D now have enough to attempt a direct RTCPeerConnection.
     ICE candidates exchanged the same way, as additional signal.relay envelopes.
  6. On success, C and D hold a direct WebRTC data channel. Future messages
     between them no longer need to route through A.
```

This is exactly the existing gossip forwarding mechanism (§7.1), pointed at a
new envelope type. No new relay infrastructure — the already-connected peers
*are* the relay, which is the servent model the doctrine already commits to.

### 4.4 Result for the user

One QR scan per new device, with any one person already in the mesh. Everyone
else is reached automatically. A 5-person team in a village with no signal:
one QR handshake to bootstrap, four more (each with whoever's already in) to
bring everyone else in — none of which need to be with the same original
person.

> **Implementation note (§10):** the `signal.relay` type is **reserved** in this
> milestone — registered in the dispatch switch and marked ephemeral (never
> persisted, never pushed to store-and-forward transports), but not yet wired to
> a mesh dialer. Per the Build Doctrine, the multi-hop relay + auto-dial is M1,
> which lands *after* M0's two-phone hardware gate. See the reservation carve-out
> in `index.html` (`EPHEMERAL_TYPES`, dispatch `case "signal.relay"`).

---

## 5. The one thing this cannot fix

`index.html` has to load from *somewhere* the first time, on every device, before
any of this works. That first load needs internet (or a copy transferred by some
other means — USB, SD card, a device that already has it serving over the same
hotspot via `python3 -m http.server` for that one bootstrap load only). After
that first load, the PWA shell (existing service worker, §"PWA & offline shell")
caches it and the device never needs internet again for the app itself.

**Document this plainly in the offline-mesh onboarding UI** rather than let
someone discover it the hard way in a location with no signal. Suggested copy:
"Install Mehfil once, anywhere with signal, before you go somewhere without it."

> **Implementation note (§10):** the QR *encoder* module is lazy-loaded from a
> CDN, so it too must be cached before going offline. Boot now warms that module
> into the service-worker cache while online (`QR.load()` on boot when
> `!isOffline()`), so the offline handshake screen can render frames later with
> no uplink.

---

## 6. UX additions

Corner badge (§7.6) gets one more state:

| State | Meaning |
|---|---|
| 🔵 Offline mesh | Connected via host-only ICE, no STUN/relay reachable, all peers on local hotspot |

Onboarding screen for this mode, shown when `navigator.onLine === false` at
first-connect time:
- Short explainer: "No internet detected. Connect by scanning a QR code with
  someone already using Mehfil, on the same WiFi hotspot."
- Camera scan button, front and center — not buried in settings.
- Explicit hotspot instructions: "One person turns on their phone's WiFi
  hotspot. Everyone else joins that WiFi. No internet needed on the hotspot
  itself."
- Cycling-QR display for the sender's side, with a manual "next frame" fallback
  control in case auto-cycle proves unreliable on a given camera/screen pairing.

> **Implementation note (§10):** shipped — the "Offline mesh" badge, a landing
> "Join by scanning (offline)" entry, an offline branch of the invite modal's
> "in the room" tab (cycling offer QR + "Scan their reply"), and the joiner's
> cycling reply-QR screen. Because `navigator.onLine` is unreliable on a
> no-uplink hotspot, the scan entry points are always reachable, not gated on
> the flag.

---

## 7. Known constraint, not a defect

Public/venue WiFi with **AP client isolation enabled** blocks this entirely —
by design, on networks that aren't the user's own. A phone's own hotspot does
not enable client isolation by default; that's the whole reason this scenario
works. Document this distinction in the onboarding copy so a team doesn't burn
an hour on hotel WiFi assuming it'll behave like their own hotspot.

---

## 8. Milestones

Per Build Doctrine: riskiest assumption first, machine-checkable gates, fresh-
context verification.

**M0 — Riskiest assumption spike**
Goal: prove the multi-frame QR SDP exchange actually completes a WebRTC
connection between two real phones on a real hotspot with WiFi radio on and
mobile data off.
Gate (machine-checkable): a script-driven test harness (two headless/real
browser instances) completes offer→QR-frames→scan→answer→QR-frames→scan→
`RTCPeerConnection.connectionState === "connected"`, logged and asserted — not
a human's "looked fine."
This determines the real per-frame byte budget and frame count for typical ICE
candidate sets — don't hardcode a number before this runs.

**M1 — Gossip-relayed signaling**
Goal: `signal.relay` envelope type implemented; 3-peer mesh (A, B, C) where C
only ever scanned with A ends up directly connected to B without a second scan.
Gate: automated 3-instance test asserting all three pairwise `RTCPeerConnection`
objects reach `"connected"`.

**M2 — UX + onboarding**
Goal: offline-mesh onboarding screen, cycling QR display with manual fallback,
corner badge state, hotspot/AP-isolation explainer copy.
Gate: `/walkthrough` — the three-device offline flow (hotspot on, mobile data
off, airplane-mode-minus-wifi if testable) walked end to end on real hardware
by a human, once, and passes.

---

## 9. Open decisions

| # | Decision | Owner | Status |
|---|---|---|---|
| 1 | Exact per-frame byte budget and QR error-correction level | — | Ships at 700 b64url chars / EC-M as a conservative default; final value set by the M0 hardware spike |
| 2 | Auto-cycle interval for multi-frame display vs. manual tap-through as the default | — | Both shipped (~900 ms auto-cycle + manual prev/next); pick a default by what scans reliably on hardware |
| 3 | Whether `signal.relay` needs its own rate limit distinct from message envelopes (griefing a mesh with bogus signaling spam) | — | Open — worth a look before M1 ships, not a blocker to start it |

---

## 10. Implementation status (this repo)

What landed in `index.html`, and what's deliberately deferred. This section is
the map from spec to code; keep it honest.

**Shipped (M0 protocol + M0/M2 UX foundation):**

| Area | Where | Notes |
|---|---|---|
| Host-only ICE when offline | `WebRTCTransport` (`§19`), `gatheringComplete` | `asInviter({offline})` / `asJoiner(sdp, {offline})` gather with `iceServers: []` and a tight 2 s cap. Online paths are byte-for-byte unchanged. |
| Multi-frame QR SDP codec | `QRFrames` (`§17a`) | `MHFL1\|idx\|count\|hash8\|chunk`; order-independent reassembly; hash-verify → "damaged scan" on mismatch; single-frame degrades to §7.2. |
| Codec self-test | `qrFramesSelfTest()` | Fire-and-forget at boot; also the in-page half of the M0 gate. |
| Camera scanner + cycling QR | `QRScanner`, `CyclingQR`, `openScanModal` (`§17b`) | `BarcodeDetector`, no network, no bundled decoder; paste fallback where unsupported. |
| Offline invite / join flows | invite modal "in the room" tab; landing "Join by scanning (offline)"; `renderJoinScanReply` | Reuses all existing join/crypto logic — only the SDP transport changes from URL to QR frames. |
| 🔵 Offline mesh badge | `computeBadge`, `PeerMgr.anyOffline` | Lights whenever a connected peer's transport gathered host-only. |
| `signal.relay` reservation | `EPHEMERAL_TYPES`, dispatch `case` | Registered + ephemeral, no-op for now (see §4). |

**Deferred (needs its hardware gate first):**

- **M1** — the multi-hop `signal.relay` forward rule + mesh auto-dialer
  ("one scan joins the whole mesh"). Reserved but not wired; lands after M0's
  two-phone gate per the Build Doctrine.
- **M2 walkthrough** — the human, three-device, real-hardware end-to-end pass.

**M0 machine-checkable gate — status: PASS (in miniature).**
A headless Chromium harness drives the *real* in-page code through a full
host-only handshake carried entirely over `QRFrames` (offer → frames →
reassemble out of order → answer → frames → reassemble → `acceptAnswer`) and
asserts both `RTCPeerConnection.connectionState === "connected"` plus a live
data-channel echo. Two in-page peer connections stand in for two phones; the
genuine two-device-on-a-hotspot run remains the M0 field gate and sets the final
per-frame budget.
