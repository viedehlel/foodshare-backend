import { pool } from '../db/pool';

type Category = 'likes' | 'kudos' | 'comments' | 'mentions' | 'follows' | 'messages';

type PushPayload = {
  userIds: string[];
  title: string;
  body: string;
  data?: { url?: string; [k: string]: any };
  category: Category;
  channelId?: 'default' | 'messages';
};

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Envoie une push notification aux utilisateurs cibles.
 * - Filtre selon les préférences (notif_preferences)
 * - Récupère tous les push_tokens des users
 * - Envoie par chunks de 100 vers Expo Push Service
 * - Supprime les tokens "DeviceNotRegistered"
 *
 * Toujours fire-and-forget : ne throw jamais (les erreurs sont logguées).
 */
export async function sendPush(payload: PushPayload): Promise<void> {
  try {
    if (payload.userIds.length === 0) return;

    // 1. Filter by user preferences (default = enabled si pas de row)
    const allowedQuery = await pool.query(
      `SELECT u.id::text AS user_id
         FROM users u
         LEFT JOIN notif_preferences p ON p.user_id = u.id
         WHERE u.id = ANY($1::uuid[])
           AND COALESCE(p.${payload.category}, TRUE) = TRUE`,
      [payload.userIds],
    );
    const allowedIds: string[] = allowedQuery.rows.map(r => r.user_id);
    if (allowedIds.length === 0) return;

    // 2. Fetch tokens
    const tokensQuery = await pool.query(
      `SELECT token FROM push_tokens WHERE user_id = ANY($1::uuid[])`,
      [allowedIds],
    );
    const tokens: string[] = tokensQuery.rows.map(r => r.token);
    if (tokens.length === 0) return;

    // 3. Build messages
    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      channelId: payload.channelId ?? 'default',
    }));

    // 4. Send in chunks of 100 (Expo limit)
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const res = await fetch(EXPO_ENDPOINT, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(chunk),
        });
        const result = await res.json() as { data?: any[] };
        // Cleanup invalid tokens
        result.data?.forEach((r, idx) => {
          if (r?.status === 'error' && r?.details?.error === 'DeviceNotRegistered') {
            const badToken = chunk[idx].to;
            pool.query('DELETE FROM push_tokens WHERE token = $1', [badToken])
              .catch(e => console.error('[push] failed to delete invalid token', e));
          }
        });
      } catch (e) {
        console.error('[push] chunk send failed', e);
      }
    }
  } catch (e) {
    console.error('[push] sendPush failed', e);
  }
}

/** Truncate a string to N chars with ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
