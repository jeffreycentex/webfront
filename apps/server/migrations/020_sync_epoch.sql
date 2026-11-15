-- Restore marker for sync (Task 3 range). See packages/shared/src/api/sync.ts.
--
--   sync_epoch  random id (32 lowercase hex chars). `webfront-restore` rewrites it after putting a
--               backup in place, so every client knows the restored database is the truth: a
--               client that sees it change discards its local copy and outbox and pulls from 0,
--               and the server rejects pushes that do not carry the current value.
--
-- Existing databases get a value here without touching any data. Clients that never knew an
-- epoch adopt the first one they see WITHOUT discarding anything, so deploying this is safe.
-- DO NOTHING keeps a value already written (e.g. by restore.sh into a backup taken before this
-- migration existed, which then runs this migration on the next start).
INSERT INTO meta (key, value) VALUES ('sync_epoch', lower(hex(randomblob(16))))
  ON CONFLICT(key) DO NOTHING;
