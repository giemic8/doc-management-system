import React, { useEffect, useState } from 'react';
import {
  Trash2,
  RotateCcw,
  Lock,
  Link2,
  Loader2,
  RefreshCw,
  AlertTriangle,
  CalendarClock,
  Building,
  User as UserIcon,
} from 'lucide-react';
import { PurgeExpiredResult, TrashedDocument, User } from '../types';
import { fetchTrash, restoreDocument, purgeDocument, purgeExpiredDocuments } from '../services/api';

interface TrashViewProps {
  user: User;
}

interface PurgeOptions {
  confirmation: string;
  revokeShareLinks?: boolean;
  acknowledgeBackupPolicy?: boolean;
}

const SKIP_REASON_LABELS: Record<string, string> = {
  retention_locked: 'Aufbewahrungsfrist oder Legal Hold aktiv',
  active_share_links: 'Aktive Share-Links vorhanden',
  backup_unavailable: 'Kein gesundes Backup vorhanden',
  not_trashed: 'Liegt nicht im Papierkorb',
};

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('de-DE');
}

function remainingLabel(days: number): string {
  if (days > 1) return `Noch ${days} Tage`;
  if (days === 1) return 'Noch 1 Tag';
  return 'Löschfrist abgelaufen';
}

/**
 * Papierkorb (Ticket #33). Deletion moves documents here for 90 days;
 * restoring is available to everyone who can see the entry, while the
 * irreversible purge is admin-only and requires typing the document id.
 *
 * The purge guards (retention lock, active share links, missing backup) are
 * enforced server-side and surface as 423/409 responses — they are translated
 * into German messages below, with an explicit opt-in retry where the backend
 * accepts one.
 *
 * This view never falls back to demo documents: a failed request must render
 * a visible error, otherwise a broken backend would look like an empty trash.
 */
export const TrashView: React.FC<TrashViewProps> = ({ user }) => {
  const [documents, setDocuments] = useState<TrashedDocument[]>([]);
  const [retentionDays, setRetentionDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<PurgeExpiredResult['skipped']>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgingExpired, setPurgingExpired] = useState(false);

  const isAdmin = user.role === 'admin';

  const loadTrash = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTrash();
      setDocuments(data.documents || []);
      setRetentionDays(data.retentionDays ?? 90);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        setError('Nicht angemeldet.');
      } else if (status === 403) {
        setError('Zugriff verweigert: Keine Berechtigung für den Papierkorb.');
      } else {
        setError('Papierkorb konnte nicht geladen werden. Backend nicht erreichbar?');
      }
      console.error('Failed to load trash:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTrash();
  }, []);

  const handleRestore = async (doc: TrashedDocument) => {
    setBusyId(doc.id);
    setError(null);
    setNotice(null);
    try {
      await restoreDocument(doc.id);
      setNotice(`„${doc.title}“ wurde wiederhergestellt.`);
      await loadTrash();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 409) {
        setError(err?.response?.data?.error || 'Dokument liegt nicht mehr im Papierkorb.');
      } else if (status === 403) {
        setError('Zugriff verweigert: Keine Berechtigung zum Wiederherstellen.');
      } else {
        setError('Wiederherstellen fehlgeschlagen.');
      }
      console.error('Failed to restore document:', err);
    } finally {
      setBusyId(null);
    }
  };

  const runPurge = async (doc: TrashedDocument, options: PurgeOptions) => {
    setBusyId(doc.id);
    setError(null);
    setNotice(null);
    try {
      const result = await purgeDocument(doc.id, options);
      setNotice(
        `„${result.title}“ wurde endgültig gelöscht: ${result.removedFiles} Datei(en), ` +
          `${result.versionsRemoved} Version(en), ${result.revokedShareLinks} Share-Link(s) widerrufen.`
      );
      await loadTrash();
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data || {};
      if (status === 423) {
        setError(
          data.error ||
            'Endgültiges Löschen blockiert: Aufbewahrungsfrist oder Legal Hold ist für dieses Dokument aktiv.'
        );
      } else if (status === 409 && data.reason === 'active_share_links') {
        const confirmed = window.confirm(
          `Für „${doc.title}“ bestehen noch aktive Share-Links. Gäste verlieren sofort den Zugriff.\n\n` +
            'Share-Links widerrufen und Dokument endgültig löschen?'
        );
        if (confirmed) {
          await runPurge(doc, { ...options, revokeShareLinks: true });
          return;
        }
        setError('Abgebrochen: Aktive Share-Links bestehen weiter.');
      } else if (status === 409 && data.reason === 'backup_unavailable') {
        const confirmed = window.confirm(
          `Es existiert kein gesundes Backup, aus dem „${doc.title}“ nach dem Löschen wiederhergestellt werden könnte.\n\n` +
            'Backup-Policy bewusst übergehen und endgültig löschen?'
        );
        if (confirmed) {
          await runPurge(doc, { ...options, acknowledgeBackupPolicy: true });
          return;
        }
        setError('Abgebrochen: Ohne gültiges Backup wurde nichts gelöscht.');
      } else if (status === 409) {
        setError(data.error || 'Dokument liegt nicht im Papierkorb.');
      } else if (status === 403) {
        setError('Zugriff verweigert: Endgültiges Löschen ist Administratoren vorbehalten.');
      } else if (status === 404) {
        setError('Dokument nicht gefunden.');
      } else if (status === 400) {
        setError(data.error || 'Bestätigung fehlt oder ist falsch.');
      } else {
        setError('Endgültiges Löschen fehlgeschlagen.');
      }
      console.error('Failed to purge document:', err);
    } finally {
      setBusyId(null);
    }
  };

  const handlePurge = async (doc: TrashedDocument) => {
    // Typed confirmation instead of a plain confirm(): purge is irreversible.
    const typed = window.prompt(
      `Endgültiges Löschen kann nicht rückgängig gemacht werden.\n\nDokument: ${doc.title}\n\n` +
        `Zur Bestätigung die Dokument-ID eingeben oder einfügen:\n${doc.id}`
    );
    if (typed === null) return;
    if (typed.trim() !== doc.id) {
      setNotice(null);
      setError('Bestätigung stimmt nicht mit der Dokument-ID überein — es wurde nichts gelöscht.');
      return;
    }
    await runPurge(doc, { confirmation: doc.id });
  };

  const handlePurgeExpired = async () => {
    const confirmed = window.confirm(
      `Alle Dokumente mit abgelaufener ${retentionDays}-Tage-Frist endgültig löschen?\n\n` +
        'Gesperrte Dokumente (Aufbewahrung, Legal Hold, Share-Links, fehlendes Backup) werden übersprungen.'
    );
    if (!confirmed) return;
    setPurgingExpired(true);
    setError(null);
    setNotice(null);
    setSkipped([]);
    try {
      const result = await purgeExpiredDocuments();
      setNotice(
        `${result.purged.length} Dokument(e) endgültig gelöscht, ${result.skipped.length} übersprungen.`
      );
      setSkipped(result.skipped || []);
      await loadTrash();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403) {
        setError('Zugriff verweigert: Endgültiges Löschen ist Administratoren vorbehalten.');
      } else if (status === 400) {
        setError(err?.response?.data?.error || 'Bestätigung fehlt oder ist falsch.');
      } else {
        setError('Abgelaufene Dokumente konnten nicht gelöscht werden.');
      }
      console.error('Failed to purge expired documents:', err);
    } finally {
      setPurgingExpired(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-100 flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-indigo-400" />
            Papierkorb
          </h1>
          <p className="text-xs text-slate-400">
            Gelöschte Dokumente bleiben {retentionDays} Tage wiederherstellbar, bevor sie endgültig entfernt werden.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={loadTrash} disabled={loading} className="btn-secondary text-xs py-2 px-3">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Aktualisieren
          </button>
          {isAdmin && (
            <button
              onClick={handlePurgeExpired}
              disabled={purgingExpired}
              className="btn-secondary text-xs py-2 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
            >
              {purgingExpired ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Abgelaufene endgültig löschen
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="glass-panel border border-rose-500/30 bg-rose-950/40 text-rose-200 px-4 py-3 rounded-xl text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="glass-panel border border-emerald-500/30 bg-emerald-950/30 text-emerald-200 px-4 py-3 rounded-xl text-xs space-y-2">
          <p>{notice}</p>
          {skipped.length > 0 && (
            <ul className="space-y-1 text-[11px] text-amber-300">
              {skipped.map((entry) => (
                <li key={entry.documentId} className="font-mono">
                  {entry.documentId}: {SKIP_REASON_LABELS[entry.reason] || entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading && documents.length === 0 && !error && (
        <div className="glass-panel p-8 text-center text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
          Lade Papierkorb…
        </div>
      )}

      {!loading && !error && documents.length === 0 && (
        <div className="glass-panel p-6 sm:p-12 text-center space-y-4">
          <Trash2 className="w-12 h-12 text-slate-600 mx-auto" />
          <h3 className="text-lg font-semibold text-slate-300">Papierkorb ist leer</h3>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            Gelöschte Dokumente erscheinen hier und können {retentionDays} Tage lang wiederhergestellt werden.
          </p>
        </div>
      )}

      {documents.length > 0 && (
        <div className="space-y-3">
          {documents.map((doc) => {
            const expired = doc.days_remaining <= 0;
            const busy = busyId === doc.id;
            return (
              <div key={doc.id} className="glass-card p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-2 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-semibold text-slate-100 text-sm truncate">{doc.title}</h4>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full font-medium border flex items-center gap-1 ${
                        expired
                          ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                          : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                      }`}
                    >
                      <CalendarClock className="w-3 h-3" />
                      {remainingLabel(doc.days_remaining)}
                    </span>
                    {doc.retention_locked && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-indigo-500/10 text-indigo-300 border-indigo-500/30 flex items-center gap-1">
                        <Lock className="w-3 h-3" />
                        Aufbewahrung / Legal Hold
                      </span>
                    )}
                    {doc.active_share_links > 0 && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium border bg-sky-500/10 text-sky-300 border-sky-500/30 flex items-center gap-1">
                        <Link2 className="w-3 h-3" />
                        {doc.active_share_links} aktive Share-Links
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-4 flex-wrap text-[12px] text-slate-400">
                    {doc.doc_type && (
                      <span className="px-2 py-0.5 rounded-md bg-slate-800/70 text-slate-300">{doc.doc_type}</span>
                    )}
                    {doc.sender && (
                      <span className="flex items-center gap-1.5 truncate">
                        <Building className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        {doc.sender}
                      </span>
                    )}
                    <span className="flex items-center gap-1.5">
                      <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                      Gelöscht am {formatDate(doc.trashed_at)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <CalendarClock className="w-3.5 h-3.5 text-slate-500" />
                      Endgültig ab {formatDate(doc.purge_after)}
                    </span>
                    {doc.trashed_by_name && (
                      <span className="flex items-center gap-1.5 truncate">
                        <UserIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        {doc.trashed_by_name}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleRestore(doc)}
                    disabled={busy}
                    className="btn-secondary text-[11px] py-1.5 px-3 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    Wiederherstellen
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => handlePurge(doc)}
                      disabled={busy}
                      className="btn-secondary text-[11px] py-1.5 px-3 hover:border-red-500/50 hover:text-red-400 disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" />
                      Endgültig löschen
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
