import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Copy,
  EyeOff,
  Loader2,
  Pencil,
  RefreshCw,
  Scan,
  SlidersHorizontal,
  Split,
  X,
} from 'lucide-react';
import { ReviewItem, ReviewProposal, ReviewSettings, User } from '../types';
import {
  fetchReviewItems,
  fetchReviewSettings,
  resolveReviewItem,
  runSimilarityScan,
  updateReviewSettings,
} from '../services/api';

interface ReviewInboxViewProps {
  user: User;
}

const FIELD_LABELS: Record<string, string> = {
  doc_type: 'Dokumenttyp',
  sender: 'Absender',
  recipient: 'Empfänger',
  document_date: 'Dokumentdatum',
  due_date: 'Fälligkeit',
  amount: 'Betrag',
  summary: 'Zusammenfassung',
  tags: 'Schlagwörter',
};

const DECISION_LABELS: Record<string, string> = {
  auto_accepted: 'Automatisch übernommen',
  needs_review: 'Vorschlag – bitte prüfen',
  discarded: 'Zu unsicher für einen Vorschlag',
};

const KIND_LABELS: Record<string, string> = {
  low_confidence: 'Unsichere Erkennung',
  exact_duplicate: 'Exaktes Duplikat',
  similar_document: 'Ähnliches Dokument',
};

function formatValue(field: string, value: any): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (field === 'amount') return `${Number(value).toFixed(2)} €`;
  return String(value);
}

/** Turns a form string back into the shape the field expects on the wire. */
function parseValue(field: string, raw: string): any {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (field === 'tags') {
    return trimmed
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (field === 'amount') {
    const parsed = Number(trimmed.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  return trimmed;
}

function toFormValue(field: string, value: any): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('de-DE');
}

function confidenceTone(confidence: number, settings: ReviewSettings | null): string {
  if (!settings) return 'bg-slate-500';
  if (confidence >= settings.autoAcceptConfidence) return 'bg-emerald-500';
  if (confidence >= settings.reviewConfidence) return 'bg-amber-500';
  return 'bg-rose-500';
}

/**
 * Prüfen (Ticket #35). The inbox for everything the extraction was not sure
 * enough about, plus every duplicate candidate the system found.
 *
 * Two rules the copy in here has to keep visible, because they are the whole
 * point of the feature:
 *
 *   - a proposal below the threshold was NOT written to the document; the
 *     field is still empty until somebody accepts or corrects it;
 *   - a duplicate candidate is never merged. Confirming one links the two
 *     documents, separating one says they are different, and both documents
 *     stay exactly where they are either way.
 *
 * Like the trash view, a failed request renders a visible error instead of
 * an empty inbox: "nothing to review" and "the backend is down" must never
 * look the same.
 */
export const ReviewInboxView: React.FC<ReviewInboxViewProps> = ({ user }) => {
  const isAdmin = user.role === 'admin';

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [settings, setSettings] = useState<ReviewSettings | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, Record<string, string>>>({});
  const [scanning, setScanning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedItems, loadedSettings] = await Promise.all([
        fetchReviewItems(showResolved ? 'all' : 'open'),
        fetchReviewSettings(),
      ]);
      setItems(loadedItems);
      setSettings(loadedSettings);
      setSettingsDraft({
        autoAcceptConfidence: String(loadedSettings.autoAcceptConfidence),
        reviewConfidence: String(loadedSettings.reviewConfidence),
        duplicateSimilarity: String(loadedSettings.duplicateSimilarity),
        similarityScanCandidates: String(loadedSettings.similarityScanCandidates),
      });
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Prüfliste konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, [showResolved]);

  useEffect(() => {
    load();
  }, [load]);

  const openCount = useMemo(() => items.filter((item) => item.status === 'open').length, [items]);

  async function act(item: ReviewItem, action: 'accept' | 'correct' | 'retry' | 'separate' | 'dismiss') {
    setBusyItemId(item.id);
    setError(null);
    setNotice(null);
    try {
      const values = action === 'correct' ? collectCorrections(item) : undefined;
      const result = await resolveReviewItem(item.id, action, values ? { values } : {});
      const applied = result.appliedFields.length
        ? ` Übernommen: ${result.appliedFields.map((field) => FIELD_LABELS[field] ?? field).join(', ')}.`
        : '';
      const rejected = result.rejectedFields.length
        ? ` Nicht speicherbar: ${result.rejectedFields.map((field) => FIELD_LABELS[field] ?? field).join(', ')}.`
        : '';
      setNotice(`Dokument ist jetzt im Status „${result.documentStatus}“.${applied}${rejected}`);
      setEditing((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      await load();
    } catch (err: any) {
      const body = err?.response?.data;
      setError(
        body?.field
          ? `${body.error} (${FIELD_LABELS[body.field] ?? body.field})`
          : body?.error ?? err?.message ?? 'Die Aktion ist fehlgeschlagen.'
      );
    } finally {
      setBusyItemId(null);
    }
  }

  function collectCorrections(item: ReviewItem): Record<string, any> {
    const draft = editing[item.id] ?? {};
    const values: Record<string, any> = {};
    for (const [field, raw] of Object.entries(draft)) {
      const parsed = parseValue(field, raw);
      if (parsed !== null) values[field] = parsed;
    }
    return values;
  }

  function startEditing(item: ReviewItem) {
    setEditing((current) => ({
      ...current,
      [item.id]:
        current[item.id] ??
        Object.fromEntries(
          item.proposals
            .filter((proposal) => proposal.decision !== 'auto_accepted')
            .map((proposal) => [proposal.field, toFormValue(proposal.field, proposal.proposedValue)])
        ),
    }));
  }

  async function saveSettings() {
    setSavingSettings(true);
    setError(null);
    try {
      const saved = await updateReviewSettings({
        autoAcceptConfidence: Number(settingsDraft.autoAcceptConfidence),
        reviewConfidence: Number(settingsDraft.reviewConfidence),
        duplicateSimilarity: Number(settingsDraft.duplicateSimilarity),
        similarityScanCandidates: Number(settingsDraft.similarityScanCandidates),
      });
      setSettings(saved);
      setNotice('Schwellenwerte gespeichert. Sie gelten ab der nächsten Erkennung.');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Schwellenwerte konnten nicht gespeichert werden.');
    } finally {
      setSavingSettings(false);
    }
  }

  async function scanNow() {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const results = await runSimilarityScan();
      const matches = results.reduce((total, result) => total + result.matches.length, 0);
      setNotice(
        results.length === 0
          ? 'Alle Dokumente wurden bereits verglichen.'
          : `${results.length} Dokument(e) verglichen, ${matches} Kandidat(en) gefunden.`
      );
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Der Vergleich ist fehlgeschlagen.');
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="glass-card p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
              <ClipboardCheck className="h-5 w-5 text-indigo-400" />
              Prüfen
              {openCount > 0 && (
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
                  {openCount} offen
                </span>
              )}
            </h2>
            <p className="max-w-3xl text-sm text-slate-400">
              Sichere Erkennungen werden automatisch übernommen. Alles darunter landet hier – der Wert steht dann noch
              <strong className="text-slate-300"> nicht </strong>
              am Dokument. Duplikate werden nie automatisch zusammengeführt: bestätigen verknüpft die beiden Dokumente,
              trennen merkt sich, dass sie verschieden sind. Beide bleiben in jedem Fall erhalten.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowResolved((current) => !current)}
              className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
            >
              {showResolved ? 'Nur offene zeigen' : 'Auch erledigte zeigen'}
            </button>
            {isAdmin && (
              <button
                onClick={scanNow}
                disabled={scanning}
                className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scan className="h-3.5 w-3.5" />}
                Duplikate suchen
              </button>
            )}
            <button
              onClick={() => setSettingsOpen((current) => !current)}
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Schwellenwerte
            </button>
            <button
              onClick={load}
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Aktualisieren
            </button>
          </div>
        </div>

        {settingsOpen && settings && (
          <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['autoAcceptConfidence', 'Automatisch übernehmen ab', '0–1'],
              ['reviewConfidence', 'Als Vorschlag zeigen ab', '0–1'],
              ['duplicateSimilarity', 'Als Duplikat vorschlagen ab', '0–1'],
              ['similarityScanCandidates', 'Vergleichskandidaten', '1–5000'],
            ].map(([field, label, hint]) => (
              <label key={field} className="space-y-1 text-xs text-slate-400">
                <span className="block">{label}</span>
                <input
                  type="number"
                  step={field === 'similarityScanCandidates' ? 1 : 0.01}
                  value={settingsDraft[field] ?? ''}
                  disabled={!isAdmin}
                  onChange={(event) =>
                    setSettingsDraft((current) => ({ ...current, [field]: event.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 disabled:opacity-60"
                />
                <span className="block text-[11px] text-slate-600">{hint}</span>
              </label>
            ))}
            <div className="sm:col-span-2 lg:col-span-4 flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500">
                {isAdmin
                  ? 'Gilt sofort für jede weitere Erkennung – auch im Worker, weil der Vergleich in der Datenbank stattfindet.'
                  : 'Nur Administratoren können die Schwellenwerte ändern.'}
                {settings.updatedAt ? ` Zuletzt geändert: ${formatDate(settings.updatedAt)}.` : ''}
              </p>
              {isAdmin && (
                <button
                  onClick={saveSettings}
                  disabled={savingSettings}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {savingSettings ? 'Speichern…' : 'Speichern'}
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-rose-300 hover:text-rose-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-auto text-emerald-300 hover:text-emerald-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-3 p-8 text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Prüfliste wird geladen…
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card p-8 text-center text-sm text-slate-400">
          Nichts zu prüfen. Alle Erkennungen waren sicher genug und es gibt keine offenen Duplikat-Kandidaten.
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              settings={settings}
              busy={busyItemId === item.id}
              editing={editing[item.id]}
              onStartEditing={() => startEditing(item)}
              onCancelEditing={() =>
                setEditing((current) => {
                  const next = { ...current };
                  delete next[item.id];
                  return next;
                })
              }
              onChangeField={(field, value) =>
                setEditing((current) => ({
                  ...current,
                  [item.id]: { ...(current[item.id] ?? {}), [field]: value },
                }))
              }
              onAct={(action) => act(item, action)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface ReviewCardProps {
  item: ReviewItem;
  settings: ReviewSettings | null;
  busy: boolean;
  editing?: Record<string, string>;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onChangeField: (field: string, value: string) => void;
  onAct: (action: 'accept' | 'correct' | 'retry' | 'separate' | 'dismiss') => void;
}

const ReviewCard: React.FC<ReviewCardProps> = ({
  item,
  settings,
  busy,
  editing,
  onStartEditing,
  onCancelEditing,
  onChangeField,
  onAct,
}) => {
  const isDuplicate = item.kind !== 'low_confidence';
  const isOpen = item.status === 'open';
  const pending = item.proposals.filter((proposal) => proposal.decision !== 'auto_accepted');

  return (
    <article className="glass-card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                isDuplicate ? 'bg-sky-500/20 text-sky-300' : 'bg-amber-500/20 text-amber-300'
              }`}
            >
              {KIND_LABELS[item.kind] ?? item.kind}
            </span>
            {!isOpen && (
              <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-300">
                erledigt · {item.status}
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold text-slate-100">{item.documentTitle}</h3>
          <p className="text-[11px] text-slate-500">
            Status: {item.documentStatus} · Eingegangen: {formatDate(item.createdAt)}
          </p>
        </div>
      </div>

      {isDuplicate && item.counterpart && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-sm">
          <div className="flex items-center gap-2 text-slate-300">
            <Copy className="h-4 w-4 text-sky-400" />
            <span>
              {item.kind === 'exact_duplicate'
                ? 'Byte-identisch mit'
                : `Inhaltlich ähnlich (${Math.round((item.counterpart.similarity ?? 0) * 100)} %) zu`}
              :{' '}
              {item.counterpart.redacted ? (
                <span className="inline-flex items-center gap-1 text-slate-400">
                  <EyeOff className="h-3.5 w-3.5" />
                  einem Dokument, das Sie nicht einsehen dürfen
                </span>
              ) : (
                <strong className="text-slate-100">{item.counterpart.title}</strong>
              )}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Beide Dokumente bleiben erhalten. „Duplikat bestätigen“ verknüpft sie nur, „Sind verschieden“ merkt sich
            die Entscheidung dauerhaft, sodass dieses Paar nie wieder gemeldet wird.
          </p>
        </div>
      )}

      {!isDuplicate && (
        <div className="space-y-2">
          {pending.length === 0 ? (
            <p className="text-sm text-slate-400">Keine offenen Felder mehr.</p>
          ) : (
            pending.map((proposal) => (
              <ProposalRow
                key={proposal.field}
                proposal={proposal}
                settings={settings}
                editingValue={editing?.[proposal.field]}
                onChange={(value) => onChangeField(proposal.field, value)}
              />
            ))
          )}
          {item.proposals.some((proposal) => proposal.decision === 'auto_accepted') && (
            <p className="text-[11px] text-slate-500">
              Automatisch übernommen:{' '}
              {item.proposals
                .filter((proposal) => proposal.decision === 'auto_accepted')
                .map((proposal) => `${FIELD_LABELS[proposal.field] ?? proposal.field} = ${formatValue(proposal.field, proposal.proposedValue)}`)
                .join(' · ')}
            </p>
          )}
        </div>
      )}

      {isOpen && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
          <button
            onClick={() => onAct('accept')}
            disabled={busy}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {isDuplicate ? 'Duplikat bestätigen' : 'Vorschläge übernehmen'}
          </button>

          {isDuplicate ? (
            <button
              onClick={() => onAct('separate')}
              disabled={busy}
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <Split className="h-3.5 w-3.5" />
              Sind verschieden
            </button>
          ) : editing ? (
            <>
              <button
                onClick={() => onAct('correct')}
                disabled={busy}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Korrektur speichern
              </button>
              <button
                onClick={onCancelEditing}
                disabled={busy}
                className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
              >
                Abbrechen
              </button>
            </>
          ) : (
            <button
              onClick={onStartEditing}
              disabled={busy}
              className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <Pencil className="h-3.5 w-3.5" />
              Korrigieren
            </button>
          )}

          <button
            onClick={() => onAct('retry')}
            disabled={busy}
            className="flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Erneut verarbeiten
          </button>
          <button
            onClick={() => onAct('dismiss')}
            disabled={busy}
            className="ml-auto rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-50"
          >
            Ignorieren
          </button>
        </div>
      )}
    </article>
  );
};

interface ProposalRowProps {
  proposal: ReviewProposal;
  settings: ReviewSettings | null;
  editingValue?: string;
  onChange: (value: string) => void;
}

const ProposalRow: React.FC<ProposalRowProps> = ({ proposal, settings, editingValue, onChange }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-semibold text-slate-300">
        {FIELD_LABELS[proposal.field] ?? proposal.field}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-slate-500">
        {DECISION_LABELS[proposal.decision] ?? proposal.decision}
        <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
          <span
            className={`block h-full ${confidenceTone(proposal.confidence, settings)}`}
            style={{ width: `${Math.round(proposal.confidence * 100)}%` }}
          />
        </span>
        {Math.round(proposal.confidence * 100)} %
      </span>
    </div>
    {editingValue === undefined ? (
      <p className="mt-1 text-sm text-slate-200">
        {proposal.decision === 'discarded'
          ? 'Kein belastbarer Vorschlag – bitte selbst eintragen.'
          : formatValue(proposal.field, proposal.proposedValue)}
      </p>
    ) : (
      <input
        value={editingValue}
        onChange={(event) => onChange(event.target.value)}
        placeholder={proposal.field === 'tags' ? 'Komma-getrennt' : proposal.field === 'document_date' ? 'JJJJ-MM-TT' : ''}
        className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
      />
    )}
  </div>
);
