import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { deliverWebhook, buildWebhookPayload } from '../../src/services/webhook.service';

vi.mock('axios');

describe('deliverWebhook', () => {
  it('succeeds on the first attempt when the endpoint returns 2xx', async () => {
    (axios.post as any) = vi.fn().mockResolvedValue({ status: 200 });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const payload = buildWebhookPayload('document.created', { id: 'doc-1' });
    const result = await deliverWebhook('https://example.com/hook', 'secret', payload, {}, sleepFn);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('retries with exponential backoff on failure, then succeeds', async () => {
    const post = vi.fn().mockResolvedValueOnce({ status: 500 }).mockResolvedValueOnce({ status: 200 });
    (axios.post as any) = post;
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const payload = buildWebhookPayload('document.created', { id: 'doc-1' });
    const result = await deliverWebhook('https://example.com/hook', 'secret', payload, { baseDelayMs: 100 }, sleepFn);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleepFn).toHaveBeenCalledWith(100); // 100 * 2^0
  });

  it('gives up after maxRetries and reports failure', async () => {
    (axios.post as any) = vi.fn().mockResolvedValue({ status: 500 });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const payload = buildWebhookPayload('document.created', { id: 'doc-1' });
    const result = await deliverWebhook('https://example.com/hook', 'secret', payload, { maxRetries: 3, baseDelayMs: 10 }, sleepFn);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 10); // 10 * 2^0
    expect(sleepFn).toHaveBeenNthCalledWith(2, 20); // 10 * 2^1
  });

  it('includes the HMAC signature header on every request', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200 });
    (axios.post as any) = post;

    const payload = buildWebhookPayload('document.deleted', { id: 'doc-2' });
    await deliverWebhook('https://example.com/hook', 'secret', payload);

    expect(post).toHaveBeenCalledWith(
      'https://example.com/hook',
      payload,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Webhook-Signature': expect.stringMatching(/^[a-f0-9]{64}$/),
          'X-Webhook-Event': 'document.deleted',
        }),
      })
    );
  });
});
