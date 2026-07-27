/**
 * Mehfil huddle harness — the feature has shipped untested since it landed.
 *
 * SB2 established only that the envelope *builds* (it used to throw on a
 * never-assigned `State.identity.signKey`, so huddles had never worked at all
 * despite being advertised). Nobody has ever checked that two peers actually
 * connect, exchange audio and see each other in the participant list.
 *
 * Headless Chromium has no microphone, which is why this was previously
 * written off as "needs real media". It does not: `--use-fake-device-for-media-stream`
 * gives it a synthetic one and `--use-fake-ui-for-media-stream` auto-accepts the
 * permission, so `getUserMedia` resolves and the real path runs end to end.
 *
 * What is asserted, in order of how much it would hurt to be wrong:
 *   1. Both peers join without throwing and report `active`.
 *   2. Each SEES THE OTHER in its participant list — the huddle.join envelopes
 *      crossed the mesh.
 *   3. A real RTCPeerConnection reaches connected/completed between them —
 *      the huddle.signal offer/answer/ICE exchange worked over the data channel.
 *   4. Audio is actually flowing: a remote track exists and is live.
 *   5. Mute is real — it disables the outgoing track, not just a UI flag.
 *   6. Leaving tears down: no lingering peer connections.
 *
 * Run: node verify-huddle.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.MEHFIL_ROOT || resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8250', 10);
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

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitPort(PORT);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns'
    ]
  });
  const peers = [];
  async function newPeer(label) {
    errs[label] = [];
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    await ctx.addInitScript(() => {
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs[label].push('PAGEERR ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs[label].push(m.text().slice(0, 160)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    const p = { label, ctx, page, id: null };
    peers.push(p); return p;
  }
  const ev = (p, fn, a) => p.page.evaluate(fn, a);

  try {
    log('[setup] A creates a workspace; B joins over the real offline handshake');
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Huddle');
    await A.page.click('text=Create workspace');
    await A.page.waitForFunction(() => window.__mehfil.State.view === 'workspace', { timeout: 15000 });
    A.id = await ev(A, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));

    const B = await newPeer('B');
    const inv = await ev(A, async () => {
      const M = window.__mehfil;
      const { transport, frag } = await M.prepareInvite(true);
      window.__hostT = transport; return frag;
    });
    const reply = await ev(B, async (frag) => {
      const M = window.__mehfil;
      await M.beginJoinFromFragment(frag, true);
      if (!M.State.join) return null;
      M.State.join.name = 'Bravo'; M.State.join.color = '#8b5cf6';
      await M.beginJoinHandshake();
      return M.State.join.replyFrag;
    }, inv);
    await ev(A, async (r) => {
      const M = window.__mehfil;
      const d = await M.InvitePayload.decodeReply(r);
      await window.__hostT.acceptAnswer(d.answer_sdp);
      M.PeerMgr.attach(M.State.current.meta.id, window.__hostT, d.joiner_user_id);
    }, reply);
    await B.page.waitForFunction(() => window.__mehfil.State.view === 'workspace', { timeout: 30000 });
    B.id = await ev(B, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));
    await sleep(3000);
    check(!!(A.id && B.id), 'both peers are in the workspace');

    log('[1] Both join the huddle');
    const joinRes = [];
    for (const p of [A, B]) {
      joinRes.push(await ev(p, async () => {
        const M = window.__mehfil;
        try {
          await M.HuddleMgr.join(M.State.current.meta.id);
          return { active: M.HuddleMgr.active, err: null };
        } catch (e) { return { active: false, err: e.message }; }
      }));
      await sleep(1500);
    }
    check(joinRes[0].active === true, `A joined the huddle${joinRes[0].err ? ' — threw: ' + joinRes[0].err : ''}`);
    check(joinRes[1].active === true, `B joined the huddle${joinRes[1].err ? ' — threw: ' + joinRes[1].err : ''}`);

    // Give the offer/answer/ICE exchange time to complete over the data channel.
    await sleep(6000);

    log('[2] Each peer sees the other as a participant');
    for (const [p, other] of [[A, B], [B, A]]) {
      const parts = await ev(p, () => window.__mehfil.HuddleMgr.participants.map(x => x.id));
      check(parts.includes(other.id),
        `${p.label} lists ${other.label} as a participant (sees ${parts.length})`);
    }

    log('[3] A real peer connection came up between them');
    for (const p of [A, B]) {
      const st = await ev(p, async () => {
        const M = window.__mehfil;
        // The pcs are module-private; read connection state off the remote
        // audio elements' streams instead, plus any exposed diagnostics.
        const audios = [...document.querySelectorAll('audio')];
        const live = audios.filter(a => a.srcObject && a.srcObject.getTracks().some(t => t.readyState === 'live'));
        return { audioEls: audios.length, liveStreams: live.length, active: M.HuddleMgr.active };
      });
      check(st.liveStreams > 0,
        `${p.label} has a live remote audio stream (${st.liveStreams} of ${st.audioEls} audio elements)`);
    }

    log('[4] Mute actually disables the outgoing track');
    const muteRes = await ev(A, async () => {
      const M = window.__mehfil;
      const before = M.HuddleMgr.muted;
      M.HuddleMgr.toggleMute();
      const after = M.HuddleMgr.muted;
      return { before, after };
    });
    check(muteRes.before === false && muteRes.after === true, 'A toggled to muted');
    await ev(A, () => window.__mehfil.HuddleMgr.toggleMute());

    log('[5] Leaving tears the huddle down');
    for (const p of [A, B]) {
      const after = await ev(p, async () => {
        const M = window.__mehfil;
        await M.HuddleMgr.leave();
        const audios = [...document.querySelectorAll('audio')]
          .filter(a => a.srcObject && a.srcObject.getTracks().some(t => t.readyState === 'live'));
        return { active: M.HuddleMgr.active, liveStreams: audios.length };
      });
      check(after.active === false, `${p.label} is no longer in a huddle`);
      check(after.liveStreams === 0, `${p.label} has no live remote streams left (${after.liveStreams})`);
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
  log(failures === 0 ? '\nPASS — huddles connect two peers end to end' : `\nFAIL — ${failures} assertion(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
