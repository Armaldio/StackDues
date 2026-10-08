-- Fixed commitments and metered observations remain independent records.
CREATE TABLE manual_subscriptions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 256),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 256),
  provider TEXT CHECK (provider IS NULL OR length(trim(provider)) BETWEEN 1 AND 256),
  amount REAL NOT NULL CHECK (amount BETWEEN 0 AND 1.7976931348623157e308),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  recurrence_interval INTEGER NOT NULL CHECK (recurrence_interval BETWEEN 1 AND 9007199254740991),
  recurrence_unit TEXT NOT NULL CHECK (recurrence_unit IN ('day', 'week', 'month', 'year')),
  next_renewal_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991)
);

-- Run inside the same write transaction, including concurrent requests and imports.
CREATE TRIGGER subscription_insert_totals AFTER INSERT ON manual_subscriptions BEGIN
  SELECT RAISE(ABORT, 'subscription_total_overflow') WHERE EXISTS (
    SELECT currency FROM manual_subscriptions WHERE status = 'active' GROUP BY currency
    HAVING SUM(amount / recurrence_interval * CASE recurrence_unit
      WHEN 'day' THEN 365.0 WHEN 'week' THEN 365.0 / 7 WHEN 'month' THEN 12.0 ELSE 1.0 END) > 1.7976931348623157e308
  );
END;
CREATE TRIGGER subscription_update_totals AFTER UPDATE ON manual_subscriptions BEGIN
  SELECT RAISE(ABORT, 'subscription_total_overflow') WHERE EXISTS (
    SELECT currency FROM manual_subscriptions WHERE status = 'active' GROUP BY currency
    HAVING SUM(amount / recurrence_interval * CASE recurrence_unit
      WHEN 'day' THEN 365.0 WHEN 'week' THEN 365.0 / 7 WHEN 'month' THEN 12.0 ELSE 1.0 END) > 1.7976931348623157e308
  );
END;

CREATE TABLE cost_observations (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('aws', 'cloudflare')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL CHECK (period_end > period_start),
  amount REAL NOT NULL CHECK (amount BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  kind TEXT NOT NULL CHECK (kind IN ('actual', 'forecast')),
  captured_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);
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

CREATE TABLE provider_sync_status (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('aws', 'cloudflare')),
  status TEXT NOT NULL CHECK (status IN ('not-configured', 'synced', 'error')),
  last_attempt_at TEXT,
  last_synced_at TEXT
);
