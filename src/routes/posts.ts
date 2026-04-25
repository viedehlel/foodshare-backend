import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { AuthRequest } from '../types';

const router = Router();

// Auto-migrate: post_likes table
pool.query(`
  CREATE TABLE IF NOT EXISTS post_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(post_id, user_id)
  )
`).catch(() => {});

// Auto-migrate: place columns on posts
pool.query(`
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS place_id TEXT;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS place_name TEXT;
  ALTER TABLE posts ADD COLUMN IF NOT EXISTS place_address TEXT;
`).catch(() => {});

// GET /posts — feed (posts of people you follow + your own)
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.image_url, p.caption, p.location, p.created_at,
         p.recipe_id, p.place_id, p.place_name, p.place_address,
         r.title AS recipe_title,
         u.id AS user_id, u.name AS user_name, u.avatar_url,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
         (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int AS like_count,
         EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1) AS liked_by_me,
         (SELECT COALESCE(json_agg(json_build_object('type', k.type, 'icon', k.icon, 'count', k.cnt)), '[]')
          FROM (SELECT type, icon, COUNT(*)::int AS cnt FROM kudos WHERE post_id = p.id GROUP BY type, icon) k
         ) AS kudos
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN recipes r ON r.id = p.recipe_id
       WHERE p.user_id = $1
          OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
       ORDER BY p.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ posts: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /posts — create a post with image upload
router.post('/', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response) => {
  const file = req.file as any;
  if (!file) { res.status(400).json({ error: 'image is required' }); return; }
  const { caption, location, recipe_id, place_id, place_name, place_address } = req.body as {
    caption: string; location?: string; recipe_id?: string;
    place_id?: string; place_name?: string; place_address?: string;
  };
  if (!caption) { res.status(400).json({ error: 'caption is required' }); return; }
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (user_id, image_url, caption, location, recipe_id, place_id, place_name, place_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, image_url, caption, location, recipe_id, place_id, place_name, place_address, created_at`,
      [req.userId, file.path, caption, location ?? null, recipe_id ?? null,
       place_id ?? null, place_name ?? null, place_address ?? null]
    );
    res.status(201).json({ post: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /posts/:id — single post detail
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id, p.image_url, p.caption, p.location, p.created_at,
         p.recipe_id, p.place_id, p.place_name, p.place_address,
         r.title AS recipe_title,
         u.id AS user_id, u.name AS user_name, u.avatar_url,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
         (SELECT COALESCE(json_agg(json_build_object('type', k.type, 'icon', k.icon, 'count', k.cnt)), '[]')
          FROM (SELECT type, icon, COUNT(*)::int AS cnt FROM kudos WHERE post_id = p.id GROUP BY type, icon) k
         ) AS kudos
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN recipes r ON r.id = p.recipe_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Post not found' }); return; }
    res.json({ post: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /posts/:id/like — toggle like
router.post('/:id/like', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await pool.query(
      'SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [req.params.id, req.userId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)', [req.params.id, req.userId]);
      pool.query(
        `INSERT INTO notifications (user_id, actor_id, type, post_id)
         SELECT p.user_id, $2, 'like', $1 FROM posts p
         WHERE p.id = $1 AND p.user_id != $2`,
        [req.params.id, req.userId]
      ).catch(() => {});
      res.json({ liked: true });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /posts/:id
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Post not found or unauthorized' }); return; }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
