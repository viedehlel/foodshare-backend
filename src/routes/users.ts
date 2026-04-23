import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

// GET /users/search?q=... — search users
router.get('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  const q = (req.query.q as string ?? '').trim();
  if (!q) { res.json({ users: [] }); return; }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.avatar_url, u.bio, u.city,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id)::int AS followers_count,
              EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) AS is_following
       FROM users u
       WHERE u.id != $2
         AND (u.name ILIKE $1 OR u.email ILIKE $1)
       LIMIT 20`,
      [`%${q}%`, req.userId]
    );
    res.json({ users: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /users/:id — public profile
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.avatar_url, u.bio, u.city,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id)::int AS followers_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id)::int AS following_count,
              (SELECT COUNT(*) FROM posts WHERE user_id = u.id)::int AS posts_count,
              EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) AS is_following
       FROM users u WHERE u.id = $1`,
      [req.params.id, req.userId]
    );
    if (!rows[0]) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /users/:id/posts
router.get('/:id/posts', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.image_url, p.caption, p.location, p.created_at,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
              (SELECT COALESCE(json_agg(json_build_object('type', k.type, 'icon', k.icon, 'count', k.cnt)), '[]')
               FROM (SELECT type, icon, COUNT(*)::int AS cnt FROM kudos WHERE post_id = p.id GROUP BY type, icon) k
              ) AS kudos
       FROM posts p
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [req.params.id]
    );
    res.json({ posts: rows });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /users/:id/follow — toggle follow
router.post('/:id/follow', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.params.id === req.userId) { res.status(400).json({ error: 'Cannot follow yourself' }); return; }
  try {
    const existing = await pool.query(
      'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.userId, req.params.id]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [req.userId, req.params.id]);
      res.json({ following: false });
    } else {
      await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1,$2)', [req.userId, req.params.id]);
      res.json({ following: true });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
