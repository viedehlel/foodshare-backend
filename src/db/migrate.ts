import { pool } from './pool';

// Idempotent migrations exécutées au démarrage du serveur.
// Toutes les commandes utilisent IF NOT EXISTS, donc safe à chaque boot.
const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS pending_registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_registrations_email_idx
  ON pending_registrations (LOWER(email));

CREATE TABLE IF NOT EXISTS password_resets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_resets_user_active_idx
  ON password_resets (user_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS push_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_tokens_user_idx ON push_tokens (user_id);

CREATE TABLE IF NOT EXISTS notif_preferences (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  likes         BOOLEAN NOT NULL DEFAULT TRUE,
  kudos         BOOLEAN NOT NULL DEFAULT TRUE,
  comments      BOOLEAN NOT NULL DEFAULT TRUE,
  mentions      BOOLEAN NOT NULL DEFAULT TRUE,
  follows       BOOLEAN NOT NULL DEFAULT TRUE,
  messages      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function runMigrations() {
  try {
    await pool.query(MIGRATIONS);
    console.log('[migrate] auth migrations applied');
  } catch (err) {
    console.error('[migrate] failed', err);
    throw err;
  }
}
