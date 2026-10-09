-- Add DigitalOcean billing while preserving encrypted credentials and immutable history.
CREATE TABLE provider_credentials_next (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('aws', 'cloudflare', 'hostinger', 'openai', 'digitalocean')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  iv TEXT,
  ciphertext TEXT,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  CHECK ((iv IS NULL AND ciphertext IS NULL) OR (
    iv IS NOT NULL AND ciphertext IS NOT NULL
    AND length(iv) = 24 AND iv NOT GLOB '*[^0-9a-f]*'
    AND length(ciphertext) BETWEEN 32 AND 16384 AND length(ciphertext) % 2 = 0
    AND ciphertext NOT GLOB '*[^0-9a-f]*'
  ))
);
INSERT INTO provider_credentials_next SELECT * FROM provider_credentials;
DROP TABLE provider_credentials;
ALTER TABLE provider_credentials_next RENAME TO provider_credentials;

DROP TRIGGER observations_duplicate;
DROP TRIGGER observations_update;
DROP TRIGGER observations_delete;
DROP INDEX cost_observations_capture;
CREATE TABLE cost_observations_next (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('aws', 'cloudflare', 'openai', 'digitalocean')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL CHECK (period_end > period_start),
  amount REAL NOT NULL CHECK (amount BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  kind TEXT NOT NULL CHECK (kind IN ('actual', 'forecast')),
  captured_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);
INSERT INTO cost_observations_next SELECT * FROM cost_observations;
DROP TABLE cost_observations;
ALTER TABLE cost_observations_next RENAME TO cost_observations;
CREATE INDEX cost_observations_capture ON cost_observations(provider, captured_at);
CREATE TRIGGER observations_duplicate BEFORE INSERT ON cost_observations WHEN EXISTS (
  SELECT 1 FROM cost_observations WHERE id = NEW.id AND (
    provider != NEW.provider OR period_start != NEW.period_start OR period_end != NEW.period_end
    OR amount != NEW.amount OR currency != NEW.currency OR kind != NEW.kind
    OR captured_at != NEW.captured_at OR metadata_json != NEW.metadata_json
  )
) BEGIN SELECT RAISE(ABORT, 'immutable_observation_conflict'); END;
CREATE TRIGGER observations_update BEFORE UPDATE ON cost_observations
BEGIN SELECT RAISE(ABORT, 'immutable_observation_conflict'); END;
CREATE TRIGGER observations_delete BEFORE DELETE ON cost_observations
BEGIN SELECT RAISE(ABORT, 'immutable_observation_conflict'); END;

CREATE TABLE provider_sync_status_next (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('aws', 'cloudflare', 'openai', 'digitalocean')),
  status TEXT NOT NULL CHECK (status IN ('not-configured', 'synced', 'error')),
  last_attempt_at TEXT,
  last_synced_at TEXT
);
INSERT INTO provider_sync_status_next SELECT * FROM provider_sync_status;
DROP TABLE provider_sync_status;
ALTER TABLE provider_sync_status_next RENAME TO provider_sync_status;
