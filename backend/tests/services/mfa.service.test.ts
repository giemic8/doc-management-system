import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';
import {
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
} from '../../src/services/mfa.service';

describe('mfa.service', () => {
  describe('generateTotpSecret', () => {
    it('generates a base32 secret string', () => {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]+=*$/);
      expect(secret.length).toBeGreaterThan(10);
    });
  });

  describe('buildTotpUri', () => {
    it('builds a otpauth:// URI including the account email and app name', () => {
      const secret = generateTotpSecret();
      const uri = buildTotpUri(secret, 'user@example.com');
      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      expect(uri).toContain(encodeURIComponent('user@example.com'));
    });
  });

  describe('verifyTotpCode', () => {
    it('accepts a code generated from the same secret', () => {
      const secret = generateTotpSecret();
      const code = authenticator.generate(secret);
      expect(verifyTotpCode(secret, code)).toBe(true);
    });

    it('rejects an incorrect code', () => {
      const secret = generateTotpSecret();
      expect(verifyTotpCode(secret, '000000')).toBe(false);
    });

    it('rejects a code generated from a different secret', () => {
      const secretA = generateTotpSecret();
      const secretB = generateTotpSecret();
      const codeFromB = authenticator.generate(secretB);
      expect(verifyTotpCode(secretA, codeFromB)).toBe(false);
    });
  });

  describe('generateBackupCodes', () => {
    it('generates 10 unique 8-digit codes by default', () => {
      const codes = generateBackupCodes();
      expect(codes).toHaveLength(10);
      codes.forEach((code) => expect(code).toMatch(/^\d{8}$/));
      expect(new Set(codes).size).toBe(10);
    });
  });

  describe('hashBackupCode / verifyBackupCode', () => {
    it('round-trips: a hashed code verifies against its original plaintext', async () => {
      const [code] = generateBackupCodes();
      const hash = await hashBackupCode(code);
      expect(await verifyBackupCode(code, hash)).toBe(true);
    });

    it('rejects a non-matching code', async () => {
      const [codeA, codeB] = generateBackupCodes();
      const hash = await hashBackupCode(codeA);
      expect(await verifyBackupCode(codeB, hash)).toBe(false);
    });
  });
});
