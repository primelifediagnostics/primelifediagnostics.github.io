// Prime Life portal – service worker.
// - caches the app's own files so it opens quickly as an installed app
// - shows "Your results are ready" notifications
// Patient data and files from Supabase are NEVER cached.
const CACHE = "plp-shell-v6";
const SHELL = ["./", "index.html", "app.js", "config.js", "logo.png", "logo-icon.png", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});

// ---- notifications ----
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  const title = d.title || "Your results are ready";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "A doctor has reviewed your blood test. Open Prime Life to view it securely.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.report_id ? "report-" + d.report_id : "prime-life",
    data: { url: d.report_id ? "./?report=" + encodeURIComponent(d.report_id) : "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && "focus" in c) { c.navigate(target); return c.focus(); } }
    return clients.openWindow(target);
  }));
});
