// Service worker: caches the app's own files so it opens without network.
// Never caches GitHub API responses (those carry encrypted data and need to stay fresh).
const VERSION = "dev";
const CACHE = "pt-shell-" + VERSION;
const SHELL = ["./", "index.html", "styles.css", "app.js", "ui.js", "core.js", "vault.js", "sync.js", "rules.js", "folder.js", "prices.js",
  "importers/degiro.js", "sw-register.js", "manifest.webmanifest", "icon.svg", "seed.example.json"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

// Network first (so updates arrive at once), cache as fallback when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // cache: "no-cache" revalidates with the server, so a new deploy shows on the next reload.
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
