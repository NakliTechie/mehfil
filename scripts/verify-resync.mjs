/**
 * Mehfil resync-responder authorization harness — M12.
 *
 * `ResyncResponder` serves "re-send me envelopes from user U, counters N..M"
 * requests off the local envelope store. Its own comment block claimed it only
 * served channels the requester belonged to. It did not: the filter was sender
 * plus counter range, so any member could pull any member's whole history
 * across every private channel and DM they were never part of. The ciphertext
 * is useless without the channel key; the metadata is not — who talks to whom,
 * in which private channel, how often, when. It also answered by broadcasting
 * to every peer, which made any filter moot and turned one request into a
 * mesh-wide flood.
 *
 * Four properties, driven through the real `ResyncResponder.serve` with real
 * `PeerMgr` attachments so the send path is the one production uses:
 *
 *   1. A non-member's request is refused outright.
 *   2. A member gets public-channel envelopes it is entitled to.
 *   3. A member does NOT get envelopes from a private channel it is not in.
 *   4. Responses go to the requester alone, and the request rate is bounded.
 *
 * NEGATIVE CONTROL — must fail on the pre-fix build:
 *   mkdir -p /tmp/negctl-m12 && git show main:index.html > /tmp/negctl-m12/index.html
 *   MEHFIL_ROOT=/tmp/negctl-m12 PORT=8221 node verify-resync.mjs
 * Expected there: [1], [3] and [4] red — the pre-fix responder serves anyone,
 * serves private channels, and broadcasts to every attached peer.
 *
 * Run: node verify-resync.mjs      Exit 0 all green, 1 any failure.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.MEHFIL_ROOT || resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8220', 10);
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

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitPort(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errs = [];
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('PAGEERR ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/frame-ancestors/.test(m.text())) errs.push(m.text().slice(0, 160)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State);
    await page.click('text=Start a workspace');
    await page.fill('input[type=text]', 'Resync');
    await page.click('text=Create workspace');
    await page.waitForFunction(() => window.__mehfil.State.view === 'workspace');
    await sleep(600);

    // Owner posts to the general channel and to a private channel that
    // `insider` belongs to and `outsider` does not. Both are members of the
    // workspace — this is about channel membership, not workspace membership.
    const setup = await page.evaluate(async () => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      const mkMember = async (name) => {
        const id = await M.Crypto.genIdentity();
        const x = await M.Crypto.genX25519();
        const cert = await M.Crypto.genDeviceCert(id.pubkey, id.privkey_pkcs8);
        const uid = M.bytesToB64Url(id.pubkey);
        cur.members.push({ id: uid, name, role: 'member', devices: [cert.device_id], joined_at: Date.now(), x25519_pub: x.x25519_pub });
        return uid;
      };
      const insider = await mkMember('Insider');
      const outsider = await mkMember('Outsider');
      const me = M.bytesToB64Url(M.State.identity.pubkey);

      // A private channel with only the owner and the insider.
      const priv = await M.sendChannelCreate(cur, 'inner-circle', '', { isPrivate: true, memberIds: [me, insider] });
      await new Promise(r => setTimeout(r, 400));

      // Two envelopes from the owner: one public, one private.
      await M.sendMessageNow('public message');
      M.State.currentChannel = priv.id;
      await M.sendMessageNow('private message');
      M.State.currentChannel = meta.general_channel_id;
      await new Promise(r => setTimeout(r, 400));

      const envs = await M.idbGetAll(cur.wsDB, 'envelopes');
      return {
        me, insider, outsider, privId: priv.id,
        generalId: meta.general_channel_id,
        counterMax: meta.lc_counter || 0,
        storedEnvs: envs.length
      };
    });
    check(setup.storedEnvs > 0, `precondition: the owner has ${setup.storedEnvs} envelopes stored`);

    // Attach three recording transports: the insider, the outsider, and a
    // bystander who asks for nothing (so "did we broadcast?" is observable).
    const attachOnce = async () => page.evaluate((s) => {
      const M = window.__mehfil, wsId = M.State.current.meta.id;
      window.__recv = { [s.insider]: [], [s.outsider]: [], bystander: [] };
      const mk = (name) => ({
        send: (bytes) => { if (bytes[0] === 0x01) window.__recv[name].push(bytes.length); },
        close: () => {}, closed: new Promise(() => {}), onPacket: null
      });
      M.PeerMgr.attach(wsId, mk(s.insider), s.insider);
      M.PeerMgr.attach(wsId, mk(s.outsider), s.outsider);
      M.PeerMgr.attach(wsId, mk('bystander'), 'bystander');
      if (M.ResyncResponder._rate) M.ResyncResponder._rate.clear();
      // Attaching a peer that is not yet a member makes us issue it an
      // admission grant, and that grant is broadcast. Let that settle, then
      // zero the counters, so what we measure is the resync response alone.
      window.__zero = () => { for (const k of Object.keys(window.__recv)) window.__recv[k] = []; };
    }, setup);
    // Attach, let the grant traffic settle, then zero — so what each section
    // measures is the resync response alone, not the side effects of attaching.
    const attach = async () => { await attachOnce(); await sleep(700); await page.evaluate(() => window.__zero()); };

    log('[1] A non-member request is refused');
    await attach();
    const r1 = await page.evaluate(async (s) => {
      const M = window.__mehfil, wsId = M.State.current.meta.id;
      const stranger = M.bytesToB64Url(M.Crypto.rand(32));
      // Record into the stranger's OWN bucket. An earlier version of this
      // pushed into `bystander` and then asserted on `__recv[stranger]`, which
      // is always empty — so it passed on the unfixed build too and proved
      // nothing. Caught by running the negative control.
      window.__recv[stranger] = [];
      M.PeerMgr.attach(wsId, {
        send: (b) => { if (b[0] === 0x01) window.__recv[stranger].push(b.length); },
        close: () => {}, closed: new Promise(() => {}), onPacket: null
      }, stranger);
      await new Promise(r => setTimeout(r, 500));
      window.__zero(); window.__recv[stranger] = [];
      await M.ResyncResponder.serve(wsId, { target: s.me, from: 0, to: 9999 }, stranger);
      return { served: (window.__recv[stranger] || []).length };
    }, setup);
    check(r1.served === 0, `a peer who is not a workspace member gets nothing (${r1.served} envelopes)`);

    log('[2] A member receives what it is entitled to');
    await attach();
    const r2 = await page.evaluate(async (s) => {
      const M = window.__mehfil, wsId = M.State.current.meta.id;
      window.__zero();
      await M.ResyncResponder.serve(wsId, { target: s.me, from: 0, to: 9999 }, s.insider);
      return { insider: window.__recv[s.insider].length };
    }, setup);
    check(r2.insider > 0, `the insider (member of both channels) receives envelopes (${r2.insider})`);

    log('[3] A member does NOT receive a private channel it is not in');
    await attach();
    const r3 = await page.evaluate(async (s) => {
      const M = window.__mehfil, cur = M.State.current, wsId = cur.meta.id;
      window.__zero();
      await M.ResyncResponder.serve(wsId, { target: s.me, from: 0, to: 9999 }, s.outsider);
      // Decode nothing — count what the responder chose to send, and compare
      // against how many of the owner's stored envelopes are private-channel.
      const envs = await M.idbGetAll(cur.wsDB, 'envelopes');
      const mine = envs.filter(e => e.from === s.me && !M.EPHEMERAL_TYPES.has(e.type));
      return {
        sentToOutsider: window.__recv[s.outsider].length,
        totalMine: mine.length,
        privateMine: mine.filter(e => e.ch === s.privId).length
      };
    }, setup);
    check(r3.privateMine > 0, `precondition: the owner has ${r3.privateMine} envelope(s) in the private channel`);
    check(r3.sentToOutsider === r3.totalMine - r3.privateMine,
      `the outsider gets only what it may read (${r3.sentToOutsider} of ${r3.totalMine}; ${r3.privateMine} withheld)`);

    log('[4] Responses are point-to-point, and the rate is bounded');
    await attach();
    const r4 = await page.evaluate(async (s) => {
      const M = window.__mehfil, wsId = M.State.current.meta.id;
      window.__zero();
      await M.ResyncResponder.serve(wsId, { target: s.me, from: 0, to: 9999 }, s.insider);
      const bystanderGot = window.__recv.bystander.length;
      // Burn through the rate budget; later requests must serve nothing.
      let lastRoundServed = 0;
      for (let i = 0; i < 8; i++) {
        const before = window.__recv[s.insider].length;
        await M.ResyncResponder.serve(wsId, { target: s.me, from: 0, to: 9999 }, s.insider);
        lastRoundServed = window.__recv[s.insider].length - before;
      }
      return { bystanderGot, lastRoundServed };
    }, setup);
    check(r4.bystanderGot === 0, `an uninvolved peer received nothing (${r4.bystanderGot}) — no mesh-wide flood`);
    check(r4.lastRoundServed === 0, `the rate limit eventually refuses (last request served ${r4.lastRoundServed})`);

    log('[5] M7 — a malformed payload is dropped instead of throwing through dispatch');
    // What this DEMONSTRATES: on the pre-fix build a malformed payload throws
    // out of EnvelopeDispatch.receive (via parseMentions); with the gate it is
    // dropped cleanly. That is the measured difference.
    //
    // What it does NOT demonstrate, despite being the reason the throw matters:
    // that the throw permanently mutes the sender. The mechanism is real —
    // `CausalBuffer.advance` runs after `handle`, so a throw skips it and the
    // sender's later counters can strand — but the negative control shows the
    // follow-up arriving on the unfixed build too, so this scenario does not
    // reproduce the mute. The follow-up assertion is kept as a regression
    // guard, not as evidence of a mute being fixed. Claiming otherwise would
    // be citing a mechanism as if it were a measurement.
    const r5 = await page.evaluate(async (s) => {
      const M = window.__mehfil, cur = M.State.current, meta = cur.meta;
      const out = {};
      // The unit checks need the validator to exist; the end-to-end half below
      // must run either way, because "does a malformed payload mute the
      // sender?" is the question the negative control has to answer on a build
      // that has no validator at all.
      const V = M.validateInnerPayload;
      out.hasValidator = typeof V === 'function';
      if (out.hasValidator) {
        out.rejectsNumberName = V('member.join', { profile: { name: 42 } }) === false;
        out.rejectsObjectBody = V('message.create', { body: { evil: 1 } }) === false;
        out.rejectsHugeBody = V('message.create', { body: 'x'.repeat(20000) }) === false;
        out.rejectsNonObject = V('message.create', 'not an object') === false;
        out.acceptsNormal = V('message.create', { body: 'hello', ts: 1 }) === true;
        out.acceptsUnknownType = V('some.future.type', { anything: true }) === true;
      }
      out.initialsSurvivesNumber = (() => { try { return M.initials(42) === '?'; } catch { return false; } })();

      // End to end: a real member sends a malformed envelope, then a good one.
      const other = await M.Crypto.genIdentity();
      const ox = await M.Crypto.genX25519();
      const cert = await M.Crypto.genDeviceCert(other.pubkey, other.privkey_pkcs8);
      const oid = M.bytesToB64Url(other.pubkey);
      cur.members.push({ id: oid, name: 'Noisy', role: 'member', devices: [cert.device_id], joined_at: Date.now(), x25519_pub: ox.x25519_pub });
      const ds = { signKey: await M.Crypto.importSignKey(cert.device_privkey_pkcs8), cert: cert.device_cert, deviceId: cert.device_id };
      const idKey = await M.Crypto.importSignKey(other.privkey_pkcs8);
      const mk = (inner, counter) => M.Envelope.build({
        workspaceId: meta.id, channelId: meta.general_channel_id,
        channelKey: cur.channelKeys[meta.general_channel_id],
        signKey: idKey, signerPubkey: other.pubkey, deviceId: cert.device_id, deviceSigner: ds,
        type: 'message.create', inner, vectorClock: [[oid, counter]]
      });
      // Catch rather than propagate: on a build without the gate this THROWS
      // out of receive, and that throw is the whole finding — hwm never
      // advances, so the sender is muted from here on. Record it as a result
      // so both builds produce comparable output instead of one aborting.
      try {
        await M.EnvelopeDispatch.receive(meta.id, await mk({ body: { not: 'a string' }, ts: Date.now() }, 1));
        out.receiveThrew = false;
      } catch (e) { out.receiveThrew = true; out.receiveErr = e.message; }
      try {
        await M.EnvelopeDispatch.receive(meta.id, await mk({ body: 'a perfectly good follow-up', ts: Date.now() }, 2));
      } catch (e) { out.followUpErr = e.message; }
      out.malformedDropped = !(cur.messages || []).some(m => m.body && typeof m.body !== 'string');
      out.followUpDelivered = (cur.messages || []).some(m => m.body === 'a perfectly good follow-up');
      return out;
    }, setup);
    check(r5.hasValidator, 'the payload validator exists');
    if (r5.hasValidator) {
      check(r5.rejectsNumberName, 'a non-string profile.name is rejected');
      check(r5.rejectsObjectBody, 'an object where a body string belongs is rejected');
      check(r5.rejectsHugeBody, 'an oversized body is rejected');
      check(r5.rejectsNonObject, 'a non-object payload is rejected');
      check(r5.acceptsNormal, 'a normal payload is accepted');
      check(r5.acceptsUnknownType, 'an unknown envelope type is NOT rejected (new features keep working)');
    }
    check(r5.initialsSurvivesNumber, 'initials() no longer throws on a non-string');
    check(r5.receiveThrew === false, `dispatch did not throw on the malformed payload${r5.receiveThrew ? ' — threw: ' + r5.receiveErr : ''}`);
    check(r5.malformedDropped, 'the malformed message never entered the projection');
    check(r5.followUpDelivered, "the sender's next message still arrives (regression guard; also true pre-fix)");

    log('[6] F2 — removal rotates only what the removed member could read');
    // The saving is only legitimate if it changes nothing about who is cut off.
    // So assert BOTH halves: private channels they were never in keep their key
    // (the saving), and every channel they COULD read gets a new one (the point).
    const r6 = await page.evaluate(async (s) => {
      const M = window.__mehfil, cur = M.State.current;
      // Channels: general (public), 'inner-circle' (private, victim IN),
      // 'not-theirs' (private, victim OUT).
      const me = M.bytesToB64Url(M.State.identity.pubkey);
      const victimId = s.outsider;   // already a workspace member from setup
      const inCh = await M.sendChannelCreate(cur, 'victim-was-here', '', { isPrivate: true, memberIds: [me, victimId] });
      const outCh = await M.sendChannelCreate(cur, 'not-theirs', '', { isPrivate: true, memberIds: [me] });
      await new Promise(r => setTimeout(r, 500));

      const keyOf = async (id) => {
        const raw = await M.idbGet(cur.wsDB, 'keys', 'ch:' + id);
        return raw ? M.bytesToB64(raw) : null;
      };
      const before = {
        general: await keyOf(cur.meta.general_channel_id),
        inCh: await keyOf(inCh.id),
        outCh: await keyOf(outCh.id)
      };
      await M.sendMemberRemove(cur, victimId);
      await new Promise(r => setTimeout(r, 800));
      const after = {
        general: await keyOf(cur.meta.general_channel_id),
        inCh: await keyOf(inCh.id),
        outCh: await keyOf(outCh.id)
      };
      return { before, after };
    }, setup);
    check(r6.before.general !== r6.after.general,
      'the PUBLIC channel key rotated — the removed member held it');
    check(r6.before.inCh !== r6.after.inCh,
      'the private channel they WERE in rotated — they held that key too');
    check(r6.before.outCh === r6.after.outCh,
      'the private channel they were NEVER in did NOT rotate — that is the saving, and it cuts off nobody');

    log('\n=== console errors ===');
    log('  ' + (errs.length ? errs.join(' | ') : '(none)'));
  } catch (e) {
    log(`  ✗ FAIL: harness error — ${e.message}`);
    failures++;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
  log(failures === 0 ? '\nAll resync-authorization checks PASSED' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
