// Plain JavaScript service worker (not TypeScript — served as-is from
// public/ so Vite copies it verbatim to the build root and it can be
// registered at the domain root, giving it control over the whole app scope).
//
// Responsibilities:
//   1. Precache a small app-shell so the SPA shell loads while offline.
//   2. Serve precached shell routes network-first-with-cache-fallback, so
//      users online always get the freshest shell, but offline visits still
//      render something instead of the browser's default offline page.
//   3. Listen for the Background Sync `sync` event and, when it fires,
//      notify any open app windows via postMessage. The service worker
//      itself does NOT perform the upload — it has no access to the app's
//      axios instance or the Bearer token in localStorage (service workers
//      run in a separate global scope without access to window/localStorage).
//      Instead the actual upload/flush logic lives in
//      src/services/offlineSync.ts inside the main app, which listens for
//      this message and calls flushOfflineQueue().

const CACHE_NAME = 'docvault-shell-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin navigational/app-shell requests; let everything
  // else (API calls, cross-origin assets) pass through untouched.
  const url = new URL(request.url);
  const isShellRequest = request.mode === 'navigate' || APP_SHELL.includes(url.pathname);
  if (!isShellRequest) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});

// Background Sync: fired by the browser once connectivity is restored,
// for a sync registered via `registration.sync.register('sync-offline-scans')`
// (see src/services/offlineSync.ts). Not supported in all browsers (notably
// Safari/iOS) — the app also has a same-effect fallback via the `online`
// window event and on startup, so functionality is not solely dependent on
// this event firing.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-scans') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'sync-offline-scans' }));
      })
    );
  }
});
