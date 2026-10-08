-- One personal owner, created once through the setup-code protected form.
CREATE TABLE owner_credentials (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
