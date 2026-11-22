// Service worker for the installable app. Network-first: data always comes live from ERPNext;
// the cached shell only lets the app open (and show an offline message) without a connection.
const CACHE = "atelier-shell-v1";
const SHELL = ["/assets/atelier/atelier/app.css", "/assets/atelier/atelier/app.js",
  "/assets/atelier/atelier/vendor/vue.esm-browser.prod.js", "/assets/atelier/atelier/icon.svg", "/assets/atelier/atelier/guide.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && url.pathname.startsWith("/assets/atelier/")) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
