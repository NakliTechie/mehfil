/**
 * Mehfil end-to-end mesh harness — multi-peer offline WebRTC over loopback.
 *
 * Proves the offline onboarding/join path without any real network, camera, or
 * device: N isolated browser contexts (= N "devices", each its own IndexedDB)
 * connect to each other via *real* WebRTC over loopback, using the app's real
 * offline handshake (host-only ICE).
 *
 * Topology: STAR. B, C, D each join the owner A directly. This isolates the
 * join-bundle fix (SB4) from the still-unfixed welcome-gate bug (W-J2) that a
 * chain would trip, and still exercises gossip: a leaf's message reaches the
 * other leaves ONLY via A's rebroadcast (B -> A -> C is real multi-hop).
 *
 * What it asserts:
 *   1. Each joiner transitions INTO the workspace after member.welcome
 *      (pre-fix this hung forever — CausalBuffer.canDeliver crashed on the
 *      join bundle's missing hwm).
 *   2. Owner's message reaches every peer.
 *   3. A leaf's message reaches the other leaves via A's gossip rebroadcast.
 *
 * Two Chromium details make loopback WebRTC work headless:
 *   - --disable-features=WebRtcHideLocalIpsWithMdns : otherwise Chrome hides
 *     loopback IPs behind unresolvable `.local` mDNS candidates and peers never
 *     connect.
 *   - navigator.onLine forced false (init script): Mehfil's isOffline() is
 *     `navigator.onLine === false`, so every transport falls back to host-only
 *     ICE — the real offline path — while loopback stays reachable.
 *
 * Run:  cd scripts && npm install && npx playwright install chromium && node verify-mesh.mjs
 * Exit: 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;

const log = (...a) => console.log(...a);
let failures = 0;
function check(cond, msg) {
  if (cond) { log(`  ✓ ${msg}`); }
  else { log(`  ✗ FAIL: ${msg}`); failures++; }
}

function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) rej(new Error('server never came up'));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

async function main() {
  // 1. Serve the repo root (single-file app; no build).
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: REPO_ROOT, stdio: 'ignore',
  });
  await waitForPort(PORT);
  log(`server up on :${PORT}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });

  const peers = [];
  async function newPeer(label) {
    const ctx = await browser.newContext();
    // Force offline mode (host-only ICE) and kill the service worker so no
    // stale shell is ever served during the run.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => log(`  [${label} pageerror] ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') log(`  [${label} console.error] ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State, { timeout: 15000 });
    const peer = { label, ctx, page };
    peers.push(peer);
    return peer;
  }
  const ev = (peer, fn, arg) => peer.page.evaluate(fn, arg);

  try {
    // 2. Owner A creates the workspace (real UI path).
    log('\n[1] Owner A creates workspace');
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Mesh Test');
    await A.page.click('text=Create workspace');
    await A.page.waitForFunction(() => window.__mehfil.State.view === 'workspace', { timeout: 10000 });
    check(true, 'A created "Mesh Test" and entered the workspace');

    // 3. Star-join B, C, D — each via the REAL offline handshake.
    const joiners = [];
    for (const name of ['Bravo', 'Charlie', 'Delta']) {
      log(`\n[2] ${name} joins A (offline host-only ICE)`);

      // A mints a fresh offline invite (own transport per joiner) and stashes it.
      const frag = await ev(A, async () => {
        const M = window.__mehfil;
        const { transport, frag } = await M.prepareInvite(true); // offline = true
        (window.__hostT = window.__hostT || []).push(transport);
        return frag;
      });

      const J = await newPeer(name);
      // Joiner runs the real join flow (beginJoinFromFragment -> beginJoinHandshake,
      // which builds the bundle the SB4 fix completes), returns its reply fragment.
      const reply = await ev(J, async ({ frag, name }) => {
        const M = window.__mehfil;
        await M.beginJoinFromFragment(frag, true);   // viaScan=true -> offline host-only ICE
        M.State.join.name = name;
        M.State.join.color = '#8b5cf6';
        await M.beginJoinHandshake();
        return M.State.join.replyFrag;
      }, { frag, name });
      check(!!reply, `${name} produced a reply fragment (answer SDP)`);

      // A accepts the reply on that joiner's transport and attaches the peer.
      const idx = joiners.length;
      await ev(A, async ({ reply, idx }) => {
        const M = window.__mehfil;
        const r = await M.InvitePayload.decodeReply(reply);
        const transport = window.__hostT[idx];
        await transport.acceptAnswer(r.answer_sdp);
        M.PeerMgr.attach(M.State.current.meta.id, transport, r.joiner_user_id);
      }, { reply, idx });

      // The SB4 assertion: joiner transitions into the workspace once the
      // welcome arrives. Pre-fix this timed out (canDeliver crashed).
      let entered = true;
      try {
        await J.page.waitForFunction(
          () => window.__mehfil.State.view === 'workspace' && !!window.__mehfil.State.current,
          { timeout: 25000 });
      } catch { entered = false; }
      check(entered, `${name} entered the workspace after member.welcome (SB4)`);
      joiners.push(J);
    }

    // 4. Owner broadcast reaches every peer.
    log('\n[3] Owner A broadcasts a message');
    await ev(A, async () => {
      const M = window.__mehfil;
      M.State.currentChannel = M.State.current.meta.general_channel_id;
      await M.sendMessageNow('hello-from-A');
    });
    for (const J of joiners) {
      let got = true;
      try {
        await J.page.waitForFunction(
          () => (window.__mehfil.State.current?.messages || []).some(m => m.body === 'hello-from-A'),
          { timeout: 15000 });
      } catch { got = false; }
      check(got, `${J.label} received owner's message`);
    }

    // 5. Gossip: a leaf's message reaches the OTHER leaves via A's rebroadcast.
    log('\n[4] Leaf Bravo broadcasts — must reach Charlie & Delta via A (gossip)');
    await ev(joiners[0], async () => {
      const M = window.__mehfil;
      M.State.currentChannel = M.State.current.meta.general_channel_id;
      await M.sendMessageNow('gossip-from-Bravo');
    });
    for (const J of [joiners[1], joiners[2], A]) {
      let got = true;
      try {
        await J.page.waitForFunction(
          () => (window.__mehfil.State.current?.messages || []).some(m => m.body === 'gossip-from-Bravo'),
          { timeout: 15000 });
      } catch { got = false; }
      check(got, `${J.label} received Bravo's message (rebroadcast)`);
    }
  } finally {
    for (const p of peers) { try { await p.ctx.close(); } catch {} }
    await browser.close();
    server.kill('SIGTERM');
  }

  log(`\n${failures === 0 ? 'PASS — all mesh assertions green' : `FAIL — ${failures} assertion(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });
