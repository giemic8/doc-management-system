import React, { useEffect, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { countQueuedScans } from '../services/offlineQueue';

const POLL_INTERVAL_MS = 4000;

export const OfflineQueueIndicator: React.FC = () => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const c = await countQueuedScans();
        if (!cancelled) setCount(c);
      } catch {
        // IndexedDB unavailable — treat as no pending scans.
      }
    };

    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  if (count === 0) return null;

  return (
    <div
      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20"
      title="Scans, die lokal gespeichert wurden und auf Upload warten"
    >
      <UploadCloud className="w-3.5 h-3.5" />
      <span>
        {count} {count === 1 ? 'Scan' : 'Scans'} warten auf Upload
      </span>
    </div>
  );
};
