-- Core tables (Task 1). See docs/CONTRACTS.md for migration number ranges.

-- Small key/value store for server state.
--   server_id    random id of this database instance (returned by sync so clients can detect a restore)
--   records_seq  last seq handed out to a record change (the sync pull cursor); only ever increases
--   server_hlc   last HLC stamp issued by the server (written by the sync feature)
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO meta (key, value) VALUES
  ('server_id', lower(hex(randomblob(16)))),
  ('records_seq', '0');

-- Every synced collection lives in this one table (see packages/shared/src/registry.ts).
--   data        JSON object of the record's domain fields (no envelope keys)
--   clocks      JSON object: field name -> HLC string (includes "deleted")
--   deleted     tombstone flag (mirrors the clocked "deleted" field)
--   created_at  / updated_at  ISO timestamps from the record envelope
--   seq         seq of the latest accepted change to this record; unique and increasing
CREATE TABLE records (
  collection TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL CHECK (json_valid(data)),
  clocks     TEXT    NOT NULL CHECK (json_valid(clocks)),
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
) STRICT;

-- Pull: WHERE seq > ? ORDER BY seq LIMIT ?
CREATE UNIQUE INDEX records_seq ON records (seq);
-- Server-side reads of one collection (calendar, services, export).
CREATE INDEX records_collection_live ON records (collection, deleted);
