# Mehfil

Browser-native, local-first team chat. Single HTML file. No accounts. No central server. Messages are end-to-end encrypted, signed by the sender, and stored on the devices of workspace members — never on a central server.

> **Status: v1 feature-complete.** All 8 slices shipped: protocol skeleton, solo + two-person workspaces, channels/DMs/attachments/reactions/threads/presence, multi-peer gossip mesh, causal delivery, Yjs workspace doc, search + admin, tier-aware UX, Cloudflare relay, and LAN bridge. See [PENDING.md](PENDING.md) for what's deferred to v1.1.

## What works

**Messaging**
- Create a workspace from a fresh browser, no signup
- `#general` channel is created automatically; add more with the `+` button
- Private channels (per-member ECDH key wrapping) and public channels
- 1:1 DMs — click any member in the People sidebar; channel id is deterministically derived
- Group DMs — "+ Start group DM" in the sidebar, pick 2+ members
- Edit + delete your own messages (hover to reveal ✎ / 🗑)
- Per-channel drafts persist across page reloads
- Emoji reactions (`👍 ❤️ 😂 😮 😢 🙏 👀 ✅`), @mentions with autocomplete, threaded replies
- File attachments up to 25 MB (encrypted in OPFS, chunked over WebRTC, 500 MB per-workspace quota with LRU eviction)

**Security**
- Ed25519 signing + X25519 ECDH + AES-256-GCM, all via native Web Crypto
- Every envelope is signed and padded to an exact 1 KB boundary
- Unskippable fingerprint + trust-card verification on every invite

**Networking**
- WebRTC peer-to-peer via Cloudflare STUN (no signaling server for 1:1)
- Multi-peer gossip mesh with seen-set dedupe and rebroadcast (Mode B)
- Vector clock causal delivery buffer; gap detection + resync
- **Cloudflare Workers relay** — store-and-forward for async / cross-internet delivery (see [docs/relay-setup.md](docs/relay-setup.md))
- **LAN bridge** (`mehfil-bridge` Go binary) — 24h buffer on your local network, mDNS auto-discovery, fingerprint pinning (see [docs/bridge-setup.md](docs/bridge-setup.md))
- "Join by code" invite — 6-word pairing code, no URL needed, valid 5 minutes

**Admin**
- Member removal with full workspace + channel rekey
- Promote-by-consensus (2-of-N admin co-signature)
- Workspace-wide search (MiniSearch, `from:name` / `in:#channel` filters)
- Export / import workspace as an encrypted `.workspace` file
- Relay config propagates to peers via `workspace.patch`

**Identity**
- Identity backup → passphrase → downloadable `.mehfil-key` file (PBKDF2-600k → AES-GCM)
- Restore from backup — "I have a backup file" on the landing page

## Run it

```sh
cd Mehfil
python3 -m http.server 8103
# open http://localhost:8103
```

Or open `index.html` directly. Requires Web Crypto Ed25519: Chrome 113+, Firefox 130+, Safari 17+.

## Two-person quickstart

1. Window 1: create a workspace, send a message, click "+ Invite someone".
2. Copy the URL from the "They're remote" tab.
3. Window 2 (different browser or incognito): paste the URL.
4. Both sides confirm the fingerprint matches. Click "The fingerprint matches".
5. Window 2 enters name + color, clicks Join. A reply URL appears — copy it.
6. Window 1: paste the reply URL, click Accept. Corner badge turns 🟢 **Live**.
7. History from Window 1 backfills to Window 2. Messages flow in real time.

> Both URLs must be exchanged. The handshake is two-way.

## Dev: `?as=` namespace isolation

Append `?as=<label>` to prefix every IndexedDB and OPFS path with `as<label>_`, giving you multiple isolated identities in the same browser at the same origin:

```
http://localhost:8103/?as=bose#join=...
```

Production paths (no `?as=`) are unaffected. Combine with `?debug=1` to expose every internal module on `window.__mehfil` for loopback tests — see `PROTOCOL.md §dev` for the convention.

## Add a relay or bridge

For workspaces that need to stay in sync across the internet or between devices that aren't simultaneously online:

- **Relay** (cloud, cross-internet): [docs/relay-setup.md](docs/relay-setup.md)
- **Bridge** (LAN, no cloud): [docs/bridge-setup.md](docs/bridge-setup.md)

## Slice history

| Slice | Walkthroughs | Status |
|---|---|---|
| 0 — Protocol skeleton | — | ✅ |
| 1 — Solo workspace | WT-01, 02, 03 | ✅ |
| 2 — Two-person Mode A | WT-04, 05, 07, 08 | ✅ |
| 3 — Channels, DMs, attachments, reactions, threads, presence | WT-13–17, 20 | ✅ |
| 4 — Gossip mesh, causal delivery, Yjs doc, gap detection | WT-09, 31 | ✅ |
| 5 — Search + admin (member removal, rekey, promote, export) | WT-18, 19, 21–23, 33, 34 | ✅ |
| 6 — Tier-aware UX, workspace launcher, search filters | WT-10, 29, 30, 35 | ✅ |
| 7 — Cloudflare relay + pairing-by-code | WT-06, 21 | ✅ |
| 8 — LAN bridge (Go binary + client integration) | WT-11, 32 | ✅ |

## Architecture

`index.html` is the entire app — markup, styles, and ~9,500 lines of vanilla JS, no framework, no build step. Web Crypto only. Custom canonical MessagePack codec (no external lib — the npm package doesn't guarantee canonical encoding). IndexedDB per spec §9.1: `envelopes` is the source of truth, everything else is a projection rebuilt on replay. State is a single object; render is a pure function of state. Yjs (lazy-loaded from esm.sh) handles workspace metadata CRDT.

## Documents

| File | Purpose |
|---|---|
| `MEHFIL-SPEC.md` | v1 specification — the authoritative protocol description |
| `MEHFIL-WALKTHROUGHS.md` | 35 testable user-flow scenarios across 8 phases |
| `PROTOCOL.md` | Pinned implementation choices (msgpack, envelope format, key hierarchy, etc.) |
| `PENDING.md` | All deferred items, open bugs, v1.1 backlog |
| `SECURITY.md` | Threat model, cryptographic primitives, vulnerability reporting |
| `docs/relay-setup.md` | How to deploy the Cloudflare Workers relay |
| `docs/bridge-setup.md` | How to install and run the LAN bridge |

## Author

[@NakliTechie](https://naklitechie.github.io)
