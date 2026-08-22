/**
 * Ticket #37 -- the operations dashboard's HTTP surface.
 *
 * Admin-only throughout, the same way backup.routes.ts gates backup health:
 * component-level failure detail, storage capacity and alert routing are
 * infrastructure facts about the household server, not user content.
 *
 * The routes stay thin on purpose. Every measurement comes from
 * opsHealth.service and every incident decision from opsAlerts.service, so
 * no route here opens a database pool, a Redis connection, a filesystem
 * handle or an LLM client of its own.
 */
import { Router, Response } from 'express';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { collectHealth } from '../services/opsHealth.service';
import {
  OpsValidationError,
  getAlertSettings,
  listIncidents,
  thresholdsFrom,
  updateAlertSettings,
} from '../services/opsAlerts.service';
import type { AlertSettingsPatch, IncidentStatus } from '../services/opsAlerts.service';
import { query } from '../database/db';
import { runOpsEvaluation } from '../services/opsAlertScheduler.service';

const router = Router();

const adminOnly = [authenticateToken, requireRole(['admin'])];

/**
 * GET /api/ops/dashboard
 *
 * Measures every component and returns it together with the open and
 * recent incidents and the current thresholds. The AI-provider probe is
 * served from its cache here (refreshed in the background) so a hanging
 * LLM host cannot hang the page an operator opens *because* things hang.
 */
router.get('/dashboard', ...adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    const settings = await getAlertSettings();
    const components = await collectHealth(thresholdsFrom(settings), { refreshAiProvider: false });
    const incidents = await listIncidents({ limit: 50 });

    const worst = components.some((c) => c.status === 'failed')
      ? 'failed'
      : components.some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'ok';

    return res.json({
      generatedAt: new Date().toISOString(),
      overallStatus: worst,
      components,
      incidents,
      openIncidents: incidents.filter((incident) => incident.status === 'open'),
      settings,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ops/capacity
 *
 * The small, cheap slice the app shell needs to show real free space
 * instead of a hardcoded figure. Reads the stored measurement rather than
 * re-probing, so rendering the sidebar costs one indexed row read.
 */
router.get('/capacity', ...adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    const stored = await query(`SELECT metrics, last_checked_at FROM ops_component_health WHERE component = 'storage';`);

    if (stored.rows.length === 0) {
      const settings = await getAlertSettings();
      const components = await collectHealth(thresholdsFrom(settings), { refreshAiProvider: false });
      const storage = components.find((component) => component.component === 'storage');
      return res.json({ measuredAt: storage?.lastCheckedAt ?? null, metrics: storage?.metrics ?? {} });
    }

    return res.json({
      measuredAt: stored.rows[0].last_checked_at,
      metrics: stored.rows[0].metrics ?? {},
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/ops/incidents?status=open|resolved
router.get('/incidents', ...adminOnly, async (req: AuthRequest, res: Response) => {
  const status = req.query.status as IncidentStatus | undefined;
  if (status && !['open', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'status must be "open" or "resolved"' });
  }

  try {
    const incidents = await listIncidents({ status, limit: 100 });
    return res.json({ incidents });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/ops/settings
router.get('/settings', ...adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    return res.json({ settings: await getAlertSettings() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/ops/settings -- thresholds and alert routing are operator input,
// not constants; the change is audited because it decides who learns about
// a failure and when.
router.put('/settings', ...adminOnly, async (req: AuthRequest, res: Response) => {
  const patch = req.body as AlertSettingsPatch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  try {
    const settings = await updateAlertSettings(patch, { id: req.user!.id, ip: req.ip });
    return res.json({ settings });
  } catch (err: any) {
    if (err instanceof OpsValidationError) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ops/evaluate
 *
 * Runs the same cycle as the scheduler on demand. Audited: it can send
 * mail, and an operator triggering it is a deliberate administrative act.
 */
router.post('/evaluate', ...adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const { components, summary } = await runOpsEvaluation({ refreshAiProvider: true });
    await query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, 'ops_health_evaluated', $2, $3);`,
      [
        req.user!.id,
        JSON.stringify({
          opened: summary.opened.length,
          ongoing: summary.bumped.length,
          resolved: summary.resolved.length,
        }),
        req.ip ?? null,
      ]
    );

    return res.json({
      components,
      opened: summary.opened.length,
      ongoing: summary.bumped.length,
      resolved: summary.resolved.length,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
