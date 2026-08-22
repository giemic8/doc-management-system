/**
 * Ticket #37 -- periodic health evaluation.
 *
 * Same shape as the other background jobs in this codebase
 * (contractAlertScheduler / emailImportScheduler): one interval handle, one
 * guarded tick, start/stop exported so tests and shutdown can control it.
 *
 * The interesting part is what the tick must survive. It runs when things
 * are already broken -- that is its whole purpose -- so a failing probe, a
 * dead database or an unreachable SMTP server must all end as a logged
 * message, never as an unhandled rejection that kills the timer and takes
 * monitoring down exactly when it is needed.
 */
import { collectHealth } from './opsHealth.service';
import { evaluateHealth, getAlertSettings, thresholdsFrom } from './opsAlerts.service';
import type { EvaluationSummary } from './opsAlerts.service';
import type { ComponentHealth } from './opsHealth.service';

let intervalHandle: NodeJS.Timeout | null = null;

export interface OpsEvaluationResult {
  components: ComponentHealth[];
  summary: EvaluationSummary;
}

/**
 * One full cycle: read the operator's thresholds, measure every dependency,
 * then reconcile incidents against what was measured. Exported because the
 * admin "Jetzt prüfen" button and the integration tests need exactly the
 * same cycle the timer runs.
 */
export async function runOpsEvaluation(options: { refreshAiProvider?: boolean } = {}): Promise<OpsEvaluationResult> {
  const settings = await getAlertSettings();
  const components = await collectHealth(thresholdsFrom(settings), {
    refreshAiProvider: options.refreshAiProvider === true,
  });
  const summary = await evaluateHealth(components, settings);
  return { components, summary };
}

export function startOpsAlertScheduler(checkIntervalMs: number = 5 * 60 * 1000) {
  if (intervalHandle) return; // already running

  intervalHandle = setInterval(async () => {
    try {
      // The scheduler has no user waiting on it, so this is the one caller
      // that may pay for a real AI-provider round trip.
      const { summary } = await runOpsEvaluation({ refreshAiProvider: true });
      if (summary.opened.length > 0 || summary.resolved.length > 0) {
        console.log(
          `Ops alert scheduler: ${summary.opened.length} new incident(s), ` +
            `${summary.bumped.length} ongoing, ${summary.resolved.length} recovered.`
        );
      }
    } catch (err: any) {
      console.error('Ops alert scheduler error:', err.message);
    }
  }, checkIntervalMs);
}

export function stopOpsAlertScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
