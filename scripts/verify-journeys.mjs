/**
 * Mehfil MULTI-ACTOR journey walkthrough — the runtime pass a single browser
 * pane can't do. Sets up 3 real peers (A owner + B + C) on the mesh, then walks
 * the feature journeys that involve more than one member and asserts what the
 * OTHER peers actually observe — the blind spots of the 2026-07-22 local
 * walkthrough (join, channel sync, cross-member reactions, DMs, admin removal).
 *
 * Reports console errors per peer + a pass/fail per journey. Not a fixer (that's
 * interactive /walkthrough-nt) — a detector that says what breaks end-to-end
 * with real peers. Run: node verify-journeys.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8161', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (cond, msg) => { if (cond) log(`  ✓ ${msg}`); else { log(`  ✗ FAIL: ${msg}`); failures++; } };
const errs = {};
function waitPort(p, t = 10000) { const s = Date.now(); return new Promise((res, rej) => { const f = () => { const c = net.connect(p, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(); }); c.on('error', () => { c.destroy(); Date.now() - s > t ? rej() : setTimeout(f, 150); }); }; f(); }); }
// poll a peer's page until fn() is truthy (returns true) or timeout (returns false)
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
    page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs[label].push(m.text().slice(0, 160)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    const peer = { label, ctx, page, id: null };
    peers.push(peer); return peer;
  }
  const ev = (p, fn, a) => p.page.evaluate(fn, a);
  const idOf = p => ev(p, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));

  try {
    // Setup: A creates, B + C join the mesh (real offline handshake).
    log('[setup] A creates workspace; B, C join');
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Journey');
    await A.page.click('text=Create workspace');
    await until(A, () => window.__mehfil.State.view === 'workspace', null, 10000);
    A.id = await idOf(A);
    const wsId = await ev(A, () => window.__mehfil.State.current.meta.id);
    for (const name of ['B', 'C']) {
      const inv = await ev(A, async () => { const M = window.__mehfil; const { transport, frag } = await M.prepareInvite(true); window.__hostT = window.__hostT || {}; const k = 'k' + (window.__k = (window.__k || 0) + 1); window.__hostT[k] = transport; return { frag, k }; });
      const J = await newPeer(name);
      const res = await ev(J, async ({ frag, name }) => { const M = window.__mehfil; await M.beginJoinFromFragment(frag, true); if (!M.State.join) return { fail: true }; M.State.join.name = name; M.State.join.color = '#8b5cf6'; await M.beginJoinHandshake(); return { r: M.State.join.replyFrag }; }, { frag: inv.frag, name });
      await ev(A, async ({ r, k }) => { const M = window.__mehfil; const d = await M.InvitePayload.decodeReply(r); await window.__hostT[k].acceptAnswer(d.answer_sdp); M.PeerMgr.attach(M.State.current.meta.id, window.__hostT[k], d.joiner_user_id); }, { r: res.r, k: inv.k });
      await until(J, () => window.__mehfil.State.view === 'workspace', null, 30000);
      J.id = await idOf(J);
    }
    const [A2, B, C] = peers;
    check(peers.every(p => p.id), 'all 3 peers joined the workspace');
    await sleep(3000); // let the mesh + presence settle

    // Journey 1 — channel create syncs to other members (Yjs workspace.patch).
    log('[1] A creates a channel — B & C should see it');
    await ev(A, async () => { const M = window.__mehfil; await M.sendChannelCreate(M.State.current, 'random', '', {}); }).catch(e => log('  create err: ' + e.message));
    for (const p of [B, C]) check(await until(p, () => (window.__mehfil.State.current?.channels || []).some(c => c.name === 'random')), `${p.label} sees the new #random channel`);

    // Journey 2 — message + cross-member reaction.
    log('[2] A posts a message; B reacts; A & C should see the reaction');
    await ev(A, async () => { const M = window.__mehfil; M.State.currentChannel = M.State.current.meta.general_channel_id; await M.sendMessageNow('journey-msg'); });
    for (const p of [B, C]) check(await until(p, () => (window.__mehfil.State.current?.messages || []).some(m => m.body === 'journey-msg')), `${p.label} received A's message`);
    const msgId = await ev(B, () => (window.__mehfil.State.current.messages.find(m => m.body === 'journey-msg') || {}).id);
    if (msgId) {
      await ev(B, async (mid) => { const M = window.__mehfil; await M.sendReactionAdd(M.State.current, mid, '👍'); }, msgId).catch(e => log('  reaction send err: ' + e.message));
      for (const p of [A2, C]) check(await until(p, (mid) => { const m = (window.__mehfil.State.current?.messages || []).find(x => x.id === mid); return m && m.reactions && JSON.stringify(m.reactions).includes('👍'); }, msgId, 12000), `${p.label} sees B's 👍 reaction`);
    } else check(false, 'could not resolve message id for reaction');

    // Journey 3 — B opens a DM with C.
    log('[3] B DMs C — C should get the DM');
    const cId = C.id;
    await ev(B, async (cid) => { const M = window.__mehfil; const other = M.State.current.members.find(m => m.id === cid); const ch = await M.ensureDmChannel(M.State.current, other); M.State.currentChannel = ch.id; await M.sendMessageNow('dm-hello'); }, cId).catch(e => log('  dm err: ' + e.message));
    check(await until(C, () => (window.__mehfil.State.current?.messages || []).some(m => m.body === 'dm-hello')), 'C received B\'s DM');

    // Journey 4 — admin removes a member.
    log('[4] A (owner) removes C — C should lose access, A & B should see C gone');
    await ev(A, async (cid) => { const M = window.__mehfil; await M.sendMemberRemove(M.State.current, cid); }, cId).catch(e => log('  remove err: ' + e.message));
    check(await until(C, () => window.__mehfil.State.view !== 'workspace' || !(window.__mehfil.State.current), null, 12000), 'C lost workspace access after removal');
    for (const p of [A2, B]) check(await until(p, (cid) => !(window.__mehfil.State.current?.members || []).some(m => m.id === cid), cId, 12000), `${p.label} sees C removed from members`);
  } finally {
    log('\n=== console errors per peer ===');
    for (const [k, v] of Object.entries(errs)) if (v.length) log(`  ${k}: ${v.slice(0, 4).join(' | ')}`); else log(`  ${k}: (none)`);
    for (const p of peers) { try { await p.ctx.close(); } catch {} }
    await browser.close(); server.kill('SIGTERM');
  }
  log(`\n${failures === 0 ? 'PASS — all multi-actor journeys green' : `FAIL — ${failures} journey assertion(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(1); });
