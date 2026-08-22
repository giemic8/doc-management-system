/**
 * Ticket #37 -- incidents, deduplication, recovery notices and delivery.
 *
 * The shape of the problem: a dependency that stays broken is observed
 * again on every evaluation cycle. Naively alerting per observation turns
 * one broken disk into a mailbox full of identical mail, which trains the
 * operator to ignore all of it. So an observation is not an alert here --
 * it is an *incident*, keyed by (component, kind):
 *
 *   first observation  -> incident row inserted, one email attempted
 *   further observations -> same row, occurrences++ and last_seen_at moved,
 *                           no second email
 *   component recovers  -> incident resolved, exactly one recovery notice
 *
 * The "one open incident per component and kind" rule is enforced by a
 * partial unique index (v007), not by application logic, so the upsert can
 * be a single statement and two concurrent evaluations cannot both decide
 * they are the first.
 *
 * Delivery order is deliberate: the incident is written to the database
 * *before* any SMTP attempt, and each attempt records its own outcome. A
 * missing, misconfigured or broken mail server therefore downgrades an
 * alert to "visible in the dashboard, marked as not delivered" instead of
 * losing it -- and can never throw into the scheduler that called it.
 *
 * Email bodies carry component, problem, severity, count and the German
 * recovery action. They never carry a document title, filename, sender or
 * space name: mail leaves the household server, and an alert must not be a
 * way around the tag ACL or the private-space rule.
 */
import nodemailer from 'nodemailer';
import { config } from '../config';
import { query } from '../database/db';
import type { ComponentHealth, OpsComponent, OpsSeverity, OpsThresholds } from './opsHealth.service';
import { DEFAULT_THRESHOLDS } from './opsHealth.service';

export type IncidentStatus = 'open' | 'resolved';
export type DeliveryPhase = 'alert' | 'recovery';
export type DeliveryStatus = 'delivered' | 'failed' | 'skipped';

export interface OpsDelivery {
  id: string;
  channel: string;
  phase: DeliveryPhase;
  status: DeliveryStatus;
  recipient: string | null;
  error: string | null;
  attemptedAt: string;
}

export interface OpsIncident {
  id: string;
  component: OpsComponent;
  kind: string;
  severity: OpsSeverity;
  status: IncidentStatus;
  summary: string;
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  recoveryNotifiedAt: string | null;
  deliveries: OpsDelivery[];
}

export interface OpsAlertSettings extends OpsThresholds {
  emailEnabled: boolean;
  recipient: string | null;
  minSeverity: OpsSeverity;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Derived from environment, never stored: whether an SMTP host exists at all. */
  smtpConfigured: boolean;
}

/** Thrown for operator input the database constraints would reject anyway. */
export class OpsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsValidationError';
  }
}

function iso(value: any): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function mapSettings(row: any): OpsAlertSettings {
  return {
    emailEnabled: row.email_enabled,
    recipient: row.recipient,
    minSeverity: row.min_severity,
    queueAgeWarnMinutes: row.queue_age_warn_minutes,
    queueAgeFailMinutes: row.queue_age_fail_minutes,
    storageFreeWarnPercent: row.storage_free_warn_percent,
    storageFreeFailPercent: row.storage_free_fail_percent,
    backupVerifyMaxAgeHours: row.backup_verify_max_age_hours,
    workerStaleMinutes: row.worker_stale_minutes,
    emailPollStaleMinutes: row.email_poll_stale_minutes,
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
    smtpConfigured: Boolean(config.smtpHost),
  };
}

/**
 * Thresholds are operator settings, not constants: a household NAS with a
 * slow scanner and a rack server have different ideas of "the queue is too
 * old", and neither should need a redeploy to say so.
 */
export async function getAlertSettings(): Promise<OpsAlertSettings> {
  const res = await query(`SELECT * FROM ops_alert_settings WHERE id = TRUE;`);
  if (res.rows.length > 0) return mapSettings(res.rows[0]);

  const created = await query(`INSERT INTO ops_alert_settings (id) VALUES (TRUE) RETURNING *;`);
  return mapSettings(created.rows[0]);
}

export interface AlertSettingsPatch {
  emailEnabled?: boolean;
  recipient?: string | null;
  minSeverity?: OpsSeverity;
  queueAgeWarnMinutes?: number;
  queueAgeFailMinutes?: number;
  storageFreeWarnPercent?: number;
  storageFreeFailPercent?: number;
  backupVerifyMaxAgeHours?: number;
  workerStaleMinutes?: number;
  emailPollStaleMinutes?: number;
}

const POSITIVE_FIELDS: Array<keyof AlertSettingsPatch> = [
  'queueAgeWarnMinutes',
  'queueAgeFailMinutes',
  'backupVerifyMaxAgeHours',
  'workerStaleMinutes',
  'emailPollStaleMinutes',
];
const PERCENT_FIELDS: Array<keyof AlertSettingsPatch> = ['storageFreeWarnPercent', 'storageFreeFailPercent'];

export async function updateAlertSettings(
  patch: AlertSettingsPatch,
  actor: { id: string; ip?: string }
): Promise<OpsAlertSettings> {
  for (const field of POSITIVE_FIELDS) {
    const value = patch[field];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
      throw new OpsValidationError(`${field} must be a positive integer`);
    }
  }
  for (const field of PERCENT_FIELDS) {
    const value = patch[field];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100)) {
      throw new OpsValidationError(`${field} must be an integer between 0 and 100`);
    }
  }
  if (patch.minSeverity !== undefined && !['warning', 'critical'].includes(patch.minSeverity)) {
    throw new OpsValidationError('minSeverity must be "warning" or "critical"');
  }
  if (patch.recipient !== undefined && patch.recipient !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.recipient)) {
    throw new OpsValidationError('recipient must be a valid email address');
  }

  const current = await getAlertSettings();
  const next = { ...current, ...patch };

  if (next.queueAgeFailMinutes < next.queueAgeWarnMinutes) {
    throw new OpsValidationError('queueAgeFailMinutes must be greater than or equal to queueAgeWarnMinutes');
  }
  if (next.storageFreeFailPercent > next.storageFreeWarnPercent) {
    throw new OpsValidationError('storageFreeFailPercent must be less than or equal to storageFreeWarnPercent');
  }
  // Refused rather than silently accepted: an enabled channel with no
  // recipient looks configured on the dashboard and delivers nowhere.
  if (next.emailEnabled && !next.recipient) {
    throw new OpsValidationError('recipient is required when the email channel is enabled');
  }

  const res = await query(
    `UPDATE ops_alert_settings SET
       email_enabled = $1,
       recipient = $2,
       min_severity = $3,
       queue_age_warn_minutes = $4,
       queue_age_fail_minutes = $5,
       storage_free_warn_percent = $6,
       storage_free_fail_percent = $7,
       backup_verify_max_age_hours = $8,
       worker_stale_minutes = $9,
       email_poll_stale_minutes = $10,
       updated_by = $11,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = TRUE
     RETURNING *;`,
    [
      next.emailEnabled,
      next.recipient,
      next.minSeverity,
      next.queueAgeWarnMinutes,
      next.queueAgeFailMinutes,
      next.storageFreeWarnPercent,
      next.storageFreeFailPercent,
      next.backupVerifyMaxAgeHours,
      next.workerStaleMinutes,
      next.emailPollStaleMinutes,
      actor.id,
    ]
  );

  // Invariant 4: changing who gets told about failures, and when, is a
  // security-relevant configuration change.
  await query(
    `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, 'ops_alert_settings_updated', $2, $3);`,
    [actor.id, JSON.stringify({ changed: Object.keys(patch) }), actor.ip ?? null]
  );

  return mapSettings(res.rows[0]);
}

/** The thresholds half of the settings, for the health probes. */
export function thresholdsFrom(settings: OpsAlertSettings): OpsThresholds {
  return {
    queueAgeWarnMinutes: settings.queueAgeWarnMinutes ?? DEFAULT_THRESHOLDS.queueAgeWarnMinutes,
    queueAgeFailMinutes: settings.queueAgeFailMinutes ?? DEFAULT_THRESHOLDS.queueAgeFailMinutes,
    storageFreeWarnPercent: settings.storageFreeWarnPercent ?? DEFAULT_THRESHOLDS.storageFreeWarnPercent,
    storageFreeFailPercent: settings.storageFreeFailPercent ?? DEFAULT_THRESHOLDS.storageFreeFailPercent,
    backupVerifyMaxAgeHours: settings.backupVerifyMaxAgeHours ?? DEFAULT_THRESHOLDS.backupVerifyMaxAgeHours,
    workerStaleMinutes: settings.workerStaleMinutes ?? DEFAULT_THRESHOLDS.workerStaleMinutes,
    emailPollStaleMinutes: settings.emailPollStaleMinutes ?? DEFAULT_THRESHOLDS.emailPollStaleMinutes,
  };
}

// ---------------------------------------------------------------------------
// incidents
// ---------------------------------------------------------------------------

function mapIncident(row: any, deliveries: OpsDelivery[] = []): OpsIncident {
  return {
    id: row.id,
    component: row.component,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    detail: row.detail ?? {},
    occurrences: row.occurrences,
    firstSeenAt: iso(row.first_seen_at)!,
    lastSeenAt: iso(row.last_seen_at)!,
    resolvedAt: iso(row.resolved_at),
    recoveryNotifiedAt: iso(row.recovery_notified_at),
    deliveries,
  };
}

function mapDelivery(row: any): OpsDelivery {
  return {
    id: row.id,
    channel: row.channel,
    phase: row.phase,
    status: row.status,
    recipient: row.recipient,
    error: row.error,
    attemptedAt: iso(row.attempted_at)!,
  };
}

export interface IncidentInput {
  component: OpsComponent;
  kind: string;
  severity: OpsSeverity;
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * The deduplication primitive. One statement, so the answer to "was this
 * incident already known" comes from the database rather than from a
 * read-then-write race. `xmax = 0` is true only for the row this statement
 * inserted; a conflicting row that got updated carries this transaction's
 * id instead.
 */
export async function openOrBumpIncident(
  input: IncidentInput
): Promise<{ incident: OpsIncident; created: boolean }> {
  const res = await query(
    `INSERT INTO ops_incidents (component, kind, severity, summary, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (component, kind) WHERE status = 'open'
     DO UPDATE SET
       occurrences = ops_incidents.occurrences + 1,
       last_seen_at = CURRENT_TIMESTAMP,
       severity = EXCLUDED.severity,
       summary = EXCLUDED.summary,
       detail = EXCLUDED.detail
     RETURNING *, (xmax = 0) AS inserted;`,
    [input.component, input.kind, input.severity, input.summary, JSON.stringify(input.detail ?? {})]
  );
  const row = res.rows[0];
  return { incident: mapIncident(row), created: row.inserted === true };
}

/** Closes an open incident. Returns null when there was nothing open. */
export async function resolveIncident(component: OpsComponent, kind: string): Promise<OpsIncident | null> {
  const res = await query(
    `UPDATE ops_incidents
     SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
     WHERE component = $1 AND kind = $2 AND status = 'open'
     RETURNING *;`,
    [component, kind]
  );
  return res.rows.length > 0 ? mapIncident(res.rows[0]) : null;
}

export async function listIncidents(options: { status?: IncidentStatus; limit?: number } = {}): Promise<OpsIncident[]> {
  const params: any[] = [];
  let where = '';
  if (options.status) {
    params.push(options.status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(options.limit ?? 50);

  const res = await query(
    `SELECT * FROM ops_incidents ${where} ORDER BY status = 'open' DESC, last_seen_at DESC LIMIT $${params.length};`,
    params
  );
  if (res.rows.length === 0) return [];

  const ids = res.rows.map((row: any) => row.id);
  const deliveries = await query(
    `SELECT * FROM ops_alert_deliveries WHERE incident_id = ANY($1::uuid[]) ORDER BY attempted_at ASC;`,
    [ids]
  );
  const byIncident = new Map<string, OpsDelivery[]>();
  for (const row of deliveries.rows) {
    const list = byIncident.get(row.incident_id) ?? [];
    list.push(mapDelivery(row));
    byIncident.set(row.incident_id, list);
  }

  return res.rows.map((row: any) => mapIncident(row, byIncident.get(row.id) ?? []));
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

async function recordDelivery(
  incidentId: string,
  phase: DeliveryPhase,
  status: DeliveryStatus,
  recipient: string | null,
  error: string | null
): Promise<OpsDelivery> {
  const res = await query(
    `INSERT INTO ops_alert_deliveries (incident_id, channel, phase, status, recipient, error)
     VALUES ($1, 'email', $2, $3, $4, $5)
     RETURNING *;`,
    [incidentId, phase, status, recipient, error]
  );
  return mapDelivery(res.rows[0]);
}

const COMPONENT_LABELS: Record<OpsComponent, string> = {
  database: 'Datenbank',
  redis: 'Redis',
  storage: 'Speicher',
  backup: 'Backup',
  ingestion: 'Dokumenteneingang',
  worker: 'Worker',
  email_import: 'E-Mail-Import',
  ai_provider: 'KI-Anbieter',
};

/**
 * Concise on purpose: subject line names the component, body names the
 * problem, the count and the action. No document identifiers of any kind.
 */
export function buildAlertMessage(incident: OpsIncident, phase: DeliveryPhase): { subject: string; text: string } {
  const label = COMPONENT_LABELS[incident.component] ?? incident.component;
  const action = typeof incident.detail?.recoveryAction === 'string' ? incident.detail.recoveryAction : '—';

  if (phase === 'recovery') {
    return {
      subject: `[DocVault] Entwarnung: ${label}`,
      text: [
        `Komponente: ${label}`,
        `Status: wieder in Ordnung`,
        `Problem war: ${incident.summary}`,
        `Beginn: ${incident.firstSeenAt}`,
        `Ende: ${incident.resolvedAt ?? '—'}`,
        `Vorkommen: ${incident.occurrences}`,
        '',
        'Diese Nachricht enthält bewusst keine Dokumentdaten.',
      ].join('\n'),
    };
  }

  return {
    subject: `[DocVault] ${incident.severity === 'critical' ? 'Kritisch' : 'Warnung'}: ${label}`,
    text: [
      `Komponente: ${label}`,
      `Problem: ${incident.summary}`,
      `Schweregrad: ${incident.severity === 'critical' ? 'kritisch' : 'Warnung'}`,
      `Seit: ${incident.firstSeenAt}`,
      `Vorkommen: ${incident.occurrences}`,
      `Empfohlene Maßnahme: ${action}`,
      '',
      'Diese Nachricht enthält bewusst keine Dokumentdaten.',
    ].join('\n'),
  };
}

function severityRank(severity: OpsSeverity): number {
  return severity === 'critical' ? 2 : 1;
}

/**
 * Attempts one notification and records the outcome. Every path writes an
 * `ops_alert_deliveries` row, and no path throws: an alert that cannot be
 * delivered still has to be visible, and the scheduler must survive a dead
 * mail server.
 */
export async function notifyIncident(
  incident: OpsIncident,
  phase: DeliveryPhase,
  settings: OpsAlertSettings
): Promise<OpsDelivery> {
  try {
    if (!settings.emailEnabled || !settings.recipient) {
      return await recordDelivery(incident.id, phase, 'skipped', settings.recipient, 'E-Mail-Kanal ist deaktiviert');
    }
    if (!config.smtpHost) {
      return await recordDelivery(
        incident.id,
        phase,
        'skipped',
        settings.recipient,
        'Kein SMTP-Server konfiguriert (SMTP_HOST fehlt)'
      );
    }
    if (phase === 'alert' && severityRank(incident.severity) < severityRank(settings.minSeverity)) {
      return await recordDelivery(
        incident.id,
        phase,
        'skipped',
        settings.recipient,
        `Schweregrad "${incident.severity}" liegt unter der Meldeschwelle "${settings.minSeverity}"`
      );
    }

    const { subject, text } = buildAlertMessage(incident, phase);
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPassword } } : {}),
    });

    await transport.sendMail({ from: config.smtpFrom, to: settings.recipient, subject, text });
    return await recordDelivery(incident.id, phase, 'delivered', settings.recipient, null);
  } catch (err: any) {
    try {
      return await recordDelivery(
        incident.id,
        phase,
        'failed',
        settings.recipient,
        err?.message ? String(err.message).slice(0, 500) : 'Unbekannter Zustellfehler'
      );
    } catch (recordErr: any) {
      // Losing the delivery record is bad but must not take the evaluation
      // cycle down with it; the incident itself is already persisted.
      console.error('Ops alert: could not record delivery outcome:', recordErr.message);
      return {
        id: 'unrecorded',
        channel: 'email',
        phase,
        status: 'failed',
        recipient: settings.recipient,
        error: err?.message ?? 'Unbekannter Zustellfehler',
        attemptedAt: new Date().toISOString(),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

export interface EvaluationSummary {
  opened: OpsIncident[];
  bumped: OpsIncident[];
  resolved: OpsIncident[];
}

/**
 * Turns one round of health readings into incident state.
 *
 * Each issue a probe reported either opens a new incident (first time seen,
 * one alert attempt) or bumps the existing one (no alert). Any incident
 * still open for a component whose probe no longer reports that kind is
 * resolved, with exactly one recovery notice -- guarded by
 * `recovery_notified_at` so a later re-evaluation cannot repeat it.
 */
export async function evaluateHealth(
  healthList: ComponentHealth[],
  settings: OpsAlertSettings
): Promise<EvaluationSummary> {
  const summary: EvaluationSummary = { opened: [], bumped: [], resolved: [] };

  for (const health of healthList) {
    for (const issue of health.issues) {
      const { incident, created } = await openOrBumpIncident({
        component: health.component,
        kind: issue.kind,
        severity: issue.severity,
        summary: issue.summary,
        detail: { recoveryAction: health.recoveryAction, componentStatus: health.status, metrics: health.metrics },
      });

      if (created) {
        // Incident first, delivery second: the local record exists before
        // anything is handed to SMTP.
        await notifyIncident(incident, 'alert', settings);
        summary.opened.push(incident);
      } else {
        summary.bumped.push(incident);
      }
    }

    const activeKinds = health.issues.map((issue) => issue.kind);
    const stale = await query(
      `SELECT * FROM ops_incidents
       WHERE component = $1 AND status = 'open' AND NOT (kind = ANY($2::text[]));`,
      [health.component, activeKinds]
    );

    for (const row of stale.rows) {
      const resolved = await resolveIncident(health.component, row.kind);
      if (!resolved) continue;
      if (!resolved.recoveryNotifiedAt) {
        await notifyIncident(resolved, 'recovery', settings);
        // Stamped after the attempt regardless of its outcome: a recovery
        // notice is a one-off, and a failed send is already recorded as a
        // delivery row rather than retried forever.
        await query(`UPDATE ops_incidents SET recovery_notified_at = CURRENT_TIMESTAMP WHERE id = $1;`, [
          resolved.id,
        ]);
      }
      summary.resolved.push(resolved);
    }
  }

  return summary;
}
