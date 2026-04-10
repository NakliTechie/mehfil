# Security

## Threat model

Mehfil is a local-first, peer-to-peer encrypted chat application. There is no central server that stores messages or keys. The threat model assumes:

- **Passive network adversaries** (eavesdroppers on the LAN or internet) — cannot read messages or learn workspace membership.
- **Active network adversaries** (MITM on the signaling path) — mitigated by the out-of-band fingerprint verification step during invite. An attacker who intercepts the invite URL still cannot forge membership without the inviter's Ed25519 private key.
- **Compromised relay/bridge operators** — can see ciphertext and metadata (who sent to whom, when), but cannot decrypt messages. The Cloudflare Worker relay and the LAN bridge are both store-and-forward only; they never hold keys.
- **Curious browser operator** (same-origin page running in the same browser profile) — Mehfil stores all sensitive material in IndexedDB and OPFS, both of which are same-origin isolated.

Mehfil does **not** protect against:

- **Compromised endpoint** — if the device is compromised (malware, full-disk access), all keys and plaintext are accessible.
- **Physical access attacks** — identity keys are stored in IndexedDB without an additional passphrase lock (unless the user exports a backup, which is PBKDF2-wrapped).
- **Metadata analysis on the relay/bridge** — message timing and size are partially visible to a relay operator. The 1 KB envelope padding reduces size leakage but does not eliminate it.
- **Per-message forward secrecy** — Mehfil does not ratchet keys. If a workspace root key or channel key is later compromised, historical messages encrypted under that key are at risk. Key rotation happens only on member removal (via `workspace.rekey` and `channel.rekey` envelopes).

## Cryptographic primitives

| Use | Algorithm | Key size |
|-----|-----------|----------|
| Identity signing | Ed25519 (Web Crypto) | 256-bit |
| ECDH key agreement | X25519 (Web Crypto) | 256-bit |
| Symmetric encryption | AES-256-GCM | 256-bit |
| Key wrapping | AES-256-GCM (ECDH-derived KEK) | 256-bit |
| Identity backup | PBKDF2-SHA256, 600,000 iterations | 256-bit output |
| Pairing code KDF | PBKDF2-SHA256, 300,000 iterations | 256-bit output |
| Fingerprints | SHA-256 (first 16 bytes) | — |
| Bridge fingerprint | SHA-256 of Ed25519 pubkey (first 16 bytes) | — |

All cryptographic operations use the browser's native Web Crypto API (`crypto.subtle`). No third-party crypto libraries are used for key material.

## Key hierarchy

```
Identity keypair (Ed25519 + X25519) — per device, never leaves the device
  │
  └─► Workspace root key (AES-256)
        Stored in IndexedDB, encrypted under nothing at rest (protected
        by same-origin isolation and the device's OS security model)
        │
        ├─► Public channel keys (AES-256, one per channel)
        │     Distributed in channel.create envelopes encrypted under root key
        │
        └─► Private channel / DM keys (AES-256, one per channel)
              Per-member wrapped under ECDH-derived KEK (X25519)
              Non-members cannot unwrap
```

## Envelope security

Every envelope carries:

- **Ciphertext** encrypted under the relevant channel key (AES-256-GCM, fresh 12-byte IV)
- **Ed25519 signature** over the canonical MessagePack encoding of the envelope fields
- **Vector clock** for causal ordering
- **1 KB padding** to obscure message length

Envelopes are verified by `Envelope.verify()` before being dispatched. Any envelope with an invalid signature is silently dropped and never persisted.

## Invite security

The invite URL carries the workspace root key in the URL fragment (`#` — not sent to any server). It also carries the inviter's Ed25519 public key and a challenge signed by the inviter.

During join, the joiner:
1. Verifies the inviter's signature on the challenge.
2. Displays the inviter's fingerprint for the user to confirm out-of-band (shown as a 4×4 colored shape grid).
3. Signs a `member.join` envelope with their own identity key, encrypted under the workspace root key.

The inviter, on receipt:
1. Re-displays the joiner's fingerprint for confirmation.
2. Sends a `member.welcome` snapshot encrypted under the workspace root key.

**If fingerprint verification is skipped**, a MITM attacker who intercepted the invite URL could impersonate the joiner. The application prevents skipping by requiring the user to click an explicit "fingerprint matches" button (same-size buttons, no keyboard shortcut to bypass).

## Relay security

The Cloudflare Worker relay uses a bearer token for write access. The token should be kept private. Anyone with the token can write arbitrary ciphertext to the relay — they cannot decrypt it (they have no keys), but they could flood the relay with garbage envelopes (which recipients will drop on signature failure).

Rate limiting (100 PUT requests per IP per minute) is enforced by the relay.

Pairing codes are single-use: the relay deletes the pairing payload on first retrieval.

## Bridge security

The LAN bridge announces itself via mDNS. Any device on the same LAN can reach it. The bridge trusts all clients to push well-formed envelopes — it does not verify signatures (that is the recipient's job).

**Fingerprint pinning** prevents MITM attacks on the bridge connection. On first connect, Mehfil fetches the bridge's Ed25519 fingerprint via `/health` and asks the user to confirm it matches the value printed in the bridge's terminal. The fingerprint is stored in the workspace metadata and verified on every subsequent connection. A mismatch triggers a blocking warning modal and the connection is refused.

## Reporting a vulnerability

Open an issue at [github.com/NakliTechie/mehfil](https://github.com/NakliTechie/mehfil) or email chirag@naklitechie.com. Please include a description of the vulnerability, steps to reproduce, and your assessment of severity. I aim to respond within 72 hours.
