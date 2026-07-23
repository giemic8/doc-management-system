import jwt from 'jsonwebtoken';
import { config } from '../config';

const CHALLENGE_PURPOSE = 'mfa-challenge';
const CHALLENGE_EXPIRY = '5m';

export interface MfaChallengePayload {
  sub: string; // user id
  purpose: typeof CHALLENGE_PURPOSE;
}

export function signChallengeToken(userId: string): string {
  const payload: MfaChallengePayload = { sub: userId, purpose: CHALLENGE_PURPOSE };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: CHALLENGE_EXPIRY });
}

/**
 * Verifies a challenge token and returns the user id it was issued for.
 * Returns null if the token is invalid, expired, or not a challenge token
 * (e.g. someone tries to reuse a normal session JWT here).
 */
export function verifyChallengeToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as any;
    if (decoded?.purpose !== CHALLENGE_PURPOSE || typeof decoded.sub !== 'string') {
      return null;
    }
    return decoded.sub;
  } catch {
    return null;
  }
}
