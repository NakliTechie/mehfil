# Mehfil — Architecture & Tech Deep Dive

How Mehfil is built, from the single-file shell down to the transport layers. For the
user-facing feature tour see [features.md](features.md). This document is a narrative
overview; the authoritative, version-locked details live in
[`../MEHFIL-SPEC.md`](../MEHFIL-SPEC.md) (protocol), [`../PROTOCOL.md`](../PROTOCOL.md)
(pinned implementation choices), and [`../SECURITY.md`](../SECURITY.md) (threat model).

---

## One file, no build

`index.html` is the entire app — markup, styles, and ~15,500 lines of vanilla JS, no
framework, no build step, no bundler. You can open the file directly or serve it with
`python3 -m http.server`. The whole thing is ~630 KB on disk.

Design consequences of the single-file constraint:

- **No dependencies at rest.** The only third-party code is lazy-loaded *on demand* from
  two pinned CDN hosts (Yjs, markdown-it, highlight.js, MiniSearch), never bundled. A
  strict Content-Security-Policy locks `script-src` to our own origin plus those two hosts.
- **Web Crypto only for cryptography.** No crypto libraries ship in the file — Ed25519,
  X25519, and AES-256-GCM all come from the native `SubtleCrypto` API.
- **State is a single object; render is a pure function of state.** No virtual DOM, no
  reactivity framework — an explicit render pass reads the state object and paints the UI.

## Message model — event-sourced IndexedDB

Storage follows `MEHFIL-SPEC.md` §9.1: the `envelopes` object store is the **single source
of truth**, and every other store (channels, read markers, presence, etc.) is a
**projection** rebuilt by replaying envelopes. This makes the data model auditable and lets
a device reconstruct all derived state from the log alone.

Every message on the wire is a signed **envelope**:

- Encoded with a **custom canonical MessagePack codec** — no external msgpack library,
  ~250 lines of hand-rolled encode/decode, verified against 18 self-test vectors on every
  boot. Canonical encoding matters because envelopes are *signed*: two devices must produce
  byte-identical bytes for the same logical message or signatures won't verify.
- **Signed** with the sender's Ed25519 key and **padded to an exact 1 KB boundary** so
  envelope size leaks as little metadata as possible.
- Delivered through a **vector-clock causal-delivery buffer** — out-of-order envelopes are
  held until their causal predecessors arrive; gap detection triggers a resync.

## Workspace metadata — Yjs CRDT

All mutable workspace metadata — channel list, member roles, pinned messages, user groups,
channel topics, and Canvas document content — lives in **one Y.Doc** (Yjs, lazy-loaded from
esm.sh). Changes propagate as `workspace.patch` envelopes and merge conflict-free via the
CRDT.

The receive-side `workspace.patch` handler is where authorization is enforced:
admin-only fields (workspace name, relays, topics, user groups) are gated by the sender's
role, and forged mutations from non-admins **auto-revert**. Because pins, groups, and topics
are CRDT fields rather than bespoke envelope types, they sync for free with no new wire
format.

## Cryptography

| Use | Algorithm | Key size |
|-----|-----------|----------|
| Identity signing | Ed25519 (Web Crypto) | 256-bit |
| ECDH key agreement | X25519 (Web Crypto) | 256-bit |
| Symmetric encryption | AES-256-GCM | 256-bit |
| Key wrapping | AES-256-GCM (ECDH-derived KEK) | 256-bit |
| Identity backup | PBKDF2-SHA256, 600,000 iterations | 256-bit output |
| Pairing code KDF | PBKDF2-SHA256, 300,000 iterations | 256-bit output |
| Fingerprints | SHA-256 (first 16 bytes) | — |

Key hierarchy: each identity is one Ed25519 keypair (shared across all of a user's
devices). Each channel has its own AES-256-GCM key, **wrapped per member** via an
X25519-ECDH-derived KEK — so a private channel's key is only ever available to its members.
Removing a member triggers `workspace.rekey` + `channel.rekey`, rotating every affected key.
Mehfil does **not** ratchet keys (no per-message forward secrecy) — see
[`../SECURITY.md`](../SECURITY.md) for what that does and doesn't protect against.

## Networking

Mehfil has no central server. Peers connect and messages move through layered transports,
each optional and independently configurable:

- **WebRTC peer-to-peer** via Cloudflare STUN — direct connections, no signaling server for
  1:1. A multi-peer **gossip mesh** with seen-set dedupe and rebroadcast fans messages out
  across a workspace.
- **Cloudflare Workers relay** — store-and-forward over the internet for async delivery
  when peers aren't online together; also hosts pairing codes. Stores encrypted, padded
  envelopes for 90 days; never holds keys, never decrypts, sees only ciphertext addressed to
  a workspace id. Setup: [relay-setup.md](relay-setup.md).
- **LAN bridge** (`mehfil-bridge`, a small Go binary) — a 24-hour in-memory buffer on your
  local network with mDNS auto-discovery (`_mehfil._tcp.local`, port 8765) and Ed25519
  fingerprint pinning. Exposes the same `/ws/:id/envelopes` HTTP API as the relay, so the
  client transport is identical. Setup: [bridge-setup.md](bridge-setup.md).
- **Join by code** — a 6-word pairing code, valid 5 minutes, that works with no URL exchange.

### Companion services (separate repos)

| Repo | Language | Purpose |
|---|---|---|
| [`mehfil-relay`](https://github.com/NakliTechie/mehfil-relay) | JS / Cloudflare Workers | Store-and-forward relay + pairing endpoint |
| [`mehfil-bridge`](https://github.com/NakliTechie/mehfil-bridge) | Go | LAN buffer + mDNS discovery |

### Multi-office federation

Run `BRIDGE_NAME="NYC" RELAY_URL=... mehfil-bridge` in each office; bridges sync through the
shared relay. The People sidebar groups members by office, and the corner badge distinguishes
"🟢 Live via WebRTC" from "🟡 Via relay" from "🔴 Offline".

## PWA & offline shell

Mehfil ships a web app manifest + a tiny service worker (`sw.js`) that caches the static
shell. The browser's install prompt (⊕ in Chrome's address bar, **Share → Add to Home
Screen** in Safari) turns it into a standalone app. The shell loads offline; messages sync
when the network returns. The service worker intentionally does **not** subscribe to push
notifications — foreground-tab notifications only, no central push service (spec §14.6).

## Testing

Open `?test=1` (e.g. `http://localhost:8103/?test=1`) to run the in-browser test suite —
no external deps, ~300 ms. It covers the core invariants: canonical MessagePack round-trips,
envelope sign+verify + tamper detection, mention parsing (members + groups + punctuation),
permalinks, unread counts, typing-indicator state, WorkspaceDoc pin/group mutations, and
Canvas binding.

The 35 end-to-end user-flow scenarios (8 phases) are documented in
[`../MEHFIL-WALKTHROUGHS.md`](../MEHFIL-WALKTHROUGHS.md).

## Dev flags

- **`?as=<label>`** — prefixes every IndexedDB and OPFS path with `as<label>_`, giving you
  multiple isolated identities in the same browser at the same origin
  (`http://localhost:8103/?as=bose#join=...`). Production paths (no `?as=`) are unaffected.
- **`?debug=1`** — exposes every internal module on `window.__mehfil` for loopback tests.
  See `PROTOCOL.md §dev` for the convention. Combines with `?as=`.

## Browser requirements

Requires Web Crypto Ed25519: **Chrome 113+, Firefox 130+, Safari 17+.**
