import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import {
  approveEmergencyAccess,
  denyEmergencyAccess,
  EmergencyAccessError,
  EMERGENCY_ACCESS_DEFAULT_HOURS,
  EMERGENCY_ACCESS_MAX_HOURS,
  listEmergencyRequests,
  requestEmergencyAccess,
  revokeEmergencyAccess,
} from '../services/emergencyAccess.service';
import { SpaceActor, SpaceError } from '../services/space.service';

// Mounted at /api/emergency-access -- ticket #34, two-person unlock of a
// private space. Every route here is authenticated as a normal user: there
// is deliberately no admin shortcut, because an admin shortcut is exactly
// what a private space exists to prevent.
const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorFrom(req: AuthRequest): SpaceActor {
  return { id: req.user!.id, role: req.user!.role, ip: req.ip };
}

function handleError(res: Response, err: any) {
  if (err instanceof EmergencyAccessError || err instanceof SpaceError) {
    return res.status(err.status).json({ error: err.message, reason: err.reason, ...err.details });
  }
  return res.status(500).json({ error: err.message });
}

// GET /api/emergency-access
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    return res.json({
      requests: await listEmergencyRequests(actorFrom(req)),
      maxHours: EMERGENCY_ACCESS_MAX_HOURS,
      defaultHours: EMERGENCY_ACCESS_DEFAULT_HOURS,
    });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// POST /api/emergency-access { spaceId, reason, hours }
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!UUID_PATTERN.test(String(req.body?.spaceId ?? ''))) {
    return res.status(400).json({ error: 'A valid spaceId is required' });
  }
  try {
    const request = await requestEmergencyAccess(actorFrom(req), {
      spaceId: req.body.spaceId,
      reason: req.body.reason,
      hours: req.body.hours === undefined ? undefined : Number(req.body.hours),
    });
    return res.status(201).json({ request });
  } catch (err: any) {
    return handleError(res, err);
  }
});

const decisions = {
  approve: approveEmergencyAccess,
  deny: denyEmergencyAccess,
  revoke: revokeEmergencyAccess,
} as const;

for (const [action, handler] of Object.entries(decisions)) {
  // POST /api/emergency-access/:id/{approve,deny,revoke}
  router.post(`/:id/${action}`, authenticateToken, async (req: AuthRequest, res: Response) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(404).json({ error: 'Emergency request not found', reason: 'not_found' });
    }
    try {
      return res.json({ request: await handler(actorFrom(req), req.params.id) });
    } catch (err: any) {
      return handleError(res, err);
    }
  });
}

export default router;
