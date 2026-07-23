import { uploadDocument } from './api';
import { getQueuedScans, removeQueuedScan } from './offlineQueue';

const SYNC_TAG = 'sync-offline-scans';

/**
 * Registers the plain service worker at /sw.js. Safe no-op in browsers
 * without Service Worker support.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('Service worker registration failed:', err);
  }
}

/**
 * Reads all scans buffered in IndexedDB and attempts to upload each one via
 * the existing uploadDocument() API call. Individual failures (e.g. still
 * offline) are swallowed so one failed item doesn't block the rest of the
 * queue or throw out of this function — failed items simply stay queued for
 * the next flush attempt.
 */
export async function flushOfflineQueue(): Promise<{ succeeded: number; failed: number }> {
  const queued = await getQueuedScans();
  let succeeded = 0;
  let failed = 0;

  for (const scan of queued) {
    try {
      const file = new File([scan.blob], scan.filename, { type: scan.blob.type });
      await uploadDocument(file);
      await removeQueuedScan(scan.id);
      succeeded += 1;
    } catch (err) {
      console.warn('Offline scan upload still failing, will retry later:', scan.filename, err);
      failed += 1;
    }
  }

  return { succeeded, failed };
}

/**
 * Sets up all the ways flushOfflineQueue() can get triggered:
 *   1. Background Sync API (`sync.register`), when supported — the
 *      registered sync tag fires the service worker's `sync` event, which
 *      posts a message back to the page (see public/sw.js), which we
 *      listen for below and use to trigger the flush.
 *   2. The `online` window event — the cross-browser fallback, since
 *      Background Sync is not supported everywhere (notably Safari/iOS).
 *      This guarantees the queue is flushed as soon as the browser detects
 *      connectivity, regardless of Background Sync support.
 *   3. Immediately on call (i.e. app startup/mount) — in case the queue
 *      already has items and the app happens to already be online (covers
 *      the case where scans were queued in a previous offline session and
 *      the user simply reopens the app while connected).
 */
export function registerBackgroundSyncOrFallback(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        const syncManager = (registration as ServiceWorkerRegistration & {
          sync?: { register: (tag: string) => Promise<void> };
        }).sync;
        if (syncManager) {
          return syncManager.register(SYNC_TAG);
        }
        return undefined;
      })
      .catch((err) => {
        // Background Sync not supported or registration failed — the
        // `online` listener below still covers us.
        console.warn('Background Sync registration unavailable, relying on fallback:', err);
      });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'sync-offline-scans') {
        void flushOfflineQueue();
      }
    });
  }

  window.addEventListener('online', () => {
    void flushOfflineQueue();
  });

  // Attempt an initial flush on startup in case items are already queued
  // and connectivity is available.
  if (navigator.onLine) {
    void flushOfflineQueue();
  }
}
