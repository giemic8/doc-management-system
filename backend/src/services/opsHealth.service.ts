/**
 * Ticket #37 -- measured health probes for every runtime dependency.
 *
 * The existing health endpoint (`GET /api/health`) answers "is this
 * process running", which is the one question that is never in doubt when
 * an operator is looking at the dashboard: the process answered, so it is
 * up. What actually breaks a household document server is a dependency
 * degrading underneath a perfectly healthy process -- a full disk, a
 * worker that stopped claiming rows, a backup target that silently
 * stopped accepting writes, an LLM host that is refusing connections.
 * Each probe here therefore measures the dependency itself and reports
 * five things the operator needs: when it last worked, what is wrong now,
 * how old the oldest queued work is, how much capacity is left, and what
 * to do about it.
 *
 * Privacy: every probe reports counts, ages and byte totals only. No
 * document title, filename, sender or space name is read into a health
 * payload, so an admin-only operations view cannot become a side channel
 * around the tag ACL (invariant 1) or the private-space rule (invariant
 * 10) -- "3 Dokumente fehlgeschlagen" is operationally sufficient and
 * names nobody. File paths are inspected on disk but never returned.
 */
import fs from 'fs';
import axios from 'axios';
import { config } from '../config';
import { pool, query } from '../database/db';
import { pingRedis } from './rateLimit.service';
import { parseBackupStatusFile } from './backupStatus.service';

export const OPS_COMPONENTS = [
  'database',
  'redis',
  'storage',
  'backup',
  'ingestion',
  'worker',
  'email_import',
  'ai_provider',
] as const;

export type OpsComponent = (typeof OPS_COMPONENTS)[number];
export type OpsStatus = 'ok' | 'degraded' | 'failed';
export type OpsSeverity = 'warning' | 'critical';

/**
 * One concrete problem with one component. A component can have several at
 * once (storage can be both short on space and missing a replica), and the
 * `kind` is what the incident table deduplicates on -- so a component that
 * stays broken for a week produces one incident per kind, not one per
 * evaluation.
 */
export interface OpsIssue {
  kind: string;
  severity: OpsSeverity;
  summary: string;
}

export interface ComponentHealth {
  component: OpsComponent;
  status: OpsStatus;
  lastSuccessAt: string | null;
  currentFailure: string | null;
  metrics: Record<string, unknown>;
  recoveryAction: string;
  issues: OpsIssue[];
  lastCheckedAt: string;
}

/** Operator-tunable limits; persisted in `ops_alert_settings`, never hardcoded. */
export interface OpsThresholds {
  queueAgeWarnMinutes: number;
  queueAgeFailMinutes: number;
  storageFreeWarnPercent: number;
  storageFreeFailPercent: number;
  backupVerifyMaxAgeHours: number;
  workerStaleMinutes: number;
  emailPollStaleMinutes: number;
}

export const DEFAULT_THRESHOLDS: OpsThresholds = {
  queueAgeWarnMinutes: 30,
  queueAgeFailMinutes: 120,
  storageFreeWarnPercent: 15,
  storageFreeFailPercent: 5,
  backupVerifyMaxAgeHours: 48,
  workerStaleMinutes: 60,
  emailPollStaleMinutes: 60,
};

/** Round-trip latency above which the database counts as slow, then unusable. */
const DB_LATENCY_WARN_MS = 250;
const DB_LATENCY_FAIL_MS = 2000;
/** A statement running longer than this is a degradation, not normal work. */
const DB_LONG_QUERY_WARN_SECONDS = 60;
/** How many recent documents get their files stat()ed per storage probe. */
const STORAGE_SAMPLE_SIZE = 200;
/** The AI probe talks to a remote host, so it gets a short leash and a cache. */
const AI_PROBE_TIMEOUT_MS = 2500;
const AI_PROBE_CACHE_MS = 5 * 60 * 1000;

/**
 * German operator instruction per problem kind. Kept as data rather than
 * scattered through the probes so the dashboard, the alert email and the
 * incident row all say exactly the same thing.
 */
const RECOVERY_ACTIONS: Record<string, string> = {
  db_unreachable: 'PostgreSQL-Container neu starten und Verbindungsdaten prüfen',
  db_slow: 'Langlaufende Abfragen in pg_stat_activity prüfen und Datenbanklast senken',
  redis_unreachable: 'Redis-Container neu starten (Rate-Limits sind bis dahin unwirksam)',
  capacity_critical: 'Speicherplatz freigeben oder Volume vergrößern',
  capacity_low: 'Speicherplatz freigeben oder Volume vergrößern',
  storage_unreadable: 'Storage-Mount prüfen und Volume neu einhängen',
  missing_originals: 'Originale aus dem Backup wiederherstellen und Storage-Mount prüfen',
  missing_replicas: 'Replikat-Pfad prüfen und Zweitkopien neu schreiben',
  backup_failed: 'Backup-Ziel prüfen und Log des Backup-Containers ansehen',
  restore_unverified: 'Wiederherstellungstest ausführen (Restore-Verifikation)',
  queue_stalled: 'Worker-Container neu starten',
  queue_slow: 'Worker-Auslastung prüfen; Verarbeitung hängt hinterher',
  documents_failed: 'Fehlgeschlagene Dokumente prüfen und erneut verarbeiten',
  worker_stalled: 'Worker-Container neu starten',
  poll_overdue: 'IMAP-Zugangsdaten und Erreichbarkeit des Postfachs prüfen',
  ai_unreachable: 'Ollama-/OpenAI-Erreichbarkeit prüfen (LLM_PROVIDER-Konfiguration)',
  ai_not_configured: 'API-Schlüssel für den konfigurierten LLM-Anbieter hinterlegen',
};

const HEALTHY_ACTIONS: Record<OpsComponent, string> = {
  database: 'Keine Maßnahme erforderlich',
  redis: 'Keine Maßnahme erforderlich',
  storage: 'Keine Maßnahme erforderlich',
  backup: 'Keine Maßnahme erforderlich',
  ingestion: 'Keine Maßnahme erforderlich',
  worker: 'Keine Maßnahme erforderlich',
  email_import: 'Keine Maßnahme erforderlich',
  ai_provider: 'Keine Maßnahme erforderlich',
};

function nowIso(): string {
  return new Date().toISOString();
}

function severityOf(issues: OpsIssue[]): OpsStatus {
  if (issues.some((issue) => issue.severity === 'critical')) return 'failed';
  if (issues.length > 0) return 'degraded';
  return 'ok';
}

/** The worst issue decides what the operator is told to do first. */
function recoveryActionFor(component: OpsComponent, issues: OpsIssue[]): string {
  const worst = issues.find((issue) => issue.severity === 'critical') ?? issues[0];
  if (!worst) return HEALTHY_ACTIONS[component];
  return RECOVERY_ACTIONS[worst.kind] ?? HEALTHY_ACTIONS[component];
}

function build(
  component: OpsComponent,
  issues: OpsIssue[],
  metrics: Record<string, unknown>,
  lastSuccessAt: string | null
): ComponentHealth {
  const status = severityOf(issues);
  return {
    component,
    status,
    lastSuccessAt,
    currentFailure: issues.length > 0 ? issues.map((issue) => issue.summary).join('; ') : null,
    metrics,
    recoveryAction: recoveryActionFor(component, issues),
    issues,
    lastCheckedAt: nowIso(),
  };
}

function minutesSince(value: Date | string | null): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 60_000));
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

/**
 * A real round trip plus a look at what the server is actually doing.
 * "The pool object exists" would pass while every connection is blocked on
 * a lock, which is exactly the failure this is meant to surface.
 */
export async function probeDatabase(): Promise<ComponentHealth> {
  const startedAt = Date.now();
  try {
    await query('SELECT 1;');
    const latencyMs = Date.now() - startedAt;

    let longestActiveSeconds = 0;
    let activeQueries = 0;
    try {
      const activity = await query(`
        SELECT COUNT(*)::int AS active,
               COALESCE(MAX(EXTRACT(EPOCH FROM (now() - query_start))), 0)::float AS longest_seconds
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND pid <> pg_backend_pid();
      `);
      activeQueries = activity.rows[0]?.active ?? 0;
      longestActiveSeconds = Math.round(activity.rows[0]?.longest_seconds ?? 0);
    } catch {
      // pg_stat_activity can be restricted on managed instances; the
      // round-trip measurement above still stands on its own.
    }

    const metrics = {
      latencyMs,
      activeQueries,
      longestActiveSeconds,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    };

    const issues: OpsIssue[] = [];
    if (latencyMs >= DB_LATENCY_FAIL_MS) {
      issues.push({
        kind: 'db_slow',
        severity: 'critical',
        summary: `Datenbank antwortet sehr langsam (${latencyMs} ms)`,
      });
    } else if (latencyMs >= DB_LATENCY_WARN_MS) {
      issues.push({ kind: 'db_slow', severity: 'warning', summary: `Datenbank antwortet langsam (${latencyMs} ms)` });
    } else if (longestActiveSeconds >= DB_LONG_QUERY_WARN_SECONDS) {
      issues.push({
        kind: 'db_slow',
        severity: 'warning',
        summary: `Langlaufende Abfrage seit ${longestActiveSeconds} s aktiv`,
      });
    }

    return build('database', issues, metrics, issues.length === 0 ? nowIso() : null);
  } catch (err: any) {
    return build(
      'database',
      [{ kind: 'db_unreachable', severity: 'critical', summary: `Datenbank nicht erreichbar: ${err.message}` }],
      { latencyMs: Date.now() - startedAt },
      null
    );
  }
}

// ---------------------------------------------------------------------------
// redis
// ---------------------------------------------------------------------------

/**
 * Redis only backs rate-limit counters here, so losing it weakens brute
 * force protection but does not stop document work -- degraded, not fatal.
 */
export async function probeRedis(): Promise<ComponentHealth> {
  const startedAt = Date.now();
  try {
    await pingRedis();
    const latencyMs = Date.now() - startedAt;
    return build('redis', [], { latencyMs, host: config.redisHost, port: config.redisPort }, nowIso());
  } catch (err: any) {
    return build(
      'redis',
      [
        {
          kind: 'redis_unreachable',
          severity: 'warning',
          summary: `Redis nicht erreichbar: ${err.message}`,
        },
      ],
      { latencyMs: Date.now() - startedAt, host: config.redisHost, port: config.redisPort },
      null
    );
  }
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

interface VolumeCapacity {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  freePercent: number;
  deviceId: number | null;
  error?: string;
}

/** Real filesystem numbers via statfs -- no configured "quota" fiction. */
async function measureVolume(rootPath: string): Promise<VolumeCapacity> {
  try {
    const stats = await fs.promises.statfs(rootPath);
    const totalBytes = stats.blocks * stats.bsize;
    // bavail, not bfree: root-reserved blocks are not space we can use.
    const freeBytes = stats.bavail * stats.bsize;
    let deviceId: number | null = null;
    try {
      deviceId = fs.statSync(rootPath).dev;
    } catch {
      deviceId = null;
    }
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freePercent: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 0,
      deviceId,
    };
  } catch (err: any) {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0, freePercent: 0, deviceId: null, error: err.message };
  }
}

export async function probeStorage(thresholds: OpsThresholds): Promise<ComponentHealth> {
  const [originals, replica] = await Promise.all([
    measureVolume(config.storagePath),
    measureVolume(config.storageReplicaPath),
  ]);

  // Stat a bounded, recent sample rather than every document: this runs on
  // a dashboard refresh, and a full sweep of a large library would turn an
  // observability page into an I/O storm.
  let sampled = 0;
  let missingPrimary = 0;
  let missingReplica = 0;
  let withoutReplica = 0;
  let documentBytes = 0;
  let sampleError: string | null = null;

  try {
    const sample = await query(
      `SELECT file_path, replica_file_path
       FROM documents
       WHERE status <> 'trashed'
       ORDER BY created_at DESC
       LIMIT $1;`,
      [STORAGE_SAMPLE_SIZE]
    );

    for (const row of sample.rows) {
      sampled += 1;
      if (!row.file_path || !fs.existsSync(row.file_path)) missingPrimary += 1;
      if (!row.replica_file_path) {
        withoutReplica += 1;
      } else if (!fs.existsSync(row.replica_file_path)) {
        missingReplica += 1;
      }
    }

    const usage = await query(
      `SELECT COALESCE(SUM(file_size), 0)::bigint AS bytes FROM documents WHERE status <> 'trashed';`
    );
    documentBytes = Number(usage.rows[0]?.bytes ?? 0);
  } catch (err: any) {
    sampleError = err.message;
  }

  const metrics = {
    originalsPath: config.storagePath,
    originalsTotalBytes: originals.totalBytes,
    originalsFreeBytes: originals.freeBytes,
    originalsUsedBytes: originals.usedBytes,
    originalsFreePercent: originals.freePercent,
    replicaPath: config.storageReplicaPath,
    replicaTotalBytes: replica.totalBytes,
    replicaFreeBytes: replica.freeBytes,
    replicaUsedBytes: replica.usedBytes,
    replicaFreePercent: replica.freePercent,
    // Ticket #31 expects the replica on separate physical storage. Reported
    // as a measurement, not an alert: on a single-disk household box this
    // is a known trade-off, and alerting on it every cycle would bury the
    // problems an operator can actually act on.
    replicaOnSameDevice:
      originals.deviceId !== null && replica.deviceId !== null ? originals.deviceId === replica.deviceId : null,
    documentBytes,
    sampledDocuments: sampled,
    missingPrimaryFiles: missingPrimary,
    missingReplicaFiles: missingReplica,
    documentsWithoutReplica: withoutReplica,
  };

  const issues: OpsIssue[] = [];

  if (originals.error) {
    issues.push({
      kind: 'storage_unreadable',
      severity: 'critical',
      summary: `Originalspeicher nicht lesbar: ${originals.error}`,
    });
  } else if (originals.freePercent <= thresholds.storageFreeFailPercent) {
    issues.push({
      kind: 'capacity_critical',
      severity: 'critical',
      summary: `Nur noch ${originals.freePercent} % freier Speicher auf dem Originalspeicher`,
    });
  } else if (originals.freePercent <= thresholds.storageFreeWarnPercent) {
    issues.push({
      kind: 'capacity_low',
      severity: 'warning',
      summary: `Freier Speicher auf dem Originalspeicher bei ${originals.freePercent} %`,
    });
  }

  if (replica.error) {
    issues.push({
      kind: 'storage_unreadable',
      severity: 'critical',
      summary: `Replikatspeicher nicht lesbar: ${replica.error}`,
    });
  }

  // Counts only: naming the affected documents here would leak titles of
  // documents the reader may not be allowed to see.
  if (missingPrimary > 0) {
    issues.push({
      kind: 'missing_originals',
      severity: 'critical',
      summary: `${missingPrimary} von ${sampled} geprüften Originalen fehlen im Speicher`,
    });
  }
  if (missingReplica > 0) {
    issues.push({
      kind: 'missing_replicas',
      severity: 'warning',
      summary: `${missingReplica} von ${sampled} geprüften Zweitkopien fehlen`,
    });
  }
  if (sampleError) {
    issues.push({
      kind: 'storage_unreadable',
      severity: 'warning',
      summary: `Dateiprüfung nicht möglich: ${sampleError}`,
    });
  }

  return build('storage', issues, metrics, issues.length === 0 ? nowIso() : null);
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

/**
 * A backup nobody has restored is a hypothesis, so this reads both halves
 * of the status file written by the backup container: the last successful
 * run and the last *verified* restore.
 */
export async function probeBackup(thresholds: OpsThresholds): Promise<ComponentHealth> {
  const status = parseBackupStatusFile(config.backupStatusPath);
  const lastBackupAt = isoOrNull(status.completedAt ?? status.timestamp);
  const lastRestoreAt = isoOrNull(status.lastRestoreAt);
  const restoreAgeMinutes = minutesSince(lastRestoreAt);

  const metrics = {
    lastBackupAt,
    lastRestoreAt,
    restoreAgeHours: restoreAgeMinutes === null ? null : Math.round((restoreAgeMinutes / 60) * 10) / 10,
    databaseVerified: status.restore.databaseVerified,
    sampledOriginalsChecked: status.restore.sampledOriginalsChecked,
    sampledOriginalsMatched: status.restore.sampledOriginalsMatched,
    dbBackupSizeBytes: status.dbBackupSizeBytes,
    storageBackupSizeBytes: status.storageBackupSizeBytes,
    lastRunSuccessful: status.success,
  };

  const issues: OpsIssue[] = [];
  if (!status.success) {
    issues.push({
      kind: 'backup_failed',
      severity: 'critical',
      summary: status.error ? `Backup fehlgeschlagen: ${status.error}` : 'Letzter Backup-Lauf war nicht erfolgreich',
    });
  }

  const maxAgeMinutes = thresholds.backupVerifyMaxAgeHours * 60;
  if (restoreAgeMinutes === null) {
    issues.push({
      kind: 'restore_unverified',
      severity: 'warning',
      summary: 'Noch keine überprüfte Wiederherstellung aufgezeichnet',
    });
  } else if (restoreAgeMinutes > maxAgeMinutes || !status.restore.databaseVerified) {
    issues.push({
      kind: 'restore_unverified',
      severity: 'warning',
      summary: `Letzte überprüfte Wiederherstellung ist ${Math.round(restoreAgeMinutes / 60)} h alt (Grenzwert ${thresholds.backupVerifyMaxAgeHours} h)`,
    });
  }

  return build('backup', issues, metrics, status.success ? lastBackupAt : null);
}

// ---------------------------------------------------------------------------
// ingestion
// ---------------------------------------------------------------------------

/**
 * Queue age, straight out of the canonical lifecycle: PostgreSQL is the
 * ingestion queue (ADR 0001), so `last_transition_at` on the rows that are
 * still waiting *is* the queue age -- there is no second broker whose depth
 * could disagree with it.
 */
export async function probeIngestion(thresholds: OpsThresholds): Promise<ComponentHealth> {
  try {
    const res = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'received')::int AS received,
        COUNT(*) FILTER (WHERE status = 'durable')::int AS durable,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(last_transition_at)
          FILTER (WHERE status = 'processing'))), 0)::float AS oldest_processing_seconds,
        COALESCE(EXTRACT(EPOCH FROM (now() - MIN(last_transition_at)
          FILTER (WHERE status IN ('received', 'durable')))), 0)::float AS oldest_pending_seconds
      FROM documents;
    `);
    const row = res.rows[0];

    const lastSuccess = await query(`
      SELECT MAX(created_at) AS at
      FROM document_state_transitions
      WHERE to_state IN ('durable', 'review', 'ready');
    `);

    const oldestProcessingMinutes = Math.round((Number(row.oldest_processing_seconds) || 0) / 60);
    const oldestPendingMinutes = Math.round((Number(row.oldest_pending_seconds) || 0) / 60);
    const queueAgeMinutes = Math.max(oldestProcessingMinutes, oldestPendingMinutes);
    const queued = Number(row.received) + Number(row.durable) + Number(row.processing);

    const metrics = {
      received: Number(row.received),
      durable: Number(row.durable),
      processing: Number(row.processing),
      failed: Number(row.failed),
      queued,
      queueAgeMinutes,
      oldestProcessingMinutes,
      oldestPendingMinutes,
      queueAgeWarnMinutes: thresholds.queueAgeWarnMinutes,
      queueAgeFailMinutes: thresholds.queueAgeFailMinutes,
    };

    const issues: OpsIssue[] = [];
    if (queued > 0 && queueAgeMinutes >= thresholds.queueAgeFailMinutes) {
      issues.push({
        kind: 'queue_stalled',
        severity: 'critical',
        summary: `Älteste Warteschlangen-Position ist ${queueAgeMinutes} Minuten alt (${queued} Dokumente warten)`,
      });
    } else if (queued > 0 && queueAgeMinutes >= thresholds.queueAgeWarnMinutes) {
      issues.push({
        kind: 'queue_slow',
        severity: 'warning',
        summary: `Verarbeitung hängt hinterher: älteste Position ${queueAgeMinutes} Minuten alt`,
      });
    }

    // Counts, never titles: the operator learns that documents failed and
    // where to look, not what is in them.
    if (Number(row.failed) > 0) {
      issues.push({
        kind: 'documents_failed',
        severity: 'warning',
        summary: `${row.failed} Dokument(e) im Status "failed"`,
      });
    }

    return build('ingestion', issues, metrics, isoOrNull(lastSuccess.rows[0]?.at));
  } catch (err: any) {
    return build(
      'ingestion',
      [{ kind: 'db_unreachable', severity: 'critical', summary: `Ingestion-Status nicht lesbar: ${err.message}` }],
      {},
      null
    );
  }
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

/**
 * The Python worker has no heartbeat table, and the backend cannot inspect
 * a sibling container's process list, so worker liveness is inferred from
 * the evidence the worker leaves in the database: rows in
 * `document_state_transitions`. That evidence only appears when there is
 * work to do, so an idle worker and a dead worker look identical -- which
 * is why this only reports a stall when documents are actually waiting and
 * nothing has moved for longer than the configured window. A real
 * heartbeat (worker writing a timestamp each poll) would remove the
 * ambiguity and belongs in the worker's own ticket.
 */
export async function probeWorker(thresholds: OpsThresholds): Promise<ComponentHealth> {
  try {
    const res = await query(`
      SELECT
        (SELECT MAX(created_at) FROM document_state_transitions
          WHERE to_state IN ('review', 'ready', 'failed')) AS last_completion_at,
        (SELECT MAX(created_at) FROM document_state_transitions
          WHERE to_state = 'processing') AS last_claim_at,
        (SELECT COUNT(*) FROM documents WHERE status IN ('durable', 'processing'))::int AS pending_work,
        COALESCE((SELECT EXTRACT(EPOCH FROM (now() - MIN(last_transition_at)))
          FROM documents WHERE status IN ('durable', 'processing')), 0)::float AS oldest_pending_seconds;
    `);
    const row = res.rows[0];

    const lastCompletionAt = isoOrNull(row.last_completion_at);
    const lastClaimAt = isoOrNull(row.last_claim_at);
    const lastActivityAt =
      [lastCompletionAt, lastClaimAt].filter(Boolean).sort().reverse()[0] ?? null;
    const idleMinutes = minutesSince(lastActivityAt);
    const pendingWork = Number(row.pending_work);
    const oldestPendingMinutes = Math.round((Number(row.oldest_pending_seconds) || 0) / 60);

    const metrics = {
      lastActivityAt,
      lastCompletionAt,
      lastClaimAt,
      minutesSinceActivity: idleMinutes,
      pendingWork,
      oldestPendingMinutes,
      livenessBasis: 'document_state_transitions',
      staleAfterMinutes: thresholds.workerStaleMinutes,
    };

    const issues: OpsIssue[] = [];
    const nothingMovedRecently = idleMinutes === null || idleMinutes >= thresholds.workerStaleMinutes;
    if (pendingWork > 0 && oldestPendingMinutes >= thresholds.workerStaleMinutes && nothingMovedRecently) {
      issues.push({
        kind: 'worker_stalled',
        severity: 'critical',
        summary: `${pendingWork} Dokument(e) warten seit ${oldestPendingMinutes} Minuten, keine Worker-Aktivität`,
      });
    }

    return build('worker', issues, metrics, lastActivityAt);
  } catch (err: any) {
    return build(
      'worker',
      [{ kind: 'db_unreachable', severity: 'critical', summary: `Worker-Aktivität nicht lesbar: ${err.message}` }],
      {},
      null
    );
  }
}

// ---------------------------------------------------------------------------
// email import
// ---------------------------------------------------------------------------

/**
 * The IMAP poller records `last_polled_at` but keeps its per-poll errors in
 * the process log only (emailImportScheduler.service.ts logs `result.errors`
 * and moves on), so the honest signal available to this probe is
 * overdueness, not the error text. Persisting the last poll error is a
 * change in the email-import module and is left to its owner.
 */
export async function probeEmailImport(thresholds: OpsThresholds): Promise<ComponentHealth> {
  try {
    const res = await query(`
      SELECT is_active, poll_interval_minutes, last_polled_at, created_at
      FROM email_import_config
      ORDER BY created_at DESC
      LIMIT 1;
    `);
    const cfg = res.rows[0];

    if (!cfg || !cfg.is_active) {
      // Not configured is not broken: a household that never wired up a
      // mailbox should not be alerted about one.
      return build('email_import', [], { configured: false, active: false }, null);
    }

    const lastPolledAt = isoOrNull(cfg.last_polled_at);
    const referenceAt = lastPolledAt ?? isoOrNull(cfg.created_at);
    const ageMinutes = minutesSince(referenceAt);
    const allowedMinutes = Math.max(
      thresholds.emailPollStaleMinutes,
      Number(cfg.poll_interval_minutes) * 3
    );

    const metrics = {
      configured: true,
      active: true,
      lastPolledAt,
      pollIntervalMinutes: Number(cfg.poll_interval_minutes),
      minutesSinceLastPoll: ageMinutes,
      overdueAfterMinutes: allowedMinutes,
      lastErrorAvailable: false,
    };

    const issues: OpsIssue[] = [];
    if (ageMinutes !== null && ageMinutes > allowedMinutes) {
      issues.push({
        kind: 'poll_overdue',
        severity: 'warning',
        summary: lastPolledAt
          ? `Letzter E-Mail-Abruf vor ${ageMinutes} Minuten (erwartet alle ${cfg.poll_interval_minutes} Minuten)`
          : `Seit ${ageMinutes} Minuten kein E-Mail-Abruf seit der Einrichtung`,
      });
    }

    return build('email_import', issues, metrics, lastPolledAt);
  } catch (err: any) {
    return build(
      'email_import',
      [{ kind: 'db_unreachable', severity: 'warning', summary: `E-Mail-Import-Status nicht lesbar: ${err.message}` }],
      {},
      null
    );
  }
}

// ---------------------------------------------------------------------------
// AI provider
// ---------------------------------------------------------------------------

let aiProviderCache: { health: ComponentHealth; at: number } | null = null;
let aiRefreshInFlight = false;

/**
 * Seam for tests and for a future push-based probe: priming the cache stops
 * the dashboard from reaching for the network at all.
 */
export function setAiProviderHealthCache(health: ComponentHealth | null): void {
  aiProviderCache = health ? { health, at: Date.now() } : null;
}

/**
 * Reaches the configured provider with a short timeout. Never called on the
 * dashboard's critical path -- see `getAiProviderHealth` -- because a
 * provider that hangs would otherwise hang the operations view, which is
 * precisely the page an operator opens when things are hanging.
 */
export async function probeAiProvider(): Promise<ComponentHealth> {
  const provider = config.llmProvider;
  const startedAt = Date.now();

  if (provider === 'openai' && !config.openaiApiKey) {
    return build(
      'ai_provider',
      [{ kind: 'ai_not_configured', severity: 'warning', summary: 'OpenAI ist gewählt, aber kein API-Schlüssel gesetzt' }],
      { provider, configured: false },
      null
    );
  }

  const endpoint = provider === 'openai' ? 'https://api.openai.com/v1/models' : `${config.ollamaHost}/api/tags`;

  try {
    await axios.get(endpoint, {
      timeout: AI_PROBE_TIMEOUT_MS,
      ...(provider === 'openai' ? { headers: { Authorization: `Bearer ${config.openaiApiKey}` } } : {}),
    });
    return build(
      'ai_provider',
      [],
      { provider, configured: true, latencyMs: Date.now() - startedAt, endpoint: provider === 'openai' ? 'openai' : config.ollamaHost },
      nowIso()
    );
  } catch (err: any) {
    return build(
      'ai_provider',
      [
        {
          // Enrichment degrades, documents still ingest and stay readable,
          // so this is a warning rather than a page-the-admin critical.
          kind: 'ai_unreachable',
          severity: 'warning',
          summary: `LLM-Anbieter (${provider}) nicht erreichbar: ${err.message}`,
        },
      ],
      { provider, configured: true, latencyMs: Date.now() - startedAt, endpoint: provider === 'openai' ? 'openai' : config.ollamaHost },
      null
    );
  }
}

/**
 * Cached view of the provider. `refresh: false` (the dashboard) returns the
 * last known answer and refreshes in the background; `refresh: true` (the
 * scheduler, which has no user waiting) probes for real when the cache is
 * stale.
 */
export async function getAiProviderHealth(refresh: boolean): Promise<ComponentHealth> {
  const fresh = aiProviderCache !== null && Date.now() - aiProviderCache.at < AI_PROBE_CACHE_MS;

  if (fresh) return aiProviderCache!.health;

  if (refresh) {
    const health = await probeAiProvider();
    aiProviderCache = { health, at: Date.now() };
    return health;
  }

  if (!aiRefreshInFlight) {
    aiRefreshInFlight = true;
    void probeAiProvider()
      .then((health) => {
        aiProviderCache = { health, at: Date.now() };
      })
      .catch(() => {
        /* a failed probe must never reject into the dashboard request */
      })
      .finally(() => {
        aiRefreshInFlight = false;
      });
  }

  if (aiProviderCache) return aiProviderCache.health;

  // Absence of evidence, reported as such: no alert is raised from "not
  // measured yet", and lastSuccessAt stays null so the dashboard shows it.
  return build('ai_provider', [], { provider: config.llmProvider, probed: false }, null);
}

// ---------------------------------------------------------------------------
// collection + persistence
// ---------------------------------------------------------------------------

async function persist(health: ComponentHealth): Promise<ComponentHealth> {
  try {
    const res = await query(
      `INSERT INTO ops_component_health
         (component, status, last_success_at, last_checked_at, current_failure, metrics, recovery_action)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5::jsonb, $6)
       ON CONFLICT (component) DO UPDATE SET
         status = EXCLUDED.status,
         -- The point of storing this: a live probe of a broken dependency
         -- cannot tell you when it last worked, the previous row can.
         last_success_at = COALESCE(EXCLUDED.last_success_at, ops_component_health.last_success_at),
         last_checked_at = CURRENT_TIMESTAMP,
         current_failure = EXCLUDED.current_failure,
         metrics = EXCLUDED.metrics,
         recovery_action = EXCLUDED.recovery_action
       RETURNING last_success_at, last_checked_at;`,
      [
        health.component,
        health.status,
        health.lastSuccessAt,
        health.currentFailure,
        JSON.stringify(health.metrics),
        health.recoveryAction,
      ]
    );
    return {
      ...health,
      lastSuccessAt: isoOrNull(res.rows[0]?.last_success_at),
      lastCheckedAt: isoOrNull(res.rows[0]?.last_checked_at) ?? health.lastCheckedAt,
    };
  } catch {
    // A database outage is exactly when persistence fails; the in-memory
    // reading still has to reach the dashboard.
    return health;
  }
}

export interface CollectOptions {
  /** Scheduler passes true; request paths pass false and use the cache. */
  refreshAiProvider?: boolean;
}

/**
 * Runs every probe (in parallel -- a slow dependency must not delay the
 * others), records each result, and returns the recorded view.
 */
export async function collectHealth(
  thresholds: OpsThresholds,
  options: CollectOptions = {}
): Promise<ComponentHealth[]> {
  const settled = await Promise.all([
    probeDatabase(),
    probeRedis(),
    probeStorage(thresholds),
    probeBackup(thresholds),
    probeIngestion(thresholds),
    probeWorker(thresholds),
    probeEmailImport(thresholds),
    getAiProviderHealth(options.refreshAiProvider === true),
  ]);

  const persisted: ComponentHealth[] = [];
  for (const health of settled) {
    persisted.push(await persist(health));
  }
  return persisted;
}

/** Last recorded reading per component, without probing anything. */
export async function readStoredHealth(): Promise<ComponentHealth[]> {
  const res = await query(`SELECT * FROM ops_component_health ORDER BY component;`);
  return res.rows.map((row: any) => ({
    component: row.component as OpsComponent,
    status: row.status as OpsStatus,
    lastSuccessAt: isoOrNull(row.last_success_at),
    currentFailure: row.current_failure,
    metrics: row.metrics ?? {},
    recoveryAction: row.recovery_action,
    issues: [],
    lastCheckedAt: isoOrNull(row.last_checked_at) ?? nowIso(),
  }));
}
