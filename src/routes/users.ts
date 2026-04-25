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

// GET /users/:id/followers
router.get('/:id/followers', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.avatar_url, u.bio, u.city,
              EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) AS is_following
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = $1
       ORDER BY u.name`,
      [req.params.id, req.userId]
    );
    res.json({ users: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /users/:id/following
router.get('/:id/following', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.avatar_url, u.bio, u.city,
              EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) AS is_following
       FROM follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = $1
       ORDER BY u.name`,
      [req.params.id, req.userId]
    );
    res.json({ users: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /users/:id/places — top restaurants visited by user
router.get('/:id/places', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT place_id, place_name, place_address, COUNT(*)::int AS post_count
       FROM posts
       WHERE user_id = $1 AND place_id IS NOT NULL
       GROUP BY place_id, place_name, place_address
       ORDER BY post_count DESC`,
      [req.params.id]
    );
    res.json({ places: rows });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /users/:id/places/:placeId/posts — user's posts at a specific restaurant
router.get('/:id/places/:placeId/posts', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.image_url, p.caption, p.location, p.created_at,
         p.place_id, p.place_name, p.place_address,
         u.id AS user_id, u.name AS user_name, u.avatar_url,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
         (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS like_count,
         EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $3) AS liked_by_me,
         (SELECT COALESCE(json_agg(json_build_object('type', k.type, 'icon', k.icon, 'count', k.cnt)), '[]')
          FROM (SELECT type, icon, COUNT(*)::int AS cnt FROM kudos WHERE post_id = p.id GROUP BY type, icon) k
         ) AS kudos
       FROM posts p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1 AND p.place_id = $2
       ORDER BY p.created_at DESC`,
      [req.params.id, req.params.placeId, req.userId]
    );
    res.json({ posts: rows });
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
