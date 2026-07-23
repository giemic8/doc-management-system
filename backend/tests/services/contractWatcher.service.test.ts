import { describe, it, expect } from 'vitest';
import {
  deriveContractStatus,
  findContractsNeedingAlert,
  NOTICE_DEADLINE_WARNING_DAYS,
  ContractRow,
} from '../../src/services/contractWatcher.service';

describe('deriveContractStatus', () => {
  const now = new Date('2026-07-23T12:00:00Z');

  it('returns "active" when no deadline is set (null)', () => {
    expect(deriveContractStatus(null, now)).toBe('active');
  });

  it('returns "active" when deadline is undefined', () => {
    expect(deriveContractStatus(undefined, now)).toBe('active');
  });

  it('returns "expired" when the deadline is in the past', () => {
    expect(deriveContractStatus('2026-07-01', now)).toBe('expired');
  });

  it('returns "expired" exactly one day past the deadline', () => {
    expect(deriveContractStatus('2026-07-22', now)).toBe('expired');
  });

  it('returns "active" when the deadline is far in the future (> warning window)', () => {
    expect(deriveContractStatus('2026-12-01', now)).toBe('active');
  });

  it('returns "notice_deadline_nearing" when within the warning window', () => {
    expect(deriveContractStatus('2026-08-01', now)).toBe('notice_deadline_nearing');
  });

  it('returns "notice_deadline_nearing" when the deadline is exactly today', () => {
    expect(deriveContractStatus('2026-07-23', now)).toBe('notice_deadline_nearing');
  });

  it('boundary: exactly NOTICE_DEADLINE_WARNING_DAYS out is "notice_deadline_nearing"', () => {
    const deadline = new Date(now);
    deadline.setDate(deadline.getDate() + NOTICE_DEADLINE_WARNING_DAYS);
    expect(deriveContractStatus(deadline, now)).toBe('notice_deadline_nearing');
  });

  it('boundary: one day beyond NOTICE_DEADLINE_WARNING_DAYS is "active"', () => {
    const deadline = new Date(now);
    deadline.setDate(deadline.getDate() + NOTICE_DEADLINE_WARNING_DAYS + 1);
    expect(deriveContractStatus(deadline, now)).toBe('active');
  });
});

describe('findContractsNeedingAlert', () => {
  const now = new Date('2026-07-23T12:00:00Z');

  const makeContract = (overrides: Partial<ContractRow>): ContractRow => ({
    document_id: 'doc-1',
    cancellation_deadline: null,
    alert_sent_at: null,
    ...overrides,
  });

  it('includes contracts with a nearing deadline and no alert sent yet', () => {
    const contracts = [
      makeContract({ document_id: 'a', cancellation_deadline: '2026-08-01', alert_sent_at: null }),
    ];
    const result = findContractsNeedingAlert(contracts, now);
    expect(result.map((c) => c.document_id)).toEqual(['a']);
  });

  it('excludes contracts that have already been alerted', () => {
    const contracts = [
      makeContract({ document_id: 'a', cancellation_deadline: '2026-08-01', alert_sent_at: '2026-07-20' }),
    ];
    expect(findContractsNeedingAlert(contracts, now)).toEqual([]);
  });

  it('excludes contracts that are still active (far future deadline)', () => {
    const contracts = [
      makeContract({ document_id: 'a', cancellation_deadline: '2026-12-01', alert_sent_at: null }),
    ];
    expect(findContractsNeedingAlert(contracts, now)).toEqual([]);
  });

  it('excludes contracts that are already expired', () => {
    const contracts = [
      makeContract({ document_id: 'a', cancellation_deadline: '2026-01-01', alert_sent_at: null }),
    ];
    expect(findContractsNeedingAlert(contracts, now)).toEqual([]);
  });

  it('excludes contracts with no deadline set', () => {
    const contracts = [makeContract({ document_id: 'a', cancellation_deadline: null, alert_sent_at: null })];
    expect(findContractsNeedingAlert(contracts, now)).toEqual([]);
  });

  it('handles a mixed batch, returning only the ones needing alerting', () => {
    const contracts = [
      makeContract({ document_id: 'nearing-unalerted', cancellation_deadline: '2026-08-01', alert_sent_at: null }),
      makeContract({ document_id: 'nearing-alerted', cancellation_deadline: '2026-08-01', alert_sent_at: '2026-07-01' }),
      makeContract({ document_id: 'expired', cancellation_deadline: '2026-01-01', alert_sent_at: null }),
      makeContract({ document_id: 'active', cancellation_deadline: '2027-01-01', alert_sent_at: null }),
    ];
    const result = findContractsNeedingAlert(contracts, now);
    expect(result.map((c) => c.document_id)).toEqual(['nearing-unalerted']);
  });
});
