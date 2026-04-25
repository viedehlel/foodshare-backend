import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

pool.query(`
  CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    kudo_type TEXT,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id, created_at DESC);
`).catch(() => {});

// GET /notifications — last 50 for current user
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.post_id, n.kudo_type, n.read,
              EXTRACT(EPOCH FROM n.created_at)::bigint * 1000 AS created_at,
              json_build_object('id', a.id, 'name', a.name, 'avatar', a.avatar_url) AS actor
       FROM notifications n
       JOIN users a ON a.id = n.actor_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    const unreadCount = rows.filter(r => !r.read).length;
    res.json({ notifications: rows, unreadCount });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /notifications/read-all
router.post('/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query('UPDATE notifications SET read = TRUE WHERE user_id = $1', [req.userId]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /notifications/:id/read
router.patch('/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
