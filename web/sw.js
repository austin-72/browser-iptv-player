/* Service worker: keeps the app itself available offline (so downloads can be watched without a connection).
   API calls always go to the network. */
const CACHE = 'app-__VERSION__';
const SHELL = ['/', '/app.js', '/app.css', '/vendor/hls.min.js', '/vendor/mpegts.js', '/brand-icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok && !r.redirected ? c.put(u, r) : null)).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/c/') || u.pathname.startsWith('/k/')) return;
  const key = e.request.mode === 'navigate' ? '/' : u.pathname;
  if (!SHELL.includes(key) && !u.pathname.startsWith('/vendor/')) return;
  // Network first (so updates arrive), the saved copy when offline.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && !r.redirected && (e.request.mode !== 'navigate' || r.headers.get('X-Page') === 'app')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key).then((r) => r || caches.match('/'))));
});

// Tapping a notification (e.g. a new episode) opens the app there.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
