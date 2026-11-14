// Сервис-воркер: приложение открывается и без интернета (данные — только онлайн)
const CACHE = 'marilu-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.endsWith('supabase.co')) return; // данные всегда из сети
  const cacheable = u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net';
  if (!cacheable) return;
  // сначала сеть (чтобы обновления приходили сразу), при ошибке — кэш
  e.respondWith(fetch(e.request, u.origin === location.origin ? { cache: 'no-cache' } : {}).then(r => {
    if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request)));
});

// ===== Пуш-уведомления =====
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'MariluStudio', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MariluStudio', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag, renotify: !!d.tag, data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.focus(); c.postMessage({ type: 'refresh' }); return; } }
    return self.clients.openWindow(url);
  }));
});
