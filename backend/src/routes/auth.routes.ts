import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../database/db';
import { config } from '../config';
import { AuthRequest, authenticateToken } from '../middleware/auth';

const router = Router();

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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
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

// GET /api/auth/me
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  return res.json({ user: req.user });
});

export default router;
