-- The Haneoka app's sign-in handoff: one-time codes bound to a PKCE challenge.
CREATE TABLE IF NOT EXISTS app_auth_code (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_auth_code_expires_idx ON app_auth_code(expires_at);
