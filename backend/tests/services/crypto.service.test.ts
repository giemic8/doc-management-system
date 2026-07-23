import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/services/crypto.service';

describe('crypto.service', () => {
  it('round-trips a plaintext secret through encrypt/decrypt', () => {
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const first = encryptSecret(plaintext);
    const second = encryptSecret(plaintext);
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe(plaintext);
    expect(decryptSecret(second)).toBe(plaintext);
  });

  it('throws when decrypting tampered ciphertext', () => {
    const encrypted = encryptSecret('JBSWY3DPEHPK3PXP');
    const tampered = encrypted.slice(0, -2) + (encrypted.slice(-2) === 'aa' ? 'bb' : 'aa');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
