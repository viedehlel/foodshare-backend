import { Router, Response } from 'express';
import multer from 'multer';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { cloudinary, upload } from '../middleware/upload';
import { AuthRequest } from '../types';

// ─── Auto-migration ───────────────────────────────────────────────────────────

pool.query(`
  CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL DEFAULT 'direct',
    name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_read_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    voice_url TEXT,
    voice_duration_sec INTEGER,
    recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL,
    poll_data JSONB,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS message_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    from_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    to_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(() => {});

// ─── Factory: accepts io instance so routes can emit events ───────────────────

export function createMessagesRouter(emitToUser: (userId: string, event: string, data: unknown) => void) {
  const router = Router();

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function fetchConversation(convId: string, userId: string) {
    const { rows } = await pool.query(
      `SELECT
        c.id, c.type, c.name,
        cm.last_read_at,
        (
          SELECT COUNT(*)::int FROM messages m2
          WHERE m2.conversation_id = c.id
            AND m2.deleted_at IS NULL
            AND m2.sender_id != $2
            AND m2.created_at > cm.last_read_at
        ) AS unread,
        (
          SELECT row_to_json(lm) FROM (
            SELECT m.id, m.type, m.content, m.sender_id,
                   EXTRACT(EPOCH FROM m.created_at)::bigint * 1000 AS created_at
            FROM messages m
            WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC LIMIT 1
          ) lm
        ) AS last_message,
        (
          SELECT json_agg(
            json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar_url)
          )
          FROM conversation_members cm2
          JOIN users u ON u.id = cm2.user_id
          WHERE cm2.conversation_id = c.id
        ) AS members
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
      WHERE c.id = $1`,
      [convId, userId]
    );
    return rows[0] ?? null;
  }

  // ─── GET /conversations ────────────────────────────────────────────────────

  router.get('/conversations', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT
          c.id, c.type, c.name,
          cm.last_read_at,
          (
            SELECT COUNT(*)::int FROM messages m2
            WHERE m2.conversation_id = c.id
              AND m2.deleted_at IS NULL
              AND m2.sender_id != $1
              AND m2.created_at > cm.last_read_at
          ) AS unread,
          (
            SELECT row_to_json(lm) FROM (
              SELECT m.id, m.type, m.content, m.sender_id,
                     EXTRACT(EPOCH FROM m.created_at)::bigint * 1000 AS created_at
              FROM messages m
              WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
              ORDER BY m.created_at DESC LIMIT 1
            ) lm
          ) AS last_message,
          (
            SELECT json_agg(
              json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar_url)
            )
            FROM conversation_members cm2
            JOIN users u ON u.id = cm2.user_id
            WHERE cm2.conversation_id = c.id
          ) AS members
        FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
        ORDER BY (
          SELECT created_at FROM messages
          WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
        ) DESC NULLS LAST`,
        [req.userId]
      );
      res.json({ conversations: rows });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── POST /conversations ────────────────────────────────────────────────────

  router.post('/conversations', requireAuth, async (req: AuthRequest, res: Response) => {
    const { userIds, type = 'direct', name } = req.body as {
      userIds: string[];
      type?: string;
      name?: string;
    };
    if (!userIds?.length) {
      res.status(400).json({ error: 'userIds required' });
      return;
    }

    try {
      // For direct conversations, check if one already exists
      if (type === 'direct' && userIds.length === 1) {
        const { rows: existing } = await pool.query(
          `SELECT c.id FROM conversations c
           JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
           JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
           WHERE c.type = 'direct'
           LIMIT 1`,
          [req.userId, userIds[0]]
        );
        if (existing.length > 0) {
          const conv = await fetchConversation(existing[0].id, req.userId!);
          res.json({ conversation: conv });
          return;
        }
      }

      const { rows: [conv] } = await pool.query(
        `INSERT INTO conversations (type, name) VALUES ($1, $2) RETURNING id`,
        [type, name ?? null]
      );
      const allMembers = [req.userId!, ...userIds];
      for (const uid of allMembers) {
        await pool.query(
          `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [conv.id, uid]
        );
      }
      const full = await fetchConversation(conv.id, req.userId!);
      res.json({ conversation: full });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── GET /conversations/:id/messages ──────────────────────────────────────

  router.get('/conversations/:id/messages', requireAuth, async (req: AuthRequest, res: Response) => {
    const { before } = req.query as { before?: string };
    try {
      // Verify membership
      const { rows: member } = await pool.query(
        `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [req.params.id, req.userId]
      );
      if (!member.length) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const { rows } = await pool.query(
        `SELECT
          m.id, m.type, m.content, m.voice_url, m.voice_duration_sec,
          m.recipe_id, m.poll_data,
          EXTRACT(EPOCH FROM m.created_at)::bigint * 1000 AS created_at,
          json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar_url) AS sender,
          COALESCE(
            (SELECT json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id))
             FROM message_reactions r WHERE r.message_id = m.id),
            '[]'::json
          ) AS reactions
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
          AND m.deleted_at IS NULL
          ${before ? `AND m.created_at < $3::timestamptz` : ''}
        ORDER BY m.created_at DESC
        LIMIT 50`,
        before ? [req.params.id, req.userId, new Date(parseInt(before)).toISOString()] : [req.params.id, req.userId]
      );
      res.json({ messages: rows.reverse() });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── PATCH /conversations/:id/read ────────────────────────────────────────

  router.patch('/conversations/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      await pool.query(
        `UPDATE conversation_members SET last_read_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2`,
        [req.params.id, req.userId]
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── POST /conversations/:id/messages ──────────────────────────────────────

  router.post('/conversations/:id/messages', requireAuth, async (req: AuthRequest, res: Response) => {
    const { type = 'text', content, voice_url, voice_duration_sec, recipe_id, poll_data } = req.body;
    try {
      // Verify membership
      const { rows: member } = await pool.query(
        `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [req.params.id, req.userId]
      );
      if (!member.length) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const { rows: [msg] } = await pool.query(
        `INSERT INTO messages
           (conversation_id, sender_id, type, content, voice_url, voice_duration_sec, recipe_id, poll_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, type, content, voice_url, voice_duration_sec, recipe_id, poll_data,
                   EXTRACT(EPOCH FROM created_at)::bigint * 1000 AS created_at`,
        [req.params.id, req.userId, type, content ?? null, voice_url ?? null,
         voice_duration_sec ?? null, recipe_id ?? null,
         poll_data ? JSON.stringify(poll_data) : null]
      );

      // Attach sender info
      const { rows: [sender] } = await pool.query(
        `SELECT id, name, avatar_url AS avatar FROM users WHERE id = $1`,
        [req.userId]
      );

      const message = { ...msg, sender, reactions: [], conversationId: req.params.id };

      // Emit to all conversation members who are online
      const { rows: members } = await pool.query(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
        [req.params.id]
      );
      members.forEach(m => emitToUser(m.user_id, 'new_message', message));

      res.json({ message });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── DELETE /messages/:id ──────────────────────────────────────────────────

  router.delete('/messages/:id', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      await pool.query(
        `UPDATE messages SET deleted_at = NOW() WHERE id = $1 AND sender_id = $2`,
        [req.params.id, req.userId]
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── POST /messages/:id/reactions ─────────────────────────────────────────

  router.post('/messages/:id/reactions', requireAuth, async (req: AuthRequest, res: Response) => {
    const { emoji } = req.body;
    try {
      // Toggle: if already reacted with same emoji, remove
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [req.params.id, req.userId, emoji]
      );
      if (existing.length) {
        await pool.query(
          `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2`,
          [req.params.id, req.userId]
        );
      } else {
        await pool.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = $3`,
          [req.params.id, req.userId, emoji]
        );
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── POST /messages/:id/vote ───────────────────────────────────────────────

  router.post('/messages/:id/vote', requireAuth, async (req: AuthRequest, res: Response) => {
    const { optionIndex } = req.body as { optionIndex: number };
    try {
      const { rows: [msg] } = await pool.query(
        `SELECT poll_data FROM messages WHERE id = $1`,
        [req.params.id]
      );
      if (!msg?.poll_data) {
        res.status(400).json({ error: 'Not a poll' });
        return;
      }
      const poll = msg.poll_data;
      // Remove previous vote if any
      if (poll.myVote !== undefined && poll.myVote !== optionIndex) {
        poll.options[poll.myVote].votes = Math.max(0, poll.options[poll.myVote].votes - 1);
        poll.total = Math.max(0, poll.total - 1);
      }
      if (poll.myVote !== optionIndex) {
        poll.options[optionIndex].votes += 1;
        poll.total += 1;
        poll.myVote = optionIndex;
      } else {
        // Un-vote
        poll.options[optionIndex].votes = Math.max(0, poll.options[optionIndex].votes - 1);
        poll.total = Math.max(0, poll.total - 1);
        delete poll.myVote;
      }
      await pool.query(
        `UPDATE messages SET poll_data = $1 WHERE id = $2`,
        [JSON.stringify(poll), req.params.id]
      );
      res.json({ poll });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── GET /message-requests ─────────────────────────────────────────────────

  router.get('/message-requests', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT mr.id, mr.status,
                EXTRACT(EPOCH FROM mr.created_at)::bigint * 1000 AS created_at,
                json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar_url) AS from_user,
                (SELECT content FROM messages WHERE conversation_id = mr.conversation_id
                 ORDER BY created_at ASC LIMIT 1) AS preview
         FROM message_requests mr
         JOIN users u ON u.id = mr.from_user_id
         WHERE mr.to_user_id = $1 AND mr.status = 'pending'
         ORDER BY mr.created_at DESC`,
        [req.userId]
      );
      res.json({ requests: rows });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── POST /message-requests ─────────────────────────────────────────────────

  router.post('/message-requests', requireAuth, async (req: AuthRequest, res: Response) => {
    const { toUserId } = req.body;
    try {
      // Create a conversation + pending request
      const { rows: [conv] } = await pool.query(
        `INSERT INTO conversations (type) VALUES ('direct') RETURNING id`
      );
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)
         ON CONFLICT DO NOTHING`,
        [conv.id, req.userId, toUserId]
      );
      const { rows: [reqRow] } = await pool.query(
        `INSERT INTO message_requests (conversation_id, from_user_id, to_user_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [conv.id, req.userId, toUserId]
      );
      res.json({ request: reqRow, conversationId: conv.id });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── PATCH /message-requests/:id/accept ───────────────────────────────────

  router.patch('/message-requests/:id/accept', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { rows: [reqRow] } = await pool.query(
        `UPDATE message_requests SET status = 'accepted'
         WHERE id = $1 AND to_user_id = $2
         RETURNING conversation_id`,
        [req.params.id, req.userId]
      );
      if (!reqRow) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ ok: true, conversationId: reqRow.conversation_id });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── PATCH /message-requests/:id/refuse ───────────────────────────────────

  router.patch('/message-requests/:id/refuse', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      await pool.query(
        `UPDATE message_requests SET status = 'refused'
         WHERE id = $1 AND to_user_id = $2`,
        [req.params.id, req.userId]
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ─── POST /upload/image ────────────────────────────────────────────────────

  router.post('/upload/image', requireAuth, upload.single('image'), (req: AuthRequest, res: Response) => {
    if (!req.file) { res.status(400).json({ error: 'No file' }); return; }
    res.json({ url: (req.file as any).path });
  });

  // ─── POST /upload/voice ────────────────────────────────────────────────────
  // Mounted at /messages/upload/voice from index.ts

  const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  router.post('/upload/voice', requireAuth, memoryUpload.single('audio'), async (req: AuthRequest, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file' });
      return;
    }
    try {
      const b64 = req.file.buffer.toString('base64');
      const dataUri = `data:${req.file.mimetype};base64,${b64}`;
      const result = await cloudinary.uploader.upload(dataUri, {
        resource_type: 'video',
        folder: 'messages/voice',
      });
      res.json({ url: result.secure_url, duration: Math.ceil((result as any).duration ?? 0) });
    } catch {
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  return router;
}
