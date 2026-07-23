import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  isShareLinkValid,
  verifySharePassword,
  hashSharePassword,
  computeLockoutAfterFailedAttempt,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES,
  ShareLinkRow,
} from '../../src/services/shareLink.service';

function baseLink(overrides?: Partial<ShareLinkRow>): ShareLinkRow {
  return {
    id: 'link-1',
    document_id: 'doc-1',
    token: 'a'.repeat(64),
    password_hash: null,
    expires_at: null,
    max_downloads: null,
    download_count: 0,
    failed_attempts: 0,
    locked_until: null,
    created_by: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
    ...overrides,
  };
}

describe('shareLink.service', () => {
  describe('isShareLinkValid', () => {
    it('is valid with no restrictions set', () => {
      expect(isShareLinkValid(baseLink())).toEqual({ valid: true });
    });

    it('is invalid when expired', () => {
      const link = baseLink({ expires_at: new Date(Date.now() - 1000).toISOString() });
      expect(isShareLinkValid(link)).toEqual({ valid: false, reason: 'expired' });
    });

    it('is valid when expires_at is in the future', () => {
      const link = baseLink({ expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString() });
      expect(isShareLinkValid(link)).toEqual({ valid: true });
    });

    it('is invalid when revoked', () => {
      const link = baseLink({ revoked_at: new Date(Date.now() - 1000).toISOString() });
      expect(isShareLinkValid(link)).toEqual({ valid: false, reason: 'revoked' });
    });

    it('is invalid when the download limit has been reached', () => {
      const link = baseLink({ max_downloads: 2, download_count: 2 });
      expect(isShareLinkValid(link)).toEqual({ valid: false, reason: 'limit_exceeded' });
    });

    it('is valid when under the download limit', () => {
      const link = baseLink({ max_downloads: 2, download_count: 1 });
      expect(isShareLinkValid(link)).toEqual({ valid: true });
    });

    it('is invalid when currently locked out from failed password attempts', () => {
      const link = baseLink({ locked_until: new Date(Date.now() + 1000 * 60).toISOString() });
      expect(isShareLinkValid(link)).toEqual({ valid: false, reason: 'locked' });
    });

    it('is valid once a past lockout has expired', () => {
      const link = baseLink({ locked_until: new Date(Date.now() - 1000).toISOString() });
      expect(isShareLinkValid(link)).toEqual({ valid: true });
    });

    it('prioritizes revoked over other reasons when multiple apply', () => {
      const link = baseLink({
        revoked_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      expect(isShareLinkValid(link).reason).toBe('revoked');
    });
  });

  describe('verifySharePassword / hashSharePassword', () => {
    it('hashes a password and verifies it correctly', async () => {
      const hash = await hashSharePassword('correct-horse');
      expect(hash).not.toBe('correct-horse');
      await expect(verifySharePassword('correct-horse', hash)).resolves.toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const hash = await bcrypt.hash('correct-horse', 10);
      await expect(verifySharePassword('wrong-password', hash)).resolves.toBe(false);
    });
  });

  describe('computeLockoutAfterFailedAttempt', () => {
    it('increments failed attempts without locking below the threshold', () => {
      const result = computeLockoutAfterFailedAttempt(0);
      expect(result.failedAttempts).toBe(1);
      expect(result.lockedUntil).toBeNull();
    });

    it('locks out once the threshold is reached', () => {
      const now = new Date('2026-01-01T00:00:00Z');
      const result = computeLockoutAfterFailedAttempt(MAX_FAILED_ATTEMPTS - 1, now);
      expect(result.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
      expect(result.lockedUntil).not.toBeNull();
      expect(result.lockedUntil!.getTime()).toBe(now.getTime() + LOCKOUT_MINUTES * 60 * 1000);
    });
  });
});
