-- Only ciphertext is persisted. Disconnect keeps a revision tombstone to reject stale clients.
CREATE TABLE provider_credentials (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('aws', 'cloudflare', 'hostinger')),
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
