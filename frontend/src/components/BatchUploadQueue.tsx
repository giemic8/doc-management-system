import React, { useCallback, useState } from 'react';
import { UploadCloud, CheckCircle2, XCircle, Loader2, X } from 'lucide-react';
import { uploadDocument } from '../services/api';

interface QueueItem {
  id: string;
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

interface BatchUploadQueueProps {
  onAllComplete?: () => void;
  /** Max number of uploads in flight at once. */
  concurrency?: number;
}

/**
 * Global drag-and-drop overlay + parallel upload queue. Listens for
 * drag/drop events on the whole window, so files can be dropped anywhere
 * in the app to start uploading -- no dedicated dropzone element needed.
 */
export const BatchUploadQueue: React.FC<BatchUploadQueueProps> = ({ onAllComplete, concurrency = 5 }) => {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState(false);
  const [activeUploads, setActiveUploads] = useState(0);

  const processQueue = useCallback((queue: QueueItem[]) => {
    setItems((prev) => {
      const merged = [...prev, ...queue];
      return merged;
    });
  }, []);

  const enqueueFiles = useCallback((files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
      file,
      progress: 0,
      status: 'pending',
    }));
    processQueue(newItems);
  }, [processQueue]);

  // Drive the concurrency-limited upload queue.
  React.useEffect(() => {
    const pending = items.filter((i) => i.status === 'pending');
    if (pending.length === 0 || activeUploads >= concurrency) return;

    const slotsAvailable = concurrency - activeUploads;
    const toStart = pending.slice(0, slotsAvailable);

    toStart.forEach((item) => {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'uploading' } : i)));
      setActiveUploads((n) => n + 1);

      uploadDocument(item.file, (percent) => {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, progress: percent } : i)));
      })
        .then(() => {
          setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'done', progress: 100 } : i)));
        })
        .catch((err) => {
          setItems((prev) =>
            prev.map((i) => (i.id === item.id ? { ...i, status: 'error', error: err?.response?.data?.error || 'Upload fehlgeschlagen' } : i))
          );
        })
        .finally(() => {
          setActiveUploads((n) => n - 1);
        });
    });
  }, [items, activeUploads, concurrency]);

  React.useEffect(() => {
    if (items.length > 0 && items.every((i) => i.status === 'done' || i.status === 'error')) {
      onAllComplete?.();
    }
  }, [items, onAllComplete]);

  React.useEffect(() => {
    let dragCounter = 0;
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      setIsDraggingOverWindow(true);
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) setIsDraggingOverWindow(false);
    };
    const handleDragOver = (e: DragEvent) => e.preventDefault();
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsDraggingOverWindow(false);
      if (e.dataTransfer?.files?.length) {
        enqueueFiles(e.dataTransfer.files);
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [enqueueFiles]);

  const dismiss = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));
  const clearCompleted = () => setItems((prev) => prev.filter((i) => i.status !== 'done'));

  return (
    <>
      {isDraggingOverWindow && (
        <div className="fixed inset-0 z-50 bg-indigo-950/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="border-4 border-dashed border-indigo-400 rounded-3xl p-16 text-center">
            <UploadCloud className="w-16 h-16 text-indigo-300 mx-auto mb-4 animate-bounce" />
            <p className="text-xl font-bold text-indigo-100">Dateien hier ablegen zum Hochladen</p>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 w-80 glass-panel p-4 space-y-2 max-h-96 overflow-auto">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-200">
              Upload-Warteschlange ({items.filter((i) => i.status === 'done').length}/{items.length})
            </h4>
            <button onClick={clearCompleted} className="text-xs text-slate-500 hover:text-slate-300">
              Erledigte entfernen
            </button>
          </div>
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-xs bg-slate-900/60 rounded-lg p-2">
              <div className="shrink-0">
                {item.status === 'done' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                {item.status === 'error' && <XCircle className="w-4 h-4 text-red-400" />}
                {(item.status === 'uploading' || item.status === 'pending') && (
                  <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                )}
              </div>
              <div className="flex-1 overflow-hidden">
                <p className="truncate text-slate-300">{item.file.name}</p>
                {item.status === 'uploading' && (
                  <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden mt-1">
                    <div className="bg-indigo-500 h-full transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                )}
                {item.status === 'error' && <p className="text-red-400 text-[10px]">{item.error}</p>}
              </div>
              <button onClick={() => dismiss(item.id)} className="text-slate-500 hover:text-slate-300 shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
};
