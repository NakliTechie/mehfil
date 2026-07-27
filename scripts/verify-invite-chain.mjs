/**
 * Mehfil non-owner-inviter harness — W-J2.
 *
 * Every existing harness builds a STAR: the owner invites everyone. That shape
 * hides W-J2 completely, because in a star the owner is also `members[0]`, so
 * "whoever is first in the array answers the join" is right by coincidence.
 *
 * This builds a CHAIN instead — A creates, A invites B, then **B invites C** —
 * which is the first arrangement where those two differ. Under the old rule the
 * responder is `members[0]` (A), who did not admit C, holds no data channel to
 * C, and is not the inviter C verified out of band; C's own C2 gate then drops
 * A's welcome, so C hangs on "Waiting…" with a live connection and no error.
 *
 * Asserts the outcome rather than the mechanism: C ends up an actual member of
 * a usable workspace, and everyone agrees on the membership.
 *
 * NEGATIVE CONTROL — must fail on the pre-fix build:
 *   mkdir -p /tmp/negctl-wj2 && git show main:index.html > /tmp/negctl-wj2/index.html
 *   MEHFIL_ROOT=/tmp/negctl-wj2 PORT=8231 node verify-invite-chain.mjs
 *
 * Run: node verify-invite-chain.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.MEHFIL_ROOT || resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8230', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (c, m) => { if (c) log(`  ✓ ${m}`); else { log(`  ✗ FAIL: ${m}`); failures++; } };
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
async function until(peer, fn, arg, timeout = 20000) {
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
    peers.push(peer); return peer;
  }
  const ev = async (p, fn, a) => {
    try { return await p.page.evaluate(fn, a); }
    catch (e) {
      if (!/Execution context was destroyed|Target closed|Cannot find context/.test(String(e.message))) throw e;
      log(`  (harness: evaluate raced a navigation on ${p.label} — retrying once)`);
      await p.page.waitForFunction(() => window.__mehfil && window.__mehfil.State, null, { timeout: 15000 });
      return await p.page.evaluate(fn, a);
    }
  };
  const idOf = p => ev(p, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));

  /** Run the real offline invite handshake from `host` to `joiner`. */
  async function invite(host, joiner, name) {
    const inv = await ev(host, async () => {
      const M = window.__mehfil;
      const { transport, frag } = await M.prepareInvite(true);
      window.__hostT = window.__hostT || {};
      const k = 'k' + (window.__k = (window.__k || 0) + 1);
      window.__hostT[k] = transport;
      return { frag, k };
    });
    const res = await ev(joiner, async ({ frag, name }) => {
      const M = window.__mehfil;
      await M.beginJoinFromFragment(frag, true);
      if (!M.State.join) return { fail: true };
      M.State.join.name = name; M.State.join.color = '#8b5cf6';
      await M.beginJoinHandshake();
      return { r: M.State.join.replyFrag };
    }, { frag: inv.frag, name });
    if (res.fail) throw new Error(`${joiner.label} could not decode the invite from ${host.label}`);
    await ev(host, async ({ r, k }) => {
      const M = window.__mehfil;
      const d = await M.InvitePayload.decodeReply(r);
      await window.__hostT[k].acceptAnswer(d.answer_sdp);
      M.PeerMgr.attach(M.State.current.meta.id, window.__hostT[k], d.joiner_user_id);
    }, { r: res.r, k: inv.k });
    return until(joiner, () => window.__mehfil.State.view === 'workspace', null, 30000);
  }

  try {
    log('[setup] A creates the workspace, then A invites B');
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Chain');
    await A.page.click('text=Create workspace');
    await until(A, () => window.__mehfil.State.view === 'workspace', null, 10000);
    A.id = await idOf(A);

    const B = await newPeer('B');
    const bJoined = await invite(A, B, 'Bravo');
    check(bJoined, 'B joined via the owner (the ordinary star case, should always work)');
    B.id = await idOf(B);
    await sleep(2500);

    log('[1] B — a NON-owner — invites C. This is what W-J2 is about.');
    const notOwner = await ev(B, () => {
      const M = window.__mehfil, cur = M.State.current;
      const me = M.bytesToB64Url(M.State.identity.pubkey);
      const mine = cur.members.find(m => m.id === me);
      return { role: mine?.role, isFirst: cur.members[0]?.id === me, count: cur.members.length };
    });
    check(notOwner.role !== 'owner', `precondition: B is not the owner (role "${notOwner.role}")`);
    check(notOwner.isFirst === false, 'precondition: B is NOT members[0] — so the old rule would pick someone else');

    const C = await newPeer('C');
    const cJoined = await invite(B, C, 'Charlie');
    check(cJoined, 'C reached the workspace after being invited by a non-owner');
    if (cJoined) C.id = await idOf(C);
    await sleep(4000);

    log('[2] C has a usable workspace, not an empty shell');
    const cState = await ev(C, () => {
      const M = window.__mehfil, cur = M.State.current;
      if (!cur) return { none: true };
      return {
        channels: cur.channels.length,
        members: cur.members.length,
        hasGeneral: cur.channels.some(ch => ch.id === cur.meta.general_channel_id),
        hasKey: !!cur.channelKeys[cur.meta.general_channel_id]
      };
    });
    check(!cState.none, 'C has a workspace bundle at all');
    check(cState.members >= 3, `C sees all three members (${cState.members})`);
    check(cState.hasGeneral === true, 'C has the general channel in its channel list');
    check(cState.hasKey === true, 'C holds the general channel key — it can actually read');

    log('[3] Everyone agrees C is a member');
    for (const p of [A, B]) {
      const sees = await ev(p, (cid) =>
        (window.__mehfil.State.current?.members || []).some(m => m.id === cid), C.id);
      check(sees === true, `${p.label} sees C in the member list`);
    }

    log('[4] C can send, and the others receive it');
    await ev(C, async () => {
      const M = window.__mehfil;
      M.State.currentChannel = M.State.current.meta.general_channel_id;
      await M.sendMessageNow('hello from the chain-invited peer');
    });
    for (const p of [A, B]) {
      const got = await until(p, () =>
        (window.__mehfil.State.current?.messages || []).some(m => m.body === 'hello from the chain-invited peer'),
        null, 20000);
      check(got, `${p.label} received C's message`);
    }

    log('\n=== console errors per peer ===');
    for (const p of peers) log(`  ${p.label}: ${errs[p.label].length ? errs[p.label].join(' | ') : '(none)'}`);
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    for (const p of peers) { try { await p.ctx.close(); } catch {} }
    await browser.close().catch(() => {});
    server.kill();
  }
  log(failures === 0 ? '\nPASS — a non-owner can invite' : `\nFAIL — ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
