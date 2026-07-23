import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature, buildWebhookPayload } from '../../src/services/webhook.service';

describe('webhook.service', () => {
  describe('signPayload / verifySignature', () => {
    it('produces a verifiable HMAC-SHA256 signature for a given secret', () => {
      const body = JSON.stringify({ event: 'document.created', data: { id: '123' } });
      const secret = 'whsec_test_123';

      const signature = signPayload(body, secret);

      expect(signature).toMatch(/^[a-f0-9]{64}$/);
      expect(verifySignature(body, secret, signature)).toBe(true);
    });

    it('rejects a signature verified against a different secret', () => {
      const body = JSON.stringify({ event: 'document.created' });
      const signature = signPayload(body, 'secret-a');
      expect(verifySignature(body, 'secret-b', signature)).toBe(false);
    });

    it('rejects a signature verified against tampered body', () => {
      const body = JSON.stringify({ event: 'document.created' });
      const secret = 'whsec_test_123';
      const signature = signPayload(body, secret);
      const tamperedBody = JSON.stringify({ event: 'document.deleted' });
      expect(verifySignature(tamperedBody, secret, signature)).toBe(false);
    });
  });

  describe('buildWebhookPayload', () => {
    it('builds a payload with event name, timestamp, and data', () => {
      const payload = buildWebhookPayload('document.created', { id: 'doc-1', title: 'Invoice.pdf' });

      expect(payload.event).toBe('document.created');
      expect(payload.data).toEqual({ id: 'doc-1', title: 'Invoice.pdf' });
      expect(typeof payload.timestamp).toBe('string');
      expect(new Date(payload.timestamp).toString()).not.toBe('Invalid Date');
    });
  });
});
