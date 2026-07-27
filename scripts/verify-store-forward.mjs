/**
 * Mehfil store-and-forward harness — Batch D (M1, M2, M3, M13).
 *
 * The README promises messages reach people who are offline. They did not.
 * Four properties, all driven through the REAL transports (a throwaway HTTP
 * relay implementing the actual /cursor + /envelopes contract, and real
 * PeerMgr attachments), not through mocks of our own code:
 *
 *   1. M2  — with ZERO WebRTC peers attached, a sent message still reaches
 *            the relay. `sendEnvelope` used to return before the relay push.
 *   2. M13 — same for `member.remove` + `workspace.rekey`, so a member removed
 *            while everyone was offline is actually removed everywhere, and
 *            offline members receive the new keys.
 *   3. M3  — envelopes that landed on the relay while the tab was closed are
 *            delivered on the next open. The transport used to fast-forward to
 *            the relay's head on every start, skipping exactly that backlog.
 *   4. M1  — in a 3-peer mesh, blob chunks go to the peer that asked, not to
 *            "whichever peer is first in the Map".
 *
 * NEGATIVE CONTROL: run the same file against a pre-fix build and every one of
 * these must FAIL. That is not a claim, it is a command:
 *
 *   mkdir -p /tmp/mehfil-negctl && git show main:index.html > /tmp/mehfil-negctl/index.html
 *   MEHFIL_ROOT=/tmp/mehfil-negctl PORT=8195 node verify-store-forward.mjs
 *
 * Expected on the pre-fix build: [1] [2] [3] red, [4] red-or-flaky (the old
 * first-peer fallback is right by luck whenever the requester happens to sort
 * first, so [4] pins the requester LAST to make the misroute deterministic).
 *
 * Run: node verify-store-forward.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, normalize } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.MEHFIL_ROOT || resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8194', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
// The relay lives on the SAME origin as the app. Not a shortcut: the app ships
// `connect-src 'self' https: wss:`, so a plain-http relay on another port is
// (correctly) refused. Same-origin keeps the real CSP in force during the test
// instead of testing a build with the policy relaxed.
const RELAY = `http://127.0.0.1:${PORT}`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (c, m) => { if (c) log(`  ✓ ${m}`); else { log(`  ✗ FAIL: ${m}`); failures++; } };

function waitPort(p, t = 10000) {
  const s = Date.now();
  return new Promise((res, rej) => {
    const f = () => {
      const c = net.connect(p, '127.0.0.1');
      c.on('connect', () => { c.destroy(); res(); });
      c.on('error', () => { c.destroy(); Date.now() - s > t ? rej(new Error('no server')) : setTimeout(f, 150); });
    };
    f();
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

/**
 * Static file server + throwaway relay on one origin.
 *
 * The relay half implements the contract RelayTransport actually speaks:
 *   GET  /ws/:id/cursor                  -> {cursor}
 *   GET  /ws/:id/envelopes?since=&limit= -> [{seq, data(base64)}]
 *   PUT  /ws/:id/envelopes               <- raw msgpack bytes
 * Sequence numbers are monotonic zero-padded strings so `since` is a simple
 * string > compare. `store` is readable from the test body — that is the
 * observation point for "did the envelope actually leave the device".
 */
function startServer() {
  const store = new Map(); // wsId -> [{seq, data}]
  let seqCounter = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, RELAY);
    const m = url.pathname.match(/^\/ws\/([^/]+)\/(cursor|envelopes)$/);
    if (!m) {
      // Static: serve the app under test.
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      try {
        const buf = await readFile(join(REPO_ROOT, rel === '/' ? 'index.html' : rel));
        const ext = rel.slice(rel.lastIndexOf('.'));
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        return res.end(buf);
      } catch { res.writeHead(404); return res.end('not found'); }
    }
    const wsId = decodeURIComponent(m[1]);
    const list = store.get(wsId) || [];
    if (m[2] === 'cursor') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ cursor: list.length ? list[list.length - 1].seq : '' }));
    }
    if (req.method === 'GET') {
      const since = url.searchParams.get('since') || '';
      const out = list.filter(e => !since || e.seq > since).slice(0, 100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const seq = String(++seqCounter).padStart(8, '0');
        if (!store.has(wsId)) store.set(wsId, []);
        store.get(wsId).push({ seq, data: Buffer.concat(chunks).toString('base64') });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  server.listen(PORT, '127.0.0.1');
  return {
    server,
    store,
    all: (wsId) => (store.get(wsId) || []),
    /** Inject an envelope as if another peer had pushed it while we were closed. */
    inject: (wsId, b64) => {
      const seq = String(++seqCounter).padStart(8, '0');
      if (!store.has(wsId)) store.set(wsId, []);
      store.get(wsId).push({ seq, data: b64 });
    }
  };
}

async function main() {
  const relay = startServer();
  await waitPort(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errs = [];
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('PAGEERR ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs.push(m.text().slice(0, 160)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    await page.click('text=Start a workspace');
    await page.fill('input[type=text]', 'StoreForward');
    await page.click('text=Create workspace');
    await page.waitForFunction(() => window.__mehfil.State.view === 'workspace');
    await sleep(500);

    // Attach the relay to this workspace and let it come up.
    const wsId = await page.evaluate(async (relayUrl) => {
      const M = window.__mehfil, cur = M.State.current;
      cur.relays = [{ url: relayUrl, token: '' }];
      M.RelayMgr.startForWorkspace(cur);
      return cur.meta.id;
    }, RELAY);
    await sleep(600);

    log('[1] M2 — a message reaches the relay with ZERO WebRTC peers attached');
    const peerCount = await page.evaluate((id) => window.__mehfil.PeerMgr.peerCount(id), wsId);
    check(peerCount === 0, 'precondition: no WebRTC peer is attached (this is the offline case)');
    const beforeCount = relay.all(wsId).length;
    await page.evaluate(async () => {
      await window.__mehfil.sendMessageNow('hello from an offline device');
    });
    await sleep(400);
    const afterMsg = relay.all(wsId).length;
    check(afterMsg > beforeCount, `the sent message was pushed to the relay (${beforeCount} → ${afterMsg} stored)`);

    // Decode what actually landed, so we assert on the envelope, not the count.
    const typesSeen = await page.evaluate((items) => {
      const M = window.__mehfil;
      return items.map(b64 => { try { return M.MP.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))?.type; } catch { return null; } });
    }, relay.all(wsId).map(e => e.data));
    check(typesSeen.includes('message.create'), `the stored envelope is a message.create (saw: ${JSON.stringify(typesSeen)})`);

    log('[2] M13 — member.remove + workspace.rekey also reach the relay when offline');
    const before2 = relay.all(wsId).length;
    const removeErr = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      // Seed a victim member row, then remove them through the real path.
      const victim = await M.Crypto.genIdentity();
      const vx = await M.Crypto.genX25519();
      const vid = M.bytesToB64Url(victim.pubkey);
      cur.members.push({ id: vid, name: 'Victim', role: 'member', devices: [], joined_at: Date.now(), x25519_pub: vx.x25519_pub });
      try { await M.sendMemberRemove(cur, vid); return null; } catch (e) { return e.message; }
    });
    check(removeErr === null, `sendMemberRemove completed without throwing${removeErr ? ' — ' + removeErr : ''}`);
    await sleep(500);
    const types2 = await page.evaluate((items) => {
      const M = window.__mehfil;
      return items.map(b64 => { try { return M.MP.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))?.type; } catch { return null; } });
    }, relay.all(wsId).slice(before2).map(e => e.data));
    check(types2.includes('member.remove'), `member.remove reached the relay (saw: ${JSON.stringify(types2)})`);
    check(types2.includes('workspace.rekey'), 'workspace.rekey reached the relay — offline members can still decrypt');

    log('[3] M3 — a backlog stored while the tab was closed is delivered on reopen');
    // The relay polls every 5s; wait for a read to have actually happened
    // rather than guessing a sleep. This is the cursor being written, which is
    // the thing under test — so poll for it instead of asserting on a race.
    // TransportCursor does not exist on the pre-fix build. Treat that as "no
    // cursor was persisted" rather than throwing, so the negative control runs
    // all four sections instead of aborting here.
    let savedCursor = '';
    for (let i = 0; i < 20 && !savedCursor; i++) {
      savedCursor = await page.evaluate(async (u) => {
        const M = window.__mehfil;
        if (!M.TransportCursor) return '';
        const rec = await M.TransportCursor.load(M.State.current.wsDB, 'relay:' + u);
        return (rec && rec.seq) || '';
      }, RELAY);
      if (!savedCursor) await sleep(500);
    }
    check(!!savedCursor, `the read cursor was persisted while running (cursor="${savedCursor}")`);
    // Stop the transport — this is "the tab was closed".
    await page.evaluate(() => window.__mehfil.RelayMgr.stop(window.__mehfil.State.current.meta.id));

    // Another member pushes messages while we are away. Built in-page from a
    // real second identity that is a real member of the workspace, so the
    // envelopes pass signature + device-cert + active-device checks. Their
    // vector-clock counters start at 1 and are contiguous — a synthetic gap
    // would park them in the CausalBuffer and we would be measuring that
    // instead of the cursor.
    const injected = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      const other = await M.Crypto.genIdentity();
      const otherX = await M.Crypto.genX25519();
      const cert = await M.Crypto.genDeviceCert(other.pubkey, other.privkey_pkcs8);
      const otherId = M.bytesToB64Url(other.pubkey);
      cur.members.push({
        id: otherId, name: 'Away Sender', role: 'member',
        devices: [cert.device_id], joined_at: Date.now(), x25519_pub: otherX.x25519_pub
      });
      const ds = {
        signKey: await M.Crypto.importSignKey(cert.device_privkey_pkcs8),
        cert: cert.device_cert, deviceId: cert.device_id
      };
      const idKey = await M.Crypto.importSignKey(other.privkey_pkcs8);
      const out = [];
      for (let i = 0; i < 3; i++) {
        const env = await M.Envelope.build({
          workspaceId: meta.id, channelId: meta.general_channel_id,
          channelKey: cur.channelKeys[meta.general_channel_id],
          signKey: idKey, signerPubkey: other.pubkey,
          deviceId: cert.device_id, deviceSigner: ds,
          type: 'message.create',
          inner: { body: 'sent while you were away #' + i, ts: Date.now() },
          vectorClock: [[otherId, i + 1]]
        });
        out.push(M.bytesToB64(M.MP.encode(env)));
      }
      return out;
    });
    for (const b64 of injected) relay.inject(wsId, b64);

    // Reopen: restart the transport exactly as workspace-open does.
    await page.evaluate(() => window.__mehfil.RelayMgr.startForWorkspace(window.__mehfil.State.current));
    await sleep(2500);
    // Messages are a projection over the envelope log, not a persisted store
    // (there is no idbPut to "messages" anywhere) — so assert on the live
    // projection, and on the envelope log that survives a reload.
    const delivered = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      const inMemory = (cur.messages || []).filter(m => String(m.body || '').startsWith('sent while you were away')).length;
      const envs = await M.idbGetAll(cur.wsDB, 'envelopes');
      return { inMemory, envCount: envs.length };
    });
    check(delivered.inMemory === 3,
      `all 3 backlog envelopes were delivered after reopen (got ${delivered.inMemory}/3)`);

    log('[4] M1 — blob chunks go to the peer that asked, in a 3-peer mesh');
    const r4 = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, wsId = cur.meta.id;
      // Three fake peers. The requester is attached LAST so it is never the
      // Map's first entry — that is what makes the old "send to first peer"
      // fallback deterministically wrong instead of a coin flip.
      const sent = { 'peer-A': 0, 'peer-B': 0, 'peer-requester': 0 };
      const mkTransport = (name) => ({
        send: (bytes) => { if (bytes[0] === 0x04) sent[name]++; },
        close: () => {},
        closed: new Promise(() => {}),
        onPacket: null
      });
      for (const name of ['peer-A', 'peer-B', 'peer-requester']) {
        M.PeerMgr.attach(wsId, mkTransport(name), name);
      }
      // Put a blob in our local store so serveRequest has something to serve.
      const blobId = 'blob-test-1';
      await M.BlobStore.putCiphertext(wsId, blobId, new Uint8Array(200_000).fill(7));
      // Drive the REAL ingest path: a 0x03 blob.request framed packet arriving
      // from peer-requester, through handlePacket.
      const body = M.MP.encode({ blob_id: blobId });
      const framed = new Uint8Array(1 + body.length);
      framed[0] = 0x03;
      framed.set(body, 1);
      await M.PeerMgr.handlePacket(wsId, framed, 'peer-requester');
      return sent;
    });
    check(r4['peer-requester'] > 0, `the requester received chunks (${r4['peer-requester']})`);
    check(r4['peer-A'] === 0 && r4['peer-B'] === 0,
      `no chunks were misrouted to uninvolved peers (A=${r4['peer-A']}, B=${r4['peer-B']})`);

    // ---- Regressions caught in review of this very change. Both were real
    // bugs I introduced or left, so they get permanent coverage. ----

    log('[5] An UNREACHABLE relay must not be reported as delivery');
    const r5 = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      // Point the workspace at a relay that does not answer. The transport
      // exists (so it is "configured") but never connects.
      M.PeerMgr.detach(cur.meta.id, 'peer-A');
      M.PeerMgr.detach(cur.meta.id, 'peer-B');
      M.PeerMgr.detach(cur.meta.id, 'peer-requester');
      cur.relays = [{ url: location.origin + '/nope-does-not-exist', token: '' }];
      M.RelayMgr.startForWorkspace(cur);
      await new Promise(r => setTimeout(r, 1200));
      const before = cur.messages.length;
      await M.sendMessageNow('sent while the relay is down');
      // sendMessageNow does not await the transport hand-off, so any code that
      // mutates `delivery` afterwards does so in a later task. Reading the flag
      // immediately would race past it and pass for the wrong reason — that is
      // exactly what the first version of this check did, and it went green on
      // a build that had the bug. Give the hand-off time to land first.
      await new Promise(r => setTimeout(r, 1500));
      const msg = cur.messages[cur.messages.length - 1];
      return { status: M.RelayMgr.status(cur.meta.id), delivery: msg.delivery, grew: cur.messages.length > before };
    });
    check(r5.grew === true, 'the message was composed');
    check(r5.delivery === 'stored',
      `an unreachable relay leaves the receipt "stored", so flushStoredMessages still retries (got "${r5.delivery}", relay status "${r5.status}")`);

    log('[6] First attach to an EMPTY relay still records the attach');
    const r6 = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      if (!M.TransportCursor) return { unsupported: true };
      // A relay URL this workspace has never read from, whose store is empty.
      const url = location.origin;
      const key = 'relay:' + url;
      // Clear any record so this is genuinely a first attach.
      const db = cur.wsDB;
      await new Promise(res => { const tx = db.transaction('cursors', 'readwrite'); tx.objectStore('cursors').delete(key); tx.oncomplete = res; tx.onerror = res; });
      const t = new M.RelayTransport({ url, token: '', workspaceId: 'empty-ws-' + Date.now(), wsDB: db });
      // Its workspace has no envelopes at all, so /cursor returns "".
      await t.start();
      t.close();
      const rec = await M.TransportCursor.load(db, 'relay:' + url);
      return { seq: t.cursor, rec };
    });
    if (r6.unsupported) {
      check(false, 'TransportCursor exists (pre-fix build has no cursor persistence)');
    } else {
      check(r6.seq === '', 'precondition: the relay reported an empty cursor for a fresh workspace');
      check(r6.rec && r6.rec.attached === true,
        `an empty first attach is still recorded, so the next start resumes instead of fast-forwarding past the first backlog (got ${JSON.stringify(r6.rec)})`);
    }

    log('[7] H1 (relay half) — a forged envelope must not burn a real id');
    const r7 = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      // Point the workspace back at the working relay.
      cur.relays = [{ url: location.origin, token: '' }];
      // A real member composes a genuine envelope that has NOT been delivered.
      const other = await M.Crypto.genIdentity();
      const otherX = await M.Crypto.genX25519();
      const cert = await M.Crypto.genDeviceCert(other.pubkey, other.privkey_pkcs8);
      const otherId = M.bytesToB64Url(other.pubkey);
      cur.members.push({
        id: otherId, name: 'H1 Sender', role: 'member',
        devices: [cert.device_id], joined_at: Date.now(), x25519_pub: otherX.x25519_pub
      });
      const ds = {
        signKey: await M.Crypto.importSignKey(cert.device_privkey_pkcs8),
        cert: cert.device_cert, deviceId: cert.device_id
      };
      const genuine = await M.Envelope.build({
        workspaceId: meta.id, channelId: meta.general_channel_id,
        channelKey: cur.channelKeys[meta.general_channel_id],
        signKey: await M.Crypto.importSignKey(other.privkey_pkcs8),
        signerPubkey: other.pubkey, deviceId: cert.device_id, deviceSigner: ds,
        type: 'message.create',
        inner: { body: 'the genuine message an attacker wants suppressed', ts: Date.now() },
        vectorClock: [[otherId, 1]]
      });
      // The forgery: same envelope id (id is SHA256(from|ts|nonce), so keeping
      // from/ts/n keeps it valid), but the ciphertext is tampered with, so the
      // device signature over the envelope no longer verifies.
      const forged = M.MP.decode(M.MP.encode(genuine));
      forged.ct = new Uint8Array(genuine.ct.length).fill(0x41);
      return {
        sameId: forged.id === genuine.id,
        forgedVerifies: await M.Envelope.verify(forged),
        genuineVerifies: await M.Envelope.verify(genuine),
        forgedB64: M.bytesToB64(M.MP.encode(forged)),
        genuineB64: M.bytesToB64(M.MP.encode(genuine)),
        id: genuine.id
      };
    });
    check(r7.sameId === true, 'the forgery carries the genuine envelope\'s id');
    check(r7.forgedVerifies === false, 'the forgery does not verify (it is a forgery)');
    check(r7.genuineVerifies === true, 'the genuine envelope verifies');

    // Attacker PUTs the forgery to the relay first. Only the relay URL and
    // token are needed for this — no WebRTC session with anyone.
    relay.inject(wsId, r7.forgedB64);
    await page.evaluate(() => window.__mehfil.RelayMgr.startForWorkspace(window.__mehfil.State.current));
    await sleep(2500);
    const burned = await page.evaluate((id) => window.__mehfil.SeenSet.has(window.__mehfil.State.current.meta.id, id), r7.id);
    check(burned === false, 'the forged envelope did NOT mark the id as seen (no mesh-wide suppression)');

    // Now the genuine envelope arrives. It must still be delivered.
    relay.inject(wsId, r7.genuineB64);
    await sleep(6000);
    const gotGenuine = await page.evaluate(() =>
      (window.__mehfil.State.current.messages || []).some(m => String(m.body || '').startsWith('the genuine message')));
    check(gotGenuine === true, 'the genuine message was still delivered after the forgery attempt');

    // Bridge half. Standing up a real bridge needs a Go daemon and a
    // fingerprint-confirmation modal, so this drives BridgeTransport._ingest
    // directly — still the real method on a real instance, just without the
    // HTTP hop, which is not what is under test here.
    const r7b = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      const other = await M.Crypto.genIdentity();
      const otherX = await M.Crypto.genX25519();
      const cert = await M.Crypto.genDeviceCert(other.pubkey, other.privkey_pkcs8);
      const otherId = M.bytesToB64Url(other.pubkey);
      cur.members.push({
        id: otherId, name: 'Bridge Sender', role: 'member',
        devices: [cert.device_id], joined_at: Date.now(), x25519_pub: otherX.x25519_pub
      });
      const ds = {
        signKey: await M.Crypto.importSignKey(cert.device_privkey_pkcs8),
        cert: cert.device_cert, deviceId: cert.device_id
      };
      const genuine = await M.Envelope.build({
        workspaceId: meta.id, channelId: meta.general_channel_id,
        channelKey: cur.channelKeys[meta.general_channel_id],
        signKey: await M.Crypto.importSignKey(other.privkey_pkcs8),
        signerPubkey: other.pubkey, deviceId: cert.device_id, deviceSigner: ds,
        type: 'message.create',
        inner: { body: 'bridge genuine message', ts: Date.now() },
        vectorClock: [[otherId, 1]]
      });
      const forged = M.MP.decode(M.MP.encode(genuine));
      forged.ct = new Uint8Array(genuine.ct.length).fill(0x41);

      const bt = new M.BridgeTransport({
        url: location.origin, pinnedFp: 'x', workspaceId: meta.id, wsDB: cur.wsDB,
        onFpConfirm: async () => true, onFpMismatch: () => {}
      });
      await bt._ingest({ data: M.bytesToB64(M.MP.encode(forged)) });
      const burned = await M.SeenSet.has(meta.id, genuine.id);
      await bt._ingest({ data: M.bytesToB64(M.MP.encode(genuine)) });
      const delivered = (cur.messages || []).some(m => String(m.body || '') === 'bridge genuine message');
      bt.close();
      return { burned, delivered };
    });
    check(r7b.burned === false, 'bridge: the forged envelope did NOT mark the id as seen');
    check(r7b.delivered === true, 'bridge: the genuine message was still delivered after the forgery');


    log('\n=== console errors ===');
    log('  ' + (errs.length ? errs.join(' | ') : '(none)'));
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    await browser.close().catch(() => {});
    relay.server.close();
  }
  log(failures === 0 ? '\nAll store-and-forward checks PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
