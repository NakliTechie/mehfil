# Mehfil — v1 Specification

**Browser-native, local-first team chat. Single HTML file. No accounts. No central server.**

Author: Chirag Patnaik (@NakliTechie) · NakliTechie portfolio
Status: v1 spec, ready for engineering review
Audience: coding agents + a human engineer reviewing the protocol layer

---

## 0. One-paragraph pitch

Mehfil is browser-native team chat that runs as a single HTML file. Messages are end-to-end encrypted, signed by the sender, and stored on the devices of workspace members — never on a central server. Inside an office, clients discover each other via a small bridge helper or via direct peer gossip and exchange messages directly over WebRTC. Across the open internet, clients sync via a Bring-Your-Own-Key relay (Cloudflare R2, S3-compatible, or self-hosted). The relay sees only ciphertext. A 50-person team that today pays four to five figures a year for hosted team chat can run Mehfil for $0 with strictly better privacy and full data ownership.

---

## 1. Design principles

1. **Local-first.** Every device has a complete replica. Anything that requires a server to function is wrong by default.
2. **Honest about limits.** Real-time inside the office; async outside. Surfaced in UI, not hidden.
3. **One envelope shape.** Every wire object is the same signed envelope, decrypted at the edge.
4. **Pluggable transport.** Gossip, bridge-assisted LAN, BYOK relay — all speak the same envelope protocol.
5. **No vendor trust roots.** Identity is a keypair. Trust is established by fingerprint verification.
6. **Composable with the portfolio.** VoiceVault, screen recorder, LocalMind, BOFH plug in as message types.
7. **Distribution surface is a URL, not an app store.** No gatekeeper between user and tool.
8. **Tiered behavior.** A 2-person workspace and a 50-person workspace are not the same product. The client adapts to size.
9. **Ship narrowly.** v1 targets ≤50-person workspaces. Anything that breaks at 200 is a v2 problem.

---

## 2. Cryptographic primitives

All via `window.crypto.subtle`. No external crypto libs.

| Purpose | Algorithm | Notes |
|---|---|---|
| Identity signing | Ed25519 | One per human |
| Key exchange | X25519 | DM keys, member key wrapping |
| Symmetric encryption | AES-256-GCM | Fresh 96-bit nonce per envelope |
| Hashing | SHA-256 | IDs, fingerprints |
| Passphrase wrap | PBKDF2 (600k iters) → AES-GCM | At-rest key protection |

**Fingerprint format:** first 16 bytes of SHA-256(pubkey), rendered as 8 groups of 4 hex chars.

**Visual hash (trust card):** the same 16 bytes deterministically render to a small grid of 4 colored geometric shapes. This is a supplementary verification signal — when verifying out of band, users can check both the hex fingerprint and the visual card. The trust card turns verification from homework into pattern-matching and is harder to fake casually.

**RNG:** `crypto.getRandomValues` exclusively. `Math.random` is forbidden anywhere in the codebase.

---

## 3. Identifiers

| ID | Form | Length |
|---|---|---|
| `user_id` | base64url(Ed25519 pubkey) | 43 chars |
| `device_id` | base64url(random 8 bytes) | 11 chars |
| `workspace_id` | base64url(random 16 bytes) | 22 chars |
| `channel_id` | base64url(random 16 bytes) | 22 chars |
| `message_id` | base64url(SHA-256(sender ‖ ts ‖ nonce))[:16] | 22 chars |
| `pairing_code` | 6 BIP39 words | ~62 bits entropy |

All timestamps: unix milliseconds, UTC. Tolerated skew ±5 minutes.

---

## 4. The envelope

Every wire-level object is one shape, encoded as **MessagePack**.

```
{
  v:    1,                          // protocol version
  id:   <message_id>,
  ws:   <workspace_id>,
  ch:   <channel_id> | null,
  from: <user_id>,
  dev:  <device_id>,
  ts:   <unix_ms>,
  lc:   [[<user_id>, <counter>], ...],   // vector clock
  type: <string>,                   // see §4.1
  ct:   <bytes>,                    // AES-GCM ciphertext of inner payload
  n:    <bytes>,                    // 96-bit nonce
  pad:  <bytes>,                    // padding to next 1KB boundary
  sig:  <bytes>,                    // Ed25519 sig over canonical encoding
  cosigs: [{from, sig}, ...] | null // optional co-signatures (see §4.3)
}
```

**Padding is mandatory.** Constant-size envelopes flatten content-length traffic analysis. Rounded to next 1KB up to 16KB; messages above 16KB use the next 16KB boundary.

### 4.1 Envelope types

| Type | Inner payload | Notes |
|---|---|---|
| `message.create` | `{body, fmt, thread?, mentions[], attachments[]}` | The main one |
| `message.edit` | `{target, body, fmt}` | LWW by `(lc, user_id)` |
| `message.delete` | `{target}` | Tombstone |
| `reaction.add` | `{target, emoji}` | OR-Set member |
| `reaction.remove` | `{target, emoji}` | OR-Set tombstone |
| `presence.update` | `{status, custom?, until?}` | Heartbeat, ephemeral |
| `typing.start` | `{}` | LAN-only, never relayed async |
| `channel.create` | `{name, topic, private, members[]}` | Posted to workspace doc |
| `channel.rekey` | `{wrapped_keys: {user_id: ciphertext}}` | After membership change |
| `workspace.patch` | `{yjs_update}` | Yjs CRDT delta |
| `workspace.rekey` | `{wrapped_root_keys: {user_id: ciphertext}}` | Workspace-level rekey |
| `member.join` | `{profile, devices[]}` | After invite acceptance |
| `member.welcome` | `{target, workspace_doc_snapshot}` | First-member response |
| `member.remove` | `{target, reason?}` | Admin op |
| `member.promote` | `{target, role}` | Promote to admin (see §4.3) |
| `member.transfer_admin` | `{from_admin, to_member}` | Voluntary handoff (v1.1) |
| `device.add` | `{device_id, device_pubkey}` | Multi-device pairing (v1.1) |
| `device.revoke` | `{device_id}` | Lost device |
| `bridge.announce` | `{bridge_pubkey, fingerprint, url}` | LAN bootstrap |
| `attachment.ref` | `{blob_id, size, mime, key, location}` | Encrypted blob pointer |
| `gossip.peer_announce` | `{peer_pubkey, transports[]}` | Servent peer discovery |
| `gossip.resync_request` | `{channel_id, missing_lc[]}` | Gap-fill request |

### 4.2 Signature scope

`sig` covers the canonical MessagePack encoding of every field except `sig` and `cosigs`. Canonical encoding = sorted map keys, no extension types beyond what's in the spec, deterministic int encoding.

Verification is the first thing every receiver does. Failed signatures → drop, log to local quarantine, do not relay.

### 4.3 Co-signed envelopes & promote-by-consensus

Some envelope types require multiple signatures to take effect. The `cosigs` field is an array of `{from, sig}` entries from additional signers. Verifiers compute the signed payload identically; each cosignature is verified against its claimed signer.

**Threshold rules per envelope type:**

| Type | Required co-signers |
|---|---|
| `member.promote` | At least 2 distinct members (v1) or admin + 1 (v1.1) |
| `member.remove` (v1.1 multi-admin) | 2 of N admins |
| `workspace.rekey` (v1.1) | 2 of N admins |

**Promote-by-consensus mechanics (v1):**

1. Any member can draft a `member.promote` envelope nominating a new admin
2. They sign it as `from`
3. They post it to the workspace doc as a "pending promotion"
4. Other members see it in their UI and can co-sign
5. Once 2 distinct members have signed, the envelope is valid and the promotion takes effect
6. The workspace doc updates the role
7. Pending promotions expire after 7 days if they don't reach threshold

This is the recovery path for the dead-admin case in v1: if the only admin loses their key, any 2 remaining members can promote a new one.

**v1 ships single-admin by default**, but the protocol supports multiple admins from day one via this mechanism. v1.1 adds the UI for multi-admin as a first-class concept.

---

## 5. Keys & access control

### 5.1 Workspace root key
- 256-bit symmetric, generated by workspace creator
- Wrapped per-member with X25519 when invited
- Encrypts the workspace metadata document and public-channel keys

### 5.2 Channel keys
- **Public channels:** key wrapped under workspace root key
- **Private channels:** key wrapped per-member with X25519
- **DMs:** key derived via X25519 between the two parties, no wrapping
- **Group DMs:** sender-keys pattern — each sender has their own key, distributed to members on first use
- Each channel has its own key — workspace membership ≠ channel membership

### 5.3 Rekey ceremony
Triggered by:
- Member removed from workspace (rekey root + all public channels)
- Member removed from private channel (rekey that channel only)
- Scheduled rotation (recommended quarterly, not enforced)

Process:
1. Admin generates new key
2. Wraps for each remaining member
3. Posts `channel.rekey` (or `workspace.rekey`) envelope encrypted under the *old* key, containing the new wrapped keys
4. New traffic uses new key
5. Old envelopes remain decryptable to whoever had the old key — known limitation, documented loudly

### 5.4 Workspace metadata document
A Yjs document holding:
- Member list (`user_id` → profile + role + devices)
- Channel list (`channel_id` → name, type, members for private)
- Workspace settings (name, icon, retention policy)
- Bridge fingerprints (pinned per workspace)
- Relay configurations (URLs, current bearer tokens)
- Pending promotions (for §4.3 consensus flow)
- Roles (owner, admin, member, guest)
- Member count (derived; drives tier-aware UI behavior — see §12)

Encrypted with workspace root key. Every member maintains a local replica. Updates flow as `workspace.patch` envelopes carrying Yjs updates.

---

## 6. Ordering & conflict resolution

### 6.1 Vector clocks
Per channel, per `(user_id, device_id)` pair. On send:
1. Increment own counter
2. Include latest known counters from all known senders
3. Stamp envelope's `lc`

On receive:
- Buffer envelopes whose `lc` references unseen counters (causal delivery)
- Release once dependencies arrive
- Wall-clock `ts` is tiebreak only

### 6.2 Gap detection
If a client sees `lc[Bose] = 5` but has only seen Bose's 1, 2, 3, it knows it's missing #4. UI surfaces this as a "missing messages" inline banner with a "Try to fetch" button. Clicking the button posts a `gossip.resync_request` to all reachable peers.

Gap detection is the first line of defense against malicious relays withholding envelopes, and the input signal for the §12 tier-escalation prompt.

### 6.3 CRDT mapping

| State | CRDT type |
|---|---|
| Reactions | Observed-Remove Set keyed by `(user_id, emoji)` |
| Message edits | Last-Writer-Wins by `(lc, user_id)` lex |
| Deletions | Add-only tombstone set, wins over edits |
| Workspace metadata | Yjs document |
| Channel topic, pinned messages, member list | Inside Yjs doc |

Yjs is the only heavyweight dependency (~80KB). Accepted.

---

## 7. Transport layer

Above the transport, the protocol knows only about envelopes and an opaque sync cursor.

```ts
interface Transport {
  send(envelope: Envelope): Promise<void>
  subscribe(cursor: Cursor, onEnvelope: (e: Envelope) => void): Unsubscribe
  fetchSince(cursor: Cursor): AsyncIterable<Envelope>
  status(): "connected" | "degraded" | "offline"
}
```

A client runs multiple transports concurrently and dedupes by `envelope.id` via a 10K-entry seen-set (LRU).

### 7.0 Transport modes (the four supported configurations)

Mehfil supports four transport configurations. A workspace can use any of them, or any combination simultaneously. The client picks the best available path per envelope.

**Mode A: Two-person mode (zero infrastructure)**
- WebRTC peer-to-peer between exactly two endpoints
- Handshake via paste-URL or scan-QR (each side encodes its WebRTC offer/answer in a URL fragment)
- Works across the open internet via STUN
- Use case: first contact, demos, two-person teams
- Limitation: no third party can join without one of the two being online to bootstrap them

**Mode B: Gossip mode (no infrastructure, 3+ peers)**
- WebRTC mesh between all currently-online peers
- Each client is also a relay — every received envelope is forwarded to all connected peers, deduped by seen-set
- New peers bootstrap by connecting to *any* existing peer; gossip fills in the rest of the mesh
- Discovery via paste-URL or scan-QR for the first connection
- After first connection, peer discovery is automatic via `gossip.peer_announce` envelopes
- Use case: small teams (3–~10) with frequent overlap, no admin willing to install anything
- Limitation: requires temporal overlap. If members never overlap, messages don't propagate.

**Mode C: Bridge mode (LAN with helper binary)**
- `mehfil-bridge` runs on an always-on machine in the office
- Provides mDNS announce, WebRTC signaling, peer registry, 24h LAN store-forward
- Bridge sees only ciphertext
- Bridge fingerprint is pinned per workspace in the workspace doc
- Use case: office workspaces ≥6 people where async overlap is unreliable
- Combines naturally with gossip — bridge is just a "well-known peer"

**Mode D: Relay mode (BYOK cloud relay)**
- HTTP-based store-and-forward relay (Cloudflare R2 + Worker, S3-compatible, etc.)
- Relay sees only ciphertext
- Bearer token auth required
- Use case: distributed teams, async work, cross-office sync
- Combines with any other mode

**Tier-to-mode default mapping** (the client recommends, the user chooses):

| Workspace size | Recommended config |
|---|---|
| 2 people | Mode A (two-person) |
| 3–5 people | Mode B (gossip) |
| 6–~10 people | Mode B + Mode D (gossip + relay) |
| ~10+ people in one office | Mode B + Mode C + Mode D (everything) |
| ~10+ people distributed | Mode B + Mode D (gossip + relay) |

The client surfaces tier transitions (see §12).

### 7.1 LAN transport: WebRTC mesh + servent gossip + bridge

**Bridge (`mehfil-bridge`)** is a Go binary, ~200 LOC, single static file, cross-compiled per OS. Runs on any always-on machine in the office.

Bridge responsibilities:
1. **mDNS announce** as `_mehfil._tcp.local`, also serves at `mehfil.local:8765`
2. **`/signal`** WebSocket — WebRTC offer/answer/ICE relay
3. **`/peers`** REST — currently connected pubkeys
4. **`/lan-relay`** — store-and-forward last 24h of envelopes for clients that drop off
5. Has its own keypair; signs `/peers` and `/signal` responses; bridge fingerprint pinned in workspace doc

The bridge sees only signed encrypted envelopes. It cannot decrypt anything. Losing the bridge loses 24h of LAN store-forward and discovery; everything else lives on each device.

**Servent gossip layer** (also runs in Mode B without a bridge): every client is also a relay. Once two clients have a WebRTC data channel, every envelope received is forwarded to all connected peers, deduped by seen-set.

This means:
- Clients can exchange messages even if the bridge is down
- A new peer visiting from another network syncs with one peer and immediately receives the full LAN's history
- Bridge load is bounded — most traffic flows peer-to-peer

**Loop prevention:** seen-set check before forward. Envelopes are content-addressed by `id`; loops die in one hop.

### 7.2 Two-person mode (Mode A) handshake

For two-person teams or first-meeting bootstrap:
1. Asha clicks "Share my session" → her client starts a WebRTC offer, encodes it as a short URL with the offer payload in the fragment
2. Asha sends the URL to Bose by any channel (the browser's native share sheet, copy-paste, QR code shown on screen)
3. Bose opens the URL → his client generates an answer → encodes as a return URL
4. Bose sends the return URL back to Asha
5. WebRTC connection established; gossip begins

Document explicitly as "two-person mode" — the floor for first-touch and small teams, not the long-term path for larger groups.

### 7.3 Async transport (BYOK relay)

Minimal HTTP protocol:

```
PUT  /ws/{workspace_id}/envelopes
     Authorization: Bearer <token>
     Content-Type: application/msgpack
     body: envelope

GET  /ws/{workspace_id}/envelopes?since={cursor}&limit=500
     Authorization: Bearer <token>
     returns: { cursor: <new_cursor>, envelopes: [...] }

GET  /ws/{workspace_id}/cursor
     Authorization: Bearer <token>
     returns: { cursor: <latest> }

POST /pairing
     Authorization: Bearer <token>
     body: { code: <6-bip39-words>, payload: <encrypted_blob>, ttl: 300 }
     returns: { ok: true }

GET  /pairing/{code}
     Authorization: Bearer <token>
     returns: { payload: <encrypted_blob> } | 404
```

Auth is **required** in v1. Bearer token configured at relay-deploy time, distributed via the invite. Compromised tokens are rotated by issuing a new invite + relay redeploy.

The relay never inspects envelope contents. It enforces:
- Token validity
- Per-token rate limit (configurable)
- Daily envelope cap (configurable, prevents bill blowups)
- Optional per-IP rate limit
- Pairing entries auto-expire after their TTL (default 5 minutes)

**Reference adapters shipped in v1:**
1. **Cloudflare R2 + Worker** — primary. Single `wrangler deploy`. ~$0/month for small teams.
2. **S3-compatible** — works with MinIO, Backblaze B2, Wasabi
3. **Bridge-as-relay** — existing bridge exposed via Tailscale or Cloudflare Tunnel

### 7.4 Pairing-by-code

For the case where direct QR scan or link share isn't viable (e.g. desktop without webcam, paranoid environments), Mehfil supports pairing via a 6-word BIP39 code:

1. Source device generates a pairing payload (same content as a join QR)
2. Source device generates a 6-word BIP39 code locally
3. Source device encrypts the payload under a key derived from the code via PBKDF2
4. Source device posts the encrypted payload to the relay's `/pairing` endpoint with the code as the lookup key, TTL 5 minutes
5. Source device displays the 6 words on screen
6. Target device user types the 6 words into a join field
7. Target device fetches from `/pairing/{code}`, derives the decryption key from the typed code, decrypts the payload
8. Standard join flow continues from here

The code is short enough to type, long enough to resist online brute-force during the 5-minute TTL (62 bits + rate limiting + single-use).

This same mechanism is reused for multi-device pairing in v1.1.

**Note:** pairing-by-code requires a relay to be reachable, so it's a Tier 3+ feature. For Tier 1–2 workspaces with no relay, users fall back to QR or link share.

### 7.5 Multi-office (v2 preview, scoped not built)

Two bridges in two offices, both syncing through a shared relay. Each office has fast LAN gossip internally; cross-office traffic goes via relay. Surfaced in UI as "Mumbai office" and "Bangalore office" with explicit latency indication.

This is a clean extension of the v1 architecture — no protocol changes required, just bridge-to-relay integration. Punt to v2.

### 7.6 Transport status UX

Corner badge, always visible:

| State | Meaning |
|---|---|
| 🟢 Live | Connected to peers via WebRTC (Mode A/B/C) |
| 🟡 Sync | Connected to relay only, async delivery |
| 🟠 Catching up | Fetching backlog |
| 🔴 Offline | All transports down, queuing locally |

Click to expand: full transport list, per-peer status, queued message count, last sync time, troubleshoot link.

---

## 8. Identity & devices

### 8.1 v1 ships single-device per identity

One browser install = one identity = one device. Simpler scope, ships faster.

### 8.2 v1.1 multi-device, scoped now

The protocol must not paint into a corner. Scope:
- **Identity** = one Ed25519 keypair, conceptually owned by the human
- **Devices** = each browser install gets its own `device_id`, signs envelopes with the same identity key
- Vector clocks are keyed by `(user_id, device_id)` from day one (even though v1 has only one device per user)
- Workspace doc tracks devices per identity from day one
- Pairing flow reuses §7.4 pairing-by-code, plus an in-room QR variant
- `device.add` and `device.revoke` envelope types reserved in v1

**The protocol is multi-device-ready in v1. The UI ships single-device. Upgrade is additive.**

### 8.3 Identity backup

First-launch flow: identity is generated immediately, but the backup nag is *deferred* until after the first message is sent. This preserves the "wait, that's it?" first-launch feeling.

After the first sent message, a non-modal banner prompts backup. Escalation:
- Day 0: friendly banner, dismissable
- Day 1+: same banner, reappears once per session
- Day 7+: full-width banner, doesn't auto-dismiss for 5 seconds
- Never blocks the user

Backup format: `.mehfil-key` file containing the passphrase-wrapped private key + recovery metadata.

### 8.4 At-rest passphrase

Optional but heavily prompted. PBKDF2 (600k iters) wraps the identity key in IndexedDB. Auto-lock after configurable idle time (default 15 min).

### 8.5 Lost-everything recovery

There is none. Documented loudly. Re-invite under fresh identity.

This must be surfaced on first launch as a "What if I lose my key?" link — not buried in settings. Honesty about recovery limitations is a brand differentiator.

---

## 9. Storage

### 9.1 IndexedDB schema

```
db: mehfil_<workspace_id>
  envelopes      key: id              indexes: ch, ts, from, type
  messages       key: message_id      indexes: ch, ts, thread        (projection)
  channels       key: channel_id                                     (projection)
  members        key: user_id                                        (projection)
  cursors        key: transport_id    value: opaque cursor
  keys           key: kind            value: wrapped key material
  search_index   key: term            value: posting list
  drafts         key: channel_id
  seen_set       key: envelope_id     value: ts (LRU pruned at 10K)
  quarantine     key: pubkey          value: reason, count
  pending_promotions  key: target_user_id  value: {nominator, sigs[], expires}
```

`envelopes` is the source of truth. Everything else is a projection rebuilt by replaying envelopes. This is event sourcing — essential for sane CRDT handling and projection recovery.

### 9.2 OPFS for blobs

- File attachments at `opfs://workspace_id/blob_id`
- Encrypted client-side before write with a per-blob key
- Per-blob key included in the `attachment.ref` envelope, encrypted under the channel key
- For BYOK relay sharing, encrypted blob is uploaded; envelope carries the URL
- Per-workspace local quota (default 2GB), LRU eviction of remote-fetched blobs (own uploads never evicted)
- v1 hard cap: 25MB per attachment

### 9.3 Search

MiniSearch (~10KB) over decrypted message bodies. Index in IndexedDB. Built incrementally as envelopes arrive. Full rebuild on demand.

**Cross-workspace search is supported by default** — every workspace's index is queryable from the global search palette.

### 9.4 Retention

Per-workspace policy: keep N days, keep N messages, keep forever. Pruning is local — each device decides. Pruned messages removed from projections; tombstones remain for vector-clock continuity.

### 9.5 Export / import

`.workspace` file = zip containing:
- `envelopes.msgpack` — every envelope, length-prefixed
- `keys.enc` — passphrase-wrapped key material
- `meta.json` — workspace ID, version, export timestamp

Import replays envelopes into a fresh local DB.

---

## 10. The invite

A workspace invite is a URL fragment (never hits a server log):

```
https://mehfil.app/#join=<base64url-payload>
```

Payload (MessagePack, encrypted with the invite token in the URL):

```
{
  ws:           workspace_id,
  name:         "Acme Co",
  wrk:          wrapped_workspace_key,
  inviter:      user_id,
  inviter_fp:   fingerprint,
  inviter_vh:   visual_hash_seed,       // for the trust card
  bridge_fp:    fingerprint | null,
  transports: [
    { type: "bridge", url: "http://mehfil.local:8765" },
    { type: "r2",     url: "https://relay.acme.workers.dev", token: "..." }
  ],
  expires:      unix_ms
}
```

QR code carries the same payload.

**Join paths supported in v1:**
1. **Scan QR with camera** — for desktops with webcams or for phone-to-phone
2. **Open link** — universal; the link is shared via any channel (native share sheet, paste, email, etc.)
3. **Type 6-word pairing code** — for desktops without cameras, requires relay (Tier 3+)

**Invitee flow:**
1. Open URL or scan QR or type code
2. Client decrypts payload
3. Display: workspace name, inviter name, inviter fingerprint + trust card, bridge fingerprint
4. **Unskippable** prompt: "Verify the inviter fingerprint with them out of band"
5. User confirms
6. Client generates identity (or imports existing)
7. Posts `member.join` to listed transports
8. Existing member responds with `member.welcome` carrying workspace doc snapshot

---

## 11. Worked example: first message in 90 seconds

Asha and Bose, two-person mode, no bridge.

1. Asha → `mehfil.app` → "Start a workspace" → name "Acme" → client generates identity, workspace root key, default `general` channel. Asha lands in the channel.
2. Asha types "hello" → message appears. Backup nag banner slides in. Asha clicks "Later."
3. Asha clicks "Invite" → picks "They're remote" → copies a join link
4. Asha sends the link to Bose via her usual channel
5. Bose opens the link → sees "Acme — invited by Asha — fingerprint `a4f2 88c1 ...`" with a colored trust card
6. Asha and Bose verify the fingerprint over voice
7. Bose clicks "The fingerprint matches" → enters his name → lands in `general`
8. WebRTC peer connection established via the URL fragment exchange
9. Asha sees Bose appear in the sidebar
10. Asha's "hello" appears in Bose's view, then any subsequent messages flow live

**Target: under 90 seconds from link send to first live message.**

---

## 12. Tier-aware behavior

Mehfil's client adapts its behavior to workspace size. The `member_count` field in the workspace doc drives this.

### 12.1 Tiers

| Tier | Member count | Default mode | Onboarding density | Notes |
|---|---|---|---|---|
| 1 | 1–2 | Two-person (Mode A) | Verbose | Toy / demo |
| 2 | 3–5 | Gossip (Mode B) | Verbose | Small team |
| 3 | 6–~10 | Gossip + Relay (B + D) | Medium | Tier escalation prompt fires |
| 4 | ~10–50 | Bridge + Relay (B + C + D) | Minimal | Production team |

### 12.2 Tier escalation prompt

Triggered when the client detects:
- More than 3 unresolved gaps in the last 24 hours, OR
- Half or more of members offline simultaneously, more than once in a week

Banner appears once, dismissable, reappears weekly until resolved:

> **Acme is getting big enough that members will start missing messages when they're not online together.** Add a relay or a bridge so Mehfil can sync in the background. → *[Set this up]*

The prompt links directly to the relevant settings page.

### 12.3 Onboarding density

Verbose mode (Tiers 1–2):
- All "What does this do?" tooltips visible by default
- Fingerprint verification screen has full explanation paragraph
- Backup nag fires aggressively
- Empty states include "try sending yourself a message" hints
- Settings page has expanded explanations

Medium mode (Tier 3):
- Tooltips on hover only
- Fingerprint verification screen has one-sentence rationale
- Backup nag fires once and is less prominent
- Empty states are calmer

Minimal mode (Tier 4):
- Tooltips off by default (re-enable in settings)
- Fingerprint verification screen is one prompt with no extra copy
- Backup nag mentioned once during onboarding, then handed to settings
- Empty states are spare

### 12.4 Why this matters

A 2-person workspace and a 50-person workspace have fundamentally different audiences. Small workspaces are self-selected experimenters who want to understand the tool. Large workspaces are people whose colleague told them to install this; they want to get to work. Tier-aware UI lets one product serve both without compromising either.

---

## 13. Workspace shell

### 13.1 The launcher

There is no in-app workspace switcher in v1. When you open `mehfil.app` and have multiple workspaces on this device, you see a launcher screen:

> **Open a workspace**
> [Acme] [Side project] [Family chat] [+ New] [Join]

Click → opens that workspace in the current tab. Cmd-click → opens in a new tab. Each workspace lives in its own browser tab. Cmd+1 / Cmd+2 / Cmd+3 — the browser's native tab switching — *is* the workspace switcher.

### 13.2 Why one tab per workspace

It matches local-first thinking. A workspace is a thing on your computer, like a document. You open it, work in it, close it. Multi-workspace apps are server-thinking — a viewer for cloud state. Mehfil is the document.

### 13.3 The sidebar

Calm by default. Channels, DMs, search, settings. No app marketplace, no workflow automations cluttering things. A "more dense" toggle in settings is available for users who prefer a fuller layout.

---

## 14. v1 scope lock

### 14.1 Must-have

- Workspace create + join via QR / setup link / 6-word code
- Channels (public, private), DMs, group DMs
- Messages: text, markdown, code blocks, edit, delete
- Reactions, threads (data model + minimal UI), @mentions
- File attachments via OPFS local + BYOK R2 remote (≤25MB)
- Two-person mode (Mode A)
- Gossip mode (Mode B)
- Bridge mode (Mode C) with `mehfil-bridge` Go binary
- Relay mode (Mode D) with Cloudflare R2 adapter
- Local search (MiniSearch), cross-workspace by default
- Local notifications
- Presence: online / last-seen
- Workspace export / import
- Identity backup with passphrase
- Bridge fingerprint pinning
- Visual hash trust cards for fingerprints
- Gap detection UI
- Tier-aware onboarding density
- Tier escalation prompt
- Per-sender rate limits at receiver
- At-rest passphrase wrapping (optional, heavily prompted)
- Message rendering security (markdown allowlist, no raw HTML, CSP)
- Promote-by-consensus for dead-admin recovery
- Workspace launcher (no in-app workspace switcher)

### 14.2 Should-have (cut if blocking)

- Reactions UI (data model is must-have)
- Thread UI (data model is must-have)
- Constant-size envelope padding tuning
- Cover-traffic option
- Drafts
- Workspace fork (escape hatch for stuck workspaces)

### 14.3 v1.1

- Multi-device pairing (protocol-ready in v1)
- Multi-admin as a first-class concept (consensus mechanism is in v1)
- Voluntary admin transfer flow
- Voice messages (VoiceVault integration)
- Video clips (screen recorder integration)
- Slash commands integrated with sibling tools (`/bofh`, `/localmind`, `/kanzen`)
- S3-compatible relay adapter
- File attachment limit raised (negotiate per-relay)

### 14.4 v2

- Multi-office bridge federation
- Huddles (audio via WebRTC mesh)
- Canvas (Yjs collaborative doc)
- Workspace rekey scheduling
- Shamir-split identity backup
- Threads first-class UI

### 14.5 Future (post-v2, conceptual)

- Web Bluetooth transport for true offline mesh between physically proximate devices (Mode E)
- Inter-workspace federation (carefully scoped — no global namespace)
- Encrypted CRDT primitives beyond Yjs for richer collaborative document types
- Post-quantum hybrid (X25519+Kyber when Web Crypto exposes it)

### 14.6 Never

- App marketplace, workflow builder
- SSO, SAML
- eDiscovery, legal hold
- Mobile push notifications via central service
- Email digests
- SFU-based large video calls
- Public discoverable channels across workspaces
- Anything that requires Mehfil-operated infrastructure
- Distribution via app stores as the primary path

---

## 15. Threat model

### 15.1 One-paragraph summary

Mehfil protects message contents from everyone except the people you invited. It does not hide *that* you are using it, *who* is in your workspace, or *when* you talk. It assumes your devices are not compromised; once they are, no chat tool can help you. It assumes you verify fingerprints with people you invite; if you don't, an attacker on your network can become you. It has no central authority that can be subpoenaed, banned, or coerced — that authority lives on the laptops of workspace members instead. Losing all your devices means losing your account; we will nag you to back up your key. The relay operator (you, your IT, Cloudflare) sees encrypted blobs and metadata, never content. The distribution surface is a URL, not an app store, so the tool cannot be removed by a gatekeeper; it can only be blocked at the network layer, and the file can be mirrored or sideloaded freely.

### 15.2 Defended

- Forged messages from non-members (signature verification)
- Replay attacks (content-addressed IDs + dedupe)
- Causal reordering (vector clocks)
- Downgrade attacks (no version negotiation, signed version field)
- Sybil attacks (invite-only, no open join)
- Rage-quit destruction (every member has a full replica)
- Subpoena resistance (no central operator to subpoena)
- Distribution gatekeeper takedown (no app store dependency)
- Dead-admin lockout (promote-by-consensus)
- XSS via message rendering (strict markdown allowlist, CSP, no raw HTML)
- Quota exhaustion (per-sender size + count limits at receiver)

### 15.3 Mitigated, residual risk documented

| Attack | Mitigation | Residual |
|---|---|---|
| Stolen unlocked device | Optional passphrase wrap, auto-lock | If user opts out, full impersonation until revoked |
| Wall-clock reorder by relay | "Received late" badges on suspicious messages | Subtle timing manipulation possible |
| Fingerprint MITM during invite | Unskippable verification + visual hash | Users who lie to themselves about verifying |
| Display name impersonation | Fingerprint badges + trust card on first interaction | UX-dependent |
| Bridge impersonation on LAN | Bridge fingerprint pinned in workspace doc | First-touch before pinning |
| Compromised servent peer | Gossip redundancy + gap detection | Small meshes degrade |
| Relay DoS / flood | Bearer token + rate limits + daily caps | Insider can flood until removed |
| WebRTC IP leak | TURN-over-TLS via bridge/relay only | LAN mode reveals LAN IPs (acceptable) |
| IndexedDB extraction by malware | Passphrase wrap | Owned device = owned everything |
| Pairing-code brute force | 62-bit code + 5-min TTL + single-use + relay rate limit | Online attack windowed |

### 15.4 Accepted limitations

- Workspace key leak by member (rekey ceremony, but old traffic stays compromised)
- Browser extension reading the page (recommend dedicated profile)
- Screenshot leaks (universal)
- Relay metadata exposure (recommend Tor/VPN for paranoid users; padding helps content-length)
- Lost-everything recovery (none; documented loudly)
- Network-layer blocking by DPI (much harder than app-store removal, but not impossible)

### 15.5 Punted

- Post-quantum (future — hybrid X25519+Kyber when Web Crypto exposes it)
- Deniable authentication (out of scope — we want non-repudiation)
- Per-message forward secrecy (Double Ratchet too expensive for groups without Matrix-level investment)
- Anonymous membership (different product)
- Network-layer traffic analysis (user's responsibility — Tor/VPN)
- Backdoored bridge binary (signed releases, GitHub publishing — if user runs untrusted code, all bets are off)

---

## 16. Engineering risks, ranked

1. **WebRTC NAT traversal across the internet.** Even with TURN, browser-to-browser fails often enough to be unreliable. **Why it's OK:** async-mode relay exists for exactly this reason.
2. **Bridge install friction.** Some teams will refuse to install anything. **Why it's OK:** Modes A and B cover first-touch and small teams.
3. **Storage growth.** Active workspaces accumulate gigabytes. **Mitigation:** retention policies, LRU blob eviction, clear quota UI.
4. **Yjs as a dep.** ~80KB minified. **Why it's OK:** solves the metadata-merge problem completely.
5. **MessagePack tooling in browser.** **Pick:** `@msgpack/msgpack` (~15KB).
6. **Identity recovery UX.** Lost keys = lost workspace. **Mitigation:** aggressive backup nag, multi-device in v1.1, promote-by-consensus for dead-admin.
7. **Empty-state UX.** **Mitigation:** clear UI, queued messages visible, "send yourself a message" hint in Tier 1.
8. **Servent gossip in pathological topologies.** Star topology where one peer bridges two clusters becomes a bottleneck. **Mitigation:** gap detection + manual resync.
9. **Pairing-code collision and brute force.** **Mitigation:** reference Cloudflare Worker adapter ships with explicit pairing rate limits.

---

## 17. Deliverables for v1

1. **`mehfil.html`** — single-file client. Vanilla JS, no framework. Yjs, MiniSearch, `@msgpack/msgpack`, markdown-it as the only deps. Inlined into the single HTML.
2. **`mehfil-bridge`** — Go binary, single static file. `brew`, `.deb`, `.pkg`, `.exe`, `.tar.gz` for Linux/macOS/Windows.
3. **`relay-cloudflare/`** — Cloudflare Worker + R2 adapter, deployable via `wrangler deploy`. Includes README with full setup walkthrough.
4. **`MEHFIL-SPEC.md`** — this document, kept current as the source of truth.
5. **`MEHFIL-WALKTHROUGHS.md`** — testable user flow walkthroughs.
6. **`PROTOCOL.md`** — wire format, envelope types, signature scheme, cursor semantics.
7. **`SECURITY.md`** — threat model + responsible disclosure contact.
8. **`docs/`** — user-facing setup guides for bridge and relay.

---

## 18. Open calls remaining

For the human engineer reviewing the protocol layer:

1. **Canonical MessagePack encoding** — pin the exact rules (sorted map keys, smallest int encoding, no extension types) and write them as a doc + test vectors.
2. **Yjs encryption boundary** — Yjs updates encrypted as opaque blobs inside `workspace.patch` envelopes is the simple path. Confirm it doesn't conflict with Yjs's incremental sync optimizations.
3. **Per-channel vs per-workspace search index** — vote: per-workspace.
4. **Bridge LAN URL mutability** — workspace doc update via `workspace.patch` when bridge IP changes.
5. **Token rotation flow** — relay token rotation as a `workspace.patch` field; old token remains valid for a 24h grace period.
6. **Pairing rate limit specifics** — Cloudflare Worker reference adapter ships with: max 10 pairing attempts per IP per minute, max 100 pairing entries per workspace per day.
7. **Promote-by-consensus expiry handling** — pending promotions older than 7 days garbage-collected on next admin op.

None of these block the spec being handed off.

---

**End of v1 spec.**
