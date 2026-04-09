# Mehfil

Browser-native, local-first team chat. Single HTML file. No accounts. No central server. Messages are end-to-end encrypted, signed by the sender, and stored on the devices of workspace members — never on a central server.

> **Status: Slice 0+1+2+3+3d.3+4a+4b.1+4b.2.** Solo workspace, two-person Mode A, full Slice 3 (channels, DMs, group DMs, attachments, peer blob transfer, reactions, mentions, threads, presence), multi-peer gossip mesh with seen-set dedupe, vector clock causal delivery buffer, **plus a Yjs CRDT for workspace metadata** — workspace renames merge across peers via `workspace.patch` envelopes carrying full-state Yjs updates. See `MEHFIL-SPEC.md`, `MEHFIL-WALKTHROUGHS.md`, and `PENDING.md` for the full v1 plan.

## What works today

- Create a workspace from a fresh browser, no signup
- Send messages in `#general`, persisted as signed encrypted envelopes in IndexedDB
- Reload the page → identity unwraps, envelopes verify, messages replay (event sourcing)
- Backup nag fires 3 seconds after the first message
- Identity backup → passphrase → downloadable `.mehfil-key` file (PBKDF2 600k → AES-GCM)
- Empty-state hint with "send yourself a message" link that creates a real envelope
- Workspace launcher remembers your workspaces across reloads
- Multiple workspaces per browser, each in its own IndexedDB
- **Invite a second person** via copy-link (remote) or QR code (in the same room)
- **Fingerprint + trust card verification** on the join screen, unskippable, same-sized buttons
- **Joiner enters name + picks avatar color** from an 8-hue palette
- **WebRTC peer-to-peer** via Cloudflare STUN (one-shot ICE gather, no signaling server)
- **Live messages** deliver in <300ms between peers with single-check → double-check states
- **History backfill** — the joiner automatically receives all prior channel history over the data channel
- **Multiple public channels** — create new channels from the sidebar `+` button, each with its own AES-256 key wrapped under the workspace root key, per-channel message history and drafts
- **Edit + delete your own messages** — hover to reveal ✎ / 🗑 buttons, inline Enter-to-commit edit, Escape-to-cancel
- **Per-channel drafts** — typed-but-unsent text persists in IndexedDB per channel, survives page reload
- **Byte-exact envelope padding** — every envelope lands on an exact 1KB boundary (≤16KB) or 16KB boundary (>16KB) via closed-form msgpack math, for traffic-analysis resistance
- **Private channels (WT-14)** — invisible to non-members, channel key wrapped per-member via X25519 ECDH → AES-GCM. Create from the `+` modal with a Private toggle and a member picker; lock icon marks them in the sidebar
- **1:1 direct messages (WT-15)** — click a member in the sidebar to start a DM. Channel id is deterministically derived from the sorted pair of user IDs; the key is derived via ECDH, no key distribution, no coordination. DMs materialize the moment either party sends the first message
- **Backup file v2** — identity backup now includes BOTH the Ed25519 signing key and the X25519 ECDH key in a single passphrase-wrapped blob. Old v1 backups (Ed25519 only) still restore, with a warning that past DMs / private channels are unrecoverable
- **Restore from backup** — the "I have a backup file" button on the landing page finally works: pick a `.mehfil-key` file, enter the passphrase, identity is reinstated with a sign-and-verify sanity check
- **Group DMs (WT-16)** — click "+ Start group DM" in the sidebar, pick 2+ people, land in a group conversation. Implemented as multi-member private channels with `dm: true` on the envelope; full sender-keys ratcheting is deferred to v1.1 (see `PROTOCOL.md §15`)
- **File attachments (WT-17)** — paperclip button in the composer + drag-and-drop anywhere in the channel view. Each file gets a fresh AES-256 per-blob key, ciphertext stored in the Origin Private File System at `mehfil_<ws>/<blob_id>`, per-blob key travels inside the signed + channel-encrypted `attachment.ref` envelope. Images render inline; other files render as click-to-download cards. 25MB hard cap per file.
- **Peer-to-peer blob transfer (Slice 3c.1)** — chunked ciphertext delivery over the existing WebRTC data channel. 14 KB chunks (sized to stay inside the ~16 KB silent-drop limit after msgpack framing overhead). Small images ≤1 MB auto-fetch on envelope receipt; larger files and non-image types become click-to-download cards with a "downloading %" progress indicator. Receivers write the ciphertext to their own OPFS at the same blob_id as the sender, so both sides decrypt symmetrically
- **Emoji reactions (Slice 3d.1)** — hover to reveal 😊, pick from 8 curated emoji (`👍 ❤️ 😂 😮 😢 🙏 👀 ✅`), click a pill to toggle your own reaction on/off. Observed-remove set semantics per `(user_id, emoji)` so removals only affect the remover's copy
- **@mentions (Slice 3d.1)** — type `@` to see the autocomplete popup, keyboard navigate with arrows, Tab/Enter to accept. Matched names render with the member's avatar color; mentions of yourself get an accent fill. The signed `mentions` field travels inside the `message.create` envelope as the canonical truth
- **Global Escape cancels modals** — one handler covers reaction picker, backup, settings, invite, create channel, group DM, restore, and the thread panel (walks back through nested UI layers one per press). Inline edit also sanitizes paste so rich-HTML clipboard content inserts as plain text
- **Threaded messages (Slice 3d.2)** — click 💬 on any message to open a thread side panel. Replies carry a `thread: <parent_id>` field that points to the ROOT parent (flat threading, no nested trees). The main channel view filters out replies and shows a "💬 N replies" pill on parents that have at least one reply. Reply counts are derived on render (no CRDT counter needed). Deleted parents still show the reply chain with a "(parent message not available)" stub
- **Presence (Slice 3d.3)** — ephemeral `presence.update` envelopes (signed + encrypted but never persisted to the envelopes store) broadcast every 30 seconds while focused, transition to "away" on `window.blur`, best-effort "offline" on `beforeunload`. Status dots overlay the avatar in the sidebar People section — green/yellow/grey for online/away/offline. A 30-second stale sweep flips any peer silent for >90 seconds to "offline". Hover the row for a relative "last seen N m ago" tooltip
- **Multi-peer gossip mesh (Slice 4a)** — `PeerMgr` now supports many peers per workspace via `Map<wsId, Map<peer_id, transport>>`. Every non-ephemeral envelope is rebroadcast to all attached peers except the source on receive, so messages propagate across a partial mesh (e.g. A↔B and B↔C will deliver an A-originated message to C without a direct A↔C link). A 10K-entry `SeenSet` LRU (backed by the IndexedDB `seen_set` store from Slice 0) drops duplicate envelopes at the framing layer before they reach the dispatch pipeline — loop-killing in one hop. New `gossip.peer_announce` envelope fired by `PeerMgr.attach` so peers 2+ hops away learn about new arrivals through gossip
- **Vector clock causal delivery (Slice 4b.1)** — envelopes carrying `lc: [[user_id, counter], ...]` are checked against a per-(sender, device) high-water-mark on arrival. If counter is more than hwm+1, the envelope is held in a per-bundle `causalBuffer` until the gap closes. Transitive drain releases chains (m3 releases m4 releases m5). Persist-first rule: envelopes hit IDB BEFORE the causal check, so buffered envelopes survive a shutdown mid-buffer and rehydrate from `Workspace.open`'s replay on next boot
- **Yjs workspace doc (Slice 4b.2)** — workspace metadata (name, channels, members, settings) lives in a Yjs CRDT lazy-loaded from esm.sh. New `workspace.patch` envelope type carries full-state Yjs update bytes between peers. The `WorkspaceDoc` wrapper module exposes named methods (`setName`, `addChannel`, `addMember`, etc.) so application code never touches `Y.Doc` directly. Settings → Rename workspace fully wired as the proof-of-concept mutation; channel and member mutations migrate to the Yjs path in Slice 5

## Trying the two-person flow

The simplest way to exercise Slice 2 is two browser windows side-by-side:

1. In window 1, create a workspace ("Acme"), send a message.
2. Click the "+ Invite someone" link in the sidebar.
3. The "They're remote" tab shows a shareable URL. Copy it.
4. In window 2 (different browser or incognito), paste the URL.
5. Verify the fingerprint matches between the two screens (they should be identical). Click "The fingerprint matches".
6. Enter a name, pick a color, click Join.
7. Window 2 shows a reply URL. Copy it and paste into window 1's "paste their reply here" field, click Accept.
8. Both sides enter the workspace. The corner badge turns 🟢 Live. The history (including the message from step 1) appears on window 2. Send a message from either side — it arrives on the other in real time.

> **Important:** the handshake needs BOTH URLs exchanged. A common mistake is to copy the first URL, paste it in window 2, and then wait — the connection won't complete until window 2's reply URL is pasted back into window 1.

### Dev shortcut: `?as=` namespacing

Two real browser tabs work but are slow to set up. For faster iteration, append `?as=<label>` to the URL: this prefixes every IndexedDB and OPFS path with `as<label>_`, letting you run multiple distinct identities in tabs of the same browser at the same origin. `http://localhost:8103/?as=bose#join=...` opens a fresh "Bose" world that doesn't collide with the default tab. Production paths (no query string) are unaffected. The same flag combined with `?debug=1` exposes every internal module on `window.__mehfil` for direct testing — see PROTOCOL.md and CONV.md for the convention.

## What does NOT work yet

| Slice | Walkthroughs | Status |
|---|---|---|
| 0 — Protocol skeleton | — | ✅ done |
| 1 — Solo workspace | WT-01, WT-02, WT-03 | ✅ done |
| 2 — Two-person Mode A | WT-04, WT-05, WT-07, WT-08 | ✅ done |
| 3a — Public channels + edit/delete/drafts | WT-13 (partial) | ✅ done |
| 3b — X25519 + private channels + 1:1 DMs | WT-14, WT-15 | ✅ done |
| 3c — Group DMs + attachments | WT-16, WT-17 | ✅ done |
| 3c.1 — Peer-to-peer blob transfer | — (part of WT-17) | ✅ done |
| 3d.1 — Reactions + @mentions + polish | WT-20 (partial) | ✅ done |
| 3d.2 — Threads (side panel, flat threading) | — | ✅ done |
| 3d.3 — Presence | — | ✅ done |
| 4a — Multi-peer mesh + seen-set + rebroadcast | — (foundation for WT-09) | ✅ done |
| 4b.1 — Vector clock causal delivery buffer | — | ✅ done |
| 4b.2 — Yjs workspace doc + WorkspaceDoc wrapper | — | ✅ done |
| 4c — Gap detection UI + resync | WT-31 | ⏳ next |
| 4 — Gossip Mode B | WT-09, 31 | — |
| 5 — Search + admin | WT-18–22, 33 | — |
| 6 — Tier UX | WT-10, 35 | — |
| 7 — Relay (Cloudflare) | WT-06, 21 | separate repo |
| 8 — Bridge (Go) | WT-11, 32 | separate repo |

## Run it

```sh
cd Mehfil
python3 -m http.server 8103
# open http://localhost:8103
```

Or just open `index.html` directly in a recent Chrome / Firefox / Safari. Anything supporting Web Crypto Ed25519 (Chrome 113+, Firefox 130+, Safari 17+).

## Architecture in one paragraph

`index.html` is the entire app. Vanilla JS, no framework, no build step. Web Crypto only — Ed25519 for signing, X25519 for key exchange (used in later slices), AES-256-GCM for encryption, PBKDF2 for at-rest passphrase wrap. Custom canonical MessagePack codec inlined (no external lib — the npm package doesn't guarantee canonical encoding). IndexedDB stores per spec §9.1: `envelopes` is the source of truth, everything else is a projection rebuilt by replay. State is a single object; render is a pure function of state.

## Documents

- `MEHFIL-SPEC.md` — v1 specification (the source of truth for what the protocol does)
- `MEHFIL-WALKTHROUGHS.md` — 35 testable user-flow scenarios across 8 phases
- `PROTOCOL.md` — pinned implementation choices (canonical msgpack rules, envelope canonical form, padding, ID formats, storage layout, backup file format, invite fragment layout, WebRTC handshake)
- `PENDING.md` — everything deferred, every known bug, every upcoming slice, every open decision. The single source of truth for "what's left to do" — update it at the moment something gets deferred, never later

## Author

[@NakliTechie](https://naklitechie.github.io)
