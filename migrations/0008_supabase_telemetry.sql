-- Supabase request counters are telemetry, separate from financial observations.
CREATE TABLE provider_credentials_next (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('aws', 'cloudflare', 'hostinger', 'openai', 'digitalocean', 'supabase')),
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

CREATE TABLE supabase_usage_observations (
  id TEXT PRIMARY KEY NOT NULL,
  organization_slug TEXT NOT NULL CHECK (length(organization_slug) BETWEEN 1 AND 128),
  project_ref TEXT NOT NULL CHECK (length(project_ref) = 20),
  project_name TEXT NOT NULL CHECK (length(project_name) BETWEEN 1 AND 256),
  interval TEXT NOT NULL CHECK (interval IN ('1day')),
  observed_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  auth_requests INTEGER NOT NULL CHECK (auth_requests >= 0),
  realtime_requests INTEGER NOT NULL CHECK (realtime_requests >= 0),
  rest_requests INTEGER NOT NULL CHECK (rest_requests >= 0),
  storage_requests INTEGER NOT NULL CHECK (storage_requests >= 0)
);
CREATE INDEX supabase_usage_capture ON supabase_usage_observations(organization_slug, captured_at);
CREATE TRIGGER supabase_usage_update BEFORE UPDATE ON supabase_usage_observations
BEGIN SELECT RAISE(ABORT, 'immutable_supabase_observation'); END;
CREATE TRIGGER supabase_usage_delete BEFORE DELETE ON supabase_usage_observations
BEGIN SELECT RAISE(ABORT, 'immutable_supabase_observation'); END;

CREATE TABLE supabase_usage_captures (
  organization_slug TEXT NOT NULL CHECK (length(organization_slug) BETWEEN 1 AND 128),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (organization_slug, captured_at)
);
CREATE TRIGGER supabase_capture_update BEFORE UPDATE ON supabase_usage_captures
BEGIN SELECT RAISE(ABORT, 'immutable_supabase_capture'); END;
CREATE TRIGGER supabase_capture_delete BEFORE DELETE ON supabase_usage_captures
BEGIN SELECT RAISE(ABORT, 'immutable_supabase_capture'); END;
