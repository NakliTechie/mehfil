/**
 * Mehfil guide — HTML builder (the committed generator, build half).
 *
 * Reads the captured screenshots and the CAPTIONS/SECTIONS data below and emits
 * a single self-contained guide/index.html — themed from the app's own design
 * tokens, with inline search. Edit the data here + guide/capture.mjs, then
 * regenerate. Never hand-edit index.html. Run: node guide/build.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

// slug -> [title, one-line "what this screen is"]
const CAPTIONS = {
  '01-landing': ['The landing screen', 'Every entry point in one place — start a workspace, join one, add a device, or restore a backup. No signup, no download.'],
  '02-how-it-works': ['How it works', 'The "?" explainer: no accounts, no servers, everything encrypted and stored only on members’ devices.'],
  '04-create-workspace': ['Create a workspace', 'Name it and go — a fresh identity and root keys are generated locally in the browser, instantly.'],
  '05-workspace-firstrun': ['Your first workspace', 'The empty state after creating — #general is ready, with gentle prompts to invite someone or send yourself a message.'],
  '10-invite-offline': ['Invite someone', 'Share a link (or QR) and compare the visual fingerprint out-of-band. Works fully offline on a shared hotspot — no signaling server.'],
  '03-join-by-scanning': ['Join by scanning (offline)', 'The no-internet path: scan the inviter’s QR (or paste the link) to join a workspace on the same hotspot. One scan wires you into the mesh.'],
  '06-workspace-populated': ['Channels & messages', 'The main surface — channels in the sidebar, threaded messages, code blocks, and a rich composer.'],
  '07-message-reactions': ['Reactions & message actions', 'React with any emoji; hover a message for reply, edit, pin, forward, and more.'],
  '08-slash-autocomplete': ['Slash commands', 'Type / for an autocomplete of workflow shortcuts — /dm, /goto, /poll, /remind, /call, /search, and more.'],
  '09-create-channel': ['Create a channel', 'Public, private, announcement, or a collaborative Canvas doc — with a topic and optional member picker.'],
  '11-search': ['Search', 'Full-text search across messages, with from: and in:# filters. Local, instant, private.'],
  '12-quick-switcher': ['⌘K quick switcher', 'Jump to any channel, DM, or member — or fall through to message search — without leaving the keyboard.'],
  '13-shortcuts': ['Keyboard shortcuts', 'The full keymap, grouped by Navigate / Channel / Workspace / Composer — a single source of truth generated from the app.'],
  '14-settings-identity': ['Settings · Identity', 'Your profile, custom status, and the backup that’s the only way to recover your identity.'],
  '15-settings-devices': ['Settings · Devices', 'Pair additional devices to the same identity, and revoke ones you’ve lost.'],
  '16-settings-workspace': ['Settings · Workspace', 'Notifications and DND, relay/bridge transports for store-and-forward, and workspace-level options.'],
  '17-settings-admin': ['Settings · Admin', 'Member management, promote-by-consensus, and named user groups you can @mention.'],
};

const SECTIONS = [
  ['Getting started', 'Open Mehfil and you’re one click from a working, encrypted workspace — no account, no server, no install.', ['01-landing', '02-how-it-works', '04-create-workspace', '05-workspace-firstrun']],
  ['Connect your team — offline', 'Mehfil’s signature: get a group talking on one WiFi or a phone hotspot with no internet at all. Invite by link or QR; peers self-organize into a mesh that survives the host leaving.', ['10-invite-offline', '03-join-by-scanning']],
  ['Messaging', 'Channels, threads, reactions, code, slash commands — the daily-driver surface.', ['06-workspace-populated', '07-message-reactions', '08-slash-autocomplete', '09-create-channel']],
  ['Find & navigate', 'Keyboard-first movement across everything you’ve got.', ['11-search', '12-quick-switcher', '13-shortcuts']],
  ['Settings & admin', 'Identity, devices, transports, and running a workspace.', ['14-settings-identity', '15-settings-devices', '16-settings-workspace', '17-settings-admin']],
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cards = (slugs, section) => slugs.map(slug => {
  const [title, desc] = CAPTIONS[slug] || [slug, ''];
  const search = `${section} ${title} ${desc} ${slug}`.toLowerCase();
  return `<figure class="card" data-search="${esc(search)}">
    <a href="screenshots/${slug}.png" target="_blank"><img loading="lazy" src="screenshots/${slug}.png" alt="${esc(title)}"></a>
    <figcaption><h3>${esc(title)}</h3><p>${esc(desc)}</p></figcaption>
  </figure>`;
}).join('\n');

const sectionsHtml = SECTIONS.map(([title, intro, slugs], i) =>
  `<section class="grp" id="s${i}"><h2>${esc(title)}</h2><p class="intro">${esc(intro)}</p><div class="grid">${cards(slugs, title)}</div></section>`
).join('\n');

const toc = SECTIONS.map(([title], i) => `<a href="#s${i}">${esc(title)}</a>`).join('');

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mehfil — User Guide</title>
<style>
  :root{ --bg:#fafaf7; --elev:#fff; --sunken:#f0eee8; --fg:#1a1a1a; --mute:#6b6b6b; --dim:#9a9a9a; --line:#e6e3da; --accent:#4f46e5; --accent-fg:#fff;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#15151a; --elev:#1d1d23; --sunken:#101015; --fg:#ececec; --mute:#9a9a9a; --dim:#6b6b6b; --line:#2a2a32; --accent:#818cf8; } }
  *{box-sizing:border-box} html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.5}
  header{padding:56px 24px 28px;max-width:1100px;margin:0 auto}
  h1{font-size:34px;margin:0 0 6px;letter-spacing:-.02em}
  .tag{color:var(--mute);font-size:16px;max-width:640px}
  .tag code{font-family:var(--mono);font-size:13px;background:var(--sunken);padding:1px 5px;border-radius:5px}
  .bar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 24px}
  .bar .inner{max-width:1100px;margin:0 auto;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  #q{flex:1;min-width:200px;padding:9px 13px;border:1px solid var(--line);border-radius:9px;background:var(--elev);color:var(--fg);font-size:14px;font-family:var(--sans)}
  #q:focus{outline:none;border-color:var(--accent)}
  .toc{display:flex;gap:6px;flex-wrap:wrap}
  .toc a{font-size:12.5px;color:var(--mute);text-decoration:none;padding:5px 10px;border-radius:7px;background:var(--sunken);white-space:nowrap}
  .toc a:hover{color:var(--accent-fg);background:var(--accent)}
  main{max-width:1100px;margin:0 auto;padding:8px 24px 80px}
  .grp{margin:40px 0}
  .grp h2{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .intro{color:var(--mute);margin:0 0 20px;max-width:720px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:22px}
  .card{margin:0;background:var(--elev);border:1px solid var(--line);border-radius:13px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .card.hidden{display:none}
  .card img{width:100%;display:block;border-bottom:1px solid var(--line);background:var(--sunken);aspect-ratio:14/9;object-fit:cover;object-position:top}
  figcaption{padding:13px 15px 15px}
  figcaption h3{margin:0 0 4px;font-size:15px}
  figcaption p{margin:0;color:var(--mute);font-size:13.5px}
  .grp.empty{display:none}
  #none{display:none;color:var(--mute);padding:40px 0;text-align:center}
  footer{max-width:1100px;margin:0 auto;padding:0 24px 60px;color:var(--dim);font-size:13px}
  footer a{color:var(--accent)}
</style></head>
<body>
<header>
  <h1>Mehfil — User Guide</h1>
  <p class="tag">Browser-native, local-first team chat in a single HTML file. No accounts, no servers, end-to-end encrypted. Works fully offline — a group on one hotspot connects peer-to-peer and self-organizes into a mesh. <a href="../index.html" style="color:var(--accent)">Open Mehfil →</a></p>
</header>
<div class="bar"><div class="inner">
  <input id="q" type="search" placeholder="Search features…  ( / to focus, Esc to clear )" autocomplete="off">
  <nav class="toc">${toc}</nav>
</div></div>
<main>
${sectionsHtml}
<p id="none">No features match — try another word.</p>
</main>
<footer>Generated from <code style="font-family:var(--mono)">guide/capture.mjs</code> + <code style="font-family:var(--mono)">guide/build.mjs</code> — don’t hand-edit this file; edit the generator and regenerate. · <a href="../index.html">Open the app</a></footer>
<script>
  const q=document.getElementById('q'), cards=[...document.querySelectorAll('.card')], grps=[...document.querySelectorAll('.grp')], none=document.getElementById('none');
  function apply(){ const v=q.value.trim().toLowerCase(); let shown=0;
    cards.forEach(c=>{ const m=!v||c.dataset.search.includes(v); c.classList.toggle('hidden',!m); if(m)shown++; });
    grps.forEach(g=>{ g.classList.toggle('empty', ![...g.querySelectorAll('.card')].some(c=>!c.classList.contains('hidden'))); });
    none.style.display = shown? 'none':'block';
  }
  q.addEventListener('input', apply);
  document.addEventListener('keydown', e=>{ if(e.key==='/' && document.activeElement!==q){ e.preventDefault(); q.focus(); } else if(e.key==='Escape'){ q.value=''; apply(); q.blur(); } });
</script>
</body></html>`;

writeFileSync(resolve(__dirname, 'index.html'), html);
console.log(`built guide/index.html — ${SECTIONS.length} sections, ${Object.keys(CAPTIONS).length} screens`);
