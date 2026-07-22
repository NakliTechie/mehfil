# Mehfil e2e — offline mesh harness

`verify-mesh.mjs` proves the offline onboarding/join path with no real network,
camera, or device: N isolated browser contexts (= N "devices", each its own
IndexedDB) connect via **real WebRTC over loopback** using the app's real
offline handshake (host-only ICE, `navigator.onLine` forced false).

Topology is a star (B, C, D join owner A). Asserts: every joiner enters the
workspace after `member.welcome` (regression guard for the join-bundle fix),
the owner's message reaches all peers, and a leaf's message reaches the other
leaves via A's gossip rebroadcast (multi-hop).

## Run
```sh
npm install
npx playwright install chromium
npm run test:mesh      # or: node verify-mesh.mjs
```
Exit 0 = all green, 1 = any failure.

## Notes
- Needs `?debug=1` (exposes `window.__mehfil`) — the harness drives the real
  invite/join functions through it, so it tests real app code, not a reimpl.
- Launches Chromium with `--disable-features=WebRtcHideLocalIpsWithMdns` so
  loopback peers exchange raw host candidates instead of unresolvable `.local`
  mDNS names.
- Single-process loopback proves the mesh *logic*. It does NOT cover real iOS
  WebKit, the camera QR scan, real LAN/NAT, or `file://` boot — see
  `plan/offline-*.md` for the layered testing plan (Device Farm can't host the
  offline mesh; a physical phone rig is the only fully-faithful test).
