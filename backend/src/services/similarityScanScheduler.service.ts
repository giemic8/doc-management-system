import { scanPendingSimilarities } from './duplicateDetection.service';

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Ticket #35 -- runs the similarity comparison for documents whose text
 * exists but has never been compared.
 *
 * It deliberately does not run inside the worker. The comparison needs the
 * stored text of every other document, which is the backend's data, and
 * putting it on the worker's processing path would make a slow neighbour
 * scan look like a slow OCR run. `documents.similarity_scanned_at` is the
 * whole queue: a restart on either side resumes exactly where it stopped,
 * because nothing about the pending work lived in a process.
 */
export function startSimilarityScanScheduler(checkIntervalMs: number = 5 * 60 * 1000) {
  if (intervalHandle) return;

  intervalHandle = setInterval(async () => {
    try {
      const results = await scanPendingSimilarities();
      const matched = results.reduce((total, result) => total + result.matches.length, 0);
      if (results.length > 0) {
        console.log(`Similarity scan: examined ${results.length} document(s), ${matched} candidate(s) found.`);
      }
    } catch (err: any) {
      console.error('Similarity scan scheduler error:', err.message);
    }
  }, checkIntervalMs);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }
}

export function stopSimilarityScanScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
