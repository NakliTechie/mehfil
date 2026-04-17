# Mehfil

Browser-native, local-first team chat. Single HTML file. No accounts. No central server. Messages are end-to-end encrypted, signed by the sender, and stored on the devices of workspace members — never in the cloud.

> **Status:** v2 + Slack-benchmark feature parity shipped (unread state, notifications, pins, slash commands, ⌘K switcher, permalinks, keyboard shortcuts, custom status, announcement channels, user groups). Canvas next.

## What works

**Messaging core**
- Create a workspace from a fresh browser, no signup
- `#general` is auto-created; add more with the `+` button
- Public and private channels (per-member ECDH key wrapping)
- 1:1 DMs (deterministic channel id) and group DMs (per-sender keys)
- Edit + delete your own messages (hover ✎ / 🗑)
- Per-channel drafts persist across reloads
- Threaded replies, @mentions with autocomplete, 8 emoji reactions (`👍 ❤️ 😂 😮 😢 🙏 👀 ✅`)
- File attachments up to 25 MB (encrypted in OPFS, chunked over WebRTC, 500 MB per-workspace quota)
- Message bodies rendered as plain text — all output escaped, no raw HTML, `@mentions` wrapped only when their user id is in the envelope's signed mentions list

**Attention**
- Unread state — sidebar badges + bold channel names, purple `@N` mention badge, "New" divider in the message list, scroll-to-divider on channel entry
- Browser notifications (foreground tab only — no push server) with per-channel mute + workspace-wide Do Not Disturb; @mentions always break through
- Pin any message to its channel (📌 hover); channel-header pill opens the pins list with Jump-to + Unpin

**Navigation**
- ⌘K quick switcher — unified palette for channels, DMs, and members (type to filter, Enter to jump; members without an existing DM show as "Start a DM")
- ⌘⇧F — message search across every workspace you've joined (MiniSearch, `from:name` / `in:#channel` filters)
- Clickable message timestamps copy `#msg/<ws>/<ch>/<msgId>` deep links; pasting one opens the workspace, switches channel, scrolls to the message, and flashes it
- Forward any message to another channel (📨 hover) — target composer is prefilled as an attributed blockquote, author reviews before sending
- Keyboard shortcuts: `⌘K` switcher · `⌘⇧F` search · `⌘⇧P` pins · `⌘⇧M` mute · `⌘⇧D` DND · `⌘,` settings · `⌘T` back to workspace picker · `⌘1–9` switch workspace · `↑` edit last · `?` or `⌘/` for the full list

**Slash commands**
- `/me <action>`, `/shrug [text]`, `/dm @name`, `/goto #channel`, `/topic <text>`, `/mute`, `/unmute`, `/dnd [on|off]`, `/pins`, `/invite`, `/call` (aka `/huddle`), `/search [q]`, `/help`
- Autocomplete picker with Tab-to-accept; unknown commands flash an inline error instead of sending

**People + admin**
- Custom status (emoji + text) with preset picker; broadcast on `presence.update`, visible in the People sidebar and on tooltip
- Channel topics — `/topic <text>` or the create-channel form; renders next to the channel name, syncs to every member live via `workspace.patch`
- Announcement channels (📢) — admins-only posting; non-admins see a read-only banner; receive-side filter drops non-admin messages so forgery is cheap to defend
- User groups — named sets of members (Settings → Admin). `@groupname` expands to notify every group member and renders as an accent pill
- Member removal with full workspace + channel rekey
- Promote-by-consensus (2-of-N admin co-signature); role badges on the People sidebar; ★ Propose-as-admin on any member row
- Export / import workspace as an encrypted `.workspace` file

**Security**
- Ed25519 signing + X25519 ECDH + AES-256-GCM, all via native Web Crypto — no external crypto libs
- Every envelope is signed and padded to an exact 1 KB boundary; metadata-minimizing by design
- Unskippable fingerprint + trust-card verification on every invite
- Bridge fingerprint pinned in the workspace doc; mismatches refuse to connect

**Multi-device identity**
- One Ed25519 identity, any number of devices
- Pair a new device with a 6-word code — works in-room or remotely over the relay
- Device list in Settings → Devices with last-seen timestamps
- Any device (or any admin) can revoke a device; revoked device is shown a clear notice and its keys are wiped
- Identity backup → passphrase → downloadable `.mehfil-key` file (PBKDF2-600k → AES-GCM); restore on the landing page

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

## Multi-office federation

Run `BRIDGE_NAME="NYC" RELAY_URL=... mehfil-bridge` in each office; bridges sync through the shared relay. The People sidebar groups members by office, and the corner badge distinguishes "🟢 Live via WebRTC" from "🟡 Via relay" from "🔴 Offline".

## Upcoming

- **Canvas** — Yjs collaborative doc as a first-class channel type

## Architecture

`index.html` is the entire app — markup, styles, and ~12,800 lines of vanilla JS, no framework, no build step. Web Crypto only. Custom canonical MessagePack codec (no external lib — ~250 lines of hand-rolled encode/decode, verified with 18 self-test vectors on every boot). IndexedDB per spec §9.1: `envelopes` is the source of truth, everything else is a projection rebuilt on replay. State is a single object; render is a pure function of state. Yjs (lazy-loaded from esm.sh) handles workspace metadata CRDT — channel list, member roles, pinned messages, user groups, and channel topics all live in one Y.Doc that syncs via `workspace.patch` envelopes.

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
