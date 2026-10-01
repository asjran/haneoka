-- Optional Cloudflare metadata belongs to private audit snapshots only.
-- Existing snapshots retain their known country/region/IP; new fields stay NULL.
ALTER TABLE community_post_revision ADD COLUMN ip_details_json TEXT CHECK(ip_details_json IS NULL OR (json_valid(ip_details_json) AND json_type(ip_details_json) = 'object'));
ALTER TABLE community_comment_revision ADD COLUMN ip_details_json TEXT CHECK(ip_details_json IS NULL OR (json_valid(ip_details_json) AND json_type(ip_details_json) = 'object'));
ALTER TABLE community_post_state_event ADD COLUMN ip_details_json TEXT CHECK(ip_details_json IS NULL OR (json_valid(ip_details_json) AND json_type(ip_details_json) = 'object'));
ALTER TABLE community_comment_state_event ADD COLUMN ip_details_json TEXT CHECK(ip_details_json IS NULL OR (json_valid(ip_details_json) AND json_type(ip_details_json) = 'object'));

CREATE TABLE community_user_last_visit (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL CHECK(visited_at >= 0),
  ip_address TEXT,
  ip_country_code TEXT,
  ip_region_code TEXT,
  ip_region_name TEXT,
  ip_details_json TEXT CHECK(ip_details_json IS NULL OR (json_valid(ip_details_json) AND json_type(ip_details_json) = 'object'))
);
