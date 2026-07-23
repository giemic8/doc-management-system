import { query } from '../database/db';
import { deliverWebhook, buildWebhookPayload, WebhookEvent } from './webhook.service';

interface WebhookEndpointRow {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
}

/**
 * Fans an event out to every active webhook endpoint subscribed to it,
 * delivering with retry/backoff (see webhook.service) and recording the
 * outcome of each delivery attempt for observability. Failures on one
 * endpoint never block delivery to the others.
 */
export async function dispatchWebhookEvent(event: WebhookEvent, data: Record<string, any>): Promise<void> {
  const endpointsRes = await query(
    `SELECT id, url, secret, events FROM webhook_endpoints WHERE is_active = true;`
  );

  const subscribed: WebhookEndpointRow[] = endpointsRes.rows.filter((ep: WebhookEndpointRow) =>
    (ep.events || []).includes(event)
  );

  const payload = buildWebhookPayload(event, data);

  await Promise.all(
    subscribed.map(async (endpoint) => {
      const result = await deliverWebhook(endpoint.url, endpoint.secret, payload);

      await query(
        `INSERT INTO webhook_deliveries (webhook_endpoint_id, event, payload, success, attempts, last_status, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [endpoint.id, event, JSON.stringify(payload), result.success, result.attempts, result.lastStatus ?? null, result.lastError ?? null]
      );
    })
  );
}
