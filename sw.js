const BASE = self.location.pathname.includes('/doc-alert/')
  ? '/doc-alert'
  : '';
const CACHE = 'doc-alert-v3';
const HTML_ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
];
const STATIC_ASSETS = [
  `${BASE}/manifest.json`,
  `${BASE}/icon-192.png`,
  `${BASE}/icon-512.png`,
];

// La instalare — cache doar asset-urile statice
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const asset of [...HTML_ASSETS, ...STATIC_ASSETS]) {
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

// La activare — șterge cache-urile vechi
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// Strategie fetch:
// - HTML: network-first (utilizatorul vede mereu versiunea nouă)
// - Assets statice: cache-first (imagini, manifest)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Nu cachăm niciodată cererile API externe (Supabase, CDN-uri)
  if (url.origin !== self.location.origin) return;

  const isHtml = HTML_ASSETS.some(a => url.pathname === a || url.pathname === a + '/');

  if (isHtml) {
    // Network-first pentru HTML — utilizatorul vede mereu versiunea nouă
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first pentru assets statice (imagini, manifest)
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        });
      })
    );
  }
});

// Afișează notificarea push primită
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    const text = event.data ? event.data.text() : '';
    data = { title: 'DOC Alert', body: text };
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

// La click pe notificare — deschide sau focusează aplicația
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || `${BASE}/`;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          try {
            if ('navigate' in client) return client.navigate(targetUrl);
          } catch (e) {
            console.warn('navigate() failed:', e);
          }
          return client;
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
