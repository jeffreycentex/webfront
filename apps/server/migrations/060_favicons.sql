-- Favicon cache (Task 5): one row per site origin. `data` is NULL for a negative entry (no icon
-- found), so misses are not re-fetched on every request.
CREATE TABLE favicon_cache (
  origin TEXT PRIMARY KEY,
  content_type TEXT,
  data BLOB,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX favicon_cache_expires ON favicon_cache (expires_at);
