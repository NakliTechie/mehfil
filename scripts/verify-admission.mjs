/**
 * Mehfil admission-control harness — proves the 2026-07-24 decision:
 * admission grants + admin-only promote (closes C4's residual).
 *
 * Two properties, both against the REAL dispatch:
 *   1. A non-member (root-key holder, e.g. invite interceptor / removed member)
 *      cannot inject a member.join — with no grant OR a forged self-signed
 *      grant — even though the envelope's signature and device cert verify.
 *   2. A plain-member (non-admin) signature does not count toward a promote,
 *      so sock puppets can't self-escalate; a sole owner can still bootstrap.
 *
 * The legitimate join path (grant issued over the data channel, attached to
 * member.join, verified by peers) is exercised end-to-end by verify-mesh /
 * verify-journeys — if grants broke real joins those would fail. This harness
 * covers the adversarial side, which they don't.
 *
 * Negative control: the same attacks succeed on the pre-admission build
 * (verified by hand against `main` — the attacker is added, a puppet promotes).
 *
 * Run: node verify-admission.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8191', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (c, m) => { if (c) log(`  ✓ ${m}`); else { log(`  ✗ FAIL: ${m}`); failures++; } };

function waitPort(p, t = 10000) {
  const s = Date.now();
  return new Promise((res, rej) => {
    const f = () => { const c = net.connect(p, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(); }); c.on('error', () => { c.destroy(); Date.now() - s > t ? rej(new Error('no server')) : setTimeout(f, 150); }); };
    f();
  });
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitPort(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errs = [];
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} }); });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('PAGEERR ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs.push(m.text().slice(0, 160)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    await page.click('text=Start a workspace');
    await page.fill('input[type=text]', 'Admission');
    await page.click('text=Create workspace');
    await page.waitForFunction(() => window.__mehfil.State.view === 'workspace');
    await sleep(500);

    log('[1] Admission grants — a non-member cannot inject member.join');
    const r1 = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      const before = cur.members.length;
      // Attacker: a fresh identity holding the workspace root key (e.g. an
      // invite interceptor) but not a member.
      const atk = await M.Crypto.genIdentity();
      const atkX = await M.Crypto.genX25519();
      const atkDev = await M.Crypto.genDeviceCert(atk.pubkey, atk.privkey_pkcs8);
      const atkId = M.bytesToB64Url(atk.pubkey);
      const ds = { signKey: await M.Crypto.importSignKey(atkDev.device_privkey_pkcs8), cert: atkDev.device_cert, deviceId: atkDev.device_id };
      // signKey is the identity key (build uses the device signer for the
      // envelope sig; the identity key is passed for shape compatibility).
      const idKey = await M.Crypto.importSignKey(atk.privkey_pkcs8);
      const mk = (inner) => M.Envelope.build({ workspaceId: meta.id, channelId: null, channelKey: cur.rootKey, signKey: idKey, signerPubkey: atk.pubkey, deviceId: atkDev.device_id, type: 'member.join', inner, vectorClock: [[atkId, 1]], deviceSigner: ds });
      const out = {};
      // No grant
      const e1 = await mk({ profile: { name: 'Evil', color: '#f00' }, devices: [atkDev.device_id], x25519_pub: atkX.x25519_pub });
      out.e1verifies = await M.Envelope.verify(e1);
      await M.EnvelopeDispatch.receive(meta.id, e1);
      out.addedNoGrant = cur.members.some(m => m.id === atkId);
      // Forged grant (attacker self-signs; issuer = attacker, not a member)
      const nonce = M.bytesToB64(M.Crypto.rand(16)), ts = Date.now();
      const gb = M.MP.encode({ t: 'admission', joiner: atkId, ws: meta.id, nonce, ts, issuer: atkId });
      const gsig = await M.Crypto.sign(idKey, gb);
      const e2 = await mk({ profile: { name: 'Evil2', color: '#f00' }, devices: [atkDev.device_id], x25519_pub: atkX.x25519_pub, grant: { joiner: atkId, ws: meta.id, nonce, ts, issuer: atkId, sig: gsig } });
      out.e2verifies = await M.Envelope.verify(e2);
      await M.EnvelopeDispatch.receive(meta.id, e2);
      out.addedForgedGrant = cur.members.some(m => m.id === atkId);
      out.countUnchanged = cur.members.length === before;
      return out;
    });
    check(r1.e1verifies === true, 'the no-grant member.join is cryptographically valid (sig+cert verify)');
    check(r1.addedNoGrant === false, 'a member.join with NO grant is dropped (non-member cannot self-admit)');
    check(r1.e2verifies === true, 'the forged-grant member.join is cryptographically valid');
    check(r1.addedForgedGrant === false, 'a member.join with a grant issued by a NON-member is dropped');
    check(r1.countUnchanged === true, 'no attacker was added to the member list');

    log('[2] Admin-only promote — a non-admin signature does not count');
    const r2 = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      // Seed a plain member row directly (no join needed for this unit check).
      const mem = await M.Crypto.genIdentity();
      const memId = M.bytesToB64Url(mem.pubkey);
      cur.members.push({ id: memId, name: 'Mem', role: 'member', devices: [], joined_at: Date.now() });
      const aId = M.bytesToB64Url(M.State.identity.pubkey);
      const aKey = await M.Crypto.importSignKey(M.State.identity.privkey_pkcs8);
      const ds = await M.Identity.deviceSigner(M.State.identity);
      const buildPromote = (signers, tgt, n, t) => M.Envelope.build({ workspaceId: meta.id, channelId: null, channelKey: cur.rootKey, signKey: aKey, signerPubkey: M.State.identity.pubkey, deviceId: M.State.identity.device_id, type: 'member.promote', inner: { target: tgt, ts: t, nonce: n, signers }, vectorClock: [[aId, (meta.lc_counter || 0) + 1]], deviceSigner: ds });
      const out = {};
      // Negative: two non-admin puppet keys try to promote the real member.
      const p1 = await M.Crypto.genIdentity(), p2 = await M.Crypto.genIdentity();
      const n1 = M.Crypto.rand(12), t1 = Date.now();
      const sp1 = M.MP.encode({ type: 'member.promote', target: memId, ts: t1, nonce: n1 });
      const s1 = await M.Crypto.sign(await M.Crypto.importSignKey(p1.privkey_pkcs8), sp1);
      const s2 = await M.Crypto.sign(await M.Crypto.importSignKey(p2.privkey_pkcs8), sp1);
      const eNeg = await buildPromote([{ user_id: M.bytesToB64Url(p1.pubkey), sig: s1 }, { user_id: M.bytesToB64Url(p2.pubkey), sig: s2 }], memId, n1, t1);
      await M.EnvelopeDispatch.receive(meta.id, eNeg);
      out.afterPuppets = cur.members.find(m => m.id === memId)?.role;
      // Positive: sole owner (A) promotes the member — threshold min(2,1)=1.
      const n2 = M.Crypto.rand(12), t2 = Date.now();
      const sp2 = M.MP.encode({ type: 'member.promote', target: memId, ts: t2, nonce: n2 });
      const as = await M.Crypto.sign(aKey, sp2);
      const ePos = await buildPromote([{ user_id: aId, sig: as }], memId, n2, t2);
      await M.EnvelopeDispatch.receive(meta.id, ePos);
      out.afterOwner = cur.members.find(m => m.id === memId)?.role;
      return out;
    });
    check(r2.afterPuppets === 'member', 'two non-admin puppet signatures do NOT reach the promote threshold');
    check(r2.afterOwner === 'admin', 'the sole owner can still promote (bootstrap preserved)');

    log('\n=== console errors ===');
    log('  ' + (errs.length ? errs.join(' | ') : '(none)'));
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    await browser.close();
    server.kill();
  }
  log(failures === 0 ? '\nPASS — admission control enforced' : `\nFAIL — ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
