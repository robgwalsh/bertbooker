-- The deployment's own knobs, as key/value text. An absent key means the
-- default the reader carries, so a fresh database needs no seed row.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
