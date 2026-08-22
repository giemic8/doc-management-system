import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * Ticket #37 -- operations dashboard and alerts.
 *
 * The five acceptance criteria, one describe block each:
 *   1. the dashboard shows last success, current failure, queue age,
 *      capacity and a recovery action;
 *   2. alerts deduplicate repeated incidents and report recovery;
 *   3. the static storage display is replaced with measured values;
 *   4. health checks cover dependency degradation, not process uptime;
 *   5. alert delivery failure stays visible locally.
 *
 * Everything runs against the real test database. The only mocked seam is
 * outbound SMTP -- delivery is the one side effect that must not leave the
 * machine during a test run.
 */
const mocks = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: (...args: any[]) => mocks.sendMail(...args),
    }),
  },
}));

import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor, loginAs } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';
import { config } from '../../src/config';
import { setAiProviderHealthCache } from '../../src/services/opsHealth.service';
import { runOpsEvaluation } from '../../src/services/opsAlertScheduler.service';
import { getAlertSettings, listIncidents, updateAlertSettings } from '../../src/services/opsAlerts.service';

const originalSmtpHost = config.smtpHost;

describe('Operations dashboard and alerts (Ticket #37)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    mocks.sendMail.mockReset();
    mocks.sendMail.mockResolvedValue({ messageId: 'test' });
    config.smtpHost = '';
    // The AI probe is the one probe that talks to the network. Priming its
    // cache keeps the suite hermetic without turning the probe itself off.
    setAiProviderHealthCache({
      component: 'ai_provider',
      status: 'ok',
      lastSuccessAt: new Date().toISOString(),
      currentFailure: null,
      metrics: { provider: 'ollama', configured: true, latencyMs: 5 },
      recoveryAction: 'Keine Maßnahme erforderlich',
      issues: [],
      lastCheckedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    config.smtpHost = originalSmtpHost;
    setAiProviderHealthCache(null);
    await closeDatabase();
  });

  async function adminToken() {
    const admin = await loginAsAdmin(app);
    return admin.token;
  }

  async function adminId(): Promise<string> {
    const res = await query(`SELECT id FROM users WHERE email = 'admin@dms.local';`);
    return res.rows[0].id;
  }

  /** A document that has been sitting in the queue for `minutes`. */
  async function stuckDocument(minutes: number, title = 'Warteschlange.pdf', status = 'processing') {
    const doc = await createTestDocument({ title, status });
    await query(
      `UPDATE documents SET last_transition_at = now() - ($2 || ' minutes')::interval WHERE id = $1;`,
      [doc.id, String(minutes)]
    );
    return doc;
  }

  /** Turns on the email channel with a mocked-out SMTP host. */
  async function enableEmailChannel(minSeverity: 'warning' | 'critical' = 'warning') {
    config.smtpHost = 'smtp.test.local';
    return updateAlertSettings(
      { emailEnabled: true, recipient: 'ops@dms.local', minSeverity },
      { id: await adminId() }
    );
  }

  function subjectsSent(): string[] {
    return mocks.sendMail.mock.calls.map((call) => String(call[0]?.subject ?? ''));
  }

  // ------------------------------------------------------------------
  // 1. Dashboard shows last success, current failure, queue age,
  //    capacity and recovery action.
  // ------------------------------------------------------------------
  describe('the dashboard reports state, queue age, capacity and a recovery action', () => {
    it('returns every component with all five operator-facing fields', async () => {
      const token = await adminToken();

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const names = res.body.components.map((component: any) => component.component).sort();
      expect(names).toEqual(
        ['ai_provider', 'backup', 'database', 'email_import', 'ingestion', 'redis', 'storage', 'worker'].sort()
      );

      for (const component of res.body.components) {
        expect(['ok', 'degraded', 'failed']).toContain(component.status);
        expect(component).toHaveProperty('lastSuccessAt');
        expect(component).toHaveProperty('currentFailure');
        expect(component).toHaveProperty('metrics');
        expect(typeof component.recoveryAction).toBe('string');
        expect(component.recoveryAction.length).toBeGreaterThan(0);
        // A failing component must always say what is wrong, never just
        // that it is failing.
        if (component.status !== 'ok') expect(component.currentFailure).toBeTruthy();
      }

      const ingestion = res.body.components.find((c: any) => c.component === 'ingestion');
      expect(typeof ingestion.metrics.queueAgeMinutes).toBe('number');
      const storage = res.body.components.find((c: any) => c.component === 'storage');
      expect(storage.metrics.originalsTotalBytes).toBeGreaterThan(0);
    });

    it('reports the age of the oldest queued document and the matching recovery action', async () => {
      const token = await adminToken();
      await stuckDocument(180);

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const ingestion = res.body.components.find((c: any) => c.component === 'ingestion');

      expect(ingestion.metrics.queueAgeMinutes).toBeGreaterThanOrEqual(179);
      expect(ingestion.metrics.processing).toBe(1);
      expect(ingestion.status).toBe('failed');
      expect(ingestion.currentFailure).toContain('180');
      expect(ingestion.recoveryAction).toBe('Worker-Container neu starten');
    });

    it('keeps the last success time after the component starts failing', async () => {
      const token = await adminToken();

      // A healthy round first: ingestion records a real "last success".
      const doc = await createTestDocument({ title: 'Erfolgreich.pdf', status: 'durable' });
      await query(
        `INSERT INTO document_state_transitions (document_id, from_state, to_state) VALUES ($1, 'received', 'durable');`,
        [doc.id]
      );
      await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);

      // Now break it and confirm the earlier success survives the failure.
      await query(`UPDATE documents SET status = 'processing', last_transition_at = now() - interval '5 hours';`);
      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const ingestion = res.body.components.find((c: any) => c.component === 'ingestion');

      expect(ingestion.status).toBe('failed');
      expect(ingestion.lastSuccessAt).toBeTruthy();
    });

    it('never names a document, sender or filename in the dashboard payload', async () => {
      const token = await adminToken();
      await createTestDocument({ title: 'Geheim-Therapiebericht-2026.pdf', status: 'failed' });
      await query(`UPDATE documents SET sender = 'Dr-Vertraulich-Praxis', failure_reason = 'OCR broke';`);
      await stuckDocument(200, 'Streng-Vertraulich-Steuerbescheid.pdf');

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const payload = JSON.stringify(res.body);

      expect(payload).not.toContain('Geheim-Therapiebericht');
      expect(payload).not.toContain('Dr-Vertraulich-Praxis');
      expect(payload).not.toContain('Streng-Vertraulich-Steuerbescheid');
      // The counts an operator actually needs are still there.
      const ingestion = res.body.components.find((c: any) => c.component === 'ingestion');
      expect(ingestion.metrics.failed).toBe(1);
      expect(ingestion.currentFailure).toContain('failed');
    });

    it('is admin-only', async () => {
      const editor = await createEditor(app);
      const login = await loginAs(app, editor.email, editor.password);

      const anonymous = await request(app).get('/api/ops/dashboard');
      expect(anonymous.status).toBe(401);

      const asEditor = await request(app)
        .get('/api/ops/dashboard')
        .set('Authorization', `Bearer ${login.body.token}`);
      expect(asEditor.status).toBe(403);

      const settings = await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ queueAgeWarnMinutes: 5 });
      expect(settings.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------
  // 2. Alerts deduplicate repeated incidents and report recovery.
  // ------------------------------------------------------------------
  describe('alerts deduplicate repeated incidents and report recovery', () => {
    it('opens one incident and sends one email, then only counts further occurrences', async () => {
      await enableEmailChannel();
      await stuckDocument(240);

      await runOpsEvaluation();
      const afterFirst = (await listIncidents({ status: 'open' })).filter(
        (incident) => incident.kind === 'queue_stalled'
      );
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].occurrences).toBe(1);
      const firstMailCount = subjectsSent().filter((subject) => subject.includes('Dokumenteneingang')).length;
      expect(firstMailCount).toBe(1);

      // Same broken state observed twice more.
      await runOpsEvaluation();
      await runOpsEvaluation();

      const afterThird = (await listIncidents({ status: 'open' })).filter(
        (incident) => incident.kind === 'queue_stalled'
      );
      expect(afterThird).toHaveLength(1);
      expect(afterThird[0].id).toBe(afterFirst[0].id);
      expect(afterThird[0].occurrences).toBe(3);
      expect(new Date(afterThird[0].lastSeenAt).getTime()).toBeGreaterThanOrEqual(
        new Date(afterFirst[0].lastSeenAt).getTime()
      );

      // The dedupe criterion: no second email for a problem already known.
      expect(subjectsSent().filter((subject) => subject.includes('Dokumenteneingang'))).toHaveLength(1);
      const alerts = afterThird[0].deliveries.filter((delivery) => delivery.phase === 'alert');
      expect(alerts).toHaveLength(1);
    });

    it('resolves the incident and sends exactly one recovery notice', async () => {
      await enableEmailChannel();
      const doc = await stuckDocument(240);

      await runOpsEvaluation();
      await runOpsEvaluation();
      expect(subjectsSent().filter((subject) => subject.includes('Entwarnung'))).toHaveLength(0);

      // Queue drains.
      await query(`DELETE FROM documents WHERE id = $1;`, [doc.id]);
      await runOpsEvaluation();

      const resolved = (await listIncidents({ status: 'resolved' })).filter(
        (incident) => incident.kind === 'queue_stalled'
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0].resolvedAt).toBeTruthy();
      expect(resolved[0].recoveryNotifiedAt).toBeTruthy();

      const recoveryMails = subjectsSent().filter((subject) => subject.includes('Entwarnung: Dokumenteneingang'));
      expect(recoveryMails).toHaveLength(1);

      // Later cycles must not repeat the recovery notice.
      await runOpsEvaluation();
      await runOpsEvaluation();
      expect(subjectsSent().filter((subject) => subject.includes('Entwarnung: Dokumenteneingang'))).toHaveLength(1);
      expect((await listIncidents({ status: 'open' })).filter((i) => i.kind === 'queue_stalled')).toHaveLength(0);
    });

    it('reopens a fresh incident when the same problem comes back after recovery', async () => {
      await enableEmailChannel();
      const first = await stuckDocument(240);

      await runOpsEvaluation();
      const opened = (await listIncidents({ status: 'open' })).find((i) => i.kind === 'queue_stalled')!;

      await query(`DELETE FROM documents WHERE id = $1;`, [first.id]);
      await runOpsEvaluation();

      await stuckDocument(240, 'Wieder-haengen-geblieben.pdf');
      await runOpsEvaluation();

      const reopened = (await listIncidents({ status: 'open' })).find((i) => i.kind === 'queue_stalled')!;
      expect(reopened).toBeTruthy();
      expect(reopened.id).not.toBe(opened.id);
      expect(reopened.occurrences).toBe(1);
      expect(subjectsSent().filter((subject) => subject.includes('Kritisch: Dokumenteneingang'))).toHaveLength(2);
    });

    it('keeps one open incident per component and kind at the database level', async () => {
      await stuckDocument(240);
      await runOpsEvaluation();
      await runOpsEvaluation();

      const rows = await query(
        `SELECT component, kind, COUNT(*)::int AS open_count
         FROM ops_incidents WHERE status = 'open'
         GROUP BY component, kind HAVING COUNT(*) > 1;`
      );
      expect(rows.rows).toHaveLength(0);

      // And the index refuses a duplicate even if application logic slipped.
      const existing = await query(`SELECT * FROM ops_incidents WHERE status = 'open' LIMIT 1;`);
      await expect(
        query(
          `INSERT INTO ops_incidents (component, kind, severity, summary) VALUES ($1, $2, 'critical', 'duplicate');`,
          [existing.rows[0].component, existing.rows[0].kind]
        )
      ).rejects.toThrow();
    });

    it('never sends document identifiers in an alert email body', async () => {
      await enableEmailChannel();
      await stuckDocument(240, 'Privater-Arztbrief-Muster.pdf');

      await runOpsEvaluation();

      const bodies = mocks.sendMail.mock.calls.map((call) => JSON.stringify(call[0]));
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).not.toContain('Privater-Arztbrief-Muster');
        expect(body).toContain('Diese Nachricht enthält bewusst keine Dokumentdaten.');
      }
    });
  });

  // ------------------------------------------------------------------
  // 3. Static storage display is replaced with measured values.
  // ------------------------------------------------------------------
  describe('storage figures are measured, not hardcoded', () => {
    it('reports real free/total bytes for the originals and replica volumes', async () => {
      const token = await adminToken();

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const storage = res.body.components.find((c: any) => c.component === 'storage');

      const actual = fs.statfsSync(config.storagePath);
      const actualTotal = actual.blocks * actual.bsize;

      expect(storage.metrics.originalsTotalBytes).toBe(actualTotal);
      expect(storage.metrics.originalsFreeBytes).toBeGreaterThan(0);
      expect(storage.metrics.originalsFreeBytes).toBeLessThanOrEqual(storage.metrics.originalsTotalBytes);
      expect(storage.metrics.originalsUsedBytes).toBe(
        storage.metrics.originalsTotalBytes - storage.metrics.originalsFreeBytes
      );
      expect(storage.metrics.originalsFreePercent).toBeGreaterThan(0);
      expect(storage.metrics.originalsFreePercent).toBeLessThanOrEqual(100);
      expect(storage.metrics.replicaTotalBytes).toBeGreaterThan(0);
      expect(storage.metrics.replicaPath).toBe(config.storageReplicaPath);
    });

    it('serves the same measured capacity to the app shell through /api/ops/capacity', async () => {
      const token = await adminToken();
      await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/ops/capacity').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.measuredAt).toBeTruthy();
      expect(res.body.metrics.originalsTotalBytes).toBeGreaterThan(0);
      expect(res.body.metrics.originalsUsedBytes).toBeGreaterThanOrEqual(0);
      expect(res.body.metrics.originalsFreePercent).toBeGreaterThan(0);
    });

    it('counts the bytes actually held by live documents', async () => {
      const token = await adminToken();
      const doc = await createTestDocument({ title: 'Groesse.pdf' });

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const storage = res.body.components.find((c: any) => c.component === 'storage');

      expect(storage.metrics.documentBytes).toBe(Number(doc.file_size));
      expect(storage.metrics.sampledDocuments).toBe(1);
    });

    it('measures capacity against the threshold the operator configured', async () => {
      const token = await adminToken();

      // Any real volume has more than 0 % free, so a 100 % floor is the
      // only way to prove the threshold is read from settings, not code.
      await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ storageFreeWarnPercent: 100, storageFreeFailPercent: 100 });

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const storage = res.body.components.find((c: any) => c.component === 'storage');

      expect(storage.status).toBe('failed');
      expect(storage.currentFailure).toContain('freier Speicher');
      expect(storage.recoveryAction).toBe('Speicherplatz freigeben oder Volume vergrößern');
    });
  });

  // ------------------------------------------------------------------
  // 4. Health checks cover dependency degradation, not process uptime.
  // ------------------------------------------------------------------
  describe('health checks measure dependencies, not process uptime', () => {
    it('keeps /api/health "ok" while a dependency is degraded, which is why this dashboard exists', async () => {
      const token = await adminToken();
      await stuckDocument(600);

      const legacy = await request(app).get('/api/health');
      expect(legacy.body.status).toBe('ok');

      const ops = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      expect(ops.body.overallStatus).toBe('failed');
    });

    it('measures a real database round trip and connection pool', async () => {
      const token = await adminToken();

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const database = res.body.components.find((c: any) => c.component === 'database');

      expect(database.status).toBe('ok');
      expect(typeof database.metrics.latencyMs).toBe('number');
      expect(database.metrics.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof database.metrics.poolTotal).toBe('number');
      expect(database.lastSuccessAt).toBeTruthy();
    });

    it('measures a real Redis round trip', async () => {
      const token = await adminToken();

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const redis = res.body.components.find((c: any) => c.component === 'redis');

      expect(redis.status).toBe('ok');
      expect(typeof redis.metrics.latencyMs).toBe('number');
      expect(redis.metrics.port).toBe(config.redisPort);
    });

    it('detects an original file that is missing from disk, by count only', async () => {
      const token = await adminToken();
      const missingPath = path.join(os.tmpdir(), `gone-${crypto.randomUUID()}.pdf`);
      await query(
        `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status)
         VALUES ('Verschwunden.pdf', 'Verschwunden.pdf', $1, 10, 'application/pdf', $2, 'ready');`,
        [missingPath, crypto.randomBytes(32).toString('hex')]
      );

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const storage = res.body.components.find((c: any) => c.component === 'storage');

      expect(storage.status).toBe('failed');
      expect(storage.metrics.missingPrimaryFiles).toBe(1);
      expect(storage.currentFailure).toContain('1 von 1');
      expect(JSON.stringify(res.body)).not.toContain('Verschwunden.pdf');
      expect(storage.recoveryAction).toContain('Backup');
    });

    it('derives worker liveness from state transitions and stays quiet when there is no work', async () => {
      const token = await adminToken();

      const idle = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const idleWorker = idle.body.components.find((c: any) => c.component === 'worker');
      // No pending work: an idle worker and a dead worker are
      // indistinguishable from the database, so nothing is claimed.
      expect(idleWorker.status).toBe('ok');
      expect(idleWorker.metrics.pendingWork).toBe(0);
      expect(idleWorker.metrics.livenessBasis).toBe('document_state_transitions');

      await stuckDocument(120, 'Unbearbeitet.pdf', 'durable');
      const stalled = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const stalledWorker = stalled.body.components.find((c: any) => c.component === 'worker');

      expect(stalledWorker.status).toBe('failed');
      expect(stalledWorker.metrics.pendingWork).toBe(1);
      expect(stalledWorker.recoveryAction).toBe('Worker-Container neu starten');
    });

    it('treats an unconfigured mailbox as quiet and an overdue one as degraded', async () => {
      const token = await adminToken();

      const quiet = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const unconfigured = quiet.body.components.find((c: any) => c.component === 'email_import');
      expect(unconfigured.status).toBe('ok');
      expect(unconfigured.metrics.configured).toBe(false);

      await query(
        `INSERT INTO email_import_config (host, port, secure, username, password_encrypted, poll_interval_minutes, is_active, last_polled_at)
         VALUES ('imap.test', 993, true, 'inbox@test', 'encrypted', 5, true, now() - interval '5 hours');`
      );

      const overdue = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const emailImport = overdue.body.components.find((c: any) => c.component === 'email_import');
      expect(emailImport.status).toBe('degraded');
      expect(emailImport.metrics.minutesSinceLastPoll).toBeGreaterThanOrEqual(299);
      expect(emailImport.recoveryAction).toContain('IMAP');
    });

    it('reports the backup component from the real backup status file', async () => {
      const token = await adminToken();
      const statusPath = path.join(os.tmpdir(), `backup-status-${crypto.randomUUID()}.json`);
      const originalPath = config.backupStatusPath;

      try {
        fs.writeFileSync(
          statusPath,
          JSON.stringify({
            version: 2,
            backupId: 'test',
            timestamp: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            lastRestoreAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
            success: true,
            restore: { backupId: 'test', databaseVerified: true, sampledOriginalsChecked: 3, sampledOriginalsMatched: 3 },
          })
        );
        config.backupStatusPath = statusPath;

        const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
        const backup = res.body.components.find((c: any) => c.component === 'backup');

        // Backup itself succeeded, but the restore verification is 10 days
        // old against a 48 hour limit -- a backup nobody restored.
        expect(backup.status).toBe('degraded');
        expect(backup.metrics.lastRunSuccessful).toBe(true);
        expect(backup.currentFailure).toContain('Wiederherstellung');
        expect(backup.recoveryAction).toContain('Wiederherstellungstest');
        expect(backup.lastSuccessAt).toBeTruthy();
      } finally {
        config.backupStatusPath = originalPath;
        fs.rmSync(statusPath, { force: true });
      }
    });

    it('serves the AI provider from cache so a hanging LLM cannot hang the dashboard', async () => {
      const token = await adminToken();
      setAiProviderHealthCache({
        component: 'ai_provider',
        status: 'degraded',
        lastSuccessAt: null,
        currentFailure: 'LLM-Anbieter (ollama) nicht erreichbar: connect ECONNREFUSED',
        metrics: { provider: 'ollama', configured: true },
        recoveryAction: 'Ollama-/OpenAI-Erreichbarkeit prüfen (LLM_PROVIDER-Konfiguration)',
        issues: [{ kind: 'ai_unreachable', severity: 'warning', summary: 'LLM-Anbieter nicht erreichbar' }],
        lastCheckedAt: new Date().toISOString(),
      });

      const startedAt = Date.now();
      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const elapsed = Date.now() - startedAt;

      const ai = res.body.components.find((c: any) => c.component === 'ai_provider');
      expect(ai.status).toBe('degraded');
      expect(ai.currentFailure).toContain('nicht erreichbar');
      expect(elapsed).toBeLessThan(5000);
    });
  });

  // ------------------------------------------------------------------
  // 5. Alert delivery failure remains visible locally.
  // ------------------------------------------------------------------
  describe('alert delivery failure remains visible locally', () => {
    it('records the incident and a failed delivery when SMTP rejects the message', async () => {
      const token = await adminToken();
      await enableEmailChannel();
      mocks.sendMail.mockRejectedValue(new Error('SMTP connection refused'));
      await stuckDocument(240);

      // The scheduler's own cycle must survive a dead mail server.
      await expect(runOpsEvaluation()).resolves.toBeTruthy();

      const res = await request(app)
        .get('/api/ops/incidents?status=open')
        .set('Authorization', `Bearer ${token}`);
      const incident = res.body.incidents.find((i: any) => i.kind === 'queue_stalled');

      expect(incident).toBeTruthy();
      expect(incident.deliveries).toHaveLength(1);
      expect(incident.deliveries[0].status).toBe('failed');
      expect(incident.deliveries[0].error).toContain('SMTP connection refused');
      expect(incident.deliveries[0].phase).toBe('alert');
    });

    it('records a skipped delivery, with a reason, when no SMTP server is configured at all', async () => {
      const token = await adminToken();
      config.smtpHost = '';
      await updateAlertSettings({ emailEnabled: true, recipient: 'ops@dms.local' }, { id: await adminId() });
      await stuckDocument(240);

      await runOpsEvaluation();

      const res = await request(app)
        .get('/api/ops/incidents?status=open')
        .set('Authorization', `Bearer ${token}`);
      const incident = res.body.incidents.find((i: any) => i.kind === 'queue_stalled');

      expect(incident.deliveries[0].status).toBe('skipped');
      expect(incident.deliveries[0].error).toContain('SMTP');
      expect(mocks.sendMail).not.toHaveBeenCalled();
    });

    it('runs with the email channel switched off and still records the incident locally', async () => {
      const token = await adminToken();
      await stuckDocument(240);

      await runOpsEvaluation();

      const settings = await getAlertSettings();
      expect(settings.emailEnabled).toBe(false);

      const res = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      const incident = res.body.openIncidents.find((i: any) => i.kind === 'queue_stalled');
      expect(incident).toBeTruthy();
      expect(incident.deliveries[0].status).toBe('skipped');
      expect(incident.deliveries[0].error).toContain('deaktiviert');
      expect(mocks.sendMail).not.toHaveBeenCalled();
    });

    it('writes the incident before attempting delivery, so a crash mid-send cannot lose it', async () => {
      await enableEmailChannel();
      mocks.sendMail.mockImplementation(async () => {
        // While SMTP is still "in flight", the incident must already exist.
        const rows = await query(`SELECT COUNT(*)::int AS count FROM ops_incidents WHERE kind = 'queue_stalled';`);
        expect(rows.rows[0].count).toBe(1);
        throw new Error('connection reset mid-send');
      });
      await stuckDocument(240);

      await runOpsEvaluation();

      const incidents = await listIncidents({ status: 'open' });
      const incident = incidents.find((i) => i.kind === 'queue_stalled')!;
      expect(incident.deliveries[0].status).toBe('failed');
      expect(incident.deliveries[0].error).toContain('connection reset mid-send');
    });

    it('shows a skipped delivery when the incident is below the configured severity floor', async () => {
      await enableEmailChannel('critical');
      // A warning-level problem: documents in "failed", nothing stalled.
      await createTestDocument({ title: 'Fehlgeschlagen.pdf', status: 'failed' });

      await runOpsEvaluation();

      const incident = (await listIncidents({ status: 'open' })).find((i) => i.kind === 'documents_failed')!;
      expect(incident.severity).toBe('warning');
      expect(incident.deliveries[0].status).toBe('skipped');
      expect(incident.deliveries[0].error).toContain('Meldeschwelle');
      expect(subjectsSent().filter((subject) => subject.includes('Warnung: Dokumenteneingang'))).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // Supporting behaviour: thresholds are persisted operator settings.
  // ------------------------------------------------------------------
  describe('alert thresholds are persisted settings, not constants', () => {
    it('lets an admin change a threshold and changes the verdict accordingly', async () => {
      const token = await adminToken();
      await stuckDocument(45);

      const beforeChange = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      expect(beforeChange.body.components.find((c: any) => c.component === 'ingestion').status).toBe('degraded');

      const update = await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ queueAgeWarnMinutes: 10, queueAgeFailMinutes: 20 });
      expect(update.status).toBe(200);
      expect(update.body.settings.queueAgeFailMinutes).toBe(20);

      const afterChange = await request(app).get('/api/ops/dashboard').set('Authorization', `Bearer ${token}`);
      expect(afterChange.body.components.find((c: any) => c.component === 'ingestion').status).toBe('failed');

      // Persisted, not per-request state.
      const stored = await query(`SELECT queue_age_fail_minutes FROM ops_alert_settings WHERE id = TRUE;`);
      expect(stored.rows[0].queue_age_fail_minutes).toBe(20);
    });

    it('refuses contradictory or unroutable settings', async () => {
      const token = await adminToken();

      const inverted = await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ queueAgeWarnMinutes: 90, queueAgeFailMinutes: 30 });
      expect(inverted.status).toBe(400);

      const noRecipient = await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ emailEnabled: true, recipient: null });
      expect(noRecipient.status).toBe(400);

      const negative = await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ workerStaleMinutes: -5 });
      expect(negative.status).toBe(400);
    });

    it('audits a settings change and a manual evaluation', async () => {
      const token = await adminToken();

      await request(app)
        .put('/api/ops/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ backupVerifyMaxAgeHours: 12 });
      const evaluated = await request(app).post('/api/ops/evaluate').set('Authorization', `Bearer ${token}`);
      expect(evaluated.status).toBe(200);
      expect(Array.isArray(evaluated.body.components)).toBe(true);

      const audit = await query(
        `SELECT action FROM audit_logs WHERE action IN ('ops_alert_settings_updated', 'ops_health_evaluated') ORDER BY created_at;`
      );
      expect(audit.rows.map((row: any) => row.action)).toEqual([
        'ops_alert_settings_updated',
        'ops_health_evaluated',
      ]);
    });
  });
});
