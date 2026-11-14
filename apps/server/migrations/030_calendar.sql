-- Calendar feed fetch state (Task 9). Server-private; the feed URL itself is never stored here,
-- only a hash to detect changes. `body` is the last good ICS text, kept so a 304 response (or
-- the daily window roll) can re-expand without refetching.
CREATE TABLE calendar_feed_state (
  feed_id       TEXT PRIMARY KEY,
  url_hash      TEXT NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  body          TEXT,
  updated_at    TEXT NOT NULL
) STRICT;
