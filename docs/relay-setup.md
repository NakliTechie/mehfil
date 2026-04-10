# Setting up the Mehfil Relay

The Mehfil Relay is an optional cloud-based store-and-forward service that lets workspace members sync across the internet — even when no direct WebRTC connection is possible and no LAN bridge is running.

## What it does

- Stores encrypted envelopes for 90 days.
- Lets devices poll for missed messages when they come back online.
- Hosts pairing codes for "Join by code" invites (no QR code or URL needed).

The relay stores **only ciphertext** — it never holds keys and cannot read messages.

## Deploy to Cloudflare Workers (free tier)

The relay runs on [Cloudflare Workers](https://workers.cloudflare.com/). The free tier is sufficient for personal workspaces.

### Prerequisites

- A Cloudflare account (free)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm install -g wrangler`
- The relay source from [github.com/NakliTechie/mehfil-relay](https://github.com/NakliTechie/mehfil-relay)

### Steps

**1. Clone the relay repo**

```bash
git clone https://github.com/NakliTechie/mehfil-relay
cd mehfil-relay
```

**2. Create a KV namespace**

```bash
wrangler kv namespace create MEHFIL_KV
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "PASTE_YOUR_KV_ID_HERE"
```

**3. Set a secret bearer token**

This token authorises clients to write envelopes. Choose a long random string:

```bash
wrangler secret put MEHFIL_TOKEN
# paste your token when prompted
```

**4. Deploy**

```bash
wrangler deploy
```

Wrangler prints the relay URL, e.g.:
```
https://mehfil-relay.your-username.workers.dev
```

**5. Verify**

```bash
curl https://mehfil-relay.your-username.workers.dev/health
# {"ok":true,"ts":...}
```

### Add the relay to a workspace

1. Open Mehfil and go to the workspace.
2. Settings → Workspace → Relays → **+ Add relay**.
3. Select type **Cloudflare R2**, enter the URL and bearer token.
4. Click **Test connection** — you should see "Connected".
5. Click **Save relay**.

Mehfil immediately starts polling for missed messages and pushing new ones through the relay. Other workspace members who are added to the same relay will receive messages even when you're not simultaneously online.

### Share the relay with new members

When you add a relay, Mehfil broadcasts the relay config to any connected peers via a `workspace.patch` envelope. New members who join via invite or pairing code will automatically inherit the relay config if you're online at the time.

For members who join while you're offline, they'll receive the relay config the next time any workspace member who has the relay configured is online together.

## Cost estimate

Cloudflare Workers free tier includes:
- 100,000 KV reads/day
- 1,000 KV writes/day
- 10 ms CPU per request

For a workspace of 10 people sending 100 messages/day, expect roughly 1,000–2,000 KV operations/day — well within the free tier.

Each envelope is padded to 1 KB. At 100 messages/day for 90 days, storage is roughly 9 MB per workspace.

## Security notes

- The bearer token authorises writes. Keep it private. Anyone with the token can push garbage ciphertext to the relay (they cannot read messages — they have no keys). If the token is compromised, deploy a new one with `wrangler secret put MEHFIL_TOKEN` and update it in every workspace.
- Pairing codes are single-use: the relay deletes the payload on first retrieval.
- The relay enforces rate limiting: 100 PUT requests per IP per minute.
- Envelope TTL is 90 days. Old envelopes are automatically evicted by Cloudflare KV.

## Self-hosted alternative

The relay API is simple (PUT/GET HTTP + KV). You can implement a compatible relay on any platform that supports key-value storage and HTTP:

```
PUT  /ws/:workspace_id/envelopes          — store an envelope (body: raw msgpack bytes)
GET  /ws/:workspace_id/envelopes?since=   — poll for new envelopes
GET  /ws/:workspace_id/cursor             — get the current cursor
POST /pairing/:code_hash                  — store a pairing payload
GET  /pairing/:code_hash                  — retrieve (and delete) a pairing payload
GET  /health                              — liveness check
```

See `relay-cloudflare/src/index.js` for the full reference implementation.
