-- Wiki attachments (Task 8). Files live content-addressed under config.attachmentsDir
-- (<sha256[0:2]>/<sha256>); this table holds their metadata. The id IS the SHA-256 of the
-- bytes, so uploading the same image twice stores it once.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  -- One of the allow-listed image types, detected from the file's magic bytes.
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX attachments_created_at ON attachments (created_at);
