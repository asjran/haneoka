CREATE TABLE account_team_inventory (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  server TEXT NOT NULL REFERENCES resource_server(slug) ON DELETE CASCADE,
  inventory_json TEXT NOT NULL CHECK (
    json_valid(inventory_json)
    AND json_type(inventory_json) = 'object'
    AND length(CAST(inventory_json AS BLOB)) <= 1048576
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (user_id, server)
);

CREATE TRIGGER account_team_inventory_after_profile_delete
AFTER UPDATE OF status ON community_profile
WHEN NEW.status = 'deleted'
BEGIN
  DELETE FROM account_team_inventory WHERE user_id = NEW.user_id;
END;
