import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  DatabaseBackup,
  HardDrive,
  Inbox,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  Server,
  XCircle,
} from 'lucide-react';
import {
  OpsAlertSettings,
  OpsComponentHealth,
  OpsComponentName,
  OpsDashboardData,
  OpsIncident,
  OpsStatus,
} from '../types';
import { fetchOpsDashboard, runOpsEvaluation, updateOpsSettings } from '../services/api';

/**
 * Ticket #37 -- the operations view.
 *
 * Admin-only (the nav entry is hidden for other roles and the backend
 * answers 403 regardless). Every number here is measured server-side; this
 * component deliberately holds no fallback constants, because inventing a
 * plausible-looking figure when the API is unreachable is exactly the
 * failure mode this ticket exists to remove.
 *
 * Each component card answers the five questions an operator has, in the
 * same order every time: what is the state, when did it last work, what is
 * wrong now, what do the numbers say, and what should I do about it.
 */

const COMPONENT_LABELS: Record<OpsComponentName, string> = {
  database: 'Datenbank',
  redis: 'Redis (Rate-Limits)',
  storage: 'Speicher',
  backup: 'Backup & Restore',
  ingestion: 'Dokumenteneingang',
  worker: 'Worker (OCR/KI)',
  email_import: 'E-Mail-Import',
  ai_provider: 'KI-Anbieter',
};

const COMPONENT_ICONS: Record<OpsComponentName, React.ComponentType<{ className?: string }>> = {
  database: Database,
  redis: Server,
  storage: HardDrive,
  backup: DatabaseBackup,
  ingestion: Inbox,
  worker: Cpu,
  email_import: Mail,
  ai_provider: Bot,
};

const STATUS_LABELS: Record<OpsStatus, string> = {
  ok: 'In Ordnung',
  degraded: 'Beeinträchtigt',
  failed: 'Gestört',
};

const STATUS_STYLES: Record<OpsStatus, string> = {
  ok: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  degraded: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  failed: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
};

const FIELD_CLASS =
  'w-full bg-slate-900/90 border border-slate-800 focus:border-indigo-500 text-sm text-slate-200 ' +
  'rounded-xl px-3 py-2 outline-none transition-all placeholder:text-slate-500';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Noch nie';
  try {
    return new Date(value).toLocaleString('de-DE');
  } catch {
    return value;
  }
}

function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} Std.` : `${hours} Std. ${rest} Min.`;
  const days = Math.floor(hours / 24);
  return `${days} Tg. ${hours % 24} Std.`;
}

const StatusPill: React.FC<{ status: OpsStatus }> = ({ status }) => (
  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${STATUS_STYLES[status]}`}>
    {STATUS_LABELS[status]}
  </span>
);

/**
 * The per-component "capacity" line: whatever measured number best answers
 * "how much room is left" for that dependency.
 */
function capacityLine(component: OpsComponentHealth): string {
  const metrics = component.metrics ?? {};
  switch (component.component) {
    case 'storage':
      return `${formatBytes(metrics.originalsUsedBytes)} / ${formatBytes(metrics.originalsTotalBytes)} belegt · ${
        metrics.originalsFreePercent ?? '—'
      } % frei`;
    case 'ingestion':
      return `${metrics.queued ?? 0} in Warteschlange · ${metrics.failed ?? 0} fehlgeschlagen`;
    case 'worker':
      return `${metrics.pendingWork ?? 0} offene Aufgabe(n)`;
    case 'database':
      return `${metrics.latencyMs ?? '—'} ms · ${metrics.poolIdle ?? '—'}/${metrics.poolTotal ?? '—'} Verbindungen frei`;
    case 'redis':
      return `${metrics.latencyMs ?? '—'} ms Antwortzeit`;
    case 'backup':
      return `DB ${formatBytes(metrics.dbBackupSizeBytes)} · Dateien ${formatBytes(metrics.storageBackupSizeBytes)}`;
    case 'email_import':
      return metrics.configured
        ? `Abruf alle ${metrics.pollIntervalMinutes} Min.`
        : 'Kein Postfach eingerichtet';
    case 'ai_provider':
      return `Anbieter: ${metrics.provider ?? '—'}`;
    default:
      return '—';
  }
}

/** Queue age is the ingestion probe's headline number, shown on its card too. */
function queueAgeLine(component: OpsComponentHealth): string | null {
  const metrics = component.metrics ?? {};
  if (component.component === 'ingestion') {
    return `Ältester Eintrag: ${formatMinutes(metrics.queueAgeMinutes)} (Grenzwert ${formatMinutes(
      metrics.queueAgeFailMinutes
    )})`;
  }
  if (component.component === 'worker' && (metrics.pendingWork ?? 0) > 0) {
    return `Wartet seit: ${formatMinutes(metrics.oldestPendingMinutes)}`;
  }
  if (component.component === 'email_import' && metrics.configured) {
    return `Letzter Abruf vor: ${formatMinutes(metrics.minutesSinceLastPoll)}`;
  }
  if (component.component === 'backup') {
    return `Letzte geprüfte Wiederherstellung: ${
      metrics.restoreAgeHours === null || metrics.restoreAgeHours === undefined
        ? 'keine'
        : `vor ${metrics.restoreAgeHours} Std.`
    }`;
  }
  return null;
}

const ComponentCard: React.FC<{ component: OpsComponentHealth }> = ({ component }) => {
  const Icon = COMPONENT_ICONS[component.component] ?? Activity;
  const queueAge = queueAgeLine(component);

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="font-semibold text-slate-200 text-sm truncate">
            {COMPONENT_LABELS[component.component] ?? component.component}
          </span>
        </div>
        <StatusPill status={component.status} />
      </div>

      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Letzter Erfolg</dt>
          <dd className="text-slate-300 text-right">{formatTimestamp(component.lastSuccessAt)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Kapazität</dt>
          <dd className="text-slate-300 text-right">{capacityLine(component)}</dd>
        </div>
        {queueAge && (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Warteschlange</dt>
            <dd className="text-slate-300 text-right">{queueAge}</dd>
          </div>
        )}
      </dl>

      <div
        className={`text-xs rounded-lg px-3 py-2 border ${
          component.currentFailure
            ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
            : 'bg-slate-900/60 border-slate-800 text-slate-400'
        }`}
      >
        {component.currentFailure ?? 'Kein aktueller Fehler'}
      </div>

      <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
        <Activity className="w-3.5 h-3.5 mt-px shrink-0 text-indigo-400" />
        <span>
          <span className="text-slate-500">Maßnahme: </span>
          {component.recoveryAction}
        </span>
      </p>
    </div>
  );
};

/**
 * Delivery is shown per incident because "we saw it but could not tell
 * anybody" is a different operational situation from "the admin was
 * mailed", and the operator has to be able to tell them apart at a glance.
 */
const DeliveryBadge: React.FC<{ incident: OpsIncident }> = ({ incident }) => {
  const latest = incident.deliveries[incident.deliveries.length - 1];

  if (!latest) {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full border bg-slate-500/10 text-slate-400 border-slate-500/30">
        keine Zustellung versucht
      </span>
    );
  }

  if (latest.status === 'delivered') {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full border bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
        zugestellt an {latest.recipient}
      </span>
    );
  }

  return (
    <span
      className="text-[11px] px-2 py-0.5 rounded-full border bg-amber-500/10 text-amber-300 border-amber-500/30"
      title={latest.error ?? undefined}
    >
      nicht zugestellt: {latest.error ?? 'unbekannter Grund'}
    </span>
  );
};

const IncidentRow: React.FC<{ incident: OpsIncident }> = ({ incident }) => (
  <li className="border border-slate-800 rounded-xl p-3 space-y-2 bg-slate-900/40">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-slate-200 font-medium">
          {COMPONENT_LABELS[incident.component] ?? incident.component}
          <span className="text-slate-500 font-normal"> · {incident.kind}</span>
        </p>
        <p className="text-xs text-slate-400 mt-0.5">{incident.summary}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
            incident.severity === 'critical'
              ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
              : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
          }`}
        >
          {incident.severity === 'critical' ? 'kritisch' : 'Warnung'}
        </span>
        {incident.occurrences > 1 && (
          <span className="text-[11px] text-slate-400">{incident.occurrences}× beobachtet</span>
        )}
      </div>
    </div>

    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
      <span className="flex items-center gap-1">
        <Clock className="w-3 h-3" /> seit {formatTimestamp(incident.firstSeenAt)}
      </span>
      <span>· zuletzt {formatTimestamp(incident.lastSeenAt)}</span>
      {incident.status === 'resolved' && (
        <span className="text-emerald-400">· behoben {formatTimestamp(incident.resolvedAt)}</span>
      )}
      <DeliveryBadge incident={incident} />
    </div>
  </li>
);

const SettingsForm: React.FC<{
  settings: OpsAlertSettings;
  onSaved: (settings: OpsAlertSettings) => void;
}> = ({ settings, onSaved }) => {
  const [draft, setDraft] = useState<OpsAlertSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const numberField = (label: string, key: keyof OpsAlertSettings, hint: string) => (
    <label className="space-y-1 block">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        type="number"
        min={0}
        className={FIELD_CLASS}
        value={String(draft[key] ?? '')}
        onChange={(event) =>
          setDraft((current) => ({ ...current, [key]: Number(event.target.value) } as OpsAlertSettings))
        }
      />
      <span className="text-[11px] text-slate-500">{hint}</span>
    </label>
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateOpsSettings({
        emailEnabled: draft.emailEnabled,
        recipient: draft.recipient?.trim() ? draft.recipient.trim() : null,
        minSeverity: draft.minSeverity,
        queueAgeWarnMinutes: draft.queueAgeWarnMinutes,
        queueAgeFailMinutes: draft.queueAgeFailMinutes,
        storageFreeWarnPercent: draft.storageFreeWarnPercent,
        storageFreeFailPercent: draft.storageFreeFailPercent,
        backupVerifyMaxAgeHours: draft.backupVerifyMaxAgeHours,
        workerStaleMinutes: draft.workerStaleMinutes,
        emailPollStaleMinutes: draft.emailPollStaleMinutes,
      });
      onSaved(updated);
      setSaved(true);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Einstellungen konnten nicht gespeichert werden.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass-panel p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Bell className="w-4 h-4 text-indigo-400" />
        <h2 className="font-bold text-slate-200 text-sm">Grenzwerte & Alarmierung</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {numberField('Warteschlange Warnung (Min.)', 'queueAgeWarnMinutes', 'Ab hier gilt der Eingang als langsam.')}
        {numberField('Warteschlange Störung (Min.)', 'queueAgeFailMinutes', 'Ab hier gilt der Eingang als hängend.')}
        {numberField('Freier Speicher Warnung (%)', 'storageFreeWarnPercent', 'Unterhalb dieses Anteils: Warnung.')}
        {numberField('Freier Speicher Störung (%)', 'storageFreeFailPercent', 'Unterhalb dieses Anteils: kritisch.')}
        {numberField('Restore-Prüfung max. Alter (Std.)', 'backupVerifyMaxAgeHours', 'Ungeprüftes Backup gilt als Risiko.')}
        {numberField('Worker ohne Aktivität (Min.)', 'workerStaleMinutes', 'Nur relevant, wenn Arbeit wartet.')}
        {numberField('E-Mail-Abruf überfällig (Min.)', 'emailPollStaleMinutes', 'Mindestwartezeit vor einer Meldung.')}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-slate-800 pt-4">
        <label className="space-y-1 block">
          <span className="text-xs text-slate-400">Empfänger für Alarme</span>
          <input
            type="email"
            placeholder="admin@haushalt.local"
            className={FIELD_CLASS}
            value={draft.recipient ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, recipient: event.target.value }))}
          />
        </label>

        <label className="space-y-1 block">
          <span className="text-xs text-slate-400">Ab Schweregrad</span>
          <select
            className={FIELD_CLASS}
            value={draft.minSeverity}
            onChange={(event) =>
              setDraft((current) => ({ ...current, minSeverity: event.target.value as OpsAlertSettings['minSeverity'] }))
            }
          >
            <option value="warning">Warnung und höher</option>
            <option value="critical">Nur kritisch</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-300 sm:self-end sm:pb-2.5">
          <input
            type="checkbox"
            checked={draft.emailEnabled}
            onChange={(event) => setDraft((current) => ({ ...current, emailEnabled: event.target.checked }))}
          />
          E-Mail-Benachrichtigung aktiv
        </label>
      </div>

      {!settings.smtpConfigured && (
        <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          Kein SMTP-Server konfiguriert (SMTP_HOST). Alarme werden weiterhin vollständig hier erfasst und als „nicht
          zugestellt“ markiert.
        </p>
      )}

      {error && (
        <p className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{error}</p>
      )}
      {saved && !error && <p className="text-xs text-emerald-400">Gespeichert.</p>}

      <button onClick={save} disabled={saving} className="btn-primary text-xs py-2 px-4">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        Grenzwerte speichern
      </button>
    </section>
  );
};

export const OpsDashboard: React.FC = () => {
  const [data, setData] = useState<OpsDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOpsDashboard());
    } catch (err: any) {
      if (err?.response?.status === 403) {
        setError('Zugriff verweigert: Nur Administratoren sehen den Betriebsstatus.');
      } else if (err?.response?.status === 401) {
        setError('Nicht angemeldet.');
      } else {
        setError('Betriebsstatus konnte nicht geladen werden.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const evaluateNow = async () => {
    setEvaluating(true);
    try {
      await runOpsEvaluation();
      await load();
    } catch {
      setError('Prüfung konnte nicht ausgeführt werden.');
    } finally {
      setEvaluating(false);
    }
  };

  const ingestion = useMemo(
    () => data?.components.find((component) => component.component === 'ingestion'),
    [data]
  );
  const storage = useMemo(() => data?.components.find((component) => component.component === 'storage'), [data]);

  const openIncidents = data?.openIncidents ?? [];
  const resolvedIncidents = (data?.incidents ?? []).filter((incident) => incident.status === 'resolved');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-100">Betrieb & Alarme</h1>
          <p className="text-xs text-slate-400">
            Gemessener Zustand von Speicher, Backup, Eingang, Worker, E-Mail-Import und KI-Anbieter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && <StatusPill status={data.overallStatus} />}
          <button onClick={evaluateNow} disabled={evaluating} className="btn-secondary text-xs py-2 px-3">
            {evaluating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
            Jetzt prüfen
          </button>
          <button onClick={load} disabled={loading} className="btn-secondary text-xs py-2 px-3">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Aktualisieren
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{error}</p>
      )}
      {loading && !data && !error && <p className="text-xs text-slate-500">Lädt...</p>}

      {data && (
        <>
          {/* The four headline numbers, so the state of the system is legible
              without reading a single card. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="glass-card p-4 space-y-1">
              <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Warteschlangen-Alter
              </p>
              <p className="text-lg font-bold text-slate-100">
                {formatMinutes(ingestion?.metrics?.queueAgeMinutes)}
              </p>
              <p className="text-[11px] text-slate-500">{ingestion?.metrics?.queued ?? 0} Dokument(e) offen</p>
            </div>

            <div className="glass-card p-4 space-y-1">
              <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5" /> Freier Speicher
              </p>
              <p className="text-lg font-bold text-slate-100">
                {formatBytes(storage?.metrics?.originalsFreeBytes)}
              </p>
              <p className="text-[11px] text-slate-500">
                von {formatBytes(storage?.metrics?.originalsTotalBytes)} ({storage?.metrics?.originalsFreePercent ?? '—'} %)
              </p>
            </div>

            <div className="glass-card p-4 space-y-1">
              <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Offene Vorfälle
              </p>
              <p className="text-lg font-bold text-slate-100">{openIncidents.length}</p>
              <p className="text-[11px] text-slate-500">
                {openIncidents.filter((incident) => incident.severity === 'critical').length} kritisch
              </p>
            </div>

            <div className="glass-card p-4 space-y-1">
              <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Letzte Messung
              </p>
              <p className="text-sm font-bold text-slate-100">{formatTimestamp(data.generatedAt)}</p>
              <p className="text-[11px] text-slate-500">
                {data.settings.emailEnabled ? `Alarme an ${data.settings.recipient}` : 'E-Mail-Alarme deaktiviert'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {data.components.map((component) => (
              <ComponentCard key={component.component} component={component} />
            ))}
          </div>

          <section className="glass-panel p-5 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <h2 className="font-bold text-slate-200 text-sm">Offene Vorfälle</h2>
            </div>
            {openIncidents.length === 0 ? (
              <p className="text-xs text-slate-500 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Keine offenen Vorfälle.
              </p>
            ) : (
              <ul className="space-y-2">
                {openIncidents.map((incident) => (
                  <IncidentRow key={incident.id} incident={incident} />
                ))}
              </ul>
            )}
          </section>

          <section className="glass-panel p-5 space-y-3">
            <div className="flex items-center gap-2">
              <XCircle className="w-4 h-4 text-slate-400" />
              <h2 className="font-bold text-slate-200 text-sm">Behobene Vorfälle</h2>
            </div>
            {resolvedIncidents.length === 0 ? (
              <p className="text-xs text-slate-500">Noch keine behobenen Vorfälle aufgezeichnet.</p>
            ) : (
              <ul className="space-y-2">
                {resolvedIncidents.slice(0, 10).map((incident) => (
                  <IncidentRow key={incident.id} incident={incident} />
                ))}
              </ul>
            )}
          </section>

          <SettingsForm
            settings={data.settings}
            onSaved={(settings) => setData((current) => (current ? { ...current, settings } : current))}
          />
        </>
      )}
    </div>
  );
};
