// Service worker of the installable web app (registered by src/pwa.ts in production builds).
// - the game page (navigation to the app root or index.html): network first, the cached copy when offline;
//   other pages (legal/*.html) are not stored as the game page;
// - built scripts and styles (hashed names under assets/*.js|css): cache first, they never change;
// - everything else of this origin (game files under assets/, packs, sounds, music, fonts, icons, legal pages):
//   the cached copy at once, refreshed from the network in the background (a new deployment shows at the next load).
const CACHE = "promptima-v2";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-256.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const gamePage = url.pathname === scope || url.pathname === scope + "index.html";
  if (gamePage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("./", copy)); }
          return res;
        })
        .catch(() => caches.match("./").then((r) => r ?? Response.error())),
    );
    return;
  }
  const store = (res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  };
  const hashed = /\/assets\/[^/]+-[\w-]{8}\.(js|css)$/.test(url.pathname);
  e.respondWith(caches.match(req).then((hit) => {
    if (hit && hashed) return hit;
    const fresh = fetch(req).then(store);
    if (!hit) return fresh;
    e.waitUntil(fresh.catch(() => undefined));
    return hit;
  }));
});
