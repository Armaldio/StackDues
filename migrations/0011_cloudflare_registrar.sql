-- Registrar discoveries contain renewal dates and auto-renew state only; they never enter financial totals.
CREATE TABLE cloudflare_registrations (
  domain_name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL CHECK (length(trim(domain_name)) BETWEEN 1 AND 253),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  last_seen_at TEXT NOT NULL
);

CREATE TABLE cloudflare_registrar_sync_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  status TEXT NOT NULL CHECK (status IN ('not-configured', 'synced', 'error')),
  last_attempt_at TEXT,
  last_synced_at TEXT
);
