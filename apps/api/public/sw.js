// Kodspot Electrical — Service Worker
// PWA install, offline fallback, API response caching, Background Sync

const CACHE_NAME = 'kodspot-v14';
const API_CACHE = 'kodspot-api-v1';
const OFFLINE_URL = '/offline.html';

// API endpoints to cache for offline reads (GET only)
const CACHEABLE_API = [
  '/api/health',
  '/api/locations',
  '/api/assets',
  '/api/templates',
  '/api/notifications/unread-count'
];

// Max age for cached API responses (5 minutes)
const API_CACHE_MAX_AGE = 5 * 60 * 1000;

// Pre-cache essential assets on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        OFFLINE_URL,
        '/css/design-system.css?v=10',
        '/js/app.js?v=11',
        '/js/offline-sync.js?v=1',
        '/site.webmanifest',
        '/favicon-32x32.png',
        '/android-chrome-192x192.png'
      ])
    )
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Background Sync ───
self.addEventListener('sync', (event) => {
  if (event.tag === 'kodspot-offline-sync') {
    event.waitUntil(replayOfflineQueue());
  }
});

async function replayOfflineQueue() {
  // Open the IndexedDB directly in SW context
  const db = await openSyncDB();
  const entries = await getAllPending(db);

  for (const entry of entries) {
    try {
      const res = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers || {},
        body: entry.body || undefined
      });
      if (res.ok || res.status === 409) {
        await removePending(db, entry.id);
        // Notify the client
        const clients = await self.clients.matchAll();
        clients.forEach((client) => {
          client.postMessage({ type: 'SYNC_COMPLETE', id: entry.id });
        });
      }
    } catch {
      // Still offline or server error — Background Sync will retry
      break;
    }
  }
}

// Minimal IndexedDB helpers for the SW context
function openSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kodspot-sync', 1);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('pending-requests')) {
        const store = d.createObjectStore('pending-requests', { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending-requests', 'readonly');
    const req = tx.objectStore('pending-requests').index('createdAt').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function removePending(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending-requests', 'readwrite');
    const req = tx.objectStore('pending-requests').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Fetch Handler ───
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  const url = new URL(event.request.url);

  // Cacheable API endpoints — network-first with stale fallback
  if (url.pathname.startsWith('/api/') && CACHEABLE_API.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(networkFirstApi(event.request));
    return;
  }

  // Non-cacheable API calls — pass through
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests — network first → offline page
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Cache HTML pages for offline navigation
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match(OFFLINE_URL)))
    );
    return;
  }

  // Static assets — stale-while-revalidate
  if (url.pathname.match(/\.(css|js|png|ico|woff2?)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
        return cached || networkFetch;
      })
    );
    return;
  }
});

// Network-first for API: try network, store in API cache, fall back to cached response
async function networkFirstApi(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const clone = res.clone();
      const cache = await caches.open(API_CACHE);
      // Store with timestamp header for TTL checking
      const headers = new Headers(clone.headers);
      headers.set('sw-cached-at', Date.now().toString());
      const body = await clone.arrayBuffer();
      await cache.put(request, new Response(body, { status: res.status, statusText: res.statusText, headers }));
    }
    return res;
  } catch {
    // Offline — try to serve from cache
    const cached = await caches.match(request, { cacheName: API_CACHE });
    if (cached) {
      const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0', 10);
      const age = Date.now() - cachedAt;
      // Return cached data with a header indicating staleness
      const headers = new Headers(cached.headers);
      headers.set('x-sw-stale', age > API_CACHE_MAX_AGE ? 'true' : 'false');
      headers.set('x-sw-age', Math.round(age / 1000).toString());
      const body = await cached.arrayBuffer();
      return new Response(body, { status: cached.status, statusText: cached.statusText, headers });
    }
    // Nothing cached — return a synthetic offline response
    return new Response(JSON.stringify({ error: 'offline', message: 'You are offline and no cached data is available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
