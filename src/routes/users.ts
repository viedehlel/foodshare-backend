import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';
import { sendPush } from '../lib/push';

const router = Router();

// Auto-migrate: username column + highlights table
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE`).catch(() => {});
pool.query(`
  CREATE TABLE IF NOT EXISTS highlights (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position   INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, post_id)
  )
`).catch(() => {});

// GET /users/search?q=... — search users
router.get('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  const q = (req.query.q as string ?? '').trim();
  if (!q) { res.json({ users: [] }); return; }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.username, u.avatar_url, u.bio, u.city,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id)::int AS followers_count,
              EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = u.id) AS is_following
       FROM users u
       WHERE u.id != $2
         AND (u.name ILIKE $1 OR u.email ILIKE $1 OR u.username ILIKE $1)
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
      `SELECT u.id, u.name, u.username, u.avatar_url, u.bio, u.city,
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

// GET /users/:id/stats — data for badge computation
router.get('/:id/stats', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE user_id = $1)::int AS posts_count,
         (SELECT COUNT(*) FROM kudos WHERE post_id IN (SELECT id FROM posts WHERE user_id = $1))::int AS kudos_received,
         (SELECT COUNT(*) FROM kudos WHERE post_id IN (SELECT id FROM posts WHERE user_id = $1) AND type = 'technique')::int AS kudos_technique,
         (SELECT COUNT(*) FROM kudos WHERE post_id IN (SELECT id FROM posts WHERE user_id = $1) AND type = 'exploration')::int AS kudos_exploration,
         (SELECT COUNT(*) FROM kudos WHERE post_id IN (SELECT id FROM posts WHERE user_id = $1) AND type = 'creativite')::int AS kudos_creativite,
         (SELECT COUNT(*) FROM follows WHERE following_id = $1)::int AS followers_count`,
      [req.params.id]
    );
    res.json({ stats: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /users/:id/highlights — pinned posts
router.get('/:id/highlights', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.image_url, p.caption, p.created_at
       FROM highlights h
       JOIN posts p ON p.id = h.post_id
       WHERE h.user_id = $1
       ORDER BY h.position ASC, h.created_at DESC`,
      [req.params.id]
    );
    res.json({ highlights: rows });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /users/me/highlights/:postId — toggle pin (max 6)
router.post('/me/highlights/:postId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await pool.query(
      'SELECT id FROM highlights WHERE user_id = $1 AND post_id = $2',
      [req.userId, req.params.postId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM highlights WHERE user_id = $1 AND post_id = $2', [req.userId, req.params.postId]);
      res.json({ pinned: false });
    } else {
      const { rows: count } = await pool.query('SELECT COUNT(*) FROM highlights WHERE user_id = $1', [req.userId]);
      if (parseInt(count[0].count) >= 6) {
        res.status(400).json({ error: 'max_highlights_reached' });
        return;
      }
      const { rows: pos } = await pool.query(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM highlights WHERE user_id = $1',
        [req.userId]
      );
      await pool.query(
        'INSERT INTO highlights (user_id, post_id, position) VALUES ($1, $2, $3)',
        [req.userId, req.params.postId, pos[0].next]
      );
      res.json({ pinned: true });
    }
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
      pool.query(
        `INSERT INTO notifications (user_id, actor_id, type)
         VALUES ($1, $2, 'follow')`,
        [req.params.id, req.userId]
      ).catch(() => {});
      (async () => {
        try {
          const { rows } = await pool.query('SELECT name FROM users WHERE id = $1', [req.userId]);
          if (rows[0]) {
            sendPush({
              userIds: [String(req.params.id)],
              title: rows[0].name,
              body: 'a commencé à te suivre',
              category: 'follows',
              data: { url: `foodshare://user/${req.userId}` },
            });
          }
        } catch {}
      })();
      res.json({ following: true });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
