/* Minimal service worker — exists only to make the app installable ("add to
 * home screen"). It deliberately NEVER caches: the fetch handler is a pass-
 * through, so the browser always loads assets from the network. This gives us
 * PWA installability with zero risk of serving a stale JS/CSS chunk after a
 * deploy (a class of bug this app has hit before). */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Purge anything a previous (caching) SW might have left behind.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* ignore */ }
    await self.clients.claim();
  })());
});

// Pass-through: don't call respondWith → the browser handles the request over
// the network exactly as if no SW existed. Required for installability.
self.addEventListener("fetch", () => {});
