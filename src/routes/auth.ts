import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

function makeToken(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '30d' });
}

// POST /auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  if (!name || !email || !password) {
    res.status(400).json({ error: 'name, email and password are required' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email, avatar_url, bio, city',
      [name, email, hash]
    );
    res.status(201).json({ token: makeToken(rows[0].id), user: rows[0] });
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Email already in use' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, password, avatar_url, bio, city FROM users WHERE email = $1',
      [email]
    );
    if (!rows[0]) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const { password: _, ...user } = rows[0];
    res.json({ token: makeToken(user.id), user });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, avatar_url, bio, city FROM users WHERE id = $1',
      [req.userId]
    );
    if (!rows[0]) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /auth/profile
router.patch('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, bio, city, avatar_url } = req.body as Partial<{ name: string; bio: string; city: string; avatar_url: string }>;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET
        name       = COALESCE($1, name),
        bio        = COALESCE($2, bio),
        city       = COALESCE($3, city),
        avatar_url = COALESCE($4, avatar_url)
       WHERE id = $5
       RETURNING id, name, email, avatar_url, bio, city`,
      [name, bio, city, avatar_url, req.userId]
    );
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/change-password
router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  const { current, next } = req.body as { current: string; next: string };
  if (!current || !next) {
    res.status(400).json({ error: 'current and next passwords are required' });
    return;
  }
  if (next.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  try {
    const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [req.userId]);
    const valid = await bcrypt.compare(current, rows[0].password);
    if (!valid) { res.status(401).json({ error: 'wrong_password' }); return; }
    const hash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.userId]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
