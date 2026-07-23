import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, DatabaseBackup, HardDriveDownload, Loader2, RefreshCw } from 'lucide-react';
import { BackupStatus } from '../types';
import { fetchBackupStatus } from '../services/api';

/**
 * Admin-only dashboard for backup health (Ticket #17). Reads
 * GET /api/backup/status, which surfaces the last-backup-status.json file
 * written by the standalone `backup` container after each daily run.
 *
 * Access control: the "Backup" nav item is hidden for non-admin users in
 * Sidebar.tsx, so under normal navigation this component only renders for
 * admins. As a defense-in-depth fallback (e.g. if reached directly), a 403
 * from the backend is still handled gracefully below with an error state.
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return 'Noch kein Backup ausgeführt';
  try {
    return new Date(timestamp).toLocaleString('de-DE');
  } catch {
    return timestamp;
  }
}

export const BackupStatusPage: React.FC = () => {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBackupStatus();
      setStatus(data);
    } catch (err: any) {
      if (err?.response?.status === 403) {
        setError('Zugriff verweigert: Nur Administratoren können den Backup-Status einsehen.');
      } else if (err?.response?.status === 401) {
        setError('Nicht angemeldet.');
      } else {
        setError('Backup-Status konnte nicht geladen werden.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-100">Backup & Wiederherstellung</h1>
          <p className="text-xs text-slate-400">
            Verschlüsselte tägliche Offsite-Backups von Datenbank &amp; Dokumentenspeicher.
          </p>
        </div>
        <button onClick={loadStatus} disabled={loading} className="btn-secondary text-xs py-2 px-3">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Aktualisieren
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
      )}

      {loading && !status && !error && <p className="text-xs text-slate-500">Lädt...</p>}

      {status && (
        <section className="glass-panel p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {status.success ? (
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
              ) : (
                <XCircle className="w-6 h-6 text-red-400" />
              )}
              <div>
                <h2 className="font-bold text-slate-200 text-sm">
                  {status.success ? 'Letztes Backup erfolgreich' : 'Kein erfolgreiches Backup'}
                </h2>
                <p className="text-xs text-slate-500">{formatTimestamp(status.timestamp)}</p>
              </div>
            </div>
            <span
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                status.success
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-red-500/10 text-red-400 border-red-500/20'
              }`}
            >
              {status.success ? 'HEALTHY' : 'FEHLER'}
            </span>
          </div>

          {status.error && (
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              {status.error}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-slate-800 pt-4">
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-1">
              <div className="flex items-center gap-2 text-slate-400 text-xs">
                <DatabaseBackup className="w-3.5 h-3.5" /> DB-Backup
              </div>
              <p className="text-lg font-bold text-slate-100">{formatBytes(status.dbBackupSizeBytes)}</p>
            </div>
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-1">
              <div className="flex items-center gap-2 text-slate-400 text-xs">
                <HardDriveDownload className="w-3.5 h-3.5" /> Storage-Backup
              </div>
              <p className="text-lg font-bold text-slate-100">{formatBytes(status.storageBackupSizeBytes)}</p>
            </div>
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-1">
              <div className="flex items-center gap-2 text-slate-400 text-xs">
                <HardDriveDownload className="w-3.5 h-3.5" /> Aktuelle Speichernutzung
              </div>
              <p className="text-lg font-bold text-slate-100">{formatBytes(status.storageUsageBytes)}</p>
            </div>
          </div>

          <div className="text-[11px] text-slate-500 border-t border-slate-800 pt-3">
            Backups werden täglich erstellt, mit AES-256 (GPG) verschlüsselt und per Rclone offsite
            synchronisiert (S3 / Wasabi / Hetzner Storage Box / MinIO).
          </div>
        </section>
      )}
    </div>
  );
};
