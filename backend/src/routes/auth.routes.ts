import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { query } from '../database/db';
import { config } from '../config';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { encryptSecret, decryptSecret } from '../services/crypto.service';
import {
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
} from '../services/mfa.service';
import { signChallengeToken, verifyChallengeToken } from '../services/mfaChallenge.service';
import { checkRateLimit } from '../services/rateLimit.service';

interface BackupCodeRecord {
  codeHash: string;
  usedAt: string | null;
}

const router = Router();

function signSessionToken(user: any) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: '7d' }
  );
}

async function isMfaRequiredForEditors(): Promise<boolean> {
  const res = await query(`SELECT value FROM org_settings WHERE key = 'mfa_required_for_editors';`);
  return res.rows[0]?.value === true;
}

// POST /api/auth/login
router.post('/login', async (req: AuthRequest, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userRes = await query(`SELECT * FROM users WHERE email = $1;`, [email]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.mfa_enabled) {
      return res.json({
        mfaRequired: true,
        challengeToken: signChallengeToken(user.id),
      });
    }

    if (user.role === 'editor' && (await isMfaRequiredForEditors())) {
      return res.json({
        mfaSetupRequired: true,
        challengeToken: signChallengeToken(user.id),
      });
    }

    return res.json({
      token: signSessionToken(user),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/mfa/verify-login
router.post('/mfa/verify-login', async (req: AuthRequest, res: Response) => {
  const { challengeToken, code } = req.body;
  if (!challengeToken || !code) {
    return res.status(400).json({ error: 'challengeToken and code are required' });
  }

  const userId = verifyChallengeToken(challengeToken);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid or expired challenge' });
  }

  const perUserLimit = await checkRateLimit(`mfa-verify:user:${userId}`, { limit: 5, windowSeconds: 15 * 60 });
  const perIpLimit = await checkRateLimit(`mfa-verify:ip:${req.ip}`, { limit: 5, windowSeconds: 15 * 60 });
  if (!perUserLimit.allowed || !perIpLimit.allowed) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  try {
    const userRes = await query(`SELECT * FROM users WHERE id = $1;`, [userId]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    const user = userRes.rows[0];

    if (!user.mfa_enabled || !user.totp_secret_encrypted) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }

    const secret = decryptSecret(user.totp_secret_encrypted);
    if (verifyTotpCode(secret, code)) {
      return res.json({ token: signSessionToken(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    }

    // Fall back to backup codes.
    const backupCodes: BackupCodeRecord[] = user.mfa_backup_codes || [];
    for (let i = 0; i < backupCodes.length; i++) {
      const record = backupCodes[i];
      if (record.usedAt) continue;
      if (await verifyBackupCode(code, record.codeHash)) {
        backupCodes[i] = { ...record, usedAt: new Date().toISOString() };
        await query(`UPDATE users SET mfa_backup_codes = $1 WHERE id = $2;`, [JSON.stringify(backupCodes), user.id]);
        return res.json({ token: signSessionToken(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
      }
    }

    return res.status(401).json({ error: 'Invalid code' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  return res.json({ user: req.user });
});

// GET /api/auth/mfa/status
router.get('/mfa/status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userRes = await query(`SELECT mfa_enabled, mfa_backup_codes FROM users WHERE id = $1;`, [req.user!.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { mfa_enabled, mfa_backup_codes } = userRes.rows[0];
    const backupCodesRemaining = ((mfa_backup_codes || []) as BackupCodeRecord[]).filter((c) => !c.usedAt).length;

    return res.json({ mfaEnabled: mfa_enabled, backupCodesRemaining });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/mfa/setup
router.post('/mfa/setup', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userRes = await query(`SELECT * FROM users WHERE id = $1;`, [req.user!.id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Restarting setup on an already-enrolled account requires the current
    // password, so a hijacked session token alone can't be used to stage a
    // takeover by overwriting the TOTP secret ahead of a fresh /confirm.
    if (user.mfa_enabled) {
      const { password } = req.body;
      if (!password) {
        return res.status(401).json({ error: 'Current password is required to restart MFA setup' });
      }
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
    }

    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret);

    await query(`UPDATE users SET totp_secret_encrypted = $1 WHERE id = $2;`, [encrypted, req.user!.id]);

    const uri = buildTotpUri(secret, req.user!.email);
    const qrCodeDataUrl = await QRCode.toDataURL(uri);

    return res.json({ qrCodeDataUrl, secret });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/mfa/confirm
router.post('/mfa/confirm', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }

  try {
    const userRes = await query(`SELECT totp_secret_encrypted FROM users WHERE id = $1;`, [req.user!.id]);
    const encrypted = userRes.rows[0]?.totp_secret_encrypted;
    if (!encrypted) {
      return res.status(400).json({ error: 'No pending MFA setup found. Call /mfa/setup first.' });
    }

    const secret = decryptSecret(encrypted);
    if (!verifyTotpCode(secret, code)) {
      return res.status(400).json({ error: 'Invalid code' });
    }

    const backupCodes = generateBackupCodes();
    const backupCodeRecords: BackupCodeRecord[] = await Promise.all(
      backupCodes.map(async (c) => ({ codeHash: await hashBackupCode(c), usedAt: null }))
    );

    await query(
      `UPDATE users SET mfa_enabled = true, mfa_backup_codes = $1 WHERE id = $2;`,
      [JSON.stringify(backupCodeRecords), req.user!.id]
    );

    return res.json({ backupCodes });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/mfa/disable
router.post('/mfa/disable', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'password is required' });
  }

  try {
    const userRes = await query(`SELECT * FROM users WHERE id = $1;`, [req.user!.id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    if (user.role === 'editor' && (await isMfaRequiredForEditors())) {
      return res.status(403).json({ error: 'MFA is required by your administrator and cannot be disabled' });
    }

    await query(
      `UPDATE users SET mfa_enabled = false, totp_secret_encrypted = NULL, mfa_backup_codes = NULL WHERE id = $1;`,
      [user.id]
    );

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/mfa/backup-codes/regenerate
router.post('/mfa/backup-codes/regenerate', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'password is required' });
  }

  try {
    const userRes = await query(`SELECT * FROM users WHERE id = $1;`, [req.user!.id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    if (!user.mfa_enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    const backupCodes = generateBackupCodes();
    const backupCodeRecords: BackupCodeRecord[] = await Promise.all(
      backupCodes.map(async (c) => ({ codeHash: await hashBackupCode(c), usedAt: null }))
    );

    await query(`UPDATE users SET mfa_backup_codes = $1 WHERE id = $2;`, [JSON.stringify(backupCodeRecords), user.id]);

    return res.json({ backupCodes });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
