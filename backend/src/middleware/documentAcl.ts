import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';
import {
  canUserAccessDocument,
  canUserDeleteDocument,
  canUserModifyDocument,
  logUnauthorizedAccess,
} from '../services/acl.service';

type DocumentPermission = 'read' | 'write' | 'delete';
type DocumentIdResolver = (req: AuthRequest) => string | string[] | undefined;

const permissionChecks = {
  read: canUserAccessDocument,
  write: canUserModifyDocument,
  delete: canUserDeleteDocument,
};

/**
 * Central route guard for document-backed features. Resolving IDs stays
 * explicit at route registration; permission semantics and denial auditing
 * stay in one place so new routes cannot accidentally use authentication as
 * a substitute for document authorization.
 */
export function requireDocumentPermission(
  permission: DocumentPermission,
  resolveDocumentIds: DocumentIdResolver,
  auditAction: string
) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const resolved = resolveDocumentIds(req);
      const documentIds = (Array.isArray(resolved) ? resolved : [resolved]).filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      );

      // Let route-level validation produce its normal 400 response when the
      // request contains no usable document IDs.
      if (documentIds.length === 0) {
        return next();
      }

      const context = { userId: req.user!.id, role: req.user!.role };
      const checkPermission = permissionChecks[permission];
      const deniedDocumentIds: string[] = [];

      for (const documentId of [...new Set(documentIds)]) {
        if (!(await checkPermission(context, documentId))) {
          deniedDocumentIds.push(documentId);
          await logUnauthorizedAccess(req.user!.id, documentId, auditAction, req);
        }
      }

      if (deniedDocumentIds.length > 0) {
        return res.status(403).json({
          error: `You do not have ${permission} permission for one or more documents`,
          deniedDocumentIds,
        });
      }

      return next();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  };
}
