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
  const browser = await chromium.launch({ headless: true });
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

    writeFileSync(`${__dirname}/CAPTURE-LOG.md`, `# Capture log\n\n${log.length} routes:\n\n${log.map(l => '- ' + l).join('\n')}\n\nConsole errors: ${errs.length}\n${errs.slice(0, 10).map(e => '- ' + e).join('\n')}\n`);
    console.log(log.join('\n'));
    console.log(`\n${log.filter(l => l.startsWith('ok')).length}/${log.length} rendered ok · ${errs.length} console errors`);
  } finally {
    await ctx.close(); await browser.close(); server.kill('SIGTERM');
  }
}
main().catch(e => { console.error('capture error:', e); process.exit(1); });
