-- Pushover outage notifications (services feature). Server-only: never synced.
--
-- notification_config: one row. The Pushover application token and user key are credentials,
-- stored here in plain text (protected by the data directory's file permissions; they are also
-- in backups). `options` is JSON validated by notificationOptionsSchema. The delivery columns are
-- a tiny log for the settings page; `paused` is set after Pushover rejects a request (4xx).
CREATE TABLE IF NOT EXISTS notification_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  app_token TEXT,
  user_key TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error_at INTEGER,
  last_error TEXT,
  paused INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Per service bookmark: what the alerting logic last saw and told the owner, so a restart never
-- re-sends alerts for outages that were already reported (or that predate the first sighting).
--   state         confirmed state last seen by the alerting logic ('up' or 'down')
--   seen_up       1 once the service has been seen up (alerts need that)
--   down_since    ms epoch when the current outage was confirmed, else NULL
--   alert         'none' (up, or an outage that never qualified), 'pending' (waiting for the
--                 minimum down time), 'raised' (down alert sent or due; recovery will be sent),
--                 'muted' (outage qualified while notifications were off: no recovery message)
--   last_alert_at ms epoch of the last down alert or reminder for this outage
CREATE TABLE IF NOT EXISTS service_alert_state (
  bookmark_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('up', 'down')),
  seen_up INTEGER NOT NULL DEFAULT 0,
  down_since INTEGER,
  alert TEXT NOT NULL DEFAULT 'none' CHECK (alert IN ('none', 'pending', 'raised', 'muted')),
  last_alert_at INTEGER
) STRICT;
