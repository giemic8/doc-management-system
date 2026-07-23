import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config';
import { signChallengeToken, verifyChallengeToken } from '../../src/services/mfaChallenge.service';

describe('mfaChallenge.service', () => {
  it('round-trips: a signed challenge token verifies back to the same user id', () => {
    const token = signChallengeToken('user-123');
    expect(verifyChallengeToken(token)).toBe('user-123');
  });

  it('rejects a normal session JWT (no mfa-challenge purpose claim)', () => {
    const sessionToken = jwt.sign({ id: 'user-123', role: 'editor' }, config.jwtSecret, { expiresIn: '7d' });
    expect(verifyChallengeToken(sessionToken)).toBeNull();
  });

  it('rejects a garbage token', () => {
    expect(verifyChallengeToken('not-a-real-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = jwt.sign({ sub: 'user-123', purpose: 'mfa-challenge' }, 'wrong-secret', { expiresIn: '5m' });
    expect(verifyChallengeToken(token)).toBeNull();
  });
});
