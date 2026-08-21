import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';

/**
 * Admin-only management of access groups, group membership, and
 * per-group tag permissions (Ticket #19 — Granular Tag & Folder ACLs).
 * Enforcement of these permissions happens in document.routes.ts /
 * search.routes.ts / ragChat.service.ts via acl.service.ts; this router
 * is purely the CRUD surface an admin uses to configure them.
 */
const router = Router();

async function auditAclChange(req: AuthRequest, action: string, details: Record<string, unknown>) {
  await query(
    `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4);`,
    [req.user?.id, action, JSON.stringify(details), req.ip ?? null]
  );
}

// GET /api/access-groups (list all groups with member + granted-tag counts)
router.get('/', authenticateToken, requireRole(['admin']), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT g.id, g.name, g.created_at,
        COALESCE(COUNT(DISTINCT uag.user_id), 0) AS member_count,
        COALESCE(COUNT(DISTINCT gtp.tag_id), 0) AS granted_tag_count
      FROM access_groups g
      LEFT JOIN user_access_groups uag ON uag.group_id = g.id
      LEFT JOIN group_tag_permissions gtp ON gtp.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name ASC;
    `);
    return res.json({ groups: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/access-groups (create a new group)
router.post('/', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await query(`INSERT INTO access_groups (name) VALUES ($1) RETURNING *;`, [name.trim()]);
    await auditAclChange(req, 'access_group_created', { groupId: result.rows[0].id, name: result.rows[0].name });
    return res.status(201).json({ group: result.rows[0] });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A group with this name already exists' });
    }
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/access-groups/:id
router.delete('/:id', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`DELETE FROM access_groups WHERE id = $1 RETURNING id;`, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    await auditAclChange(req, 'access_group_deleted', { groupId: req.params.id });
    return res.json({ deleted: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/access-groups/:id/members
router.get('/:id/members', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.name, u.role
       FROM user_access_groups uag
       JOIN users u ON u.id = uag.user_id
       WHERE uag.group_id = $1
       ORDER BY u.name ASC;`,
      [req.params.id]
    );
    return res.json({ members: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/access-groups/:id/members (replace the full member list)
router.put('/:id/members', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { userIds } = req.body ?? {};
  if (!Array.isArray(userIds)) {
    return res.status(400).json({ error: 'userIds (array) is required' });
  }
  try {
    await query(`DELETE FROM user_access_groups WHERE group_id = $1;`, [req.params.id]);
    for (const userId of userIds) {
      await query(
        `INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
        [userId, req.params.id]
      );
    }
    await auditAclChange(req, 'access_group_members_replaced', { groupId: req.params.id, userIds });
    return res.json({ updated: true, memberCount: userIds.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/access-groups/:id/tag-permissions
router.get('/:id/tag-permissions', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT gtp.tag_id, t.name AS tag_name, t.color AS tag_color, gtp.can_read, gtp.can_write, gtp.can_delete
       FROM group_tag_permissions gtp
       JOIN tags t ON t.id = gtp.tag_id
       WHERE gtp.group_id = $1
       ORDER BY t.name ASC;`,
      [req.params.id]
    );
    return res.json({ permissions: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/access-groups/:id/tag-permissions/:tagId (upsert a single grant)
router.put(
  '/:id/tag-permissions/:tagId',
  authenticateToken,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    const { canRead = true, canWrite = false, canDelete = false } = req.body ?? {};
    try {
      const result = await query(
        `INSERT INTO group_tag_permissions (group_id, tag_id, can_read, can_write, can_delete)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (group_id, tag_id) DO UPDATE SET can_read = $3, can_write = $4, can_delete = $5
         RETURNING *;`,
        [req.params.id, req.params.tagId, !!canRead, !!canWrite, !!canDelete]
      );
      await auditAclChange(req, 'access_group_permission_updated', {
        groupId: req.params.id,
        tagId: req.params.tagId,
        canRead: !!canRead,
        canWrite: !!canWrite,
        canDelete: !!canDelete,
      });
      return res.json({ permission: result.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/access-groups/:id/tag-permissions/:tagId (revoke a grant entirely)
router.delete(
  '/:id/tag-permissions/:tagId',
  authenticateToken,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    try {
      await query(`DELETE FROM group_tag_permissions WHERE group_id = $1 AND tag_id = $2;`, [
        req.params.id,
        req.params.tagId,
      ]);
      await auditAclChange(req, 'access_group_permission_revoked', {
        groupId: req.params.id,
        tagId: req.params.tagId,
      });
      return res.json({ deleted: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

export default router;
