import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';
import {
  addMember,
  addTrustedContact,
  createSpace,
  deleteSpace,
  getSpaceDetail,
  listSpacesForUser,
  removeMember,
  removeTrustedContact,
  SpaceActor,
  SpaceError,
} from '../services/space.service';

// Mounted at /api/spaces -- ticket #34, private and shared family spaces.
const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorFrom(req: AuthRequest): SpaceActor {
  return { id: req.user!.id, role: req.user!.role, ip: req.ip };
}

/** Turns a refused space operation into its HTTP shape; anything else is a genuine 500. */
function handleError(res: Response, err: any) {
  if (err instanceof SpaceError) {
    return res.status(err.status).json({ error: err.message, reason: err.reason, ...err.details });
  }
  return res.status(500).json({ error: err.message });
}

// GET /api/spaces
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    return res.json({ spaces: await listSpacesForUser(actorFrom(req)) });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// POST /api/spaces { name, kind }
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const space = await createSpace(actorFrom(req), { name: req.body?.name, kind: req.body?.kind });
    return res.status(201).json({ space });
  } catch (err: any) {
    return handleError(res, err);
  }
});

/**
 * GET /api/spaces/directory
 *
 * The people a space can be shared with, or nominated as trusted contacts.
 * Deliberately open to every authenticated user rather than admins only:
 * nominating a trusted contact is the private-space owner's decision, and
 * an owner who has to ask an admin for the list has already lost the
 * independence this ticket is about. It returns names and addresses of
 * accounts on the same household server -- no roles, no content -- which
 * everyone in a family already knows.
 *
 * Registered before /:id so the literal path is not read as a space id.
 */
router.get('/directory', authenticateToken, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT id, name, email FROM users ORDER BY name ASC;`);
    return res.json({ users: result.rows });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// GET /api/spaces/:id
router.get('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(404).json({ error: 'Space not found', reason: 'not_found' });
  }
  try {
    return res.json({ space: await getSpaceDetail(actorFrom(req), req.params.id) });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// DELETE /api/spaces/:id
router.delete('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return res.status(404).json({ error: 'Space not found', reason: 'not_found' });
  }
  try {
    await deleteSpace(actorFrom(req), req.params.id);
    return res.json({ deleted: true });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// POST /api/spaces/:id/members { userId, canWrite, canDelete }
router.post('/:id/members', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(req.params.id) || !UUID_PATTERN.test(String(req.body?.userId ?? ''))) {
    return res.status(400).json({ error: 'A valid space id and userId are required' });
  }
  try {
    await addMember(actorFrom(req), req.params.id, {
      userId: req.body.userId,
      canWrite: typeof req.body.canWrite === 'boolean' ? req.body.canWrite : undefined,
      canDelete: typeof req.body.canDelete === 'boolean' ? req.body.canDelete : undefined,
    });
    return res.status(201).json({ added: true });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// DELETE /api/spaces/:id/members/:userId
router.delete('/:id/members/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(req.params.id) || !UUID_PATTERN.test(req.params.userId)) {
    return res.status(400).json({ error: 'A valid space id and userId are required' });
  }
  try {
    await removeMember(actorFrom(req), req.params.id, req.params.userId);
    return res.json({ removed: true });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// POST /api/spaces/:id/trusted-contacts { userId }
router.post('/:id/trusted-contacts', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(req.params.id) || !UUID_PATTERN.test(String(req.body?.userId ?? ''))) {
    return res.status(400).json({ error: 'A valid space id and userId are required' });
  }
  try {
    await addTrustedContact(actorFrom(req), req.params.id, req.body.userId);
    return res.status(201).json({ added: true });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// DELETE /api/spaces/:id/trusted-contacts/:userId
router.delete('/:id/trusted-contacts/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(req.params.id) || !UUID_PATTERN.test(req.params.userId)) {
    return res.status(400).json({ error: 'A valid space id and userId are required' });
  }
  try {
    await removeTrustedContact(actorFrom(req), req.params.id, req.params.userId);
    return res.json({ removed: true });
  } catch (err: any) {
    return handleError(res, err);
  }
});

export default router;
