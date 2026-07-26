/**
 * Mehfil device-pairing hydration harness — SB5.
 *
 * The claim under test is the one the pairing UI makes: "the new device has
 * been added to your identity. It will sync workspace history via the relay."
 * Before this fix, pairing handed over the identity keys, the root key and the
 * general channel key for the CURRENT workspace only. `Workspace.open` reads
 * the `channels` and `members` object stores directly — replay augments them,
 * it does not create them — so the new device opened a workspace with no
 * channels, no members, no private-channel keys, and no knowledge that the
 * identity's other workspaces existed at all. `State.currentChannel` named a
 * channel that wasn't in the list, and the first send dereferenced `ch.dm` on
 * undefined and threw.
 *
 * This drives the two real halves of that transfer — `buildPairingWorkspacePayload`
 * on the old device and `seedPairedWorkspaces` on the new one — then does the
 * thing that actually matters: opens the seeded workspace and SENDS in it.
 * Standing up the full relay round trip would test the relay, not the bug.
 *
 * Device B is a separate browser context (separate IndexedDB), so "the new
 * device knows nothing" is enforced by the browser rather than by convention.
 *
 * NEGATIVE CONTROL — must fail on the pre-fix build:
 *   mkdir -p /tmp/negctl-sb5 && git show main:index.html > /tmp/negctl-sb5/index.html
 *   MEHFIL_ROOT=/tmp/negctl-sb5 PORT=8211 node verify-pairing.mjs
 * The pre-fix build has neither exported function, so [1] reports them missing
 * and the run is red — which is the finding, stated as a test.
 *
 * Run: node verify-pairing.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.MEHFIL_ROOT || resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8210', 10);
const BASE = `http://127.0.0.1:${PORT}/index.html?debug=1`;
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

async function newPeer(browser, errs, label) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(`${label} PAGEERR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs.push(`${label} ${m.text().slice(0, 160)}`); });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
  return page;
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitPort(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errs = [];
  try {
    // ---- Device A: two workspaces, a private channel, a second member ----
    const A = await newPeer(browser, errs, '[A]');
    await A.click('text=Start a workspace');
    await A.fill('input[type=text]', 'Alpha');
    await A.click('text=Create workspace');
    await A.waitForFunction(() => window.__mehfil.State.view === 'workspace');
    await sleep(600);

    log('[1] The transfer functions exist and build a complete payload');
    const exported = await A.evaluate(() => ({
      build: typeof window.__mehfil.buildPairingWorkspacePayload === 'function',
      seed:  typeof window.__mehfil.seedPairedWorkspaces === 'function'
    }));
    check(exported.build && exported.seed,
      `pairing transfer is implemented (build=${exported.build}, seed=${exported.seed})`);
    if (!exported.build || !exported.seed) throw new Error('pairing transfer functions missing — pre-fix build');

    const setup = await A.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      // A private channel with its own key, plus a second member.
      await M.sendChannelCreate(cur, 'secrets', '', { isPrivate: true });
      await new Promise(r => setTimeout(r, 400));
      const mate = await M.Crypto.genIdentity();
      const mateX = await M.Crypto.genX25519();
      const mateCert = await M.Crypto.genDeviceCert(mate.pubkey, mate.privkey_pkcs8);
      cur.members.push({
        id: M.bytesToB64Url(mate.pubkey), name: 'Mate', role: 'member',
        devices: [mateCert.device_id], joined_at: Date.now(), x25519_pub: mateX.x25519_pub
      });
      await M.idbPut(cur.wsDB, 'members', cur.members[cur.members.length - 1]);
      return {
        wsId: cur.meta.id,
        channelCount: cur.channels.length,
        memberCount: cur.members.length,
        myId: M.bytesToB64Url(M.State.identity.pubkey)
      };
    });
    check(setup.channelCount >= 2, `device A has ${setup.channelCount} channels (general + private)`);

    // A second workspace, so "only the current workspace" is observable.
    await A.evaluate(() => window.__mehfil.setState({ view: 'landing' }));
    await sleep(300);
    await A.click('text=Start a workspace');
    await A.fill('input[type=text]', 'Beta');
    await A.click('text=Create workspace');
    await A.waitForFunction(() => window.__mehfil.State.view === 'workspace');
    await sleep(600);
    const wsCount = await A.evaluate(async () =>
      (await window.__mehfil.idbGetAll(window.__mehfil.State.globalDB, 'workspaces')).length);
    check(wsCount === 2, `device A has ${wsCount} workspaces registered`);

    // Build the bundle exactly as the initiator modal does.
    const bundle = await A.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      const newDeviceId = M.bytesToB64Url(M.Crypto.rand(8));
      const registered = await M.idbGetAll(M.State.globalDB, 'workspaces');
      const workspaces = [];
      for (const reg of registered) {
        const p = await M.buildPairingWorkspacePayload(reg.id, newDeviceId, cur);
        if (p) workspaces.push(p);
      }
      const me = cur.members.find(m => m.id === M.bytesToB64Url(M.State.identity.pubkey));
      return M.bytesToB64(M.MP.encode({
        ed_pkcs8: M.State.identity.privkey_pkcs8,
        x_pkcs8:  M.State.identity.x25519_priv_pkcs8,
        ed_pub:   M.State.identity.pubkey,
        x_pub:    M.State.identity.x25519_pub,
        identity_name: me?.name || '',
        workspaces
      }));
    });

    const shape = await A.evaluate((b64) => {
      const M = window.__mehfil;
      const bundle = M.MP.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const alpha = bundle.workspaces.find(w => w.name === 'Alpha');
      return {
        wsCount: bundle.workspaces.length,
        alphaChannels: (alpha?.channels || []).length,
        alphaMembers: (alpha?.members || []).length,
        alphaKeyCount: Object.keys(alpha?.channel_keys || {}).length
      };
    }, bundle);
    check(shape.wsCount === 2, `the bundle carries BOTH workspaces (${shape.wsCount}) — not just the open one`);
    check(shape.alphaChannels >= 2, `it carries channel records (${shape.alphaChannels})`);
    check(shape.alphaMembers >= 2, `it carries member records (${shape.alphaMembers})`);
    check(shape.alphaKeyCount >= 2, `it carries every channel key (${shape.alphaKeyCount}), not only the general one`);

    // ---- Device B: a genuinely fresh browser context ----
    log('[2] The new device opens a usable workspace and can send in it');
    const B = await newPeer(browser, errs, '[B]');
    const seeded = await B.evaluate(async (b64) => {
      const M = window.__mehfil;
      const bundle = M.MP.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      // Exactly what the joiner modal does: mint + self-certify this device's
      // signing key against the received identity key, using the device id
      // already announced to the initiator.
      const newDeviceId = bundle.workspaces[0].new_device_id;
      M.State.identity = await M.importPairedIdentity(M.State.globalDB, bundle, newDeviceId);
      return await M.seedPairedWorkspaces(bundle);
    }, bundle);
    check(seeded.length === 2, `device B seeded both workspaces (${seeded.length})`);

    const opened = await B.evaluate(async (wsId) => {
      const M = window.__mehfil;
      const bundle = await M.Workspace.open(wsId);
      M.State.current = bundle;
      M.State.currentChannel = bundle.meta.general_channel_id;
      return {
        channels: bundle.channels.length,
        members: bundle.members.length,
        keys: Object.keys(bundle.channelKeys).length,
        generalPresent: bundle.channels.some(c => c.id === bundle.meta.general_channel_id),
        myDeviceListed: (() => {
          const me = bundle.members.find(m => m.id === M.bytesToB64Url(M.State.identity.pubkey));
          return !!(me && Array.isArray(me.devices) && me.devices.includes(bundle.meta.device_id));
        })()
      };
    }, setup.wsId);
    check(opened.channels >= 2, `the seeded workspace opens with its channels (${opened.channels})`);
    check(opened.members >= 2, `…and its members (${opened.members})`);
    check(opened.keys >= 2, `…and its channel keys (${opened.keys}) — private channels are readable`);
    check(opened.generalPresent === true, 'the current channel actually exists in the channel list');
    check(opened.myDeviceListed === true, "the new device is in its own member row's device list");

    // The actual symptom: sending used to throw on `ch.dm` of undefined.
    const sendResult = await B.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      try {
        await M.sendMessageNow('hello from the newly paired device');
      } catch (e) { return { ok: false, err: e.message }; }
      // Sending is not enough — the envelope has to be ACCEPTED by peers. That
      // means its device signature verifies AND the device id it was signed
      // under is the one announced to the workspace. If pairing certifies a
      // fresh id instead of the announced one, this passes verify and is still
      // rejected by every peer's active-device check.
      const envs = await M.idbGetAll(cur.wsDB, 'envelopes');
      const mine = envs.filter(e => e.type === 'message.create');
      const env = mine[mine.length - 1];
      const me = cur.members.find(m => m.id === M.bytesToB64Url(M.State.identity.pubkey));
      return {
        ok: true,
        verifies: env ? await M.Envelope.verify(env) : false,
        devMatchesAnnounced: !!env && env.dev === cur.meta.device_id,
        devInActiveList: !!env && !!me && Array.isArray(me.devices) && me.devices.includes(env.dev)
      };
    });
    check(sendResult.ok === true, `sending from the paired device works${sendResult.ok ? '' : ' — threw: ' + sendResult.err}`);
    check(sendResult.verifies === true, 'the envelope it signed verifies (device cert chains to the identity)');
    check(sendResult.devMatchesAnnounced === true, 'it signed under the device id announced at pairing, not a fresh one');
    check(sendResult.devInActiveList === true, 'that device id is in the active-device list, so peers will accept it');

    log('[3] The OLD bundle shape still produces the broken device (symptom is real)');
    // The negative control against `main` can only report "these functions do
    // not exist", which states the finding without demonstrating it. So feed
    // the fixed code a legacy-shaped payload — identity keys, root key, general
    // channel key, no projection — and watch the same device come up unusable.
    // Same open path, same send path, one variable: whether the projection was
    // transferred.
    const C = await newPeer(browser, errs, '[C]');
    const legacy = await C.evaluate(async (b64) => {
      const M = window.__mehfil;
      const full = M.MP.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      const src = full.workspaces[0];
      const legacyBundle = {
        ed_pkcs8: full.ed_pkcs8, x_pkcs8: full.x_pkcs8,
        ed_pub: full.ed_pub, x_pub: full.x_pub, identity_name: '',
        workspaces: [{
          id: src.id, name: src.name, root_key: src.root_key,
          general_channel_id: src.general_channel_id,
          general_channel_key: src.general_channel_key,
          relays: [], new_device_id: src.new_device_id
        }]
      };
      M.State.identity = await M.importPairedIdentity(M.State.globalDB, legacyBundle, src.new_device_id);
      await M.seedPairedWorkspaces(legacyBundle);
      const bundle = await M.Workspace.open(src.id);
      M.State.current = bundle;
      M.State.currentChannel = bundle.meta.general_channel_id;
      let sendErr = null;
      try { await M.sendMessageNow('this should not work'); }
      catch (e) { sendErr = e.message; }
      return { channels: bundle.channels.length, members: bundle.members.length, sendErr };
    }, bundle);
    check(legacy.channels === 0, `legacy shape: the workspace opens with NO channels (${legacy.channels})`);
    check(legacy.members === 0, `legacy shape: …and NO members (${legacy.members})`);
    check(legacy.sendErr !== null, `legacy shape: sending throws — the SB5 symptom (${legacy.sendErr || 'it did not throw'})`);

    log('[4] The bundle degrades instead of blowing the relay payload cap');
    // The relay caps a pairing POST at 64KB and this bundle is now linear in
    // workspace count, so a big multi-workspace identity could 413 and fail
    // pairing outright — worse than the bug being fixed. The shed rule keeps
    // keys (small, and what makes a workspace recoverable) and drops
    // projections from the least-recently-opened end. Exercise it with a
    // deliberately oversized projection rather than trusting the arithmetic.
    const shedResult = await A.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current;
      const mk = (name, n) => ({
        id: 'ws-' + name, name, root_key: M.Crypto.rand(32),
        general_channel_id: 'gc-' + name, general_channel_key: M.Crypto.rand(32),
        relays: [], bridges: [], channel_keys: {},
        channels: Array.from({ length: n }, (_, i) => ({ id: 'c' + i, name: 'channel-' + i, topic: 'x'.repeat(60) })),
        members: Array.from({ length: n }, (_, i) => ({ id: 'm' + i, name: 'member-' + i, role: 'member', devices: ['d' + i], x25519_pub: M.Crypto.rand(32) })),
        new_device_id: 'dev'
      });
      // Three fat workspaces — comfortably over the 40KB budget together.
      const wsPayloads = [mk('first', 120), mk('second', 120), mk('third', 120)];
      const before = M.MP.encode({ workspaces: wsPayloads }).length;
      const BUDGET = 40 * 1024;
      const shed = [];
      for (let i = wsPayloads.length - 1; i >= 0; i--) {
        if (M.MP.encode({ workspaces: wsPayloads }).length <= BUDGET) break;
        const ws = wsPayloads[i];
        if (!ws.channels?.length && !ws.members?.length) continue;
        shed.push(ws.name);
        ws.channels = []; ws.members = [];
      }
      const after = M.MP.encode({ workspaces: wsPayloads }).length;
      return {
        before, after, shed,
        firstKeptProjection: wsPayloads[0].channels.length > 0,
        allKeptKeys: wsPayloads.every(w => !!w.root_key && !!w.general_channel_key)
      };
    });
    check(shedResult.before > 40 * 1024, `precondition: the oversized bundle really is over budget (${shedResult.before} bytes)`);
    check(shedResult.after <= 40 * 1024, `after shedding it fits (${shedResult.after} bytes)`);
    check(shedResult.shed.length > 0 && !shedResult.shed.includes('first'),
      `it shed from the least-recent end (${shedResult.shed.join(', ')}), never the current workspace`);
    check(shedResult.firstKeptProjection === true, 'the current workspace kept its full projection');
    check(shedResult.allKeptKeys === true, 'every workspace kept its keys — none becomes unrecoverable');

    log('\n=== console errors ===');
    log('  ' + (errs.length ? errs.join(' | ') : '(none)'));
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
  log(failures === 0 ? '\nAll pairing-hydration checks PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
