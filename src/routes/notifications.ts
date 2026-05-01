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

// ─── Push tokens ──────────────────────────────────────────────────────────────

// POST /notifications/token — register or refresh a push token for current user
router.post('/token', requireAuth, async (req: AuthRequest, res: Response) => {
  const { token, platform } = req.body as { token: string; platform: string };
  if (!token || !platform) { res.status(400).json({ error: 'token_and_platform_required' }); return; }
  try {
    // Token UNIQUE : si un autre user avait ce token (rare, ex: même device), on l'écrase.
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform, last_seen_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = EXCLUDED.platform,
             last_seen_at = NOW()`,
      [req.userId, token, platform],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/token]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /notifications/token — unregister a push token (called on logout)
router.delete('/token', requireAuth, async (req: AuthRequest, res: Response) => {
  const { token } = req.body as { token: string };
  if (!token) { res.status(400).json({ error: 'token_required' }); return; }
  try {
    await pool.query(
      'DELETE FROM push_tokens WHERE user_id = $1 AND token = $2',
      [req.userId, token],
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Notification preferences ─────────────────────────────────────────────────

const DEFAULT_PREFS = {
  likes: true, kudos: true, comments: true,
  mentions: true, follows: true, messages: true,
};

// GET /notifications/settings
router.get('/settings', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT likes, kudos, comments, mentions, follows, messages
         FROM notif_preferences WHERE user_id = $1`,
      [req.userId],
    );
    const settings = rows[0] ?? DEFAULT_PREFS;
    res.json({ settings });
  } catch {
    res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /notifications/settings
router.patch('/settings', requireAuth, async (req: AuthRequest, res: Response) => {
  const allowed = ['likes', 'kudos', 'comments', 'mentions', 'follows', 'messages'] as const;
  const updates: Partial<Record<typeof allowed[number], boolean>> = {};
  for (const k of allowed) {
    if (typeof req.body?.[k] === 'boolean') updates[k] = req.body[k];
  }
  try {
    // UPSERT : insère avec defaults si pas de row, sinon merge
    const cols = Object.keys(updates);
    if (cols.length === 0) {
      const { rows } = await pool.query(
        `SELECT likes, kudos, comments, mentions, follows, messages
         FROM notif_preferences WHERE user_id = $1`,
        [req.userId],
      );
      res.json({ settings: rows[0] ?? DEFAULT_PREFS });
      return;
    }
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const insertCols = ['user_id', ...cols].join(', ');
    const insertVals = [req.userId, ...cols.map(c => updates[c as keyof typeof updates])];
    const insertPlaceholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO notif_preferences (${insertCols})
         VALUES (${insertPlaceholders})
       ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()
       RETURNING likes, kudos, comments, mentions, follows, messages`,
      insertVals,
    );
    res.json({ settings: rows[0] });
  } catch (err) {
    console.error('[notifications/settings]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
