-- Provider discovery is stored separately; only explicit links enter the fixed ledger.
CREATE TABLE hostinger_subscriptions (
  external_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(external_id)) BETWEEN 1 AND 128),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  last_seen_at TEXT NOT NULL
);

CREATE TABLE hostinger_sync_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  status TEXT NOT NULL CHECK (status IN ('not-configured', 'synced', 'error')),
  last_attempt_at TEXT,
  last_synced_at TEXT
);

CREATE TABLE hostinger_subscription_links (
  external_id TEXT PRIMARY KEY NOT NULL REFERENCES hostinger_subscriptions(external_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL UNIQUE REFERENCES manual_subscriptions(id) ON DELETE CASCADE,
  overrides_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides_json)),
  linked_at TEXT NOT NULL
);

CREATE INDEX hostinger_links_subscription ON hostinger_subscription_links(subscription_id);
