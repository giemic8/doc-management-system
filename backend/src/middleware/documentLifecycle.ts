import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';
import { query } from '../database/db';

type DocumentIdResolver = (req: AuthRequest) => string | string[] | undefined;

/**
 * Ticket #33 -- a trashed document is excluded from normal use. It can be
 * restored or purged, but not edited, split, merged or re-tagged while it
 * waits out its recovery window: mutating deleted content produces states
 * no user asked for and no restore can explain.
 */
export function rejectTrashedDocuments(resolveDocumentIds: DocumentIdResolver) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const resolved = resolveDocumentIds(req);
      const documentIds = (Array.isArray(resolved) ? resolved : [resolved]).filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      );

      // Let route-level validation produce its normal 400/404 response.
      if (documentIds.length === 0) {
        return next();
      }

      const result = await query(`SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND status = 'trashed';`, [
        documentIds,
      ]);

      if (result.rows.length > 0) {
        return res.status(409).json({
          error: 'Document is in the trash; restore it before changing it',
          reason: 'document_trashed',
          trashedDocumentIds: result.rows.map((row: any) => row.id),
        });
      }

      return next();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  };
}
