import { describe, it, expect } from 'vitest';
import { signAuditHistory, verifyAuditHistorySignature } from '../../src/services/auditExport.service';

describe('signAuditHistory', () => {
  it('produces a verifiable signature over a serialized audit history', () => {
    const auditEntries = [{ id: '1', action: 'upload', created_at: '2024-01-01T00:00:00Z' }];
    const signature = signAuditHistory(auditEntries, 'secret');
    expect(verifyAuditHistorySignature(auditEntries, 'secret', signature)).toBe(true);
  });

  it('fails verification if the audit history is tampered with after signing', () => {
    const auditEntries = [{ id: '1', action: 'upload', created_at: '2024-01-01T00:00:00Z' }];
    const signature = signAuditHistory(auditEntries, 'secret');

    const tampered = [{ id: '1', action: 'delete', created_at: '2024-01-01T00:00:00Z' }];
    expect(verifyAuditHistorySignature(tampered, 'secret', signature)).toBe(false);
  });

  it('fails verification against a different secret', () => {
    const auditEntries = [{ id: '1', action: 'upload' }];
    const signature = signAuditHistory(auditEntries, 'secret-a');
    expect(verifyAuditHistorySignature(auditEntries, 'secret-b', signature)).toBe(false);
  });
});
