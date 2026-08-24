// Service worker LITE: network-first con fallback su cache (come la FULL).
const VERSION = "lite-v29";
const CACHE = "fal-" + VERSION;
const SHELL_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./engine-lite.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  // pulisci SOLO le vecchie cache di QUESTA app (fal-*): la FULL (fa-*) vive sullo stesso dominio
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("fal-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // NON intercettare le richieste cross-origin (Firebase: stream SSE + REST) → sync realtime intatta
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
  );
});
