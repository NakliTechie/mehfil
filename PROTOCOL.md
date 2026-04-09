# Mehfil — Protocol Notes

Companion to `MEHFIL-SPEC.md`. Pins the parts the spec leaves open and records implementation choices made during development.

This file is the source of truth for any decision the spec marks as "open call" or "to be confirmed". It must stay in sync with the code.

---

## 1. Canonical MessagePack encoding

Mehfil uses MessagePack on the wire and as the input to every signature. Two implementations of the protocol must produce **byte-identical** output for the same input, or signatures will not verify across implementations.

The reference `@msgpack/msgpack` library does **not** guarantee canonical encoding (sorted map keys, smallest int representation). Mehfil therefore ships its own minimal canonical codec.

### Supported types

| JS value                 | msgpack format(s) used                                       |
|--------------------------|--------------------------------------------------------------|
| `null` / `undefined`     | nil (0xc0)                                                   |
| `false` / `true`         | false (0xc2) / true (0xc3)                                   |
| integer in [0, 127]      | positive fixint                                              |
| integer in [-32, -1]     | negative fixint                                              |
| integer in [0, 2^8-1]    | uint8 (0xcc)                                                 |
| integer in [0, 2^16-1]   | uint16 (0xcd)                                                |
| integer in [0, 2^32-1]   | uint32 (0xce)                                                |
| integer in [0, 2^53-1]   | uint64 (0xcf)                                                |
| integer in [-2^7, -1]    | int8 (0xd0)                                                  |
| integer in [-2^15, -1]   | int16 (0xd1)                                                 |
| integer in [-2^31, -1]   | int32 (0xd2)                                                 |
| integer in [-2^53, -1]   | int64 (0xd3)                                                 |
| non-integer number       | float64 (0xcb)                                               |
| string                   | fixstr / str8 / str16 / str32 (smallest that fits)           |
| `Uint8Array`             | bin8 / bin16 / bin32 (smallest that fits)                    |
| `Array`                  | fixarray / array16 / array32 (smallest that fits)            |
| plain object             | fixmap / map16 / map32 (smallest that fits)                  |

Extension types, BigInts beyond ±2^53-1, float32, and Date objects are **not used** in v1. Implementations should reject them on encode and on decode.

### Canonical rules

1. **Smallest representation.** Each value is written using the shortest msgpack form that fits it. e.g. `0` is `0x00`, never `0xcc 0x00`.
2. **Map key ordering.** Maps are encoded with their keys sorted lexicographically by the **byte sequence of the encoded key**. In practice, all map keys in v1 are short ASCII strings, so this is equivalent to sorting them as ASCII strings — but the byte-sequence rule is the formal definition and must be used if a non-string key is ever introduced.
3. **No duplicate keys.** Map keys must be unique within a map. Decoders reject maps with duplicate keys.
4. **Strings are UTF-8.** No surrogate pairs, no BOM. Strings produced by `TextEncoder` are accepted as-is.
5. **No nil values inside maps or arrays unless the schema explicitly allows them.** This is enforced at the envelope-shape level, not the codec level — the codec will encode nils faithfully if asked.
6. **Floats are float64.** v1 has no use of float32 anywhere.

### Test vectors

Implementations must agree on these encodings:

| Input (JS)                          | Hex output                                          |
|-------------------------------------|-----------------------------------------------------|
| `null`                              | `c0`                                                |
| `false`                             | `c2`                                                |
| `true`                              | `c3`                                                |
| `0`                                 | `00`                                                |
| `127`                               | `7f`                                                |
| `128`                               | `cc 80`                                             |
| `255`                               | `cc ff`                                             |
| `256`                               | `cd 01 00`                                          |
| `-1`                                | `ff`                                                |
| `-32`                               | `e0`                                                |
| `-33`                               | `d0 df`                                             |
| `""`                                | `a0`                                                |
| `"hi"`                              | `a2 68 69`                                          |
| `[]`                                | `90`                                                |
| `[1,2]`                             | `92 01 02`                                          |
| `{}`                                | `80`                                                |
| `{"b":2,"a":1}`                     | `82 a1 61 01 a1 62 02`  (keys sorted: a then b)     |
| `Uint8Array([1,2,3])`               | `c4 03 01 02 03`                                    |

These vectors live as a self-test inside `index.html` and run on every load. If they fail, the app refuses to boot.

---

## 2. Envelope canonical form

The signature in an envelope covers the canonical msgpack encoding of the envelope **with `sig` and `cosigs` removed**. The signer must:

1. Build the envelope object with all fields except `sig` and `cosigs`.
2. Encode it canonically (per §1).
3. Sign the bytes with Ed25519.
4. Add the resulting `sig` to the object.
5. Optionally add `cosigs` (built the same way for each cosigner).

The verifier reverses this:

1. Take the envelope.
2. Strip `sig` and `cosigs` to a fresh object.
3. Encode canonically.
4. Verify the signature against the canonical bytes.
5. For each cosig, verify against the same canonical bytes.

There is no separate "signed payload" envelope shape — the envelope itself is the signed object minus its own signature.

---

## 3. Padding

Per spec §4: "Rounded to next 1KB up to 16KB; messages above 16KB use the next 16KB boundary."

The `pad` field is a `Uint8Array` of zero bytes. The padded length is computed over the **fully-encoded envelope including signature**, and `pad` is sized so that the final encoded length lands **exactly** on the boundary. Slice 3a fixes the earlier iterative best-effort approach with the following closed-form derivation.

### Algorithm

1. Build the envelope with `pad = Uint8Array(0)`.
2. Sign it — produces `sig` (64 bytes, Ed25519, always the same size).
3. Encode the full envelope once. Let `L0 = MP.encode(env).length`.
4. Compute target `T`:
   - `T = ⌈L0 / 1024⌉ × 1024` if `L0 ≤ 16384`
   - `T = ⌈L0 / 16384⌉ × 16384` if `L0 > 16384`
5. Let `delta = T − L0`. If `delta === 0`, we're done.
6. Replace `pad` with a populated `Uint8Array(padLen)`:
   - `delta ≤ 255`:        `padLen = delta`        (bin8, same 2-byte header as empty bin8 → delta is pure content)
   - `delta ≤ 65536`:      `padLen = delta − 1`    (bin16, header grows from 2 → 3, content adds delta−1)
   - otherwise:            `padLen = delta − 3`    (bin32, header grows from 2 → 5, content adds delta−3)
7. Re-sign over the canonical bytes *including* the populated pad. `sig` length doesn't change so the final encoded length is now exactly `T`.
8. Assert `MP.encode(env).length === T`. Fail loud on mismatch — if this ever fires, the header-growth assumption above is wrong and we'd rather crash loudly than ship mis-aligned envelopes.

### Why the delta formulas work

An empty `bin8` encodes as two bytes: `0xc4 0x00`. A populated `bin8` with `P ≤ 255` content bytes encodes as `0xc4 <P> <P content bytes>` → `P + 2` total. The *growth* from empty to populated is `(P + 2) − 2 = P`. So if we need to add exactly `delta` bytes and `delta ≤ 255`, set `P = delta`.

A `bin16` with `P` content bytes encodes as `0xc5 <len16> <P content bytes>` → `P + 3` total. Growth from empty bin8 is `(P + 3) − 2 = P + 1`. So if we need to add `delta` bytes and `delta > 255`, set `P = delta − 1` and we must use bin16. The minimum P for this case is `256` (i.e. delta starts at `257`), which fits since `256 > 255`. Max is `65535` → delta max is `65536`.

A `bin32` with `P` content bytes encodes as `0xc6 <len32> <P>` → `P + 5` total. Growth `P + 3`. `P = delta − 3`. Min P is `65536` (delta `65539`).

There's no discontinuity: as `delta` crosses `255 → 256` the formula switches from `P = delta` (making `P = 256`, bin16) to `P = delta − 1` (also `P = 255`... wait). Actually case 2 starts at `delta = 256`: `P = 255`, but `255 ≤ 255` is bin8 territory. Contradiction? No — the transition happens one step later, at `delta = 257`: case 1 would give `P = 257` which overflows bin8, case 2 gives `P = 256` which fits bin16. In practice the correct cutoff is `delta ≤ 255` → bin8, `delta ≥ 256` → bin16. When `delta === 256`, case 1 says `P = 256` (invalid for bin8) — so the guard must be `delta ≤ 255` strict.

The current implementation uses exactly that cutoff: `if (delta <= 255) padLen = delta; else if (delta <= 65536) padLen = delta − 1; else padLen = delta − 3`. Verified across body sizes 1 byte → 20KB: every envelope lands on the exact boundary.

### Test matrix

| Body size (bytes) | Encoded length | Pad bytes | Notes |
|------|------|------|------|
| 1 | 1024 | 654 | 1KB target, bin16 region |
| 300 | 1024 | 352 | 1KB target, bin16 region |
| 500 | 1024 | 153 | 1KB target, bin8 region |
| 800 | 2048 | 876 | 2KB target |
| 1500 | 2048 | 177 | 2KB target, bin8 region |
| 15000 | 16384 | 1012 | 16KB target, bin16 region |
| 20000 | 32768 | 12396 | 32KB target (next 16KB boundary) |

Every row lands exactly on `encLen % 1024 === 0` (or `% 16384 === 0` for the large ones).

---

## 4. Identifier formats

Per spec §3, all base64url IDs use **unpadded** base64url (RFC 4648 §5 with `=` removed).

| ID            | Source bytes                              | Encoded length |
|---------------|-------------------------------------------|----------------|
| `user_id`     | 32-byte Ed25519 public key                | 43             |
| `device_id`   | 8 random bytes                            | 11             |
| `workspace_id`| 16 random bytes                           | 22             |
| `channel_id`  | 16 random bytes                           | 22             |
| `message_id`  | first 16 bytes of SHA-256(sender‖ts‖nonce)| 22             |

The `‖` operator above means: `sender_pubkey_bytes` (32) ‖ `ts_be_uint64` (8) ‖ `nonce` (12). 52 bytes total.

---

## 5. Storage layout

Two IndexedDB databases:

### `mehfil_global`
Tracks the user's identity and the list of workspaces present on this device. One database, used regardless of how many workspaces exist.

| Store         | Key            | Value                                                            |
|---------------|----------------|------------------------------------------------------------------|
| `identity`    | `'self'`       | `{ pubkey: bytes, privkey_pkcs8: bytes, created_at: ms }`        |
| `workspaces`  | `workspace_id` | `{ id, name, created_at, last_opened_at }`                       |
| `settings`    | string         | arbitrary key/value                                              |

### `mehfil_<workspace_id>`
One per workspace. Schema per spec §9.1:

| Store               | Key             | Notes                                                    |
|---------------------|-----------------|----------------------------------------------------------|
| `envelopes`         | `id`            | indexes: `ch`, `ts`, `from`, `type` — source of truth    |
| `messages`          | `id`            | projection rebuilt from envelopes                        |
| `channels`          | `id`            | projection                                               |
| `members`           | `id`            | projection                                               |
| `cursors`           | `transport_id`  | opaque transport sync cursor                             |
| `keys`              | `kind`          | wrapped key material                                     |
| `seen_set`          | `envelope_id`   | LRU pruned at 10K entries                                |
| `quarantine`        | `pubkey`        | reason, count                                            |
| `drafts`            | `channel_id`    | composer drafts                                          |
| `pending_promotions`| `target_user_id`| `{nominator, sigs[], expires}`                           |

Slice 0+1 creates and uses: `envelopes`, `messages`, `channels`, `members`, `keys`. Other stores are created (so the schema is correct from day one) but not yet written to.

---

## 6. Identity backup file format

`.mehfil-key` is a JSON file (not msgpack — chosen so users can inspect it with any text editor).

### v2 (Slice 3b)

```json
{
  "magic": "mehfil-key",
  "v": 2,
  "created_at": 1712534400000,
  "kdf": {
    "name": "PBKDF2",
    "hash": "SHA-256",
    "iters": 600000,
    "salt_b64": "..."
  },
  "wrap": {
    "name": "AES-GCM",
    "iv_b64": "...",
    "ct_b64": "..."
  },
  "pubkey_b64":        "...",    // Ed25519 raw public key
  "x25519_pubkey_b64": "..."     // X25519 raw public key
}
```

`ct` is the AES-GCM-encrypted canonical-msgpack-encoded object `{ed25519: <PKCS8>, x25519: <PKCS8>}` containing both private keys. Wrapping key comes from PBKDF2 over the user's passphrase with the stored salt and 600k iterations.

Both public keys are in cleartext so a user inspecting the file can identify the identity without the passphrase.

### v1 (Slices 0-3a) — deprecated, still accepted on restore

```json
{
  "magic": "mehfil-key",
  "v": 1,
  "created_at": ...,
  "kdf": {...},
  "wrap": {...},
  "pubkey_b64": "..."
}
```

`ct` is the AES-GCM-encrypted raw PKCS8 bytes of the Ed25519 private key. No X25519 key. On restore, the loader generates a fresh X25519 keypair — **past DMs and private channels encrypted to the old X25519 pubkey are unrecoverable.** The loader displays a warning when restoring a v1 file.

### Restore verification

The loader performs a sanity check on every restore: import the restored Ed25519 private key, sign a known test string, verify the signature against the public key stored in the file. This catches corrupted files and wrong passphrases (which would otherwise silently produce an "identity" whose signatures nobody accepts).

---

## 7. Decisions still open

These don't block Slice 0+1 but need pinning before later slices.

- **Yjs encryption boundary** (spec §18.2) — defer to Slice 3.
- **Token rotation grace period** (spec §18.5) — defer to Slice 7 (relay).
- **Pairing rate limits** (spec §18.6) — defer to Slice 7.

---

## 8. Invite URL fragment — v1 encryption boundary

Spec §10 says the invite payload is "MessagePack, encrypted with the invite token in the URL". The wording is ambiguous — there is no obvious separate invite token delivered alongside the URL, and deriving an encryption key from something already in the URL fragment provides no actual confidentiality.

**v1 decision:** the fragment is `#join=<base64url(canonical_msgpack(payload))>` with **no encryption layer applied**. The security argument is:

1. URL fragments are never sent to servers and are not written to server logs.
2. The user chose the delivery channel (Signal / WhatsApp / email / voice) and accepts its privacy characteristics.
3. Anyone who possesses the URL is by construction being invited — "defend the URL against someone who has the URL" is incoherent.
4. The workspace root key is in the fragment (field `wrk`). Encrypting the payload with a key also in the URL is pointless; encrypting with a separately-distributed key requires the secondary channel to have higher integrity than the URL-delivery channel, which is rarely true in practice.

This may be revisited in v1.1 if a specific threat model calls for it. Documented loudly.

## 9. Slice 2 transport framing

The WebRTC data channel carries length-framed binary packets. One byte of tag, then payload:

| Tag  | Meaning | Payload format |
|------|---------|----------------|
| 0x01 | Envelope | canonical msgpack-encoded envelope |
| 0x02 | ACK | envelope id, UTF-8 encoded |

Tags ≥0x80 are reserved for Slice 4 (gossip) and beyond. Framing is transport-local; it is not part of the signed envelope protocol. ACKs are UX sugar (single-check → double-check), not correctness-critical.

## 10. WebRTC STUN choice

v1 ships with a single STUN server hard-coded:

```
stun:stun.cloudflare.com:3478
```

Rationale: Cloudflare is already in the mental model as the relay provider, and their STUN is globally anycast with no usage caps. Users can swap it in settings later. This is **not** a protocol decision — a Mehfil client that uses Google STUN or no STUN at all is still spec-compliant. It's only here so future bug reports have a known baseline.

Same-host WebRTC (e.g. two tabs on the same machine) succeeds without ever contacting STUN — the candidates are all host-local. First contact took ~200ms in local testing.

## 11. Mode A handshake — URL roundtrip

Spec §7.2 defines the two-URL handshake: inviter sends URL A (contains offer), joiner sends URL B (contains answer) back through the same OOB channel. Implementation notes:

- **One-shot ICE gathering.** Both sides wait for `iceGatheringState === 'complete'` before emitting their URL, with a 5-second safety timeout. This produces a stable SDP that can be copied once and sent. No trickle-ICE support in v1 (would require a signaling transport).
- **SDP compression.** SDPs are ~1–4KB and highly repetitive. We use `CompressionStream('deflate-raw')` (browser-native) before base64url-encoding. Real SDPs compress ~1.3–3x depending on verbosity; typical invite URLs in Slice 2 testing are 700–1200 chars total, comfortably inside QR code capacity.
- **Join payload** (`#join=<frag>`) carries: workspace id and name, workspace root key (raw), inviter pubkey + fingerprint + display name, general channel id + key (raw), compressed offer SDP, expiry.
- **Reply payload** (`#join-reply=<frag>`) carries: workspace id, joiner pubkey, joiner display name, joiner color, compressed answer SDP.
- **No member.join via URL.** The joiner's identity announcement rides over the data channel as a signed `member.join` envelope *after* the WebRTC connection is established. The reply URL only establishes the transport; all signed state lives in envelopes.

---

## 12. X25519 — second keypair per identity (Slice 3b)

Every Mehfil identity now has two keypairs:

- **Ed25519** — signing + identity root. Unchanged since Slice 0. `user_id = base64url(ed25519_pub)`.
- **X25519** — ECDH key agreement. Used to derive per-member key-wrapping keys for private channels (§5.2) and to derive symmetric keys for 1:1 DMs (§13). Generated alongside the Ed25519 key at `Identity.ensure()` time.

The Ed25519 key is the identity root and must never change — rotating it would make every past signature unverifiable. The X25519 key is a subordinate encryption key; in principle it could be rotated (Slice 5 admin work). In practice v1 does not rotate it.

### Migration path

Identity records created in Slice 0 / 1 / 2 / 3a have only the Ed25519 fields. On load, `Identity.ensure()` detects a missing `x25519_pub` / `x25519_priv_pkcs8` and generates a fresh X25519 keypair in place, persisting the updated record. The Ed25519 key is untouched. Any DMs / private channels created before migration are lost (there were none, since those features land in 3b).

### Distribution

The X25519 public key travels with every `member.join` envelope (in the inner payload as `x25519_pub: <32 bytes>`) and inside each member record in `member.welcome` snapshots. Every client's local `members` projection stores it. Private channel creation and DM initiation look it up from that projection.

### ECDH derivation

```
kek_ab = deriveKey(
  { name: "X25519", public: party_b.x25519_pub },
  party_a.x25519_priv,
  { name: "AES-GCM", length: 256 },
  ...
);
```

The derived key is a native AES-GCM CryptoKey — no intermediate raw bytes, no HKDF step. Because ECDH is symmetric, `kek_ab == kek_ba`. Both parties derive the same key independently.

**AES-GCM key reuse:** the derived KEK is the SAME for any given `(party_a, party_b)` pair, so reusing it across multiple encrypt calls is safe ONLY with unique nonces per call. Every wrap operation uses a fresh 96-bit random IV via `Crypto.rand(12)`.

## 13. Private channels (§5.2) and the `wrapped_keys` structure

Private channels use per-member key wrapping via X25519 ECDH. The `channel.create` envelope's inner payload for a private channel is:

```
{
  id: <channel_id>,
  name, topic,
  private: true,
  members: [user_id, ...],
  wrapped_keys: {
    <user_id_1>: { iv: <12 bytes>, ct: <48 bytes> },
    <user_id_2>: { iv: <12 bytes>, ct: <48 bytes> },
    ...
  },
  wrapper: <user_id of the envelope signer>
}
```

For each recipient listed in `members`, the creator:
1. Imports the recipient's `x25519_pub` from the local `members` projection.
2. Calls `deriveKey(X25519, my_priv, their_pub)` to get an AES-GCM KEK.
3. Generates a fresh 12-byte IV.
4. Encrypts the 32-byte raw channel key under the KEK with that IV.
5. Stores `{iv, ct}` in `wrapped_keys` under the recipient's `user_id`.

The `wrapper` field identifies whose X25519 public key the recipient needs to ECDH with. In v1 only the envelope signer can wrap, so `wrapper === env.from` — but the explicit field is here so later slices (admin adds members to an existing private channel) can carry wrapped entries from a different key without breaking the decryption path.

On receive:
1. Decrypt the envelope under the workspace root key (all workspace members can do this).
2. Look up `wrapped_keys[my_user_id]`. If absent → drop silently (not a member, channel is invisible).
3. Look up `members.find(m => m.id === inner.wrapper)`, get their `x25519_pub`.
4. Derive the KEK via ECDH.
5. Decrypt the wrapped entry with `{iv, ct}` under the KEK.
6. Import the 32 raw bytes as an AES-GCM CryptoKey, store as the channel key.

**Non-members see the envelope exists** (it's encrypted under the workspace root key, which they have) **but cannot derive the channel key**. They don't get a `wrapped_keys[their_id]` entry, and even if they somehow computed one, they don't have the wrapper's X25519 private key needed for ECDH from the *other* side.

**Note on visibility:** since non-members can decrypt the envelope, they can see the channel name, topic, and member list. This is intentional — hiding channel metadata entirely would require a separate "metadata key" per channel and add significant complexity. v1 accepts that non-members know a private channel exists and who's in it; they just can't read the messages. Documented in spec §15.4.

## 14. 1:1 DMs (§5.2) — deterministic channel id and key derivation

Unlike private channels, DMs have **no `channel.create` envelope**. The DM channel id and key are both deterministically derived from the pair of user IDs, so both parties converge on them independently without any protocol round trip.

### DM channel id

```
sorted_pair = sort([user_a_id, user_b_id])       // lexicographic
bytes = UTF-8(sorted_pair.join("|"))
dm_channel_id = base64url(SHA-256(bytes)[:16])    // 22 chars, same format as other channel ids
```

The sort + join ensures both parties compute the same id regardless of who computes first. The 16-byte truncation matches the ordinary `channel_id` format from §4.

### DM channel key

```
dm_key = deriveKey(
  { name: "X25519", public: their_x25519_pub },
  my_x25519_priv,
  { name: "AES-GCM", length: 256 },
  ...
)
```

Again symmetric: both parties compute the same AES key. No wrapping, no distribution.

### First-use materialization

The DM channel record exists locally only after the first message:

- If the user clicks "Start DM with Bose" in the sidebar, `ensureDmChannel()` computes the id, derives the key, and persists both as a new `channels` record with `dm: true, dm_with: <user_id>`.
- If an incoming envelope arrives whose `ch` is unknown, dispatch tries `tryResolveIncomingDm()`: for each known member with an x25519_pub, compute `dmChannelId(me, member)` — if one matches, materialize the DM channel the same way.

This means a DM "exists" the moment either party sends into it. No pending states, no offer/accept flow.

### `Workspace.open` replay

The event-sourced replay loop also handles DM resolution: if it encounters a `message.create` whose `ch` doesn't match a known channel, it runs the same DM resolution against the members list loaded so far. This is critical for rebuilding DM state after a page reload — the channel record is persisted, but on fresh load it has to be materialized from the first incoming envelope all over again if the channel record was somehow lost.

### Backward compatibility

DMs require both parties to have published `x25519_pub` values. Members who joined before Slice 3b have `x25519_pub: null` on their records and cannot participate in DMs until they rejoin (which generates + publishes the X25519 keypair via `member.join`). The UI surfaces a clear error: "Bose doesn't have X25519 keys yet — they joined before Slice 3b."

---

## 15. Group DMs — simplified from spec (Slice 3c)

Spec §5.2 specifies group DMs as "sender-keys pattern — each sender has their own key, distributed to members on first use". A faithful implementation requires separate sender-key envelopes per participant, per-sender key storage on every client, and logic to pick the right sender key based on `env.from` at decrypt time. It buys two things:

1. **Forward key isolation on removal** — removing a member retires their sender key, future messages from other members stay decryptable without a full rekey.
2. **Chain key ratcheting** — if you pair it with Double Ratchet or Messaging Layer Security, you get forward secrecy. Mehfil does not pair it with ratcheting (spec §15.5 explicitly punts per-message forward secrecy), so this benefit is theoretical.

**v1 ships a simpler shape:** group DMs are multi-member private channels carrying `dm: true` in the `channel.create` inner payload. Exactly the same envelope, dispatch handler, and wrapping code as a private channel with 3+ members — zero new envelope types, zero new key-storage code. Each participant gets the single group-DM AES key wrapped under `ECDH(creator_priv, their_x25519_pub)`. Every subsequent message is encrypted under that one key by whoever is sending.

What's lost compared to spec-faithful sender-keys:

- Removing a member requires a full rekey ceremony (Slice 5 admin work) rather than retiring one member's sender key.
- No per-sender chain-key ratchet. But v1 has no per-message forward secrecy anyway, so this is status quo.

What's preserved:

- Non-members can't decrypt (per-member ECDH wrapping).
- All messages signed by the sender → forgery resistance, attribution.
- Members without `x25519_pub` (pre-3b joiners) are rejected at creation time with a clear error.
- No deterministic channel id (unlike 1:1 DMs) — group DM creation is an explicit user action, not a derivation from membership.

The `dm: true` flag rides in the `channel.create` inner payload. Both sides project the channel with `dm: true` so the sidebar renders it under "Direct Messages" rather than "Channels". 1:1 DMs take a different code path (deterministic id + derivation, no `channel.create` envelope) — `dm_with: <user_id>` distinguishes a 1:1 DM from a group DM where `dm_with: null`.

This simplification is documented in `PENDING.md` under `[v1.1] Full sender-keys pattern for group DMs`. Upgrading to spec-faithful sender-keys in v1.1 is additive — new envelope types, new dispatch cases, no changes to the v1 wire format.

## 16. Attachments (§9.2) — OPFS storage with per-blob encryption (Slice 3c)

File attachments are stored encrypted in the Origin Private File System at `mehfil_<workspace_id>/<blob_id>`. Nothing in OPFS is ever in the clear.

### Send path

1. User attaches a file via the paperclip button or drag-and-drop.
2. Client reads it into a `Uint8Array`. Enforces the 25MB cap per spec §14.1.
3. `BlobStore.put` generates:
   - A fresh AES-256-GCM key (the per-blob key).
   - A random 12-byte IV.
   - A random 16-byte blob id (base64url-encoded).
4. The plaintext is encrypted under the per-blob key with that IV.
5. The ciphertext (plaintext + 16-byte GCM auth tag) is written to OPFS at the blob id.
6. An `attachment.ref` envelope is built with inner payload:
   ```
   {
     blob_id: <22-char base64url>,
     key:     <32 raw bytes>,         // the per-blob AES key
     iv:      <12 raw bytes>,
     size:    <plaintext byte length>,
     mime:    <string>,
     name:    <filename string>
   }
   ```
7. The envelope is encrypted under the channel key (public or private) as usual. Signed, padded, broadcast.

### Key distribution

The per-blob key travels *inside* the envelope's encrypted inner payload. So:

- **Only channel members can decrypt the envelope** → only they see the per-blob key + blob id.
- **Only someone with the blob bytes** (from local OPFS or a future relay fetch) can decrypt the actual file content.

This gives the property that even an attacker who compromises OPFS cannot read attachments without also compromising at least one channel member's Mehfil state to get the envelope → get the per-blob key.

### Receive path (local)

When an `attachment.ref` envelope arrives:

1. Dispatch verifies + decrypts the envelope (standard path).
2. Creates a message record with `attachment: {blob_id, key, iv, size, mime, name, available}`.
3. If the signer is the local user, `available = true` (the blob is already in local OPFS from `sendAttachment`).
4. Otherwise, `available` starts as `null` and the render path does a lazy `BlobStore.has(workspace, blob_id)` check, flipping it to `true` / `false` on first render.
5. Rendering: images get a `blob:` URL via `URL.createObjectURL(new Blob([decrypted_bytes], {type: mime}))`. Other files get a download-on-click card.

### Receive path (remote, peer blob transfer)

**Slice 3c does NOT ship peer-to-peer blob transfer.** When an attachment envelope arrives at a peer who doesn't already have the blob bytes in their OPFS (the common case: Asha sends a file, Bose hasn't fetched it yet), the message renders with a "Not downloaded — sender needs to be online" placeholder.

The full peer blob transfer flow — chunked raw-bytes delivery over the data channel, in-memory reassembly, write to OPFS — is a Slice 3c follow-up tracked in `PENDING.md`. The architecture is in place: the envelope carries everything a recipient needs (blob id, key, IV, size) to request and decrypt the bytes once they arrive.

### Replay on reload

`Workspace.open`'s event-sourced replay processes `attachment.ref` envelopes the same way as `message.create`: decrypt inner payload, push into the messages projection. It does NOT eagerly probe OPFS for each blob during replay (that would serialize and stall workspaces with many attachments). Instead, `available` starts `null` for non-sender messages and the render path probes lazily per-attachment on first render.

---

## 17. Peer-to-peer blob transfer (Slice 3c.1)

Attachments (spec §9.2, see §16 above) store encrypted bytes in the sender's OPFS. For recipients to actually view an image or download a file, they need the ciphertext bytes in their own OPFS. Slice 3c.1 ships that delivery path as a pair of new transport-level packet tags.

### Wire framing

Two new tags extend the existing PeerMgr framing (see §9 for tags 0x01 envelope + 0x02 ack):

| Tag  | Meaning        | Payload (canonical msgpack)                     |
|------|----------------|-------------------------------------------------|
| 0x03 | `blob.request` | `{ blob_id: <22-char base64url> }`              |
| 0x04 | `blob.chunk`   | `{ blob_id, seq, total, data: <bytes> }`        |

Both are transport-local. Neither is signed — they're delivered inside an authenticated WebRTC data channel whose peer was already vetted by the join flow. The content they carry (blob ciphertext) is already AES-GCM encrypted at the application layer, so a transport-layer forgery gains an attacker nothing without the per-blob key from the `attachment.ref` envelope.

### Chunk size

```
CHUNK_SIZE = 14 * 1024   // 14 KB of payload per chunk
```

**Why not 16 KB.** The WebRTC data channel spec recommends 16 KB as a "safe" max message size for cross-browser interop. A 16 KB blob chunk plus the msgpack envelope overhead (map header, `blob_id` string of 23 bytes, `seq`/`total` ints, bin16 length prefix, tag byte) adds roughly 50 bytes, pushing the framed packet slightly over 16 KB. Some WebRTC stacks silently drop messages above 16 KB without raising an error on either end. Reserving 2 KB of headroom keeps every packet safely under the limit.

**A 25 MB file** (spec §14.1 hard cap) chunks into `⌈25 × 1024 × 1024 / 14336⌉ = 1829` chunks. That's a few seconds of data-channel streaming at typical LAN speeds. No backpressure logic in v1; recipients eat chunks as fast as they arrive.

### Sender path (`BlobTransfer.serveRequest`)

On receiving a `blob.request` packet:
1. Read the raw ciphertext from local OPFS via `BlobStore.getCiphertext(workspace_id, blob_id)`.
2. If not present, drop silently (maybe Slice 4 gossip will forward the request elsewhere).
3. Compute `total = ⌈ciphertext.length / CHUNK_SIZE⌉`.
4. Walk the ciphertext, slicing into consecutive chunks. For each chunk, call `PeerMgr.sendBlobChunk(workspace_id, blob_id, seq, total, slice_bytes)` which frames as tag 0x04 + msgpack payload and `dc.send()`s it.
5. Slice views are NOT copied before send. `slice = ciphertext.subarray(start, end)` produces a view on the existing buffer; msgpack encoding reads it directly. No double allocation.

### Receiver path (`BlobTransfer.receiveChunk`)

In-flight inbound transfers are tracked in a module-level `Map<blob_id, { total, chunks[], received: Set<seq>, bytesReceived, startedAt }>`.

1. Look up the in-flight entry for `chunk.blob_id`. If absent, the chunk is unsolicited — drop silently. (v1 doesn't gossip-forward unsolicited chunks; that's Slice 4.)
2. On the first chunk, size the `chunks` array to `chunk.total`.
3. Store `chunk.data` at `chunks[chunk.seq]`, add `seq` to the received set, bump `bytesReceived`.
4. Trigger a re-render so any downloading-spinner UI reflects the new progress percentage.
5. When `received.size === total`, concatenate all chunks into a single `Uint8Array` and write it to local OPFS via `BlobStore.putCiphertext(workspace_id, blob_id, assembled)`. This uses the same `blob_id` as the sender, so both sides' OPFS becomes byte-identical at that path.
6. Flip any projected-message `attachment.available` flags that reference this `blob_id`, and re-render.
7. Delete the in-flight entry.

### Ordering

WebRTC data channels with `{ ordered: true }` (the Mehfil default) deliver messages in the order they were sent. Mehfil relies on this for chunks: no reorder buffer, no per-seq out-of-order handling. If the transport were ever reconfigured to unordered mode, the receiver path would still work because chunks are indexed by explicit `seq`, but there's no timeout/retransmission logic in v1 — an out-of-order unordered channel would stall waiting for the next seq.

### Fetch triggers

`EnvelopeDispatch`'s handler for `attachment.ref` kicks off an auto-fetch on receive under two conditions:

1. The envelope signer is not the local user (sender-side paths already have the blob in local OPFS).
2. A peer is attached for the workspace.
3. The attachment is a small image: `mime.startsWith("image/")` AND `size ≤ 1 MB` (`AUTO_FETCH_SIZE_LIMIT`).

Larger files and non-image types wait for an explicit user click on the "⬇ click to download" card rendered by `renderAttachment`. The click handler calls `BlobTransfer.requestBlob` which is the same code path as auto-fetch.

### Dedupe

`BlobTransfer.requestBlob(wsid, blob_id)` is idempotent. A second call while a transfer is already in flight returns immediately — the in-flight map doubles as a mutex. After completion (or failure), the entry is deleted and a fresh request will trigger a new transfer.

---

## 18. Reactions — `reaction.add` / `reaction.remove` (Slice 3d.1)

Per spec §4.1 and §6.3, reactions are an observed-remove set keyed by `(user_id, emoji)`. Each user can add at most one copy of each emoji per message; they can remove their own but not others'.

### Envelopes

```
reaction.add     { target: <message_id>, emoji: <string> }
reaction.remove  { target: <message_id>, emoji: <string> }
```

Both are signed + encrypted under the target message's channel key. `env.from` identifies the reacting user. No sender-only restriction — anyone in the channel can react to any message.

### Projection

Reactions are not stored as separate records; they're projected directly onto the message record as:

```
msg.reactions = { [emoji]: [user_id, ...] }
```

Emoji keys are kept in insertion order (natural array iteration) so the rendered pills don't jitter as reactions arrive from different peers. Within each emoji's user_id list, duplicates are ignored (OR-Set semantics); removals filter the list by the signer's `env.from`, leaving other users' copies of the same emoji untouched.

### Dispatch + replay

Both live dispatch and `Workspace.open` replay handle `reaction.add` / `reaction.remove` the same way: look up `inner.target` in the in-memory messages array (or `msgById` map during replay), mutate `msg.reactions` in place. Because the replay loop is ts-sorted (§3a), edits/deletes/reactions always land after the `message.create` they target.

### UI

- Hover-revealed 😊 button in the message actions panel opens a reaction picker with 8 curated emoji (`👍 ❤️ 😂 😮 😢 🙏 👀 ✅`). No full emoji keyboard in v1 — too much code for too little value.
- Reaction pills below the message body show each active emoji with a count. "Mine" pills (where my user_id is in the list) get an accent-colored border.
- Clicking an existing pill toggles my own reaction on/off.
- Escape dismisses the reaction picker (see §20 polish below).

## 19. @mentions (Slice 3d.1)

Per spec §4.1 and §14.1, messages can tag other members via `@name` syntax. The signed `mentions` field in the `message.create` inner payload is the canonical source of truth:

```
message.create  { body, fmt: "text", mentions?: [user_id, ...] }
```

The `mentions` field is OPTIONAL and omitted from the wire format when empty, keeping backward compat with pre-3d.1 envelopes.

### Parsing

Send-side parsing (`parseMentions(body, members)`) uses this regex:

```
/@([\p{L}\p{N}_-]+)/gu
```

- `\p{L}` — any Unicode letter
- `\p{N}` — any Unicode digit
- `_` and `-` — conventional identifier chars
- **No `.`** — the trailing-punctuation trap. A name like "Alice" followed by a period in "@Alice." would otherwise capture "Alice." which won't match any member. Dropping `.` from the character class means names can't contain periods at the wire level either, but it's a reasonable trade-off.
- Unicode flag `u` enables `\p{…}` matching and correct handling of surrogate pairs.

For each match, look up the captured name in the current members list. If found, add the member's `user_id` to the `mentions` set (deduped via `Set`). If not found, silently ignore — the `@name` text in the body still renders as plain text on receive.

### Render-side highlighting

`renderMessageBody(body, mentions, members)` re-scans the body text with the same regex and wraps each validated mention (one whose matched name corresponds to a member whose id is in the signed `mentions` list) in a styled `<span class="mention">`. Unvalidated `@name` tokens render as plain escaped text. Every other character goes through `escapeHTML` — the span is constructed from pre-escaped substrings, so no raw HTML ever hits the output. XSS-safe by construction.

The span's text color is the member's avatar color (the deterministic 8-hue palette from Slice 3b §16), except mentions of the local user which get the accent fill for prominence.

### Composer autocomplete

When the caret is immediately after an `@word` pattern in the composer, a floating popup lists up to 6 members whose names start with the prefix (case-insensitive). Keyboard: Arrow Up/Down navigate, Enter/Tab accept, Escape dismiss. Mouse: click to accept. Acceptance replaces the `@word` with `@<full name> ` (with trailing space) and positions the caret after.

The popup is anchored above the composer textarea via `getBoundingClientRect()`. Closing is lazy: any blur event hides it after a 150ms delay so the mousedown-to-accept path on popup entries still fires.

## 20. Polish — global Escape handler and paste sanitization (Slice 3d.1)

### Global Escape

A single `window.addEventListener("keydown")` handler catches the Escape key and closes, in priority order:

1. Any open reaction picker (`.reaction-picker`)
2. The topmost `.modal-bg` — last-inserted wins since modals stack via `appendChild`

This replaces per-modal Escape wiring. When a modal is removed, `State.modal` is cleared via `setState` if it was tracking a managed modal. Covers backup, settings, invite, create channel, group DM, restore modals, and the reaction picker.

### Contenteditable paste sanitization

`beginInlineEdit`'s contenteditable div installs an `onpaste` handler that preventDefaults the event, reads `text/plain` from the clipboard, and inserts via the legacy `document.execCommand("insertText", false, text)`. This is the only API that correctly updates contenteditable's internal selection model for a plain-text insert; the modern alternatives (`Selection.collapse` + `Range.insertNode`) are verbose and fiddly.

`execCommand` is deprecated but this specific subcommand is universally supported and has no pending removal timeline. Worst case: we migrate to a Selection/Range shim, ~15 extra lines.

Additionally, `beginInlineEdit` now calls `el.textContent = original` on entry to reset the contenteditable's content from the render-time HTML (which may contain `<span class="mention">` highlights) to plain text. This prevents mention markup from polluting the edit state and ensures `el.innerText` on commit returns the user's actual edits.

---

## 21. Threaded messages (Slice 3d.2)

Per spec §4.1 and §14.1, messages can be organized into flat threads via an optional `thread: <parent_message_id>` field in the `message.create` inner payload. Threads are scoped to a single channel — a reply and its parent always share the same `ch`.

### Wire format

```
message.create  { body, fmt: "text", mentions?: [...], thread?: <message_id> }
```

`thread` is OPTIONAL and omitted from the wire when not set, so plain messages remain byte-identical to pre-3d.2. When present, it points to the ROOT parent of the thread — not the immediate ancestor. This is the **flat threading** rule: a reply to a reply still records the root parent, not the reply it was a reply to. Mehfil v1 does not support nested trees; the thread panel is a linear chronological list.

### Projection

Reply messages have `msg.thread = parent_id` on the in-memory record. Parent messages have `msg.thread === undefined`. Reply counts are **derived on the fly** during render — not stored as counter fields on the parent. This avoids the "CRDT for counters" problem entirely: the counter is `O(n)` over the channel's messages per render, which is fast for small-to-medium channels and never goes stale with respect to the envelope log.

### Main channel view filtering

The main channel view filters out reply messages (`m => !m.thread`). Parents that have at least one reply get a `💬 N replies` pill below the body which, when clicked, opens the thread panel for that parent.

### Thread panel

A second `<aside class="thread-panel">` renders alongside the main channel area when `State.threadOpen` is set to a parent message id. Layout:

- **Header** — "Thread" label + close button (✕)
- **Parent block** — the parent message rendered via `renderMessage(..., {inThreadPanel: true})` which suppresses the "reply in thread" action (you can't reply-to-a-reply) and the reply count pill (the panel IS the reply count UI)
- **Divider** — "N REPLIES" header when there's at least one reply
- **Reply list** — all messages with `thread === parent_id`, sorted by ts
- **Thread composer** — dedicated textarea that sends via `sendMessageNow(body, { threadId: State.threadOpen })`; no draft persistence (main composer keeps its channel draft)

`renderMessage` signature gained an optional `opts` object with two flags:

- `opts.replyCount` — number to render in the pill (main view only)
- `opts.inThreadPanel` — suppresses thread action button and reply count pill for messages inside the panel

### Channel switch + Escape lifecycle

The thread panel closes automatically when:

- The user switches channels (`setState({ currentChannel, threadOpen: null })`)
- The user clicks the panel's ✕ button
- The user presses Escape — global handler priority order is reaction picker → modal stack → thread panel, so repeated Escapes walk back through nested UI layers one at a time

### Deleted parent

If the parent message is absent from the projection (deleted, or the envelope never arrived), the thread panel still renders the reply chain and shows a "(parent message not available)" stub at the top. The panel remains usable for continuing the thread — v1 doesn't forbid replies to deleted parents.

### Replay

The `thread` field is persisted by both the live dispatch handler and the `Workspace.open` replay loop the same way as other `message.create` fields. Verified across a close-and-reopen cycle: parent + replies reconstruct with correct `thread` pointers and the reply count pill updates accordingly ("1 reply" → "2 replies" after adding a new reply).

---

## 22. Presence — `presence.update` (Slice 3d.3)

Per spec §4.1, `presence.update` is an **ephemeral** envelope type — signed and encrypted like any other envelope (authenticity + privacy), but never persisted to the `envelopes` store. Presence state lives only in memory on each peer. Reloading a workspace resets presence to a blank slate; peers populate it over the next heartbeat cycle.

### Ephemeral type set

A module-level `EPHEMERAL_TYPES` set declares which envelope types skip persistence:

```
const EPHEMERAL_TYPES = new Set(["presence.update", "typing.start"]);
```

`typing.start` (spec §4.1) is reserved for future use; Slice 3d.3 only ships `presence.update`. The dispatch pipeline's `EnvelopeDispatch.receive` checks membership in this set after signature verification and before the dedupe/persist step:

```
if (!EPHEMERAL_TYPES.has(env.type)) {
  const existing = await idbGet(current.wsDB, "envelopes", env.id);
  if (existing) return;
  await idbPut(current.wsDB, "envelopes", env);
}
```

Non-ephemeral types behave as before. Ephemeral types are verified and decrypted like any other envelope but never touch IndexedDB. **Verified invariant:** `idbGetAll('envelopes').length` is unchanged before and after dispatching a `presence.update`.

### Wire shape

Workspace-level envelope (`ch: null`), encrypted under the workspace root key so every member can decrypt:

```
presence.update  { status: "online" | "away" | "offline" }
```

Spec §4.1 also allows optional `custom` (custom status text) and `until` (auto-expiry timestamp); Slice 3d.3 ships only the bare `status`. Adding `custom` and `until` is additive and doesn't need a wire-format bump.

### Projection

In-memory only, on the workspace bundle:

```
bundle.presence: { [user_id]: { status, updated_at } }
```

`updated_at` is the **receiver's** local wall clock (`Date.now()` at receive time), not the sender's `env.ts`. This matters for the stale sweep (§below): wall clock skew between peers would otherwise confuse it.

### Heartbeat driver (`PresenceDriver`)

Started when a workspace becomes the active one (both via `openWorkspaceById` for returning users and via the `member.welcome` dispatch branch for joiners mid-flow). Stopped via `PresenceDriver.stop()` which tears down all timers and window listeners.

Three timers/listeners run concurrently:

1. **30-second interval.** Broadcasts the current status (`document.hasFocus() ? "online" : "away"`) on every tick. Keeps peers from flipping us to "offline" via the stale sweep after 90 seconds of inactivity.

2. **Focus/blur listeners.** Immediate transitions, not waiting for the next tick: `window.focus → sendPresence(current, "online")`, `window.blur → sendPresence(current, "away")`.

3. **`beforeunload` listener.** Best-effort final `sendPresence(current, "offline")` to give peers a chance to transition us to offline before the stale sweep catches us 90 seconds later. Not all browsers fire `beforeunload` reliably (mobile tab close, background-killed tabs), so this is best-effort only.

### Stale sweep

A second 30-second interval walks `bundle.presence` and flips any entry to `"offline"` if `Date.now() - entry.updated_at > 90_000`. The local user's own entry is skipped — my status is driven by focus/blur events, not wall-clock age. Triggers a re-render if any status changed.

The 90-second threshold is 3× the heartbeat interval. This means a genuinely-online peer who sends heartbeats on time will have `updated_at` refreshed roughly every 30 seconds, staying well clear of the stale threshold.

### `PeerMgr.attach` re-broadcast

When a new peer attaches mid-session (via the invite handshake), `PeerMgr.attach` immediately fires `sendPresence(current, status)` so the new peer learns our presence state without waiting up to 30 seconds for the next scheduled heartbeat.

### Own-state mirroring

`sendPresence(current, status)` updates `current.presence[myUserId]` **before** attempting the broadcast. This means:

- Solo workspaces (no peer attached) still see our own status update in the sidebar.
- Our own sidebar dot transitions immediately on focus/blur, without waiting for a network round trip that would never come.

### Sidebar rendering

Each member's avatar in the People section gets a small colored dot overlay:

```
.presence-dot.online   → var(--ok)    (green)
.presence-dot.away     → var(--warn)  (yellow)
.presence-dot.offline  → var(--fg-dim) (grey)
```

Members with no presence entry default to "offline". Hover title on the row shows a relative timestamp: "Online", "Away", or "Offline (last seen 5m ago)".

### Replay

`Workspace.open` does not interact with presence at all — `bundle.presence` is initialized empty on every open, and the ephemeral fast-path in `EnvelopeDispatch.receive` ensures no presence envelopes are in the store to replay. This is the correct behavior: after a reload, you genuinely don't know who's online until the first heartbeat cycle.

---

## 23. Multi-peer mesh + gossip rebroadcast (Slice 4a)

Slice 2 introduced WebRTC peer-to-peer for two-person workspaces. Slice 4a generalizes this to N peers in a partial mesh: each peer has direct data channels to some subset of the others, and envelopes propagate to the entire mesh via rebroadcast. This is the Mode B gossip pattern from spec §7.0 / §7.1.

### PeerMgr structure change

Pre-4a: `PeerMgr.peers: Map<workspace_id, {transport, peerUserId}>` — exactly one peer per workspace.

Slice 4a: `PeerMgr.peers: Map<workspace_id, Map<peer_user_id, {transport}>>` — many peers per workspace, keyed by user_id within each workspace.

Public API additions:
- `PeerMgr.attach(wsId, transport, peerUserId)` — register a new peer's transport. Multiple calls add multiple peers.
- `PeerMgr.detach(wsId, peerUserId?)` — detach one peer or, if `peerUserId` is omitted, all peers in the workspace.
- `PeerMgr.peerCount(wsId)` / `PeerMgr.hasPeers(wsId)` — predicates that callers use instead of `.peers.has()`.
- `PeerMgr.sendEnvelope(wsId, env, excludePeerId?)` — broadcasts to ALL attached peers, optionally excluding the source peer (used by the rebroadcast path).
- `PeerMgr.status(wsId)` — `"connected"` if any peer is connected, `"connecting"` if any is mid-handshake, `"offline"` otherwise, `"none"` if no peers attached.

The pre-4a single-peer call sites (`PeerMgr.peers.has(wsId)`, `PeerMgr.peers.get(wsId)`) have all been swept and replaced with the new API. Old code that did `peers.set(wsId, {transport, peerUserId})` directly would silently break with the new shape — there are none left in the codebase.

### `gossip.peer_announce` envelope

```
gossip.peer_announce  { peer: <user_id>, devices: [<device_id>, ...] }
```

Workspace-level (`ch: null`), encrypted under the workspace root key. Fired by `PeerMgr.attach` whenever a new peer's transport opens. The envelope rebroadcasts through the mesh just like any other workspace-level envelope, so peers 2+ hops away learn about the new arrival without needing a direct connection.

Recipient handler (`gossip.peer_announce` case in `EnvelopeDispatch.handle`) records the announcing user_id in `bundle.knownPeers: Set<user_id>` — this set tracks "peers we've seen broadcast through gossip at least once", distinct from the authoritative `members` projection which is built from signed `member.join` envelopes. Slice 4d (or later) may use `knownPeers` to attempt direct WebRTC connections via signaling-relayed-through-the-mesh.

### Rebroadcast logic

`PeerMgr.handlePacket` is the heart of the gossip mechanic. On every incoming `0x01` envelope packet:

1. **Seen-set check.** Drop immediately if the envelope id is already in `SeenSet` for this workspace. This is the FIRST step — before signature verification, before persistence, before anything else. Loops die in one hop.
2. **Mark as seen.** Add the id to `SeenSet` so any future hops bringing the same envelope back also drop.
3. **Process locally.** Hand to `EnvelopeDispatch.receive` which verifies, dedupes (a redundant check now, but kept for non-PeerMgr code paths), persists, decrypts, and updates projections.
4. **Ack to sender.** Point-to-point ACK back to the source peer for the single→double-check delivery state.
5. **Rebroadcast.** If the envelope type is NOT in `EPHEMERAL_TYPES`, forward via `PeerMgr.sendEnvelope(wsId, env, sourcePeerId)` — broadcasts to every attached peer EXCEPT the one we received from. The next hop's seen-set check stops the cycle.

Ephemeral envelopes (`presence.update`, `typing.start`) are NOT rebroadcast. Forwarding presence would mislead recipients about whose status the heartbeat actually reflects — each peer broadcasts its own presence directly.

### `sendEnvelope` self-marks

A subtle correctness bug to prevent: when a local helper builds an envelope and broadcasts via `PeerMgr.sendEnvelope`, peers will rebroadcast it back to us. Without protection, our own dispatch handler would process the envelope a second time. Fix: `PeerMgr.sendEnvelope` calls `SeenSet.add(wsId, env.id)` BEFORE broadcasting. So the envelope is in our seen-set the moment it leaves our outbound code path; any rebroadcast hop that reaches us drops it at the seen-set check.

This is centralized in `sendEnvelope` itself rather than scattered across every local-build helper, so it's impossible to forget when adding new envelope types.

### `SeenSet` LRU + IDB persistence

```
SeenSet._cache: WeakMap<wsDB, Map<envelope_id, ts>>
```

Module-level WeakMap **keyed by the IDB connection object (`wsDB`)**, not by workspace_id. Why: a single page (in test mode) can have multiple Mehfil "peer" bundles with the same workspace_id but distinct wsDB instances. Keying by wsDB keeps their seen-sets isolated. In production (one browser tab per origin) the two are equivalent.

API:
- `SeenSet.hydrate(wsDB)` — load all entries from the persisted `seen_set` IndexedDB store into the in-memory cache. Called once per workspace open.
- `SeenSet.has(wsId, envelope_id)` — fast O(1) lookup against `State.current.wsDB`'s cache.
- `SeenSet.add(wsId, envelope_id)` — adds to in-memory cache + persists async to IDB. If the cache exceeds `SEEN_SET_MAX = 10_000`, prunes the oldest 10% by insertion order.

The `seen_set` IndexedDB store was created in Slice 0 per spec §9.1; Slice 4a is the first to actually use it. Persistence matters because a peer that restarts and rejoins the mesh would otherwise re-broadcast every envelope it ever processed once a peer attaches (since its in-memory seen-set would be empty). Hydration on workspace open prevents this.

### Verified end-to-end

Three peers (A, B, C) in the same page with separate IDB instances and separate identities. Four real WebRTC transports establishing A↔B and B↔C (no direct A↔C). Asha sends a `message.create` envelope via her A↔B transport. Trace:

1. Asha builds envelope, persists locally, calls `sendEnvelope` → `SeenSet.add(A's seen-set, env.id)` → broadcasts to B
2. B receives via T_B_to_A.onPacket → SeenSet.has(B's seen-set, env.id) is FALSE → add → dispatch → rebroadcast via `sendEnvelope(wsId, env, ashaUid)` → goes to Charlie via T_B_to_C
3. Charlie receives → SeenSet.has(C) is FALSE → add → dispatch → rebroadcast via `sendEnvelope(wsId, env, boseUid)` → no other peers → no-op
4. Optionally (and we tested): if Charlie were also connected back to Asha somehow, the rebroadcast would reach Asha; her seen-set check would drop it. The cycle dies.

Result: both Bose and Charlie's `bundle.messages` contain "hello mesh"; both seen-sets contain the envelope id. The relay works without a direct A↔C link.

---

**Version:** living document, updated per slice. Slice 2 added §8–§11. Slice 3a extended §3 (closed-form padding). Slice 3b bumped §6 to v2 and added §12–§14. Slice 3c added §3b (BlobStore), §15 (group DMs simplification), §16 (attachments). Slice 3c.1 added §17 (peer-to-peer blob transfer) and extended §9 with tags 0x03 + 0x04. Slice 3d.1 added §18 (reactions), §19 (@mentions), §20 (polish). Slice 3d.2 added §21 (threads). Slice 3d.3 added §22 (presence) and established the ephemeral-type fast-path. Slice 4a added §23 (multi-peer mesh + gossip rebroadcast + SeenSet + `gossip.peer_announce`). Slice 4b.1 added §24 (vector clock causal delivery buffer). Slice 4b.2 added §25 (Yjs workspace doc + `WorkspaceDoc` wrapper + `workspace.patch` envelope). Slice 4c added §26 (gap detection + resync).

## 26. Gap detection + resync (Slice 4c)

Spec §6.2 / WT-31. Slice 4b.1's causal buffer holds envelopes whose own sender-counter exceeds hwm+1, so we KNOW we're missing the gap because we have a later envelope to prove it. But there's a second signal: an envelope from sender X may carry an `lc` entry like `[Y, 7]` meaning "X had seen Y's counter 7 at send time". If our own hwm for Y is below 7, we're missing some of Y's envelopes too — even with no later envelope from Y.

### `GapTracker` module (§20c2)

- `bundle.gaps: Map<user_id, Map<device_id, max_known_counter>>` — sentinel device id `lc_peek` for "I saw this in someone's lc but I don't know which device of theirs sent it"
- `GapTracker.observe(bundle, env)` — called from the dispatch pipeline after successful processing. Walks `env.lc` and for each entry from a sender OTHER than `env.from`, records the counter as a peek
- `GapTracker.missingFor(bundle, senderId)` — returns `max(0, lc_peek - max(hwm devices))`
- `GapTracker.allGaps(bundle)` — list all senders with non-zero gaps; also includes senders represented in the causal buffer (we have a future envelope but no peek)

### `gossip.resync_request` transport packet (tag 0x05)

```
{ target: <user_id>, from: <counter>, to: <counter> }
```

Transport-level packet, not a signed envelope. Same shape as the existing 0x03 / 0x04 blob transfer packets — fast and simple, no sig overhead. Receivers can implicitly trust the requester is in the workspace because they're an attached peer.

### `ResyncResponder` module (§20c3)

- `serve(workspaceId, req, requesterPeerId)` — walks the local envelopes store, filters by `env.from === req.target` and `senderCounter ∈ [req.from, req.to]`, re-broadcasts each match via `PeerMgr.sendEnvelope`
- The re-broadcast goes to ALL peers, not just the requester. Other peers in the mesh may also be missing these envelopes — opportunistic gossip. Their seen-set drops anything they already have.
- Privacy caveat: a peer in channel X but not channel Y could request a counter range and indirectly observe whether the target sends to Y. Slice 5+ should add a per-channel resync ACL.

### Gap banner UI

`renderGapBanner(current)` produces an inline banner above the message list whenever `GapTracker.allGaps(current)` returns at least one entry. Format:

- 1 sender: "Missing N messages from Alice"
- 2-3 senders: "Missing messages from Alice, Bose, Charlie"
- 4+ senders: "Missing messages from Alice, Bose and N others"

Plus a "Try to fetch" button that broadcasts one `gossip.resync_request` per sender via `PeerMgr.sendResyncRequest`. The banner disappears naturally on the next render once `hwm` advances past the lc-peek max.

### Verified end-to-end

Single bundle, three synthesized members:

- Bose joins → hwm[bose]=1, Carol joins → hwm[carol]=1
- Bose sends `message.create` with `lc: [[bose, 2], [charlie, 5]]`
- Asha's dispatch processes Bose's message → bose hwm advances to 2
- `GapTracker.observe` peeks the `[charlie, 5]` entry → records `gaps[charlie][lc_peek] = 5`
- `GapTracker.missingFor(charlie)` returns `5 - 1 = 4`
- Banner renders: **"⚠ Missing 4 messages from Charlie"** with "Try to fetch" button

Resync round trip:

- Carol joins (different identity), Asha forces gap state for Carol
- Bose's peer IDB is seeded with Carol's counter-2 / 3 / 4 envelopes
- `ResyncResponder.serve(wsId, {target: carol, from: 2, to: 4}, ...)` walks the peer store, finds 3 matches, broadcasts each
- 3 envelopes feed back into Asha's dispatch via `EnvelopeDispatch.receive`
- Asha's projection: 1 → 4 messages; hwm[carol] advances 1 → 4; `missingFor(carol)` returns 0
- The Carol banner disappears; the unrelated Charlie banner stays

## 25. Yjs workspace doc (Slice 4b.2)

Spec §5.4 + §6.3 specify Yjs as the CRDT for workspace metadata (name, channel list, member list, settings). Slice 4b.2 introduces the Yjs document alongside the existing kv `workspace_meta` record. Both stores coexist during the migration period; future slices migrate channel/member mutations to the Yjs path one at a time.

### Lazy load

Yjs is lazy-loaded from `https://esm.sh/yjs@13` during `boot()`. Module-level `let Y = null` is populated on first boot and cached by the browser thereafter. If the user is offline on first launch, boot() throws a clean error: "Couldn't load Yjs from esm.sh (offline?). Mehfil needs it to merge workspace metadata changes."

This is the second external runtime dep after the QR encoder (Slice 2). Both follow the same pattern: lazy import from esm.sh, cached by the browser.

### Document structure

Three top-level shared types:

```
doc.getMap("meta")     — workspace name, icon, settings
doc.getMap("channels") — channel_id → channel record (JSON)
doc.getMap("members")  — user_id → member record (JSON)
```

Channel and member records are stored as plain JSON-compatible values (Y.Map's nested record support). Binary fields (`x25519_pub`) are base64url-encoded as `x25519_pub_b64` so they survive Yjs's structural cloning. Derived fields (`fpBytes`) are stripped before storage and recomputed on read.

### `WorkspaceDoc` wrapper

Application code never touches `Y.Doc`, `Y.Map`, or `Y.Array` directly. The `WorkspaceDoc` module exposes named methods:

- `WorkspaceDoc.create()` — fresh doc with all top-level types initialized
- `WorkspaceDoc.load(wsDB)` — load persisted doc from `keys → workspace_yjs`, returns null if absent
- `WorkspaceDoc.save(wsDB, doc)` — write the full state as a binary snapshot to `keys → workspace_yjs`
- `WorkspaceDoc.applyUpdate(doc, bytes)` — apply a remote update via `Y.applyUpdate(doc, bytes, "remote")`
- `WorkspaceDoc.mutate(doc, fn)` — run `fn` inside a `Y.transact` and return the **full state** as update bytes (see "delta vs full state" gotcha below)
- `WorkspaceDoc.setName(doc, name)` — workspace rename
- `WorkspaceDoc.addChannel(doc, channelRec)` — add a channel to the channels map
- `WorkspaceDoc.addMember(doc, memberRec)` — add a member to the members map
- `WorkspaceDoc.getName(doc)`, `getChannels(doc)`, `getMembers(doc)` — read projections
- `WorkspaceDoc.migrateFromLegacy(wsDB, meta, channels, members)` — one-time migration: build a fresh doc from the existing kv-projected state, persist, return the new doc

### Delta vs full state — the gotcha

Yjs's `Y.encodeStateAsUpdate(doc, stateVector)` returns delta updates that reference prior operations as **causal parents**. When you apply a delta to a peer that doesn't already have the parents, Yjs marks the new ops as "pending" and does NOT integrate them into the visible state.

In a real Yjs-over-WebSocket setup, both peers exchange state vectors at handshake time and then trade incremental deltas. Mehfil's transport doesn't have a handshake-then-stream model — peers may join late, may have independently created their local doc via migration, and may receive a `workspace.patch` envelope at any time without prior synchronization.

The fix in `WorkspaceDoc.mutate`: return `Y.encodeStateAsUpdate(doc)` (full state, no state vector argument) instead of the delta. Every mutation broadcasts the full metadata blob. The cost is bytes-on-the-wire — for small workspaces (a few hundred bytes of metadata), this is negligible. Slice 5+ may add a "bootstrap on join then delta" optimization once `member.welcome` carries an authoritative snapshot.

The pre-fix bug: a 42-byte delta from Asha's rename couldn't graft onto Bose's independently-created doc. Bose's local state stayed at the original name. After the fix, the same mutation produces a 542-byte full-state update that Bose can apply and converge correctly.

### `workspace.patch` envelope

```
type: "workspace.patch"
inner: { update: <Yjs update bytes> }
```

Workspace-level (`ch: null`), encrypted under the workspace root key like every other admin-tier envelope. **Persisted to the envelopes store** — workspace patches are NOT ephemeral. They go through the normal dispatch pipeline including the causal delivery buffer (§24), though Yjs's CRDT semantics mean out-of-order arrival would be tolerated regardless.

### Dispatch handler

```
case "workspace.patch":
  WorkspaceDoc.applyUpdate(current.doc, inner.update);
  await WorkspaceDoc.save(current.wsDB, current.doc);
  // Mirror name into legacy kv + global workspaces list
  const newName = WorkspaceDoc.getName(current.doc);
  if (newName && newName !== current.meta.name) {
    current.meta.name = newName;
    await idbPut(current.wsDB, "keys", current.meta, "workspace_meta");
    // ... also update the global workspaces row
  }
  break;
```

The "mirror to legacy kv" step is a transitional shim. It exists because the sidebar render path (and other UI code) still reads `current.meta.name` directly, not via `WorkspaceDoc.getName(current.doc)`. As Slice 5 migrates UI paths to read from the Yjs doc, the shim can be removed.

### `sendWorkspacePatch` helper

The local-mutation-then-broadcast pattern:

```
const update = WorkspaceDoc.setName(current.doc, "New Name");
await sendWorkspacePatch(current, update);
```

`sendWorkspacePatch` handles all the wiring: persists the doc, mirrors the name into legacy kv + global workspaces, builds the envelope (signed + encrypted under workspace root key), persists the envelope, broadcasts via `PeerMgr.sendEnvelope` (which also marks in SeenSet to prevent reflection back to us).

### Migration path

`Workspace.open` checks for a persisted Yjs doc first. If absent (a workspace created before 4b.2), it runs `WorkspaceDoc.migrateFromLegacy` which builds a fresh doc from the current kv `workspace_meta` + projected `channels` and `members` stores. The new doc is persisted immediately so subsequent opens take the load path. Migration is idempotent — running it twice is safe but the second invocation never fires because the persisted doc now exists.

### What's in 4b.2 vs 4b.3+

Slice 4b.2 wires up the rename-workspace path end-to-end as the proof-of-concept mutation. Channel and member mutations still flow through their existing envelope types (`channel.create`, `member.join`). Those are migrated to the Yjs path in Slice 5 admin work, where they pair naturally with the rekey + member-removal flows.

### Verified end-to-end

Single bundle:
- Workspace.create → Workspace.open → migration runs → 518-byte initial Yjs doc persisted
- WorkspaceDoc.setName → 542-byte full-state update bytes
- sendWorkspacePatch → envelope persisted, legacy meta + global workspaces row mirrored
- Sidebar reflects the new name immediately

Cross-peer (two independent bundles, two independent IDB instances):
- Asha mutates her doc, sends `workspace.patch` envelope
- Bose's independently-created doc (initial name "YjsTest") receives the envelope via `EnvelopeDispatch`
- `WorkspaceDoc.applyUpdate` merges the full-state update via Yjs's CRDT
- Bose's doc name converges to "YjsTest Renamed"
- Bose's legacy `meta.name` mirrored
- Bose's persisted doc round-trips through `WorkspaceDoc.load` → still renamed

## 24. Vector clock causal delivery (Slice 4b.1)

Slice 4a's gossip rebroadcast enables messages to traverse a mesh, but it assumes envelopes arrive at each peer in causal order. In practice, gossip topologies guarantee no such thing: envelope M2 can reach you via a short path while M1 (its causal predecessor) is still traveling a longer one. Without a causal buffer, the dispatch pipeline would project M2 into the UI before M1 — a user would see a reply appear before the message it's replying to.

### The rule

Every envelope carries an `lc` field: a list of `[user_id, counter]` pairs. For Slice 4b.1 we enforce the **per-sender causal chain**: an envelope from sender X with counter N requires that we've already seen counter N-1 from X's device first. If we haven't, the envelope is buffered.

Other entries in `lc` (counters from senders OTHER than `env.from`) are informational in v1 — they tell us what the sender had seen at send time, useful for gap detection (Slice 4c) but not a blocker for delivery. Full Lamport-clock dominance comparison is spec §6.1 and can be added later without a wire-format change.

### `bundle.hwm` — high-water-mark map

Per-bundle state, populated during `Workspace.open`'s envelope replay:

```
bundle.hwm: Map<user_id, Map<device_id, highest_counter_seen>>
```

Keyed by sender user_id AND device_id (per spec §8.2 — vector clocks are per-(user, device) pair from Slice 0 onwards). Device id is the `env.dev` field on the outer envelope, NOT anything from `lc`.

Computed on workspace open by walking the envelopes store and taking the max counter seen for each (sender, device) pair. Not persisted separately — always derivable from the envelopes store.

### `bundle.causalBuffer` — pending envelopes

In-memory array of envelopes whose dependencies aren't yet satisfied. NOT persisted separately — but the envelopes themselves ARE persisted to the envelopes store before the causal check runs (see "persist-first" rule below), so a shutdown mid-buffer is recoverable.

### The persist-first rule

`EnvelopeDispatch.receive` is restructured so that for non-ephemeral envelopes, the order is:

1. Signature verification
2. **Persist to envelopes store** (via `idbPut`)
3. **Causal check** via `CausalBuffer.canDeliver`
4. If not deliverable → `CausalBuffer.buffer`, return
5. Otherwise decrypt + dispatch + advance hwm + drain buffer

This is the critical change. Pre-4b.1, persistence happened after the dispatch check. Pre-4b.1 had no causal check, so that was fine. But with a causal buffer, if we buffered BEFORE persisting, a shutdown mid-buffer would lose the buffered envelopes. Persist-first ensures that envelopes reach disk before they're eligible for buffering — if the power dies with a buffer of 5 envelopes, the next `Workspace.open` sees all 5 in the envelopes store, rebuilds hwm from scratch, and the replay loop processes them in ts-order (which happens to usually be causal order, catching the common case).

The cost: a tiny window where an envelope is persisted but unusable (failed signature verify → it's still in the store). Slice 5 adds a quarantine store + periodic cleanup. For now the window is narrow enough to accept.

### `CausalBuffer.canDeliver(bundle, env)`

Returns true iff the envelope can be delivered now. The rule:

```
senderCounter = env.lc.find([sender, counter] where sender === env.from)[1]
hwm = bundle.hwm.get(env.from)?.get(env.dev) || 0
return senderCounter <= hwm + 1
```

- `senderCounter === hwm + 1` — the normal case, new envelope advances the chain
- `senderCounter === hwm` — idempotent retry, safe to deliver again (the in-memory dedupe in `handle()` catches double-projection)
- `senderCounter < hwm` — an old envelope arriving late, safe to deliver (though usually the seen-set has already caught it)
- `senderCounter > hwm + 1` — gap, buffer until hwm catches up

### `CausalBuffer.advance(bundle, env)`

Called after successful dispatch of a non-ephemeral envelope. Bumps `bundle.hwm.get(env.from).get(env.dev)` to `max(current, senderCounter)`.

### `CausalBuffer.drain(bundle, dispatchFn)`

Called after every successful dispatch. Walks the buffer and releases any envelope whose `canDeliver` now returns true. Repeats in a loop until a full pass makes no progress — handles transitive dependency chains (m3 releases m4 which releases m5...).

Uses a callback `dispatchFn` rather than re-entering `receive()` so the causal check doesn't fire a second time on the just-released envelope. The caller (dispatch pipeline) inlines a trimmed dispatch path that skips the persist + causal steps.

### Verified end-to-end

Test: inject three message.create envelopes from the same sender with counters 2, 3, 4 (following a member.join at counter 1) in the order [m4, m2, m3]:

1. **m4 arrives** → hwm=1, counter=4, `4 > 1+1` → BUFFERED. buffer size = 1, messages = 0
2. **m2 arrives** → hwm=1, counter=2, `2 <= 1+1` → delivered, hwm advances to 2. Drain walks buffer: m4 needs hwm≥3, still buffered. buffer size = 1, messages = 1
3. **m3 arrives** → hwm=2, counter=3, `3 <= 2+1` → delivered, hwm advances to 3. Drain walks buffer: m4 needs hwm≥3, now deliverable → released → dispatched → hwm advances to 4. buffer size = 0, messages = 3
4. **Final order in the projection:** `["msg 2", "msg 3", "msg 4"]` — causal order preserved despite out-of-order arrival
5. **Reload test:** close the workspace and reopen. `hwm[bose][bd]` rehydrates to 4 from the envelope log. All 3 messages reappear in correct order.

### Replay path quirk

`Workspace.open`'s replay loop does NOT go through `EnvelopeDispatch.receive` — it processes envelopes directly via verify → decrypt → switch on type. This means the causal check is NOT enforced during replay. That's intentional: the replay loop ts-sorts envelopes first, which happens to be causal order for single-device-per-user traffic in small clusters. For edge cases (clock skew producing ts-out-of-order for causally-ordered messages), the projection order is slightly wrong but self-healing because hwm is rebuilt from scratch on every open — any new envelope arriving live will hit the live dispatch path where causal order IS enforced.

Slice 4b.2 (Yjs workspace doc) doesn't touch this. Full strict causal replay is a Slice 5+ concern if anyone reports an issue in practice.

Deferred items, open decisions, known bugs and upcoming slices are tracked in `PENDING.md`. When a decision in this file changes, update both this file and the corresponding entry there.
