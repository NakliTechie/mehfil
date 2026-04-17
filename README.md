# Mehfil

Browser-native, local-first team chat. Single HTML file. No accounts. No central server. Messages are end-to-end encrypted, signed by the sender, and stored on the devices of workspace members — never in the cloud.

> **Status: v2 in progress.** Multi-office bridge federation and huddles (WebRTC audio mesh) shipped. Canvas up next.

## What works

**Messaging**
- Create a workspace from a fresh browser, no signup
- `#general` channel is created automatically; add more with the `+` button
- Private channels (per-member ECDH key wrapping) and public channels
- 1:1 DMs — click any member in the People sidebar; channel id is deterministically derived
- Group DMs — "+ Start group DM" in the sidebar, pick 2+ members; per-sender keys so removing a member only retires their key
- Edit + delete your own messages (hover to reveal ✎ / 🗑)
- Per-channel drafts persist across page reloads
- Emoji reactions (`👍 ❤️ 😂 😮 😢 🙏 👀 ✅`), @mentions with autocomplete, threaded replies
- File attachments up to 25 MB (encrypted in OPFS, chunked over WebRTC, 500 MB per-workspace quota)
- Unread state — sidebar badges + bold channel names, `@N` mention badge, "New" divider in the message list, scroll-to-divider on channel open
- Browser notifications (foreground tab only — no push server) with per-channel mute + workspace-wide Do Not Disturb; @mentions always break through
- Pin any message to its channel (📌 hover action); pinned messages listed in a channel-header pill with jump-to
- Slash commands with autocomplete — `/me`, `/shrug`, `/dm @name`, `/goto #name`, `/mute`, `/unmute`, `/dnd [on|off]`, `/pins`, `/invite`, `/call` (aka `/huddle`), `/search [q]`, `/topic <text>`, `/help`. Channel topics render next to the channel name.
- ⌘K quick switcher — unified palette for channels, DMs, and members (type to filter, Enter to jump). Message search moved to ⌘⇧F.
- Clickable message timestamps copy a `#msg/<ws>/<ch>/<msgId>` deep link; pasting one opens the workspace, switches channel, scrolls to the message, and flashes it.
- Forward any message to another channel (📨 hover action) — the target channel's composer is prefilled as a blockquote attributed to the author; author reviews before sending.
- Keyboard shortcuts: `⌘K` switcher · `⌘⇧F` search · `⌘⇧P` pins · `⌘⇧M` mute · `⌘⇧D` DND · `⌘,` settings · `↑` edit last · `?` or `⌘/` for the full list.

**Security**
- Ed25519 signing + X25519 ECDH + AES-256-GCM, all via native Web Crypto
- Every envelope is signed and padded to an exact 1 KB boundary
- Unskippable fingerprint + trust-card verification on every invite

**Multi-device identity**
- One Ed25519 identity, any number of devices
- Pair a new device with a 6-word code — works in-room or remotely over the relay
- Device list in Settings → Devices with last-seen timestamps
- Any device (or any admin) can revoke a device; revoked device is shown a clear notice and its keys are wiped

**Huddles**
- 🎙 button in sidebar starts a live audio call — WebRTC mesh, no server
- Anyone online can join; audio is encrypted under the workspace key
- Speaking rings animate on active microphones; mute toggle; leave at any time

**Networking**
- WebRTC peer-to-peer via Cloudflare STUN (no signaling server for 1:1)
- Multi-peer gossip mesh with seen-set dedupe and rebroadcast
- Vector clock causal delivery buffer; gap detection + resync
- **Cloudflare Workers relay** — store-and-forward over the internet; async delivery; hosts pairing codes
- **LAN bridge** (`mehfil-bridge` Go binary) — 24h buffer on your local network, mDNS auto-discovery, fingerprint pinning
- "Join by code" — 6-word pairing code, no URL needed, valid 5 minutes

**Admin**
- Member removal with full workspace + channel rekey
- Promote-by-consensus (2-of-N admin co-signature); role badges on the People sidebar
- ★ Propose-as-admin button on any member row (visible to admins and owners)
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

**New here?** The [User Guide](guide/index.html) walks through every feature with screenshots — also accessible via the `?` button on the landing page or **Guide ↗** in Settings.

## Two-person quickstart

1. Window 1: create a workspace, send a message, click "+ Invite someone".
2. Copy the URL from the "They're remote" tab.
3. Window 2 (different browser or incognito): paste the URL.
4. Both sides confirm the fingerprint matches. Click "The fingerprint matches".
5. Window 2 enters name + color, clicks Join. A reply URL appears — copy it.
6. Window 1: paste the reply URL, click Accept. Corner badge turns 🟢 **Live**.
7. History from Window 1 backfills to Window 2. Messages flow in real time.

> Both URLs must be exchanged. The handshake is two-way.

## Relay — store-and-forward over the internet

The **Mehfil Relay** is an optional Cloudflare Workers service. Deploy your own in five minutes:

```bash
git clone https://github.com/NakliTechie/mehfil-relay
cd mehfil-relay
wrangler kv namespace create MEHFIL_KV   # paste the id into wrangler.toml
wrangler secret put MEHFIL_TOKEN         # choose a long random bearer token
wrangler deploy
```

Once deployed, add the relay URL + token in **Settings → Workspace → Relays → + Add relay**. Mehfil immediately starts pushing outgoing envelopes to the relay and polling for missed ones. Other workspace members who have the same relay configured will receive messages even when you're not simultaneously online.

What the relay does:
- Stores encrypted envelopes for **90 days** (1 KB each, padded)
- Lets devices poll for missed messages on reconnect
- Hosts **pairing codes** — the "Join by code" and "Add this device" flows both use relay slots

What the relay never does: hold keys, decrypt messages, or identify users. It sees only padded ciphertext addressed to a workspace id.

Full setup guide including cost estimate and self-hosted alternative: [docs/relay-setup.md](docs/relay-setup.md).

## Bridge — 24-hour buffer on your LAN

The **Mehfil Bridge** (`mehfil-bridge`) is a small Go binary you run on any always-on machine — a desktop, home server, or Raspberry Pi. It buffers messages for devices that aren't online at the same time, without involving any cloud service.

```bash
# macOS (Homebrew)
brew install naklitechie/tap/mehfil-bridge
mehfil-bridge
# prints: Bridge fingerprint: a3f8 92c1 5b04 e7d2
```

On first connect Mehfil fetches the bridge's Ed25519 fingerprint and asks you to compare it to the one printed in your terminal. The fingerprint is then pinned — if it ever changes (e.g. a rogue device on your LAN), Mehfil refuses to connect.

What the bridge does:
- Announces itself via **mDNS** (`_mehfil._tcp.local`, port 8765) — Mehfil finds it automatically
- Buffers the last **24 hours** of workspace envelopes in memory (nothing on disk)
- Exposes the same `/ws/:id/envelopes` HTTP API as the relay, so the same client transport works for both

Add it in **Settings → Workspace → LAN Bridge → + Add bridge**, then click **Auto-detect**. The tier escalation banner is suppressed once a bridge is configured.

Full setup guide including background service configs (launchd / systemd): [docs/bridge-setup.md](docs/bridge-setup.md).

## Dev: `?as=` namespace isolation

Append `?as=<label>` to prefix every IndexedDB and OPFS path with `as<label>_`, giving you multiple isolated identities in the same browser at the same origin:

```
http://localhost:8103/?as=bose#join=...
```

Production paths (no `?as=`) are unaffected. Combine with `?debug=1` to expose every internal module on `window.__mehfil` for loopback tests — see `PROTOCOL.md §dev` for the convention.

## What's new in v2

- **Multi-office bridge federation** — run `BRIDGE_NAME="NYC" RELAY_URL=... mehfil-bridge` in each office; bridges sync through the relay. People sidebar groups members by office.
- **Huddles** — 🎙 button in the sidebar footer starts a live audio call. Anyone online can join; audio is WebRTC peer-to-peer, encrypted under the workspace key. Speaking rings animate on active mics.

## Upcoming

- **Canvas** — Yjs collaborative doc as a first-class channel type

## Architecture

`index.html` is the entire app — markup, styles, and ~10,600 lines of vanilla JS, no framework, no build step. Web Crypto only. Custom canonical MessagePack codec (no external lib). IndexedDB per spec §9.1: `envelopes` is the source of truth, everything else is a projection rebuilt on replay. State is a single object; render is a pure function of state. Yjs (lazy-loaded from esm.sh) handles workspace metadata CRDT.

Two companion services live in separate repos:

| Repo | Language | Purpose |
|---|---|---|
| [`mehfil-relay`](https://github.com/NakliTechie/mehfil-relay) | JS / Cloudflare Workers | Store-and-forward relay + pairing endpoint |
| [`mehfil-bridge`](https://github.com/NakliTechie/mehfil-bridge) | Go | LAN buffer + mDNS discovery + WebRTC signaling |

## Documents

| File | Purpose |
|---|---|
| `guide/index.html` | **User guide** — feature walkthroughs with screenshots, mobile guide |
| `MEHFIL-SPEC.md` | v1 specification — the authoritative protocol description |
| `MEHFIL-WALKTHROUGHS.md` | 35 testable user-flow scenarios across 8 phases |
| `PROTOCOL.md` | Pinned implementation choices (msgpack, envelope format, key hierarchy, etc.) |
| `SECURITY.md` | Threat model, cryptographic primitives, vulnerability reporting |
| `docs/relay-setup.md` | How to deploy the Cloudflare Workers relay |
| `docs/bridge-setup.md` | How to install and run the LAN bridge |

## Author

[@NakliTechie](https://naklitechie.github.io)
