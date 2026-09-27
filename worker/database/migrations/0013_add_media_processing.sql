CREATE TABLE community_media_job (
  attachment_id TEXT PRIMARY KEY NOT NULL REFERENCES community_attachment(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','ready','failed')),
  progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX community_media_job_pending_idx ON community_media_job(state,lease_until,updated_at);

CREATE TABLE community_attachment_variant (
  attachment_id TEXT NOT NULL REFERENCES community_attachment(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('thumb','poster','media','moderation')),
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK(media_type IN ('image/jpeg','image/png','image/webp','video/mp4')),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  duration_seconds REAL,
  sha256 TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(attachment_id,kind)
);
