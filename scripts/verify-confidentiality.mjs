/**
 * Mehfil confidentiality harness — who gets which keys when they join.
 *
 * This exists because a real regression got past verify-mesh and
 * verify-journeys on 2026-07-23. Neither of them creates a private channel or
 * a group DM *before* someone joins, so neither touches the welcome
 * snapshot's restricted-channel path at all. A fix for finding C3 shipped
 * that silently dropped every private channel and group DM for every joiner,
 * and both harnesses stayed green. The gap was coverage, not care.
 *
 * Two properties, and they pull in opposite directions — which is exactly why
 * both belong in one test:
 *
 *   CONFIDENTIALITY  a joiner must NOT receive keys for restricted channels
 *                    they aren't a member of (finding C3). Before C3 the
 *                    welcome shipped every channel's raw key to everyone.
 *   ENTITLEMENT      a joiner MUST receive, and be able to DECRYPT, the
 *                    restricted channels they ARE a member of. It is easy to
 *                    "fix" C3 by withholding keys from everybody; that passes
 *                    a leak test and breaks the product.
 *
 * Also asserts the M9 flags survive the welcome projection, since a group DM
 * arriving flagged as a public channel is how you notice the projection is
 * lossy.
 *
 * Topology: A owns the workspace. #secret is private, members {A, B}. A posts
 * in it. THEN B joins (entitled) and C joins (not entitled).
 *
 * KNOWN LIMIT — read before trusting a green run. This asserts the two
 * user-facing properties, but it does NOT isolate the welcome-snapshot code
 * path. After a join the owner also runs replayHistory(), which re-sends the
 * original channel.create carrying per-member `wrapped_keys`, so an entitled
 * re-joiner can obtain a private channel by EITHER route. Verified by
 * experiment: this harness passes against commit f70547d, in which the
 * welcome-snapshot unwrap was completely broken — replay masked it.
 *
 * So: it will catch a leak (C getting keys it shouldn't) and it will catch a
 * total entitlement failure, but it will NOT catch the welcome path alone
 * regressing while replay still works. Isolating that needs replayHistory
 * suppressed, which tests a configuration the app never runs in. Worth doing
 * if the welcome snapshot is reworked again.
 *
 * Run: node verify-confidentiality.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8171', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (cond, msg) => { if (cond) log(`  ✓ ${msg}`); else { log(`  ✗ FAIL: ${msg}`); failures++; } };
const errs = {};

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
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs[label].push('PAGEERR ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs[label].push(m.text().slice(0, 160)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    const peer = { label, ctx, page, id: null };
    peers.push(peer);
    return peer;
  }
  const ev = (p, fn, a) => p.page.evaluate(fn, a);
  const idOf = p => ev(p, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));

  // Drives the real invite -> join handshake, same as verify-journeys.
  async function join(host, label, name) {
    const inv = await ev(host, async () => {
      const M = window.__mehfil;
      const { transport, frag } = await M.prepareInvite(true);
      window.__hostT = window.__hostT || {};
      const k = 'k' + (window.__k = (window.__k || 0) + 1);
      window.__hostT[k] = transport;
      return { frag, k };
    });
    const J = await newPeer(label);
    const res = await ev(J, async ({ frag, nm }) => {
      const M = window.__mehfil;
      await M.beginJoinFromFragment(frag, true);
      if (!M.State.join) return { fail: true };
      M.State.join.name = nm;
      M.State.join.color = '#8b5cf6';
      await M.beginJoinHandshake();
      return { r: M.State.join.replyFrag };
    }, { frag: inv.frag, nm: name });
    if (res.fail) throw new Error(`${label}: join fragment rejected`);
    await ev(host, async ({ r, k }) => {
      const M = window.__mehfil;
      const d = await M.InvitePayload.decodeReply(r);
      await window.__hostT[k].acceptAnswer(d.answer_sdp);
      M.PeerMgr.attach(M.State.current.meta.id, window.__hostT[k], d.joiner_user_id);
    }, { r: res.r, k: inv.k });
    const ok = await until(J, () => window.__mehfil.State.view === 'workspace', null, 30000);
    J.id = await idOf(J);
    return { peer: J, entered: ok };
  }

  // Everything under "keys" in the peer's workspace DB — the ground truth for
  // what it can actually decrypt, regardless of what the UI shows.
  const keyInventory = (p) => ev(p, async () => {
    const M = window.__mehfil;
    const db = M.State.current.wsDB;
    return await new Promise((res, rej) => {
      const rq = db.transaction('keys', 'readonly').objectStore('keys').getAllKeys();
      rq.onsuccess = () => res((rq.result || []).map(String).sort());
      rq.onerror = rej;
    });
  });

  try {
    log('[setup] A creates a workspace, a private channel {A,B}, and posts a secret');
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Confidential');
    await A.page.click('text=Create workspace');
    await until(A, () => window.__mehfil.State.view === 'workspace', null, 10000);
    A.id = await idOf(A);

    // B's identity has to exist before A can wrap a key for it, so B joins
    // first, THEN A makes the private channel including B, THEN C joins.
    const jb = await join(A, 'B', 'Bravo');
    check(jb.entered, 'B joined the workspace');
    const B = jb.peer;
    await sleep(2000);

    const secretId = await ev(A, async (bid) => {
      const M = window.__mehfil;
      const ch = await M.sendChannelCreate(M.State.current, 'secret', '', {
        isPrivate: true, memberIds: [M.bytesToB64Url(M.State.identity.pubkey), bid],
      });
      return ch.id;
    }, B.id);
    check(!!secretId, 'A created private #secret with members {A,B}');
    await sleep(1500);
    await ev(A, async (cid) => {
      const M = window.__mehfil;
      M.State.currentChannel = cid;               // sendMessageNow posts to the current channel
      await M.sendMessageNow('the-secret-payload');
    }, secretId);
    await sleep(2000);

    log('[1] C joins — C is NOT a member of #secret');
    const jc = await join(A, 'C', 'Charlie');
    check(jc.entered, 'C joined the workspace');
    const C = jc.peer;
    await sleep(3000);

    const cKeys = await keyInventory(C);
    const cChans = await ev(C, () => (window.__mehfil.State.current.channels || []).map(c => c.name));
    log(`    C key inventory: ${cKeys.join(', ')}`);
    log(`    C channels:      ${cChans.join(', ')}`);

    check(!cKeys.includes('ch:' + secretId), 'C did NOT receive the private channel key');
    check(!cChans.includes('secret'), 'C cannot even see that #secret exists');
    check(!cKeys.some(k => k.startsWith('sk:')), 'C received no group-DM sender keys');
    const cCanRead = await ev(C, () => (window.__mehfil.State.current.messages || []).some(m => m.body === 'the-secret-payload'));
    check(!cCanRead, 'C cannot read the secret message');

    log('[2] entitlement — B re-joins with the SAME identity, so #secret must');
    log('    arrive via the WELCOME snapshot. This is the path C3 rewrote, and');
    log('    the only way to catch a fix that withholds keys from real members.');
    const bHasKeyLive = (await keyInventory(B)).includes('ch:' + secretId);
    check(bHasKeyLive, 'B holds the private channel key from channel.create');

    // Re-join inside B's OWN browser context so the identity in the global DB
    // is reused. Wiping just the workspace DB forces the whole join handshake
    // again — and this time B is already in #secret's member list, so the key
    // can only reach it through the welcome snapshot.
    const wsIdForWipe = await ev(A, () => window.__mehfil.State.current.meta.id);
    // B's page holds the workspace DB open, which makes deleteDatabase block
    // and silently no-op — the re-join would then find the workspace still
    // present and never exercise the welcome path at all. Close it first.
    await B.page.close();
    const B2page = await B.ctx.newPage();
    errs['B2'] = [];
    B2page.on('pageerror', e => errs['B2'].push('PAGEERR ' + e.message));
    B2page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs['B2'].push(m.text().slice(0, 160)); });
    await B2page.goto(BASE);
    await B2page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    const wiped = await B2page.evaluate(async (wsid) => {
      const out = await new Promise(r => {
        const rq = indexedDB.deleteDatabase('mehfil_' + wsid);
        rq.onsuccess = () => r('deleted');
        rq.onerror = () => r('error');
        rq.onblocked = () => r('BLOCKED');
      });
      // Also drop the global workspace listing, or beginJoinFromFragment
      // short-circuits into "you already have this workspace, reopening".
      try {
        const g = await window.__mehfil.openGlobalDB();
        await new Promise(r => { const t = g.transaction('workspaces', 'readwrite'); t.objectStore('workspaces').delete(wsid); t.oncomplete = t.onerror = () => r(); });
      } catch (_) {}
      return out;
    }, wsIdForWipe);
    check(wiped === 'deleted', `B2's workspace DB actually wiped (got "${wiped}") — a BLOCKED wipe would fake a pass`);
    await B2page.reload();
    await B2page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    const B2 = { label: 'B2', ctx: B.ctx, page: B2page, id: null };
    peers.push(B2);
    const sameIdentity = (await idOf(B2)) === B.id;
    check(sameIdentity, 'B2 reuses B\'s identity (so it is already in #secret\'s member list)');

    const inv2 = await ev(A, async () => {
      const M = window.__mehfil;
      const { transport, frag } = await M.prepareInvite(true);
      window.__hostT = window.__hostT || {};
      const k = 'k' + (window.__k = (window.__k || 0) + 1);
      window.__hostT[k] = transport;
      return { frag, k };
    });
    const res2 = await ev(B2, async ({ frag }) => {
      const M = window.__mehfil;
      await M.beginJoinFromFragment(frag, true);
      if (!M.State.join) return { fail: true };
      M.State.join.name = 'Bravo';
      M.State.join.color = '#8b5cf6';
      await M.beginJoinHandshake();
      return { r: M.State.join.replyFrag };
    }, { frag: inv2.frag });
    if (!res2.fail) {
      await ev(A, async ({ r, k }) => {
        const M = window.__mehfil;
        const d = await M.InvitePayload.decodeReply(r);
        await window.__hostT[k].acceptAnswer(d.answer_sdp);
        M.PeerMgr.attach(M.State.current.meta.id, window.__hostT[k], d.joiner_user_id);
      }, { r: res2.r, k: inv2.k });
    }
    check(await until(B2, () => window.__mehfil.State.view === 'workspace', null, 30000),
      'B2 entered the workspace via a fresh join');
    await sleep(3000);

    const b2Keys = await keyInventory(B2);
    const b2Chans = await ev(B2, () => (window.__mehfil.State.current.channels || []).map(c => c.name));
    log(`    B2 key inventory: ${b2Keys.join(', ')}`);
    log(`    B2 channels:      ${b2Chans.join(', ')}`);
    check(b2Keys.includes('ch:' + secretId),
      'B2 RECEIVED the private channel key through the welcome snapshot');
    check(b2Chans.includes('secret'),
      'B2 can see #secret (entitlement preserved, not withheld from everyone)');
    const b2Priv = await ev(B2, () => (window.__mehfil.State.current.channels || []).find(c => c.name === 'secret')?.private);
    check(b2Priv === true, 'B2 projects #secret with private:true (M9 flags survived)');

    log('[3] M9 — flags survive the welcome projection');
    const cFlags = await ev(C, () => (window.__mehfil.State.current.channels || [])
      .map(c => ({ name: c.name, private: !!c.private, dm: !!c.dm, announce: !!c.announce })));
    const general = cFlags.find(c => c.name === 'general');
    check(!!general && general.private === false, 'C projects #general as public (flags applied, not defaulted)');
    check(cFlags.every(c => typeof c.private === 'boolean'), 'every projected channel carries explicit flags');

    log('\n=== console errors per peer ===');
    for (const p of peers) log(`  ${p.label}: ${errs[p.label].length ? errs[p.label].join(' | ') : '(none)'}`);
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    await browser.close();
    server.kill();
  }

  log(failures === 0 ? '\nPASS — confidentiality + entitlement green' : `\nFAIL — ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
