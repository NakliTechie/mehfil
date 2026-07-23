/**
 * Mehfil mesh overlay SCALE harness — N peers over loopback WebRTC.
 *
 * Generalizes verify-mesh.mjs to an arbitrary peer count (env N, default 12).
 * Star-bootstraps N-1 joiners off owner A (each via the real offline handshake),
 * then lets the mesh auto-dialer densify the overlay and asserts, at scale:
 *   1. CONVERGE   — every peer reaches >=2 connected edges AND the graph is
 *                   connected (BFS over connected-peer sets). Records time.
 *   2. BROADCAST  — a message from A, and from a random leaf, reaches all peers.
 *   3. CHURN      — kill K random peers; survivors stay connected and a fresh
 *                   message from a survivor still reaches every other survivor.
 * Emits JSON metrics (degree distribution, convergence/recovery ms) and exits
 * non-zero on any failed assertion.
 *
 * Local: node verify-mesh-scale.mjs         (N=12 — safe on a laptop)
 * Scale: N=30 node verify-mesh-scale.mjs    (needs a big box; loopback caps
 *        ~10-15 contexts/process on a laptop — that's the whole reason for AWS)
 *
 * Chromium needs --disable-features=WebRtcHideLocalIpsWithMdns (loopback peers
 * exchange raw host candidates, not unresolvable .local mDNS names).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const N       = Math.max(2, parseInt(process.env.N || '12', 10));
const PORT    = parseInt(process.env.PORT || '8151', 10);
const BASE    = `http://127.0.0.1:${PORT}/index.html?debug=1`;
const CONVERGE_TIMEOUT_MS = parseInt(process.env.CONVERGE_TIMEOUT_MS || String(15000 + N * 2500), 10);
const CHURN_K = parseInt(process.env.CHURN_K || String(Math.max(1, Math.floor(N / 4))), 10);

const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failures = 0;
const check = (cond, msg) => { if (cond) log(`  ✓ ${msg}`); else { log(`  ✗ FAIL: ${msg}`); failures++; } };

function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(); });
      s.on('error', () => { s.destroy(); Date.now() - start > timeoutMs ? rej(new Error('server down')) : setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
}

// BFS connectivity over an adjacency map {id: Set(ids)}; returns reachable count from `start`.
function reachableCount(adj, start) {
  const seen = new Set([start]); const q = [start];
  while (q.length) { const cur = q.shift(); for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
  return seen.size;
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitForPort(PORT);
  log(`server up on :${PORT} — target N=${N}, churn K=${CHURN_K}`);

  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const peers = [];  // { label, ctx, page, id, alive }

  async function newPeer(label) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ unregister: async () => {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => log(`  [${label} pageerror] ${e.message}`));
    await page.goto(BASE);
    await page.waitForFunction(() => window.__mehfil && window.__mehfil.State, { timeout: 15000 });
    const peer = { label, ctx, page, id: null, alive: true };
    peers.push(peer);
    return peer;
  }
  const ev = (peer, fn, arg) => peer.page.evaluate(fn, arg);
  const idOf = (peer) => ev(peer, () => window.__mehfil.bytesToB64Url(window.__mehfil.State.identity.pubkey));

  // Snapshot the overlay: for each alive peer, its connected-peer id set.
  async function snapshot(wsId) {
    const adj = new Map();
    const alive = peers.filter(p => p.alive);
    // Gather all peers' views in parallel so polling stays cheap and doesn't
    // starve the browser's own WebRTC/healing work at higher N.
    const views = await Promise.all(alive.map(p =>
      ev(p, (wsId) => {
        const M = window.__mehfil, wsPeers = M.PeerMgr.peers.get(wsId), out = [];
        if (wsPeers) for (const [pid, e] of wsPeers) if (e.transport.status === 'connected') out.push(pid);
        return out;
      }, wsId).catch(() => [])
    ));
    alive.forEach((p, i) => adj.set(p.id, new Set(views[i])));
    // Symmetrize (an edge is live if either endpoint reports connected).
    for (const [id, nbrs] of adj) for (const nb of nbrs) if (adj.has(nb)) adj.get(nb).add(id);
    return adj;
  }

  try {
    // 1. Owner A + N-1 joiners (star bootstrap off A).
    log(`[setup] creating workspace + joining ${N - 1} peers`);
    const A = await newPeer('A');
    await A.page.click('text=Start a workspace');
    await A.page.fill('input[type=text]', 'Scale Test');
    await A.page.click('text=Create workspace');
    await A.page.waitForFunction(() => window.__mehfil.State.view === 'workspace', { timeout: 10000 });
    A.id = await idOf(A);
    const wsId = await ev(A, () => window.__mehfil.State.current.meta.id);

    let joined = 0;
    for (let i = 1; i < N; i++) {
      const name = `P${i}`;
      const J = await newPeer(name);
      let replyFrag = null, diag = null;
      // Robust join: a fresh invite each attempt (keyed transport so a skip/
      // retry can't misalign indices), guard State.join (beginJoinFromFragment
      // returns without setting it if the workspace already exists locally or
      // the invite fails to decode), retry once, then skip rather than crash.
      for (let attempt = 0; attempt < 2 && !replyFrag; attempt++) {
        const inv = await ev(A, async () => {
          const M = window.__mehfil; const { transport, frag } = await M.prepareInvite(true);
          window.__hostT = window.__hostT || {};
          const key = 'k' + (window.__k = (window.__k || 0) + 1);
          window.__hostT[key] = transport; return { frag, key };
        });
        const res = await ev(J, async ({ frag, name }) => {
          const M = window.__mehfil;
          await M.beginJoinFromFragment(frag, true);
          if (!M.State.join) return { fail: true, view: M.State.view, err: String((M.State.error && M.State.error.message) || M.State.error || '') };
          M.State.join.name = name; M.State.join.color = '#8b5cf6';
          await M.beginJoinHandshake();
          return { replyFrag: M.State.join.replyFrag };
        }, { frag: inv.frag, name });
        if (res.fail) { diag = res; await sleep(600); continue; }
        await ev(A, async ({ reply, key }) => {
          const M = window.__mehfil; const r = await M.InvitePayload.decodeReply(reply);
          await window.__hostT[key].acceptAnswer(r.answer_sdp);
          M.PeerMgr.attach(M.State.current.meta.id, window.__hostT[key], r.joiner_user_id);
        }, { reply: res.replyFrag, key: inv.key });
        replyFrag = res.replyFrag;
      }
      if (!replyFrag) { log(`  ${name} join FAILED (view=${diag?.view} err=${diag?.err}) — skipping`); continue; }
      try {
        await J.page.waitForFunction(() => window.__mehfil.State.view === 'workspace', { timeout: 30000 });
      } catch { log(`  ${name} connected but didn't reach workspace`); }
      J.id = await idOf(J);
      joined++;
      if (i % 5 === 0 || i === N - 1) log(`  joined ${joined}/${N - 1}`);
    }
    check(peers.filter(p => p.id).length === N, `all ${N} peers joined the workspace (${joined + 1}/${N} incl. owner)`);

    // 2. Converge: every peer >=2 connected edges AND graph connected.
    log('[1] Overlay convergence (bounded-degree, self-healing)');
    const convStart = Date.now();
    let adj = new Map(), converged = false;
    while (Date.now() - convStart < CONVERGE_TIMEOUT_MS) {
      adj = await snapshot(wsId);
      const alive = peers.filter(p => p.alive);
      const allDeg = alive.every(p => (adj.get(p.id)?.size || 0) >= 2);
      const connected = reachableCount(adj, A.id) === alive.length;
      if (allDeg && connected) { converged = true; break; }
      await sleep(2500);
    }
    const convMs = Date.now() - convStart;
    const degrees = peers.filter(p => p.alive).map(p => adj.get(p.id)?.size || 0).sort((a, b) => a - b);
    const dmin = degrees[0], dmax = degrees[degrees.length - 1], dmed = degrees[Math.floor(degrees.length / 2)];
    check(converged, `overlay converged in ${(convMs / 1000).toFixed(1)}s — all peers ≥2 edges, graph connected (degree min/med/max ${dmin}/${dmed}/${dmax})`);

    // 3. Broadcast from A and from a random leaf.
    async function broadcastReaches(sender, body) {
      await ev(sender, async (body) => {
        const M = window.__mehfil; M.State.currentChannel = M.State.current.meta.general_channel_id;
        await M.sendMessageNow(body);
      }, body);
      let ok = 0; const targets = peers.filter(p => p.alive && p !== sender);
      for (const p of targets) {
        try { await p.page.waitForFunction((b) => (window.__mehfil.State.current?.messages || []).some(m => m.body === b), body, { timeout: 20000 }); ok++; } catch {}
      }
      return { ok, total: targets.length };
    }
    log('[2] Broadcast reachability');
    let r = await broadcastReaches(A, 'from-owner');
    check(r.ok === r.total, `owner's message reached all ${r.total} peers (${r.ok}/${r.total})`);
    const leaf = peers.filter(p => p.alive && p !== A)[Math.floor((peers.length - 1) / 2)];
    r = await broadcastReaches(leaf, 'from-leaf');
    check(r.ok === r.total, `${leaf.label}'s message reached all others (${r.ok}/${r.total})`);

    // 4. Churn: kill K random peers, survivors must stay connected + reachable.
    log(`[3] Churn — killing ${CHURN_K} peers (incl. the owner A, the original hub)`);
    // Kill A (worst case: the star-bootstrap hub) plus evenly-spaced others.
    const kill = [A];
    for (let i = 1, step = Math.max(1, Math.floor(peers.length / CHURN_K)); kill.length < CHURN_K && i < peers.length; i += step) {
      if (!kill.includes(peers[i])) kill.push(peers[i]);
    }
    for (const v of kill) { v.alive = false; try { await v.ctx.close(); } catch {} log(`  killed ${v.label}`); }
    const survivors = peers.filter(p => p.alive);
    log(`  ${survivors.length} survivors — waiting for the mesh to heal`);
    await sleep(Math.min(20000, 6000 + CHURN_K * 2000));
    const adj2 = await snapshot(wsId);
    const anchor = survivors[0];
    const connected2 = reachableCount(adj2, anchor.id) === survivors.length;
    check(connected2, `survivors stayed connected after churn (${reachableCount(adj2, anchor.id)}/${survivors.length} reachable)`);
    r = await broadcastReaches(anchor, 'post-churn');
    check(r.ok === r.total, `a survivor's message reached all other survivors post-churn (${r.ok}/${r.total})`);

    // 5. Metrics
    const metrics = { N, churnK: CHURN_K, convergedMs: convMs, converged, degreeMinMedMax: [dmin, dmed, dmax], survivorsConnected: connected2, failures };
    log('METRICS ' + JSON.stringify(metrics));
  } finally {
    for (const p of peers) { try { await p.ctx.close(); } catch {} }
    await browser.close();
    server.kill('SIGTERM');
  }

  log(`${failures === 0 ? `PASS — mesh overlay green at N=${N}` : `FAIL — ${failures} assertion(s) failed at N=${N}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });
