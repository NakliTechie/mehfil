/**
 * Mehfil service worker — offline shell only.
 *
 * Intentionally does NOT:
 *  - Subscribe to or deliver push notifications. The spec's §14.6
 *    "never" list rules out push via a central service, and foreground
 *    Notification() already covers the honest use case.
 *  - Intercept API or relay traffic. It only caches the static shell
 *    (index.html + lazy-loaded CDN modules) so the app works offline.
 *  - Store any user data. All encrypted envelopes live in IndexedDB +
 *    OPFS, which are independent of the SW cache.
 *
 * Cache strategy:
 *  - Precache index.html + manifest on install.
 *  - Runtime: cache-first for same-origin GETs + esm.sh / jsdelivr
 *    dynamic imports. Network-first would work too but cache-first is
 *    better for offline startup, and the CDN URLs are versioned so
 *    stale-cache bugs are bounded.
 */
const CACHE_NAME = "mehfil-shell-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Remove caches from older versions.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = url.hostname === "esm.sh" || url.hostname === "cdn.jsdelivr.net";

  // Skip relay / bridge / WebSocket traffic — these must always hit the wire.
  if (!sameOrigin && !isCdn) return;
  // Skip the service worker itself + dev tools.
  if (sameOrigin && url.pathname.endsWith("/sw.js")) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) {
      // Refresh in the background; don't block the UI on it.
      fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
      }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res.ok && (res.type === "basic" || res.type === "cors")) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      // Totally offline and never cached — return a minimal fallback
      // for top-level navigations so the user sees *something*.
      if (req.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
