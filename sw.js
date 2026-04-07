const BASE = self.location.pathname.includes('/doc-alert/')
  ? '/doc-alert'
  : '';
const CACHE = 'doc-alert-v2';
const ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/manifest.json`,
  `${BASE}/icon-192.png`,
  `${BASE}/icon-512.png`,
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const asset of ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn('Cache add failed for', asset, err);
        }
      }
    })
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request);
    })
  );
});
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'DOC Alert', body: event.data?.text() || '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'DOC Alert', {
      body: data.body || '',
      icon: data.icon || `${BASE}/icon-192.png`,
      badge: data.badge || `${BASE}/icon-192.png`,
      tag: data.tag || 'doc-alert',
      requireInteraction: true,
      data: {
        url: data.url || `${BASE}/`,
      },
    })
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || `${BASE}/`;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) return client.navigate(targetUrl);
          return client;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});


self.addEventListener("message", async (event) => {
  if (event.data === "check-docs") {
    try {
      const res = await fetch("https://fxcgjvsvjfshbaepyic.supabase.co/functions/v1/send-doc-alerts", {
        method: "POST"
      })

      const data = await res.json()

      if (data.notifications && data.notifications.length > 0) {
        for (const n of data.notifications) {
          self.registration.showNotification(n.title, {
            body: n.body,
            icon: "icon-192.png"
          })
        }
      }
    } catch (err) {
      console.error("Error checking docs:", err)
    }
  }
})
