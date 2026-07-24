/**
 * Mehfil device-revocation harness — proves C5 actually cuts a device off.
 *
 * Before this, revocation was cosmetic: it edited a device-id list and nothing
 * checked it, so a revoked (or stolen) device kept full signing authority
 * forever. The fix is per-device certified keys + an active-device gate at
 * ingest. This asserts the observable consequence: after A revokes B's device,
 * a message B sends is DROPPED by A, while a message B sent before revocation
 * was delivered.
 *
 * Topology: A owns the workspace, B joins. A (admin) revokes B's device.
 *
 * Run: node verify-revocation.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8181', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (cond, msg) => { if (cond) log(`  ✓ ${msg}`); else { log(`  ✗ FAIL: ${msg}`); failures++; } };
const errs = {};
const warns = {};

function waitPort(p, t = 10000) {
  const s = Date.now();
  return new Promise((res, rej) => {
    const f = () => { const c = net.connect(p, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(); }); c.on('error', () => { c.destroy(); Date.now() - s > t ? rej(new Error('no server')) : setTimeout(f, 150); }); };
    f();
  });
}
async function until(peer, fn, arg, timeout = 15000) {
  try { await peer.page.waitForFunction(fn, arg, { timeout }); return true; } catch { return false; }
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitPort(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const peers = [];
  async function newPeer(label) {
    errs[label] = [];
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} }); });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs[label].push('PAGEERR ' + e.message));
    warns[label] = [];
    page.on('console', m => {
      const t = m.text();
      if (m.type() === 'error' && !/frame-ancestors/.test(t)) errs[label].push(t.slice(0, 160));
      if (m.type() === 'warning' || m.type() === 'warn') warns[label].push(t.slice(0, 200));
    });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    const peer = { label, ctx, page, id: null };
    peers.push(peer);
    return peer;
  }
  const ev = (p, fn, a) => p.page.evaluate(fn, a);
  const idOf = p => ev(p, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));

  try {
    log('[setup] A creates a workspace; B joins');
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Revocation');
    await A.page.click('text=Create workspace');
    await until(A, () => window.__mehfil.State.view === 'workspace', null, 10000);
    A.id = await idOf(A);

    const inv = await ev(A, async () => { const M = window.__mehfil; const { transport, frag } = await M.prepareInvite(true); window.__hostT = window.__hostT || {}; const k = 'k' + (window.__k = (window.__k || 0) + 1); window.__hostT[k] = transport; return { frag, k }; });
    const B = await newPeer('B');
    const res = await ev(B, async ({ frag }) => { const M = window.__mehfil; await M.beginJoinFromFragment(frag, true); if (!M.State.join) return { fail: true }; M.State.join.name = 'Bravo'; M.State.join.color = '#8b5cf6'; await M.beginJoinHandshake(); return { r: M.State.join.replyFrag }; }, { frag: inv.frag });
    await ev(A, async ({ r, k }) => { const M = window.__mehfil; const d = await M.InvitePayload.decodeReply(r); await window.__hostT[k].acceptAnswer(d.answer_sdp); M.PeerMgr.attach(M.State.current.meta.id, window.__hostT[k], d.joiner_user_id); }, { r: res.r, k: inv.k });
    check(await until(B, () => window.__mehfil.State.view === 'workspace', null, 30000), 'B joined the workspace');
    B.id = await idOf(B);
    await sleep(2500);

    const bDevice = await ev(B, () => window.__mehfil.State.identity.device_id);
    log(`    B's device_id: ${bDevice}`);
    const aSeesBdevice = await ev(A, (bid) => { const m = window.__mehfil.State.current.members.find(x => x.id === bid); return (m?.devices || []).slice(); }, B.id);
    check(aSeesBdevice.includes(bDevice), 'A sees B\'s device in B\'s active-device list');

    log('[1] B sends a message BEFORE revocation — A must receive it');
    await ev(B, () => { const M = window.__mehfil; M.State.currentChannel = M.State.current.meta.general_channel_id; return M.sendMessageNow('before-revoke'); });
    check(await until(A, () => (window.__mehfil.State.current?.messages || []).some(m => m.body === 'before-revoke'), null, 12000),
      'A received B\'s pre-revocation message');

    // The gate defends against a device that does NOT cooperate — a stolen or
    // malicious one that ignores its own revocation. A cooperating B tears
    // itself down (handleSelfRevocation), which would mask the gate. So build a
    // validly-signed envelope from B's device NOW, while B still has its keys,
    // and hold it to inject after revocation.
    log('[2] capture a validly-signed envelope from B\'s device (pre-revoke)');
    const forged = await ev(B, async () => {
      const M = window.__mehfil;
      const cur = M.State.current;
      const meta = cur.meta;
      const chId = meta.general_channel_id;
      const env = await M.Envelope.build({
        workspaceId: meta.id, channelId: chId,
        channelKey: cur.channelKeys[chId],
        signKey: await M.Crypto.importSignKey(M.State.identity.privkey_pkcs8),
        signerPubkey: M.State.identity.pubkey,
        deviceId: M.State.identity.device_id,
        type: 'message.create',
        inner: { id: 'forged-' + Date.now(), body: 'after-revoke', ts: Date.now() },
        vectorClock: [[M.bytesToB64Url(M.State.identity.pubkey), (meta.lc_counter || 0) + 5]],
      });
      return M.bytesToB64Url(M.MP.encode(env));
    });
    check(!!forged, 'built a valid envelope signed by B\'s (soon-revoked) device');

    log('[3] A (admin) revokes B\'s device');
    await ev(A, async (bdev) => { const M = window.__mehfil; await M.sendDeviceRevoke(M.State.current, bdev); }, bDevice);
    check(await until(A, (bid) => { const m = window.__mehfil.State.current.members.find(x => x.id === bid); return !(m?.devices || []).length; }, B.id, 8000),
      'A removed B\'s device from the active list');
    await sleep(1500);

    log('[4] inject B\'s pre-built envelope into A — the ingest gate must drop it');
    const beforeCount = await ev(A, () => (window.__mehfil.State.current?.messages || []).length);
    await ev(A, async (b64) => {
      const M = window.__mehfil;
      const env = M.MP.decode(M.b64UrlToBytes(b64));
      // Sanity: it still verifies (the cert is valid) — so ONLY the active-
      // device gate can be what stops it.
      window.__verifies = await M.Envelope.verify(env);
      await M.EnvelopeDispatch.receive(M.State.current.meta.id, env);
    }, forged);
    const stillVerifies = await ev(A, () => window.__verifies);
    check(stillVerifies === true, 'the envelope\'s signature+cert still verify (revocation is not a crypto failure)');
    await sleep(500);
    const arrived = await ev(A, () => (window.__mehfil.State.current?.messages || []).some(m => m.body === 'after-revoke'));
    check(!arrived, 'A DROPPED the revoked device\'s envelope despite a valid signature');
    const sawDropWarn = warns['A'].some(e => /revoked\/unknown device/.test(e));
    check(sawDropWarn, 'A\'s ingest gate logged the revoked-device drop (the enforcement fired)');

    log('\n=== console errors per peer (A\'s revoked-device drops are warnings, filtered) ===');
    for (const p of peers) {
      const real = errs[p.label].filter(e => !/revoked\/unknown device/.test(e));
      log(`  ${p.label}: ${real.length ? real.join(' | ') : '(none)'}`);
    }
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    await browser.close();
    server.kill();
  }

  log(failures === 0 ? '\nPASS — device revocation is enforced' : `\nFAIL — ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
