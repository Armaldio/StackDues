-- User opt-outs survive refreshes and deletion of automatically imported rows.
CREATE TABLE hostinger_subscription_exclusions (
  external_id TEXT PRIMARY KEY NOT NULL REFERENCES hostinger_subscriptions(external_id) ON DELETE CASCADE,
  excluded_at TEXT NOT NULL
);

ALTER TABLE hostinger_subscription_links ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1));
