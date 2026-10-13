-- Revoke copied owner session cookies immediately after logout.
CREATE TABLE revoked_sessions (
  session_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX revoked_sessions_expiry ON revoked_sessions(expires_at);
