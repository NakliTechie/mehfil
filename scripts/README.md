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
npm run test:journeys  # multi-actor journeys (channels, reactions, DMs, admin)
```
Exit 0 = all green, 1 = any failure.

## `csp-hash.mjs` — keep the CSP hashes current

`script-src` pins each inline `<script>` block by SHA-256 instead of allowing
`'unsafe-inline'`, so an HTML-injection bug can't turn into script execution
(finding L1). The hashes cover the exact bytes of those blocks, so **editing
index.html invalidates them and the app then refuses to boot at all**.

```sh
npm run csp:check      # exit 1 if stale — run before committing
npm run csp:write      # recompute and rewrite in place after editing
```

This is not a build step: index.html still opens straight from disk. A stale
hash is caught loudly rather than silently — both harnesses boot the real page,
so they go red immediately.

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
