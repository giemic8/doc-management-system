import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import { query } from '../database/db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { requireDocumentPermission } from '../middleware/documentAcl';
import { createDecryptStream } from '../services/fileEncryption.service';
import { checkRateLimit } from '../services/rateLimit.service';
import {
  isShareLinkValid,
  verifySharePassword,
  hashSharePassword,
  computeLockoutAfterFailedAttempt,
  ShareLinkRow,
} from '../services/shareLink.service';

const DEFAULT_EXPIRES_IN_DAYS = 7;

/**
 * Authenticated creator-management routes, mounted at /api/documents
 * alongside document.routes.ts (same pattern as documentRetentionRouter in
 * retention.routes.ts) — only logged-in users of this system can create,
 * list, or revoke share links for a document they can see.
 */
export const shareLinkRouter = Router();

// POST /api/documents/:id/share-links (create a new guest share link)
shareLinkRouter.post(
  '/:id/share-links',
  authenticateToken,
  requireDocumentPermission('write', (req) => req.params.id, 'create_share_link'),
  async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { password, expiresInDays, maxDownloads } = req.body ?? {};

  try {
    const docRes = await query(`SELECT id, status FROM documents WHERE id = $1;`, [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    // Ticket #33 -- a trashed document is excluded from normal use, so it
    // must not gain new guest access while it waits out its recovery window.
    if (docRes.rows[0].status === 'trashed') {
      return res.status(409).json({ error: 'Document is in the trash and cannot be shared', reason: 'document_trashed' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const passwordHash = password ? await hashSharePassword(password) : null;

    const effectiveExpiresInDays = expiresInDays === undefined ? DEFAULT_EXPIRES_IN_DAYS : Number(expiresInDays);
    const expiresAt =
      effectiveExpiresInDays === null
        ? null
        : new Date(Date.now() + effectiveExpiresInDays * 24 * 60 * 60 * 1000);

    const effectiveMaxDownloads =
      maxDownloads === undefined || maxDownloads === null || maxDownloads === '' ? null : Number(maxDownloads);

    const result = await query(
      `INSERT INTO document_share_links (document_id, token, password_hash, expires_at, max_downloads, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, expires_at, max_downloads, created_at;`,
      [id, token, passwordHash, expiresAt, effectiveMaxDownloads, req.user?.id]
    );

    const row = result.rows[0];
    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details, ip_address)
       VALUES ($1, $2, 'share_link_created', $3, $4);`,
      [id, req.user?.id, JSON.stringify({ shareLinkId: row.id }), req.ip ?? null]
    );
    // The raw token is only ever returned here, at creation time — the
    // creating user distributes it themselves. Unlike calendar feed
    // tokens, re-exposure isn't avoided elsewhere because this token is
    // *meant* to be handed out; it's just never persisted in plaintext
    // in a way that a list view would leak it back to a lower-trust caller.
    return res.status(201).json({
      shareUrl: `/share/${token}`,
      token,
      expiresAt: row.expires_at,
      maxDownloads: row.max_downloads,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
  }
);

// GET /api/documents/:id/share-links (list active share links; never returns password_hash or the raw token)
shareLinkRouter.get(
  '/:id/share-links',
  authenticateToken,
  requireDocumentPermission('read', (req) => req.params.id, 'list_share_links'),
  async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const result = await query(
      `SELECT id, expires_at, max_downloads, download_count, created_at, revoked_at
       FROM document_share_links
       WHERE document_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC;`,
      [id]
    );
    return res.json({ shareLinks: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
  }
);

// DELETE /api/documents/:id/share-links/:linkId (revoke)
shareLinkRouter.delete(
  '/:id/share-links/:linkId',
  authenticateToken,
  requireDocumentPermission('write', (req) => req.params.id, 'revoke_share_link'),
  async (req: AuthRequest, res: Response) => {
  const { id, linkId } = req.params;
  try {
    const result = await query(
      `UPDATE document_share_links SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND document_id = $2 AND revoked_at IS NULL
       RETURNING id;`,
      [linkId, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Share link not found or already revoked' });
    }
    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details, ip_address)
       VALUES ($1, $2, 'share_link_revoked', $3, $4);`,
      [id, req.user?.id, JSON.stringify({ shareLinkId: linkId }), req.ip ?? null]
    );
    return res.json({ revoked: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
  }
);

/**
 * Public routes, mounted at /api/share — NO authenticateToken, since guests
 * accessing a shared document are never logged in. Every access attempt
 * (successful or not) is logged to audit_logs with document_id, user_id =
 * null, and the share link's `id` (never the raw token) in `details`.
 */
export const publicShareRouter = Router();

async function fetchLinkWithDocument(token: string) {
  const result = await query(
    `SELECT l.*, d.title AS document_title, d.file_path, d.derived_file_path, d.original_filename,
            d.mime_type, d.is_encrypted, d.encryption_iv, d.encryption_auth_tag, d.status AS document_status
     FROM document_share_links l
     JOIN documents d ON d.id = l.document_id
     WHERE l.token = $1;`,
    [token]
  );
  return result.rows[0] || null;
}

async function logGuestAccess(
  documentId: string | null,
  action: string,
  shareLinkId: string | null,
  req: Request,
  extraDetails?: Record<string, unknown>
) {
  await query(
    `INSERT INTO audit_logs (document_id, user_id, action, details, ip_address) VALUES ($1, NULL, $2, $3, $4);`,
    [documentId, action, JSON.stringify({ shareLinkId, ...extraDetails }), req.ip]
  );
}

// GET /api/share/:token/info (public metadata only, no document content)
publicShareRouter.get('/:token/info', async (req: Request, res: Response) => {
  const { token } = req.params;
  try {
    const link = await fetchLinkWithDocument(token);
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Ticket #33 -- the document was deleted into the trash after the link
    // was handed out; guests lose access immediately, without waiting for
    // the link itself to be revoked or expire.
    if (link.document_status === 'trashed') {
      await logGuestAccess(link.document_id, 'guest_share_document_trashed', link.id, req);
      return res.status(410).json({ valid: false, error: 'Document is no longer available', reason: 'document_deleted' });
    }

    const validity = isShareLinkValid(link as ShareLinkRow);
    if (!validity.valid) {
      await logGuestAccess(link.document_id, `guest_share_${validity.reason}`, link.id, req);
      return res.status(validity.reason === 'expired' ? 410 : 403).json({
        valid: false,
        reason: validity.reason,
      });
    }

    await logGuestAccess(link.document_id, 'guest_share_info_access', link.id, req);

    return res.json({
      documentTitle: link.document_title,
      requiresPassword: !!link.password_hash,
      valid: true,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/share/:token/verify (public — pre-checks a password before the frontend shows a download button)
//
// Design decision: this endpoint is stateless. It does NOT issue a
// session/grant token, because a guest download page has no established
// session mechanism and inventing one would add complexity (storage,
// expiry, revocation) for a link that is itself already short-lived and
// single-purpose. Instead, the password must be supplied AGAIN on the
// actual GET /:token/download call below, which re-validates it in the
// exact same request that serves the file bytes. This endpoint exists
// purely as a UX convenience (validate before showing a "Download"
// button) and must never be treated as sufficient to gate the download.
publicShareRouter.post('/:token/verify', async (req: Request, res: Response) => {
  const { token } = req.params;
  const { password } = req.body ?? {};

  try {
    const link = await fetchLinkWithDocument(token);
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Ticket #33 -- trashed document: guest access ends immediately.
    if (link.document_status === 'trashed') {
      await logGuestAccess(link.document_id, 'guest_share_document_trashed', link.id, req);
      return res.status(410).json({ valid: false, error: 'Document is no longer available', reason: 'document_deleted' });
    }

    const validity = isShareLinkValid(link as ShareLinkRow);
    if (!validity.valid) {
      await logGuestAccess(link.document_id, `guest_share_${validity.reason}`, link.id, req);
      return res.status(validity.reason === 'expired' ? 410 : 403).json({ valid: false, reason: validity.reason });
    }

    if (!link.password_hash) {
      return res.json({ valid: true });
    }

    // Rate-limit password-guessing per token+IP, mirroring auth.routes.ts's
    // MFA-verify rate limiting (5 attempts / 15 min window), in addition to
    // the DB-backed per-link lockout below.
    const ipLimit = await checkRateLimit(`share-verify:ip:${req.ip}`, { limit: 5, windowSeconds: 15 * 60 });
    const tokenLimit = await checkRateLimit(`share-verify:token:${token}`, { limit: 5, windowSeconds: 15 * 60 });
    if (!ipLimit.allowed || !tokenLimit.allowed) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    const isMatch = password ? await verifySharePassword(password, link.password_hash) : false;
    if (!isMatch) {
      const { failedAttempts, lockedUntil } = computeLockoutAfterFailedAttempt(link.failed_attempts);
      await query(
        `UPDATE document_share_links SET failed_attempts = $1, locked_until = $2 WHERE id = $3;`,
        [failedAttempts, lockedUntil, link.id]
      );
      await logGuestAccess(link.document_id, 'guest_share_password_fail', link.id, req);
      return res.status(403).json({ valid: false, reason: 'invalid_password' });
    }

    // Successful password check resets the failure counter.
    await query(`UPDATE document_share_links SET failed_attempts = 0, locked_until = NULL WHERE id = $1;`, [link.id]);

    return res.json({ valid: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/share/:token/download?password=... (public — password re-checked in this same request, file streamed/decrypted on the fly)
publicShareRouter.get('/:token/download', async (req: Request, res: Response) => {
  const { token } = req.params;
  const password = (req.query.password as string | undefined) ?? undefined;

  try {
    const link = await fetchLinkWithDocument(token);
    if (!link) {
      return res.status(404).json({ error: 'Link not found' });
    }

    // Ticket #33 -- trashed document: guest access ends immediately.
    if (link.document_status === 'trashed') {
      await logGuestAccess(link.document_id, 'guest_share_document_trashed', link.id, req);
      return res.status(410).json({ valid: false, error: 'Document is no longer available', reason: 'document_deleted' });
    }

    const validity = isShareLinkValid(link as ShareLinkRow);
    if (!validity.valid) {
      await logGuestAccess(link.document_id, `guest_share_${validity.reason}`, link.id, req);
      return res.status(validity.reason === 'expired' ? 410 : 403).json({ error: 'Link is not valid', reason: validity.reason });
    }

    if (link.password_hash) {
      const ipLimit = await checkRateLimit(`share-download:ip:${req.ip}`, { limit: 5, windowSeconds: 15 * 60 });
      const tokenLimit = await checkRateLimit(`share-download:token:${token}`, { limit: 5, windowSeconds: 15 * 60 });
      if (!ipLimit.allowed || !tokenLimit.allowed) {
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      }

      const isMatch = password ? await verifySharePassword(password, link.password_hash) : false;
      if (!isMatch) {
        const { failedAttempts, lockedUntil } = computeLockoutAfterFailedAttempt(link.failed_attempts);
        await query(
          `UPDATE document_share_links SET failed_attempts = $1, locked_until = $2 WHERE id = $3;`,
          [failedAttempts, lockedUntil, link.id]
        );
        await logGuestAccess(link.document_id, 'guest_share_password_fail', link.id, req);
        return res.status(403).json({ error: 'Invalid password', reason: 'invalid_password' });
      }
    }

    // Re-check the download limit right before serving, and increment
    // atomically so concurrent requests can't race past max_downloads.
    const incrementResult = await query(
      `UPDATE document_share_links
       SET download_count = download_count + 1, failed_attempts = 0, locked_until = NULL
       WHERE id = $1 AND (max_downloads IS NULL OR download_count < max_downloads)
       RETURNING download_count;`,
      [link.id]
    );

    if (incrementResult.rows.length === 0) {
      await logGuestAccess(link.document_id, 'guest_share_limit_exceeded', link.id, req);
      return res.status(403).json({ error: 'Download limit exceeded', reason: 'limit_exceeded' });
    }

    const servePath = link.derived_file_path && fs.existsSync(link.derived_file_path) ? link.derived_file_path : link.file_path;
    if (!fs.existsSync(servePath)) {
      return res.status(404).json({ error: 'File on disk not found' });
    }

    await logGuestAccess(link.document_id, 'guest_share_access', link.id, req);

    res.setHeader('Content-Type', link.mime_type || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(link.original_filename)}"`);

    // Mirrors document.routes.ts's GET /:id/file decrypt-on-the-fly
    // pattern exactly — encrypted originals are never streamed as raw
    // ciphertext to a guest.
    if (link.is_encrypted && servePath === link.file_path && link.encryption_iv && link.encryption_auth_tag) {
      const decryptStream = createDecryptStream(link.encryption_iv, link.encryption_auth_tag);
      fs.createReadStream(servePath).pipe(decryptStream).pipe(res);
    } else {
      fs.createReadStream(servePath).pipe(res);
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
