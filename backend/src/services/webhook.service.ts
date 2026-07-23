import crypto from 'crypto';
import axios from 'axios';

export type WebhookEvent = 'document.created' | 'document.processed' | 'workflow.triggered' | 'document.deleted';

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, any>;
}

export function buildWebhookPayload(event: WebhookEvent, data: Record<string, any>): WebhookPayload {
  return { event, timestamp: new Date().toISOString(), data };
}

export function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = signPayload(body, secret);
  // Constant-time comparison to avoid timing attacks; guard length mismatch
  // (timingSafeEqual throws if buffers differ in length).
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export interface DeliveryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface DeliveryResult {
  success: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

/**
 * Delivers a signed webhook payload with exponential backoff retry.
 * Injectable `sleepFn` for tests to skip real delays.
 */
export async function deliverWebhook(
  url: string,
  secret: string,
  payload: WebhookPayload,
  options: DeliveryOptions = {},
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<DeliveryResult> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  while (attempts < maxRetries) {
    attempts++;
    try {
      const res = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': payload.event,
        },
        timeout: 10000,
        validateStatus: () => true,
      });
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        return { success: true, attempts, lastStatus };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err: any) {
      lastError = err.message;
    }

    if (attempts < maxRetries) {
      await sleepFn(baseDelayMs * 2 ** (attempts - 1));
    }
  }

  return { success: false, attempts, lastStatus, lastError };
}
