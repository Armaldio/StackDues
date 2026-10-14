-- Store Cloudflare Workers plan discovery separately from the metered usage feed.
CREATE TABLE cloudflare_fixed_subscriptions (
  external_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(external_id)) BETWEEN 1 AND 128),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  last_seen_at TEXT NOT NULL
);

CREATE TABLE cloudflare_fixed_subscription_links (
  external_id TEXT PRIMARY KEY NOT NULL REFERENCES cloudflare_fixed_subscriptions(external_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL UNIQUE REFERENCES manual_subscriptions(id) ON DELETE CASCADE,
  overrides_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides_json)),
  linked_at TEXT NOT NULL,
  automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1))
);

CREATE INDEX cloudflare_fixed_links_subscription ON cloudflare_fixed_subscription_links(subscription_id);

CREATE TABLE cloudflare_fixed_subscription_exclusions (
  external_id TEXT PRIMARY KEY NOT NULL REFERENCES cloudflare_fixed_subscriptions(external_id) ON DELETE CASCADE,
  excluded_at TEXT NOT NULL
);
