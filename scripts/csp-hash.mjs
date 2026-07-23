/**
 * CSP inline-script hash tool (finding L1).
 *
 * `script-src` pins each inline <script> block by SHA-256 instead of allowing
 * 'unsafe-inline'. That downgrades an HTML-injection bug from "runs arbitrary
 * JS in the origin, reads the identity keys out of IndexedDB" to "draws
 * something ugly" — which is the whole point of the directive.
 *
 * The cost is that the hashes are only valid for the exact bytes of the
 * script blocks, so every edit to index.html invalidates them. This script
 * is the fix for that cost. It is NOT a build step: index.html still opens
 * directly from disk with no tooling. It's a maintenance tool, the same kind
 * of committed helper as guide/regenerate.sh and the verify-*.mjs harnesses.
 *
 *   node scripts/csp-hash.mjs --check    # exit 1 if the CSP is stale
 *   node scripts/csp-hash.mjs --write    # recompute and rewrite in place
 *
 * A stale hash makes the app fail to boot at all, so it is caught loudly:
 * verify-mesh.mjs and verify-journeys.mjs both boot the real page and go red.
 * Run --check before committing, or --write after editing a script block.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(__dirname, "..", "index.html");

// Everything script-src allows that isn't an inline-block hash. Kept here so
// the regenerated directive is byte-identical apart from the hashes.
const STATIC_SOURCES = ["'self'", "https://esm.sh", "https://cdn.jsdelivr.net"];

/** SHA-256 of each inline (no src=) <script> body, as a CSP source token. */
export function inlineHashes(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\ssrc\s*=/.test(m[1])) continue;   // external — covered by 'self'
    const digest = createHash("sha256").update(m[2], "utf8").digest("base64");
    out.push(`'sha256-${digest}'`);
  }
  return out;
}

function buildDirective(hashes) {
  return `script-src ${STATIC_SOURCES[0]} ${hashes.join(" ")} ${STATIC_SOURCES.slice(1).join(" ")};`;
}

function main() {
  const mode = process.argv[2] || "--check";
  const html = readFileSync(TARGET, "utf8");

  const current = html.match(/script-src [^;]*;/);
  if (!current) {
    console.error("csp-hash: no script-src directive found in index.html");
    process.exit(2);
  }

  const wanted = buildDirective(inlineHashes(html));

  if (current[0] === wanted) {
    console.log(`csp-hash: OK — ${inlineHashes(html).length} inline blocks, hashes current.`);
    return;
  }

  if (mode === "--write") {
    writeFileSync(TARGET, html.replace(current[0], wanted), "utf8");
    console.log(`csp-hash: rewrote script-src (${inlineHashes(html).length} inline blocks).`);
    return;
  }

  console.error("csp-hash: STALE — script-src does not match the inline blocks.");
  console.error("  in file: " + current[0]);
  console.error("  wanted : " + wanted);
  console.error("\nThe app will not boot with a stale hash. Fix with:");
  console.error("  node scripts/csp-hash.mjs --write");
  process.exit(1);
}

// Only run when invoked directly, so the harnesses can import inlineHashes().
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
