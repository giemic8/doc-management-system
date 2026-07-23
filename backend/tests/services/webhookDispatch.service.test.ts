import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/database/db', () => ({ query: (...args: any[]) => mockQuery(...args) }));

const mockDeliverWebhook = vi.fn();
vi.mock('../../src/services/webhook.service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/webhook.service')>('../../src/services/webhook.service');
  return { ...actual, deliverWebhook: (...args: any[]) => mockDeliverWebhook(...args) };
});

import { dispatchWebhookEvent } from '../../src/services/webhookDispatch.service';

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDeliverWebhook.mockReset();
  });

  it('delivers to every active endpoint subscribed to the event', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 'ep-1', url: 'https://a.example.com/hook', secret: 'secret-a', events: ['document.created'] },
          { id: 'ep-2', url: 'https://b.example.com/hook', secret: 'secret-b', events: ['document.created', 'document.deleted'] },
        ],
      })
      .mockResolvedValue({ rows: [] }); // audit insert calls

    mockDeliverWebhook.mockResolvedValue({ success: true, attempts: 1, lastStatus: 200 });

    await dispatchWebhookEvent('document.created', { id: 'doc-1' });

    expect(mockDeliverWebhook).toHaveBeenCalledTimes(2);
    expect(mockDeliverWebhook).toHaveBeenCalledWith(
      'https://a.example.com/hook',
      'secret-a',
      expect.objectContaining({ event: 'document.created' })
    );
  });

  it('does not deliver to endpoints not subscribed to the event', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'ep-1', url: 'https://a.example.com/hook', secret: 'secret-a', events: ['workflow.triggered'] }],
    });

    await dispatchWebhookEvent('document.created', { id: 'doc-1' });

    expect(mockDeliverWebhook).not.toHaveBeenCalled();
  });

  it('records a delivery log row for each attempted delivery', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'ep-1', url: 'https://a.example.com/hook', secret: 'secret-a', events: ['document.created'] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    mockDeliverWebhook.mockResolvedValue({ success: true, attempts: 1, lastStatus: 200 });

    await dispatchWebhookEvent('document.created', { id: 'doc-1' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_deliveries'),
      expect.arrayContaining(['ep-1', 'document.created'])
    );
  });

  it('continues delivering to other endpoints even if one fails', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 'ep-1', url: 'https://a.example.com/hook', secret: 'secret-a', events: ['document.created'] },
          { id: 'ep-2', url: 'https://b.example.com/hook', secret: 'secret-b', events: ['document.created'] },
        ],
      })
      .mockResolvedValue({ rows: [] });

    mockDeliverWebhook
      .mockResolvedValueOnce({ success: false, attempts: 3, lastError: 'timeout' })
      .mockResolvedValueOnce({ success: true, attempts: 1, lastStatus: 200 });

    await expect(dispatchWebhookEvent('document.created', { id: 'doc-1' })).resolves.not.toThrow();
    expect(mockDeliverWebhook).toHaveBeenCalledTimes(2);
  });
});
