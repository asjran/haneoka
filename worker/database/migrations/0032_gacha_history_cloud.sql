CREATE TABLE IF NOT EXISTS account_gacha_history (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL CHECK (length(account_key) = 64 AND account_key NOT GLOB '*[^a-f0-9]*'),
  server TEXT NOT NULL CHECK (server IN ('jp', 'global-hmt', 'global-en', 'global-kr')),
  history_json TEXT NOT NULL CHECK (
    json_valid(history_json)
    AND json_type(history_json) = 'object'
    AND COALESCE(json_extract(history_json, '$.schema'), '') = 'haneoka-gacha-cloud-v1'
    AND COALESCE(json_type(history_json, '$.histories'), '') = 'array'
    AND length(CAST(history_json AS BLOB)) <= 1048576
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  refresh_requested INTEGER NOT NULL DEFAULT 0 CHECK (refresh_requested BETWEEN 0 AND 9007199254740991),
  refresh_completed INTEGER NOT NULL DEFAULT 0 CHECK (refresh_completed BETWEEN 0 AND refresh_requested),
  PRIMARY KEY (user_id, account_key)
);

CREATE TRIGGER IF NOT EXISTS account_gacha_history_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_gacha_history WHERE user_id = NEW.user_id;
END;
