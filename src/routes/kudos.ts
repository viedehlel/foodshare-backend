import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router({ mergeParams: true });

// POST /posts/:postId/kudos — toggle a kudo type
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { type, icon } = req.body as { type: string; icon: string };
  if (!type || !icon) { res.status(400).json({ error: 'type and icon are required' }); return; }
  try {
    const existing = await pool.query(
      'SELECT 1 FROM kudos WHERE post_id = $1 AND user_id = $2 AND type = $3',
      [req.params.postId, req.userId, type]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM kudos WHERE post_id = $1 AND user_id = $2 AND type = $3',
        [req.params.postId, req.userId, type]
      );
      res.json({ given: false });
    } else {
      await pool.query(
        'INSERT INTO kudos (post_id, user_id, type, icon) VALUES ($1,$2,$3,$4)',
        [req.params.postId, req.userId, type, icon]
      );
      pool.query(
        `INSERT INTO notifications (user_id, actor_id, type, post_id, kudo_type)
         SELECT p.user_id, $2, 'kudo', $1, $3 FROM posts p
         WHERE p.id = $1 AND p.user_id != $2`,
        [req.params.postId, req.userId, type]
      ).catch(() => {});
      res.json({ given: true });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /posts/:postId/kudos/mine — types given by current user
router.get('/mine', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      'SELECT type FROM kudos WHERE post_id = $1 AND user_id = $2',
      [req.params.postId, req.userId]
    );
    res.json({ types: rows.map(r => r.type) });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
