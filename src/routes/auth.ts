import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { rateLimit } from '../middleware/rateLimit';
import { sendVerificationEmail, sendResetEmail } from '../lib/mail';
import { AuthRequest } from '../types';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VERIFY_TTL_MIN = parseInt(process.env.VERIFY_CODE_TTL_MIN ?? '15', 10);
const RESET_TTL_MIN = parseInt(process.env.RESET_CODE_TTL_MIN ?? '15', 10);
const MAX_ATTEMPTS = 5;

function makeToken(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '30d' });
}

function makeResetToken(userId: string) {
  return jwt.sign(
    { userId, scope: 'pwd_reset' },
    process.env.JWT_SECRET!,
    { expiresIn: '5m' },
  );
}

function generateCode(): string {
  // 6 digits, zero-padded, cryptographically random
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

const sendMailLimiter = rateLimit({ windowMs: 15 * 60_000, max: 5, scope: 'auth_mail' });

// ─── Register: insert pending row, send code ──────────────────────────────────

router.post('/register', sendMailLimiter, async (req: Request, res: Response) => {
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  if (!name?.trim() || !email?.trim() || !password) {
    res.status(400).json({ error: 'name, email and password are required' });
    return;
  }
  if (!EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'password_too_short' });
    return;
  }
  const cleanEmail = email.trim();
  const cleanName = name.trim();
  try {
    // Block if email already exists in users
    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [cleanEmail],
    );
    if (existing.length > 0) {
      res.status(409).json({ error: 'email_taken' });
      return;
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 8);
    const passwordHash = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MIN * 60_000);

    // Replace any stale pending row from a previous attempt (functional unique
    // index on LOWER(email) makes ON CONFLICT awkward — clearer to delete + insert).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM pending_registrations WHERE LOWER(email) = LOWER($1)',
        [cleanEmail],
      );
      await client.query(
        `INSERT INTO pending_registrations (email, name, password_hash, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [cleanEmail, cleanName, passwordHash, codeHash, expiresAt],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await sendVerificationEmail(cleanEmail, cleanName, code);
    res.json({ ok: true, email: cleanEmail });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Verify email: consume pending row, create user, return token ─────────────

router.post('/verify-email', async (req: Request, res: Response) => {
  const { email, code } = req.body as { email: string; code: string };
  if (!email || !code) {
    res.status(400).json({ error: 'email_and_code_required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, password_hash, code_hash, expires_at, attempts
         FROM pending_registrations WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    const pending = rows[0];
    if (!pending) {
      res.status(404).json({ error: 'expired_or_not_found' });
      return;
    }
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending.id]);
      res.status(404).json({ error: 'expired_or_not_found' });
      return;
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      await pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending.id]);
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    const valid = await bcrypt.compare(code, pending.code_hash);
    if (!valid) {
      await pool.query(
        'UPDATE pending_registrations SET attempts = attempts + 1 WHERE id = $1',
        [pending.id],
      );
      res.status(400).json({
        error: 'invalid_code',
        attemptsLeft: Math.max(0, MAX_ATTEMPTS - 1 - pending.attempts),
      });
      return;
    }

    // Create user, drop pending row
    const { rows: created } = await pool.query(
      `INSERT INTO users (name, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, avatar_url, bio, city`,
      [pending.name, pending.email, pending.password_hash],
    );
    await pool.query('DELETE FROM pending_registrations WHERE id = $1', [pending.id]);

    res.json({ token: makeToken(created[0].id), user: created[0] });
  } catch (err: any) {
    if (err.code === '23505') {
      // Race: someone else just registered with this email
      res.status(409).json({ error: 'email_taken' });
      return;
    }
    console.error('[auth/verify-email]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Resend verification code ─────────────────────────────────────────────────

router.post('/resend-verification', sendMailLimiter, async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  if (!email) { res.status(400).json({ error: 'email_required' }); return; }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name FROM pending_registrations WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    const pending = rows[0];
    if (!pending) {
      // Anti-énumération : on n'indique pas que l'email n'est pas en pending
      res.json({ ok: true });
      return;
    }
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MIN * 60_000);
    await pool.query(
      `UPDATE pending_registrations
       SET code_hash = $1, expires_at = $2, attempts = 0
       WHERE id = $3`,
      [codeHash, expiresAt, pending.id],
    );
    await sendVerificationEmail(pending.email, pending.name, code);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/resend-verification]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Forgot password: always 200, send code if user exists ────────────────────

router.post('/forgot-password', sendMailLimiter, async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  if (!email) { res.status(400).json({ error: 'email_required' }); return; }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    const user = rows[0];
    if (!user) {
      // Anti-énumération : succès silencieux
      res.json({ ok: true });
      return;
    }
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60_000);
    // Invalider les codes actifs précédents
    await pool.query(
      `UPDATE password_resets SET consumed_at = NOW()
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, codeHash, expiresAt],
    );
    await sendResetEmail(user.email, user.name, code);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/forgot-password]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Verify reset code: return short-lived reset_token ────────────────────────

router.post('/verify-reset-code', async (req: Request, res: Response) => {
  const { email, code } = req.body as { email: string; code: string };
  if (!email || !code) {
    res.status(400).json({ error: 'email_and_code_required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id, pr.code_hash, pr.expires_at, pr.attempts
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
         WHERE LOWER(u.email) = LOWER($1)
           AND pr.consumed_at IS NULL
         ORDER BY pr.created_at DESC
         LIMIT 1`,
      [email],
    );
    const reset = rows[0];
    if (!reset) {
      res.status(404).json({ error: 'expired_or_not_found' });
      return;
    }
    if (new Date(reset.expires_at).getTime() < Date.now()) {
      await pool.query(
        'UPDATE password_resets SET consumed_at = NOW() WHERE id = $1',
        [reset.id],
      );
      res.status(404).json({ error: 'expired_or_not_found' });
      return;
    }
    if (reset.attempts >= MAX_ATTEMPTS) {
      await pool.query(
        'UPDATE password_resets SET consumed_at = NOW() WHERE id = $1',
        [reset.id],
      );
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    const valid = await bcrypt.compare(code, reset.code_hash);
    if (!valid) {
      await pool.query(
        'UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1',
        [reset.id],
      );
      res.status(400).json({
        error: 'invalid_code',
        attemptsLeft: Math.max(0, MAX_ATTEMPTS - 1 - reset.attempts),
      });
      return;
    }
    res.json({ reset_token: makeResetToken(reset.user_id) });
  } catch (err) {
    console.error('[auth/verify-reset-code]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Reset password: consume token, update password ───────────────────────────

router.post('/reset-password', async (req: Request, res: Response) => {
  const { reset_token, new_password } = req.body as { reset_token: string; new_password: string };
  if (!reset_token || !new_password) {
    res.status(400).json({ error: 'token_and_password_required' });
    return;
  }
  if (new_password.length < 6) {
    res.status(400).json({ error: 'password_too_short' });
    return;
  }
  try {
    let payload: { userId: string; scope: string };
    try {
      payload = jwt.verify(reset_token, process.env.JWT_SECRET!) as any;
    } catch {
      res.status(401).json({ error: 'invalid_or_expired_token' });
      return;
    }
    if (payload.scope !== 'pwd_reset') {
      res.status(401).json({ error: 'invalid_token_scope' });
      return;
    }
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, payload.userId]);
    await pool.query(
      `UPDATE password_resets SET consumed_at = NOW()
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [payload.userId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/reset-password]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── Login (unchanged) ────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, password, avatar_url, bio, city FROM users WHERE email = $1',
      [email],
    );
    if (!rows[0]) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const { password: _, ...user } = rows[0];
    res.json({ token: makeToken(user.id), user });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Me ───────────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, avatar_url, bio, city FROM users WHERE id = $1',
      [req.userId],
    );
    if (!rows[0]) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Profile updates / avatar / change-password (unchanged) ───────────────────

router.patch('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, bio, city, avatar_url } = req.body as Partial<{ name: string; bio: string; city: string; avatar_url: string }>;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET
        name       = COALESCE($1, name),
        bio        = COALESCE($2, bio),
        city       = COALESCE($3, city),
        avatar_url = COALESCE($4, avatar_url)
       WHERE id = $5
       RETURNING id, name, email, avatar_url, bio, city`,
      [name, bio, city, avatar_url, req.userId],
    );
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/avatar', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response) => {
  const file = req.file as any;
  if (!file?.path) { res.status(400).json({ error: 'image required' }); return; }
  try {
    const { rows } = await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, name, email, avatar_url, bio, city',
      [file.path, req.userId],
    );
    res.json({ user: rows[0] });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  const { current, next } = req.body as { current: string; next: string };
  if (!current || !next) {
    res.status(400).json({ error: 'current and next passwords are required' });
    return;
  }
  if (next.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  try {
    const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [req.userId]);
    const valid = await bcrypt.compare(current, rows[0].password);
    if (!valid) { res.status(401).json({ error: 'wrong_password' }); return; }
    const hash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.userId]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
