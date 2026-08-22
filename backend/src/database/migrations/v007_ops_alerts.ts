import type { Migration } from './index';

/**
 * Ticket #37 -- operations dashboard and alerting.
 *
 * The system already knows whether each of its dependencies is healthy;
 * it just never wrote that knowledge down anywhere an operator could see
 * it. Four additive tables close that gap:
 *
 * - `ops_component_health` -- the latest probe result per dependency, one
 *   row per component. Persisting it (instead of computing it per request)
 *   is what makes "last success" answerable while the component is
 *   currently down: a live probe of a dead Redis can only report the
 *   failure, not the last time it worked.
 * - `ops_incidents` -- one row per ongoing problem. The partial unique
 *   index makes "one open incident per component and kind" a database
 *   guarantee rather than an application convention, which is what lets
 *   the alerting path dedupe with a plain upsert and never send a second
 *   email for a problem that is already known.
 * - `ops_alert_deliveries` -- one row per delivery attempt, written after
 *   the incident itself already exists. An SMTP outage therefore degrades
 *   into "the incident is visible locally and marked undelivered" instead
 *   of losing the alert altogether.
 * - `ops_alert_settings` -- the thresholds an operator tunes (queue age,
 *   free storage, backup verification age) plus the delivery channel.
 *   Thresholds live here rather than in code so tuning them does not need
 *   a redeploy, and the singleton shape keeps "which row is current" from
 *   ever being a question.
 *
 * The CHECK constraints are deliberately wordy: an incident that is
 * resolved without a resolution time, a delivery that succeeded without a
 * recipient, a failed delivery with no error, an enabled email channel
 * with nowhere to send to, and a component that is failing without saying
 * why are all states the dashboard would have to render as nonsense, so
 * none of them are representable.
 *
 * No table here holds a document id, title, filename, sender or space
 * name: operational health is expressed in counts and ages only, so an
 * admin dashboard (and any alert email derived from it) cannot become a
 * side channel around tag ACLs or the private-space rule.
 */
export const opsAlerts: Migration = {
  version: 7,
  name: 'ops_alerts',
  sql: `
    CREATE TABLE IF NOT EXISTS ops_component_health (
      component VARCHAR(30) PRIMARY KEY
        CHECK (component IN ('database', 'redis', 'storage', 'backup', 'ingestion', 'worker', 'email_import', 'ai_provider')),
      status VARCHAR(20) NOT NULL CHECK (status IN ('ok', 'degraded', 'failed')),
      -- Last time this component was observed fully healthy. Survives the
      -- outage it is meant to describe, which a live probe cannot.
      last_success_at TIMESTAMP WITH TIME ZONE,
      last_checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      current_failure TEXT,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- Short German operator instruction, e.g. "Worker-Container neu starten".
      recovery_action TEXT NOT NULL,
      CONSTRAINT ops_component_health_failure_reason CHECK (
        (status = 'ok' AND current_failure IS NULL)
        OR (status <> 'ok' AND current_failure IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS ops_incidents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      component VARCHAR(30) NOT NULL
        CHECK (component IN ('database', 'redis', 'storage', 'backup', 'ingestion', 'worker', 'email_import', 'ai_provider')),
      -- What kind of problem it is ('queue_stalled', 'capacity_low', ...),
      -- not merely which component: one component can be short on disk and
      -- missing files at the same time, and those are separate incidents.
      kind VARCHAR(40) NOT NULL,
      severity VARCHAR(20) NOT NULL CHECK (severity IN ('warning', 'critical')),
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      summary TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurrences INT NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
      first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP WITH TIME ZONE,
      recovery_notified_at TIMESTAMP WITH TIME ZONE,
      CONSTRAINT ops_incident_resolution_time CHECK (
        (status = 'open' AND resolved_at IS NULL)
        OR (status = 'resolved' AND resolved_at IS NOT NULL)
      ),
      -- A recovery notice is a statement that the problem ended, so it
      -- cannot exist while the incident is still open.
      CONSTRAINT ops_incident_recovery_after_resolution CHECK (
        recovery_notified_at IS NULL OR status = 'resolved'
      )
    );

    -- The deduplication guarantee: a component+kind that is already known
    -- to be broken cannot get a second open incident, so repeated
    -- evaluations bump the existing one instead of alerting again.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_incidents_one_open
      ON ops_incidents (component, kind) WHERE status = 'open';

    CREATE INDEX IF NOT EXISTS idx_ops_incidents_recent
      ON ops_incidents (last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS ops_alert_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      incident_id UUID NOT NULL REFERENCES ops_incidents(id) ON DELETE CASCADE,
      channel VARCHAR(20) NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
      phase VARCHAR(20) NOT NULL CHECK (phase IN ('alert', 'recovery')),
      status VARCHAR(20) NOT NULL CHECK (status IN ('delivered', 'failed', 'skipped')),
      recipient VARCHAR(320),
      error TEXT,
      attempted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT ops_delivery_recipient_required CHECK (status <> 'delivered' OR recipient IS NOT NULL),
      -- A delivery that did not happen has to say why, otherwise the
      -- dashboard's "nicht zugestellt" state carries no information.
      CONSTRAINT ops_delivery_reason_required CHECK (status = 'delivered' OR error IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_ops_alert_deliveries_incident
      ON ops_alert_deliveries (incident_id, attempted_at DESC);

    CREATE TABLE IF NOT EXISTS ops_alert_settings (
      -- Singleton: the primary key can only hold one value, so a second
      -- settings row is impossible rather than merely discouraged.
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
      email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      recipient VARCHAR(320),
      min_severity VARCHAR(20) NOT NULL DEFAULT 'critical'
        CHECK (min_severity IN ('warning', 'critical')),
      queue_age_warn_minutes INT NOT NULL DEFAULT 30 CHECK (queue_age_warn_minutes > 0),
      queue_age_fail_minutes INT NOT NULL DEFAULT 120 CHECK (queue_age_fail_minutes > 0),
      storage_free_warn_percent INT NOT NULL DEFAULT 15
        CHECK (storage_free_warn_percent BETWEEN 0 AND 100),
      storage_free_fail_percent INT NOT NULL DEFAULT 5
        CHECK (storage_free_fail_percent BETWEEN 0 AND 100),
      backup_verify_max_age_hours INT NOT NULL DEFAULT 48 CHECK (backup_verify_max_age_hours > 0),
      worker_stale_minutes INT NOT NULL DEFAULT 60 CHECK (worker_stale_minutes > 0),
      email_poll_stale_minutes INT NOT NULL DEFAULT 60 CHECK (email_poll_stale_minutes > 0),
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT ops_settings_thresholds_ordered CHECK (
        queue_age_fail_minutes >= queue_age_warn_minutes
        AND storage_free_fail_percent <= storage_free_warn_percent
      ),
      -- Enabling the channel without a recipient would look configured
      -- and silently deliver nowhere.
      CONSTRAINT ops_settings_recipient_required CHECK (
        email_enabled = FALSE OR recipient IS NOT NULL
      )
    );

    INSERT INTO ops_alert_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
  `,
};
