/**
 * Mehfil guide — screenshot capture (the committed generator, capture half).
 *
 * Boots the app, seeds one workspace with realistic data, then walks a
 * route-plan shooting each surface at retina to guide/screenshots/. Edit the
 * ROUTES data here (+ CAPTIONS in build.mjs) and regenerate — never hand-edit
 * guide/index.html. Run: node guide/capture.mjs   (via guide/regenerate.sh)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const OUT = resolve(__dirname, 'screenshots');
const PORT = 8171;
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
mkdirSync(OUT, { recursive: true });
const waitPort = (p, t = 10000) => new Promise((res, rej) => { const s = Date.now(); const f = () => { const c = net.connect(p, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(); }); c.on('error', () => { c.destroy(); Date.now() - s > t ? rej() : setTimeout(f, 150); }); }; f(); });

const log = [];
async function shot(page, slug) {
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; }).catch(() => {});
  await sleep(500);
  const len = await page.evaluate(() => document.getElementById('app')?.innerHTML.length || 0);
  await page.screenshot({ path: `${OUT}/${slug}.png` });
  const ok = len > 80;
  log.push(`${ok ? 'ok  ' : 'EMPTY'} ${slug} (app html ${len})`);
  return ok;
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  await waitPort(PORT);
  // Fake media: the huddle surface needs getUserMedia to resolve, and a headless
  // browser has no microphone. These flags give it a synthetic one and
  // auto-accept the permission prompt, so the huddle screenshot shows the real
  // active-huddle UI rather than a permission error.
  const browser = await chromium.launch({ headless: true, args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns'
  ] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs.push(m.text().slice(0, 100)); });

  try {
    await page.goto(BASE); await page.waitForFunction(() => window.__mehfil?.State);

    // --- anonymous / first-run surfaces ---
    await shot(page, '01-landing');
    await page.evaluate(() => document.querySelector('button')?.parentElement && [...document.querySelectorAll('button')].find(b => /how does this work/i.test(b.textContent))?.click());
    await sleep(400); await shot(page, '02-how-it-works');
    await page.keyboard.press('Escape'); await sleep(200);
    // join-by-scanning (offline) doorway — NEW
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /join by scanning/i.test(b.textContent))?.click());
    await sleep(500); await shot(page, '03-join-by-scanning');
    await page.goto(BASE); await page.waitForFunction(() => window.__mehfil?.State); await sleep(300);
    // create workspace
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /start a workspace/i.test(b.textContent))?.click());
    await sleep(300);
    await page.fill('input[type=text]', 'Acme Team');
    await shot(page, '04-create-workspace');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /create workspace/i.test(b.textContent))?.click());
    await page.waitForFunction(() => window.__mehfil.State.view === 'workspace'); await sleep(500);
    await shot(page, '05-workspace-firstrun');

    // --- seed some content so screens aren't empty ---
    await page.evaluate(async () => {
      const M = window.__mehfil, S = M.State;
      S.currentChannel = S.current.meta.general_channel_id;
      await M.sendMessageNow('Welcome to Acme Team 👋 this is #general');
      await M.sendMessageNow('Kicking off the design review at 3pm — notes in the canvas');
      await M.sendMessageNow('```js\nconst mehfil = "one html file";\n```');
      await M.sendChannelCreate(S.current, 'design', 'Design crits + specs', {});
      await M.setCustomStatus?.('🎯', 'Focused');
    });
    await sleep(800); await shot(page, '06-workspace-populated');

    // --- G1: a REAL second member, via the real offline handshake ---
    // Everything above is one person talking to themselves, which is what the
    // guide has always shown. A conversation needs two people, and faking a
    // second member by writing rows into the projection would put a picture in
    // the guide that the app cannot actually produce. So this is a genuine
    // second browser context completing a genuine join.
    const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
    const pageB = await ctxB.newPage();
    await pageB.goto(BASE); await pageB.waitForFunction(() => window.__mehfil?.State);
    {
      const inv = await page.evaluate(async () => {
        const M = window.__mehfil;
        const { transport, frag } = await M.prepareInvite(true);
        window.__hostT = transport; return frag;
      });
      const reply = await pageB.evaluate(async (frag) => {
        const M = window.__mehfil;
        await M.beginJoinFromFragment(frag, true);
        if (!M.State.join) return null;
        M.State.join.name = 'Priya'; M.State.join.color = '#f59e0b';
        await M.beginJoinHandshake();
        return M.State.join.replyFrag;
      }, inv);
      if (reply) {
        await page.evaluate(async (r) => {
          const M = window.__mehfil;
          const d = await M.InvitePayload.decodeReply(r);
          await window.__hostT.acceptAnswer(d.answer_sdp);
          M.PeerMgr.attach(M.State.current.meta.id, window.__hostT, d.joiner_user_id);
        }, reply);
        await pageB.waitForFunction(() => window.__mehfil.State.view === 'workspace', { timeout: 30000 }).catch(() => {});
        await sleep(3000);
        await pageB.evaluate(async () => {
          const M = window.__mehfil, S = M.State;
          S.currentChannel = S.current.meta.general_channel_id;
          await M.sendMessageNow('Just joined — the QR scan took about two seconds 🙌');
          await M.sendMessageNow('Where do you want the design crit notes, here or #design?');
        });
        await sleep(2500);
      }
    }
    await shot(page, '18-two-person-conversation');

    // --- threads: reply in a thread, then shoot the panel open ---
    await page.evaluate(async () => {
      const M = window.__mehfil, S = M.State;
      const root = S.current.messages.find(m => /design crit notes/i.test(m.body))
                || S.current.messages.find(m => /design review/i.test(m.body));
      if (!root) return;
      await M.sendMessageNow('#design please — keeping #general for announcements', { threadId: root.id });
      M.setState({ threadOpen: root.id });
    });
    await sleep(900); await shot(page, '19-thread-panel');
    await page.evaluate(() => window.__mehfil.setState({ threadOpen: null })); await sleep(400);

    // --- polls: post one and cast a vote from each side ---
    await page.evaluate(async () => {
      const M = window.__mehfil;
      await M.sendMessageNow('', { poll: { question: 'Ship the offline join this week?',
        options: ['Ship it', 'One more test pass', 'Hold for the phone rig'] } });
    });
    await sleep(1200);
    // Priya votes, so the poll shows real tallies rather than an empty shell.
    await pageB.evaluate(async () => {
      const M = window.__mehfil, S = M.State;
      const poll = (S.current.messages || []).find(m => m.poll);
      if (poll && M.sendPollVote) await M.sendPollVote(S.current, poll.id, 0);
    }).catch(e => console.warn('poll vote:', e));
    await sleep(1500); await shot(page, '20-poll');

    // reaction on the first message
    await page.evaluate(async () => {
      const M = window.__mehfil, S = M.State;
      const msg = S.current.messages.find(m => /Welcome/.test(m.body));
      if (msg) await M.sendReactionAdd(S.current, msg.id, '🎉');
    });
    await sleep(500); await shot(page, '07-message-reactions');

    // slash autocomplete
    await page.evaluate(() => { const c = document.getElementById('composer'); if (c) { c.focus(); } });
    await page.type('#composer', '/', { delay: 30 }).catch(() => {});
    await sleep(400); await shot(page, '08-slash-autocomplete');
    await page.evaluate(() => { const c = document.getElementById('composer'); if (c) c.value = ''; });

    // create-channel modal
    await page.evaluate(() => [...document.querySelectorAll('button,[class]')].find(e => e.getAttribute && /Create channel/i.test(e.getAttribute('title') || ''))?.click());
    await sleep(400); await shot(page, '09-create-channel'); await page.keyboard.press('Escape'); await sleep(200);

    // invite modal — offline QR (NEW)
    await page.evaluate(() => window.__mehfil.openInviteModal());
    await sleep(1500); await shot(page, '10-invite-offline'); await page.keyboard.press('Escape'); await sleep(300);

    // search palette
    await page.evaluate(() => window.__mehfil.openSearchPalette?.());
    await sleep(500); await page.type('body', '', { delay: 0 }).catch(() => {});
    await shot(page, '11-search'); await page.keyboard.press('Escape'); await sleep(200);

    // quick switcher
    await page.evaluate(() => window.__mehfil.openQuickSwitcher?.());
    await sleep(400); await shot(page, '12-quick-switcher'); await page.keyboard.press('Escape'); await sleep(200);

    // keyboard shortcuts overlay
    await page.keyboard.press('Escape'); await sleep(100);
    await page.evaluate(() => { const el = document.getElementById('composer'); if (el) el.blur(); });
    await page.keyboard.press('?'); await sleep(400); await shot(page, '13-shortcuts');
    await page.keyboard.press('Escape'); await sleep(200);

    // settings — walk the tabs
    await page.evaluate(() => [...document.querySelectorAll('button,[class]')].find(e => e.getAttribute && /Settings/i.test(e.getAttribute('title') || ''))?.click());
    await sleep(500); await shot(page, '14-settings-identity');
    for (const [tab, slug] of [['Devices', '15-settings-devices'], ['Workspace', '16-settings-workspace'], ['Admin', '17-settings-admin']]) {
      await page.evaluate((t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t)?.click(), tab);
      await sleep(500); await shot(page, slug);
    }
    await page.keyboard.press('Escape'); await sleep(200);

    // --- canvas channel, actually in use ---
    await page.evaluate(async () => {
      const M = window.__mehfil, S = M.State;
      const ch = await M.sendChannelCreate(S.current, 'whiteboard', 'Sketches + diagrams', { isCanvas: true });
      if (ch) M.setState({ currentChannel: ch.id, threadOpen: null });
    });
    await sleep(1500); await shot(page, '21-canvas');

    // --- huddle: join one so the bar renders in its active state ---
    await page.evaluate(async () => {
      const M = window.__mehfil, S = M.State;
      S.currentChannel = S.current.meta.general_channel_id;
      M.setState({ currentChannel: S.current.meta.general_channel_id });
      try { await M.HuddleMgr.join(S.current.meta.id); } catch (e) { console.warn('huddle join:', e); }
    });
    await sleep(2000); await shot(page, '22-huddle-active');
    await page.evaluate(async () => { try { await window.__mehfil.HuddleMgr.leave(); } catch {} });
    await sleep(500);

    writeFileSync(`${__dirname}/CAPTURE-LOG.md`, `# Capture log\n\n${log.length} routes:\n\n${log.map(l => '- ' + l).join('\n')}\n\nConsole errors: ${errs.length}\n${errs.slice(0, 10).map(e => '- ' + e).join('\n')}\n`);
    console.log(log.join('\n'));
    console.log(`\n${log.filter(l => l.startsWith('ok')).length}/${log.length} rendered ok · ${errs.length} console errors`);
  } finally {
    await ctx.close().catch(() => {});
    for (const c of browser.contexts()) { try { await c.close(); } catch {} }
    await browser.close(); server.kill('SIGTERM');
  }
}
main().catch(e => { console.error('capture error:', e); process.exit(1); });
