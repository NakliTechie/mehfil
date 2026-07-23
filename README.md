# Mehfil

Browser-native, local-first team chat. Single HTML file. No accounts. No central server. Messages are end-to-end encrypted, signed by the sender, and stored on the devices of workspace members — never in the cloud.

**[👉 Try it now — naklitechie.github.io/mehfil](https://naklitechie.github.io/mehfil/)** · no signup, no download

> **Status:** v2 + a fleet of daily-driver polish. The full Slack-benchmark feature set — channels, DMs, threads, reactions, files, huddles with screen share, Canvas collab docs, voice/screen messages, polls, checklists, scheduled send, search, ⌘K switcher, and more — plus a **self-organizing offline mesh** (below), a PWA-installable offline shell, and an in-browser test suite. See [docs/features.md](docs/features.md) for the complete list. **Alpha stage — wire/storage breakage is acceptable; not yet security-audited (see [SECURITY.md](SECURITY.md)).**

## What it is

- **Local-first** — a workspace is created in a fresh browser tab with no signup. Keys and messages live only on members' devices.
- **End-to-end encrypted** — Ed25519 signing + X25519 ECDH + AES-256-GCM, all via native Web Crypto, no external crypto libs. Per-channel keys wrapped per member.
- **No central server** — peers connect over WebRTC; an optional Cloudflare Workers relay and/or a LAN bridge add store-and-forward, but neither ever holds keys or sees plaintext.
- **Works fully offline** — the whole app (including Yjs) is inlined, so it boots with no internet. On a shared WiFi or a phone hotspot, peers connect directly with a QR-code handshake — no signaling server, no accounts, no signal needed.
- **Self-organizing mesh** — you scan **one** QR to join, and the app auto-wires direct connections to several other members through the mesh (bounded-degree, self-healing). The group stays connected even when the person who invited you — or the original host — leaves. Validated by an automated real-WebRTC test **from 4 up to 30 peers** (`scripts/verify-mesh-scale.mjs`); see [docs/architecture.md](docs/architecture.md).
- **One HTML file** — the entire app (markup, styles, ~16,400 lines of vanilla JS, Yjs + QR libs inlined) in a single ~910 KB file. No framework, no build step.

Part of the [naklios-universe](https://naklitechie.github.io/) single-file app series.

## Run it

**Fastest path** — open the hosted version at **[naklitechie.github.io/mehfil](https://naklitechie.github.io/mehfil/)**. It's the same single HTML file served from GitHub Pages; your keys and messages still live only in your browser.

**Or serve locally** if you'd rather trust nothing but your own machine:

```sh
cd Mehfil
python3 -m http.server 8103
# open http://localhost:8103
```

Or open `index.html` directly. Requires Web Crypto Ed25519: Chrome 113+, Firefox 130+, Safari 17+.

**New here?** The [User Guide](guide/index.html) walks through every feature with screenshots — also via the `?` button on the landing page or **Guide ↗** in Settings. Then try the [two-person quickstart](docs/features.md#getting-connected--two-person-quickstart).

## Documentation

| Doc | Purpose |
|---|---|
| [docs/features.md](docs/features.md) | **Feature deep dive** — the complete capability tour: messaging, Canvas, huddles, slash commands, admin, palette, roadmap |
| [docs/architecture.md](docs/architecture.md) | **Architecture & tech deep dive** — single-file design, event-sourced storage, CRDT metadata, crypto stack, networking layers, PWA, dev flags |
| [guide/index.html](guide/index.html) | **User guide** — feature walkthroughs with screenshots, mobile guide |
| [MEHFIL-SPEC.md](MEHFIL-SPEC.md) | v1 specification — the authoritative protocol description |
| [PROTOCOL.md](PROTOCOL.md) | Pinned implementation choices (msgpack, envelope format, key hierarchy) |
| [MEHFIL-WALKTHROUGHS.md](MEHFIL-WALKTHROUGHS.md) | 35 testable user-flow scenarios across 8 phases |
| [SECURITY.md](SECURITY.md) | Threat model, cryptographic primitives, vulnerability reporting |
| [docs/relay-setup.md](docs/relay-setup.md) | How to deploy the Cloudflare Workers relay |
| [docs/bridge-setup.md](docs/bridge-setup.md) | How to install and run the LAN bridge |

## Author

[@NakliTechie](https://naklitechie.github.io)
