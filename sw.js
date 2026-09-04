// Service worker: cache-first for the shell so the game is fully playable with
// no network at all. Bump CACHE when files change - the old cache is deleted on
// activate, so a stale shell can never survive a deploy.

const CACHE = "ruledrift-v1";

const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "src/main.js",
  "src/engine.js",
  "src/rules.js",
  "src/rng.js",
  "src/storage.js",
  "src/share.js",
  "src/charts.js",
  "src/tiles.js",
  "src/audio.js",
  "assets/icon.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // Refresh in the background so the next load is current.
        fetch(req)
          .then((res) => res.ok && caches.open(CACHE).then((c) => c.put(req, res.clone())))
          .catch(() => {});
        return hit;
      }
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("index.html"));
    })
  );
});
