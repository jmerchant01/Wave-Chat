const CACHE_NAME = 'wave-v1';
const STATIC_ASSETS = ['/', '/manifest.json'];

// ── Install ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network first, cache fallback ──
self.addEventListener('fetch', e => {
  // Skip non-GET and socket.io requests
  if(e.request.method !== 'GET') return;
  if(e.request.url.includes('/socket.io/')) return;
  if(e.request.url.includes('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Push Notifications ──
self.addEventListener('push', e => {
  let data = { title: 'WAVE', body: 'You have a new notification', roomId: null };
  try { data = e.data.json(); } catch {}

  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'wave-notification',
    renotify: true,
    data: { roomId: data.roomId, url: data.roomId ? `/?room=${data.roomId}` : '/' },
    actions: data.roomId ? [
      { action: 'join', title: '🎙️ Join Room' },
      { action: 'dismiss', title: 'Dismiss' }
    ] : []
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// ── Notification click ──
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if(e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for(const client of clientList){
        if(client.url.includes(self.location.origin) && 'focus' in client){
          client.focus();
          client.postMessage({ type: 'notification_click', url });
          return;
        }
      }
      // Open new window
      if(clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Message from client ──
self.addEventListener('message', e => {
  if(e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
