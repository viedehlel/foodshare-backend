import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';
import { sendPush, truncate } from '../lib/push';

const router = Router({ mergeParams: true });

// GET /posts/:postId/comments
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows: comments } = await pool.query(
      `SELECT c.id, c.text, c.created_at,
              u.id AS user_id, u.name AS user_name, u.avatar_url,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id)::int AS likes,
              EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = $2) AS liked_by_me
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $1
       ORDER BY c.created_at ASC`,
      [req.params.postId, req.userId]
    );

    const commentIds = comments.map(c => c.id);
    let replies: any[] = [];
    if (commentIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT r.id, r.comment_id, r.text, r.created_at,
                u.id AS user_id, u.name AS user_name, u.avatar_url,
                (SELECT COUNT(*) FROM reply_likes rl WHERE rl.reply_id = r.id)::int AS likes,
                EXISTS(SELECT 1 FROM reply_likes rl WHERE rl.reply_id = r.id AND rl.user_id = $2) AS liked_by_me
         FROM replies r
         JOIN users u ON u.id = r.user_id
         WHERE r.comment_id = ANY($1::uuid[])
         ORDER BY r.created_at ASC`,
        [commentIds, req.userId]
      );
      replies = rows;
    }

    const repliesByComment = replies.reduce<Record<string, any[]>>((acc, r) => {
      (acc[r.comment_id] = acc[r.comment_id] ?? []).push(r);
      return acc;
    }, {});

    res.json({ comments: comments.map(c => ({ ...c, replies: repliesByComment[c.id] ?? [] })) });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /posts/:postId/comments
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { text } = req.body as { text: string };
  if (!text?.trim()) { res.status(400).json({ error: 'text is required' }); return; }
  try {
    const { rows } = await pool.query(
      `INSERT INTO comments (post_id, user_id, text) VALUES ($1,$2,$3)
       RETURNING id, text, created_at`,
      [req.params.postId, req.userId, text.trim()]
    );
    pool.query(
      `INSERT INTO notifications (user_id, actor_id, type, post_id)
       SELECT p.user_id, $2, 'comment', $1 FROM posts p
       WHERE p.id = $1 AND p.user_id != $2`,
      [req.params.postId, req.userId]
    ).catch(() => {});
    (async () => {
      try {
        const { rows: pushRows } = await pool.query(
          `SELECT p.user_id::text AS author_id, u.name AS actor_name
             FROM posts p, users u
             WHERE p.id = $1 AND u.id = $2 AND p.user_id != $2`,
          [req.params.postId, req.userId],
        );
        if (pushRows[0]) {
          sendPush({
            userIds: [pushRows[0].author_id],
            title: pushRows[0].actor_name,
            body: truncate(text.trim(), 100),
            category: 'comments',
            data: { url: `foodshare://post/${req.params.postId}` },
          });
        }
      } catch {}
    })();
    res.status(201).json({ comment: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /posts/:postId/comments/:commentId/replies
router.post('/:commentId/replies', requireAuth, async (req: AuthRequest, res: Response) => {
  const { text } = req.body as { text: string };
  if (!text?.trim()) { res.status(400).json({ error: 'text is required' }); return; }
  try {
    const { rows } = await pool.query(
      `INSERT INTO replies (comment_id, user_id, text) VALUES ($1,$2,$3)
       RETURNING id, text, created_at`,
      [req.params.commentId, req.userId, text.trim()]
    );
    res.status(201).json({ reply: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /posts/:postId/comments/:commentId/like
router.post('/:commentId/like', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await pool.query(
      'SELECT 1 FROM comment_likes WHERE comment_id = $1 AND user_id = $2',
      [req.params.commentId, req.userId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2', [req.params.commentId, req.userId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO comment_likes (comment_id, user_id) VALUES ($1,$2)', [req.params.commentId, req.userId]);
      res.json({ liked: true });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /posts/:postId/comments/:commentId/replies/:replyId/like
router.post('/:commentId/replies/:replyId/like', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await pool.query(
      'SELECT 1 FROM reply_likes WHERE reply_id = $1 AND user_id = $2',
      [req.params.replyId, req.userId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM reply_likes WHERE reply_id = $1 AND user_id = $2', [req.params.replyId, req.userId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO reply_likes (reply_id, user_id) VALUES ($1,$2)', [req.params.replyId, req.userId]);
      res.json({ liked: true });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
