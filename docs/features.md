# Mehfil — Features

A complete tour of what Mehfil can do. For how it works under the hood, see
[architecture.md](architecture.md). For the authoritative protocol, see
[`../MEHFIL-SPEC.md`](../MEHFIL-SPEC.md). New users may prefer the visual
[User Guide](../guide/index.html) (feature walkthroughs with screenshots).

---

## Messaging core

- Create a workspace from a fresh browser, no signup
- `#general` is auto-created; add more with the `+` button
- Public and private channels (per-member ECDH key wrapping), plus announcement (📢) and canvas (📝) channel types
- 1:1 DMs (deterministic channel id) and group DMs (per-sender keys)
- Edit + delete your own messages (hover ✎ / 🗑)
- Per-channel drafts persist across reloads
- Threaded replies, @mentions with autocomplete, 8 emoji reactions (`👍 ❤️ 😂 😮 😢 🙏 👀 ✅`)
- File attachments up to 25 MB (encrypted in OPFS, chunked over WebRTC, 500 MB per-workspace quota)
- **Voice messages** 🎙 and **screen clips** 🎬 recorded via `MediaRecorder`, encrypted as attachments, inline `<audio>`/`<video>` players in the message list
- **Code blocks** with triple-backtick fences — ` ```js ` renders a syntax-highlighted block via lazy-loaded highlight.js
- **Polls** via `/poll question | opt A | opt B | …` — vote bars update live, one vote per user, click to change
- **Checklists** via `/checklist Title | item 1 | item 2 | …` — toggles sync to every member via `checklist.toggle` envelopes
- Message bodies rendered as plain text — all output escaped, no raw HTML, `@mentions` wrapped only when their user id is in the envelope's signed mentions list

## Canvas 📝

- Collaborative markdown documents as a channel type — typing syncs live between members via Yjs
- Diff-based textarea ↔ `Y.Text` binding with 500ms debounced `workspace.patch` broadcast
- Toggle between **Edit** and **Preview** from the channel header (markdown-it lazy-loaded from esm.sh)
- Public-only in v1 (shared workspace root key); private canvas is a follow-up

## Attention

- Unread state — sidebar badges + bold channel names, purple `@N` mention badge, "New" divider in the message list, scroll-to-divider on channel entry
- Browser notifications (foreground tab only — no push server) with per-channel mute + workspace-wide Do Not Disturb; @mentions always break through
- Typing indicators — "Alice is typing…" / "Alice and Bose are typing…" below the message list, driven by `typing.start` ephemeral envelopes
- Pin any message to its channel (📌 hover); channel-header pill opens the pins list with Jump-to + Unpin

## Navigation

- ⌘K quick switcher — unified palette for channels, DMs, and members (type to filter, Enter to jump; members without an existing DM show as "Start a DM")
- ⌘⇧F — message search across every workspace you've joined (MiniSearch, `from:name` / `in:#channel` filters)
- **💬 All threads** sidebar entry — every thread you authored, replied in, or were mentioned in, newest-reply first
- **🔖 Saved** sidebar entry — per-device bookmarks via the 🔖 hover action on any message
- **📝 Drafts** sidebar entry — every non-empty composer draft across channels, click to jump
- Clickable message timestamps copy `#msg/<ws>/<ch>/<msgId>` deep links; pasting one opens the workspace, switches channel, scrolls to the message, and flashes it
- **Timezone-aware timestamps** — tooltip shows `3:42 PM · 9:12 AM for Alice` when the author's time zone differs from yours
- Forward any message to another channel (📨 hover) — target composer is prefilled as an attributed blockquote, author reviews before sending
- Keyboard shortcuts: `⌘K` switcher · `⌘⇧F` search · `⌘⇧P` pins · `⌘⇧M` mute · `⌘⇧D` DND · `⌘,` settings · `⌘T` back to workspace picker · `⌘1–9` switch workspace · `↑` edit last · `?` or `⌘/` for the full list

## Slash commands

- **Core**: `/me`, `/shrug`, `/dm @name`, `/goto #channel`, `/topic <text>`, `/mute`, `/unmute`, `/dnd [on|off]`, `/pins`, `/invite`, `/call` (aka `/huddle`), `/search [q]`, `/help`
- **Collaboration**: `/poll question | opt A | opt B | …`, `/checklist Title | item 1 | item 2 | …`, `/send <time> <msg>` (scheduled), `/scheduled` (list queued), `/remind me in 15m|2h <text>`
- **People**: `/tz @name` (their local time), `/away [min]` (temporary status, auto-clears)
- **Utilities**: `/roll NdM`, `/flip`, `/8ball <q>`, `/hash <text>`, `/uuid`, `/base64 <text>`, `/base64d <text>`
- Autocomplete picker with Tab-to-accept; unknown commands flash an inline error instead of sending

## People + admin

- Custom status (emoji + text) with preset picker; broadcast on `presence.update`, visible in the People sidebar and on tooltip
- **Rich profile** — optional pronouns, title, timezone (Settings → Identity). Other members see them in the sidebar tooltip; timezone drives the tz-aware timestamp tooltip
- **Personal reminders** via `/remind me in 15m <text>` — stored locally, fire as a toast + Notification when due (tab-open caveat, documented honestly)
- **Scheduled send** via `/send in 15m <text>` or `/send tomorrow at 9am <text>` — queued locally, post through the normal send path when the time hits
- Channel topics — `/topic <text>` or the create-channel form; renders next to the channel name, syncs to every member live via `workspace.patch`
- Announcement channels (📢) — admins-only posting; non-admins see a read-only banner; receive-side filter drops non-admin messages so forgery is cheap to defend
- User groups — named sets of members (Settings → Admin). `@groupname` expands to notify every group member and renders as an accent pill
- Member removal with full workspace + channel rekey
- Promote-by-consensus (2-of-N admin co-signature); role badges on the People sidebar; ★ Propose-as-admin on any member row
- **Voluntary admin transfer** — unilaterally grant admin to any member ("Make admin")
- **Step down** from admin — unilateral self-demote, guarded against the last-admin case
- **Workspace rekey scheduling** — off / quarterly / yearly; banner reminds you when the schedule is due, "Rekey now" rotates the workspace + every channel key in one go
- Export / import workspace as an encrypted `.workspace` file

## Multi-device identity

- One Ed25519 identity, any number of devices
- Pair a new device with a 6-word code — works in-room or remotely over the relay
- Device list in Settings → Devices with last-seen timestamps
- Any device (or any admin) can revoke a device; revoked device is shown a clear notice and its keys are wiped
- Identity backup → passphrase → downloadable `.mehfil-key` file (PBKDF2-600k → AES-GCM); restore on the landing page

## Huddles

- 🎙 button in sidebar starts a live audio call — WebRTC mesh, no server
- Anyone online can join; audio is encrypted under the workspace key
- Speaking rings animate on active microphones; mute toggle; leave at any time
- **🖥 Live screen share** — click the screen button to share a tab, window, or the whole display. Video tracks are added to each peer connection and renegotiated; remote peers' screens render inline above the huddle bar

## Security (at a glance)

- Ed25519 signing + X25519 ECDH + AES-256-GCM, all via native Web Crypto — no external crypto libs
- Every envelope is signed and padded to an exact 1 KB boundary; metadata-minimizing by design
- Unskippable fingerprint + trust-card verification on every invite
- Bridge fingerprint pinned in the workspace doc; mismatches refuse to connect
- `workspace.patch` receive handler gates admin-only fields (name, relays, topics, user groups) by sender role — forged mutations from non-admins auto-revert
- Strict Content-Security-Policy — `script-src` locked to our own origin + the two CDN hosts we pull lazy modules from

The full threat model and cryptographic primitives table live in [`../SECURITY.md`](../SECURITY.md).

## Palette

**Settings → Identity → Appearance** has a picker for the page colorway. The default keeps the original indigo and follows your OS light/dark preference; the named palettes are pulled from the [Rangrez](https://github.com/NakliTechie/rangrez) library and pin Mehfil to a specific aesthetic regardless of system theme.

| Palette | Mood |
|---|---|
| **Indigo** _(default)_ | the original — follows OS light/dark |
| **کہوہ Kahwa** | Kashmiri saffron + cardamom + almond — the literal mehfil setting |
| **ঠাকুর Tagore** | Jorasanko whitewash, where Gitanjali was written |
| **Mumbai Art Deco** | Marine Drive at dusk — Parsi merchants' Miami |
| **خشت Khesht** | Yazd mud-brick warmth, 2,000-year-old wind towers |
| **صحراء Sahara** | Erg Chebbi dunes at golden hour |
| **Dal Lake Dusk** _(dark)_ | shikara on still water, lotus pads catching last sun |
| **شب یلدا Yalda** _(dark)_ | Persian winter solstice — Hafez, pomegranate, stay awake till dawn |

The choice is per-device (saved in `localStorage` under `mehfil:palette`) — it never leaves your browser and isn't shared with workspace members. Code blocks keep their syntax-highlight palette regardless of the chosen colorway.

## Getting connected — two-person quickstart

1. Window 1: create a workspace, send a message, click "+ Invite someone".
2. Copy the URL from the "They're remote" tab.
3. Window 2 (different browser or incognito): paste the URL.
4. Both sides confirm the fingerprint matches. Click "The fingerprint matches".
5. Window 2 enters name + color, clicks Join. A reply URL appears — copy it.
6. Window 1: paste the reply URL, click Accept. Corner badge turns 🟢 **Live**.
7. History from Window 1 backfills to Window 2. Messages flow in real time.

> Both URLs must be exchanged. The handshake is two-way.

Once two people are connected, add store-and-forward (relay or LAN bridge) so members receive
messages even when they aren't online at the same time — see
[architecture.md § Networking](architecture.md#networking) and the setup guides
([relay](relay-setup.md), [bridge](bridge-setup.md)).

### No internet at all? Scan to connect

On a phone hotspot with **no uplink** — a remote site, no cellular, no ISP — skip the URL
entirely. One person taps **+ Invite → They're in the room** (or "Scan-to-connect instead");
the other opens Mehfil on the same hotspot and taps **Join by scanning (offline)**. The two
phones scan each other's cycling QR codes camera-to-camera — that QR carries the whole WebRTC
handshake, so no link, server, or channel is needed. Works **iPhone ↔ Android** (the scanner
uses the native detector where available and a bundled software decoder on iOS; the QR
encoder is inlined too, so nothing loads from the network). The corner badge shows **🔵
Offline mesh**. (Everyone must be on the same hotspot; venue WiFi with AP client isolation blocks it —
a phone's own hotspot does not. Install Mehfil once, anywhere with signal, before you go
somewhere without it.) Full design: [`MEHFIL-OFFLINE-MESH-SPEC.md`](../MEHFIL-OFFLINE-MESH-SPEC.md).

## Roadmap

Next-up work, ranked by value-to-effort. Everything below is consistent with the local-first frame and `MEHFIL-SPEC.md` §14.6 — no bots, no workflows, no SFU, no central infrastructure.

- **S3-compatible relay adapter (v1.1)** — bring-your-own object storage. The relay-type dropdown already surfaces "S3-compatible," but the SigV4-signed HTTP isn't wired up; deferred until someone needs it.
- **Larger file attachments (v1.1)** — current cap is 25 MB. Raising it needs chunked upload with resume + streaming decrypt; deferred until a concrete use case shows up.
- **Slash integrations** (`/bofh`, `/localmind`, `/kanzen`) — wiring the slash registry into the sibling NakliTechie tools so a `/bofh sha256 <text>` in a channel returns a result inline.
- **Shamir-split identity backup (v2)** — N-of-K key shares distributed across trusted contacts as an alternative to the current passphrase-wrapped `.mehfil-key` backup.
- **Canvas polish (v1.x → v2)** — private canvas (per-channel-key-encrypted Y.Doc), remote cursor positions via Yjs awareness, and an optional rich-text editor.
- **Offline mesh — gossip-relayed signaling (v1.1, M1)** — the two-peer offline QR handshake ships today (host-only ICE, multi-frame QR, in-page scanner, 🔵 badge). M1 adds the multi-hop `signal.relay` mesh dialer so a new peer reaches the *whole* mesh from a single scan with any one member. The envelope type is reserved; the dialer lands after its 3-peer hardware gate. See `MEHFIL-OFFLINE-MESH-SPEC.md`.
- **Low-latency signaling path for huddles (v2.x)** — WebRTC signaling for huddles currently rides on the regular envelope path (~3 s per round-trip on the bridge). Fine for 1:1 and small groups; if group huddles need sub-second connection setup, a dedicated thin WebSocket signaling endpoint comes back. See `MEHFIL-SPEC.md` §7.1.

The authoritative version-locked list (with shipped markers and a "Never" rule-out section) is `MEHFIL-SPEC.md` §14.
