-- Expand community attachments for 128 MiB multipart uploads and accepted media.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE community_work_cover_backup AS SELECT id, cover_attachment_id FROM community_work WHERE cover_attachment_id IS NOT NULL;

ALTER TABLE community_attachment ADD COLUMN width INTEGER;
ALTER TABLE community_attachment ADD COLUMN height INTEGER;
ALTER TABLE community_attachment ADD COLUMN r2_upload_id TEXT;

CREATE TABLE community_attachment_new (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'post' CHECK (purpose IN ('avatar', 'post', 'work-cover')),
  idempotency_key TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 160),
  media_type TEXT NOT NULL CHECK (media_type IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
    'image/heif', 'video/mp4', 'video/webm', 'video/quicktime', 'text/plain'
  )),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 134217728),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size = declared_size),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  r2_upload_id TEXT UNIQUE,
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  r2_etag TEXT,
  r2_version TEXT,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'scanning', 'ready', 'review', 'rejected', 'deleted')),
  moderation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'allow', 'review', 'block')),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 80),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  object_deleted_at INTEGER,
  UNIQUE(owner_user_id, idempotency_key),
  CHECK (deleted_at IS NULL OR status = 'deleted'),
  CHECK (object_deleted_at IS NULL OR deleted_at IS NOT NULL)
);
INSERT INTO community_attachment_new (
  id, owner_user_id, purpose, idempotency_key, object_key, original_name,
  media_type, declared_size, byte_size, width, height, r2_upload_id, sha256,
  r2_etag, r2_version, status, moderation_status, failure_code, expires_at,
  created_at, updated_at, deleted_at, object_deleted_at
)
SELECT id, owner_user_id, purpose, idempotency_key, object_key, original_name,
       media_type, declared_size, byte_size, width, height, r2_upload_id, sha256,
       r2_etag, r2_version, status, moderation_status, failure_code, expires_at,
       created_at, updated_at, deleted_at, object_deleted_at
FROM community_attachment;

CREATE TABLE community_post_attachment_new (
  post_id TEXT NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES community_attachment_new(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 15),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, attachment_id),
  UNIQUE(post_id, position)
);
INSERT INTO community_post_attachment_new (post_id, attachment_id, position, created_at)
SELECT post_id, attachment_id, position, created_at FROM community_post_attachment;

CREATE TABLE community_post_revision_attachment_new (
  post_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES community_attachment_new(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 15),
  PRIMARY KEY (post_id, revision_number, attachment_id),
  UNIQUE(post_id, revision_number, position),
  FOREIGN KEY (post_id, revision_number)
    REFERENCES community_post_revision(post_id, revision_number) ON DELETE RESTRICT
);
INSERT INTO community_post_revision_attachment_new
  (post_id, revision_number, attachment_id, position)
SELECT post_id, revision_number, attachment_id, position
FROM community_post_revision_attachment;

CREATE TABLE community_profile_avatar_new (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES community_profile(user_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES community_attachment_new(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);
INSERT INTO community_profile_avatar_new SELECT * FROM community_profile_avatar;
DROP TRIGGER community_profile_avatar_before_insert;
DROP TRIGGER community_profile_avatar_before_update;
DROP TABLE community_profile_avatar;
DROP TABLE community_post_revision_attachment;
DROP TABLE community_post_attachment;
DROP TABLE community_attachment;
ALTER TABLE community_attachment_new RENAME TO community_attachment;
ALTER TABLE community_profile_avatar_new RENAME TO community_profile_avatar;
ALTER TABLE community_post_attachment_new RENAME TO community_post_attachment;
ALTER TABLE community_post_revision_attachment_new RENAME TO community_post_revision_attachment;

CREATE INDEX community_attachment_owner_idx
  ON community_attachment(owner_user_id, status, created_at DESC, id DESC);
CREATE INDEX community_attachment_cleanup_idx
  ON community_attachment(status, expires_at, updated_at, id);
CREATE TABLE community_attachment_part (
  attachment_id TEXT NOT NULL REFERENCES community_attachment(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 200),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 1),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, part_number)
);
CREATE INDEX community_attachment_part_lookup_idx
  ON community_attachment_part(attachment_id, part_number);
CREATE INDEX community_post_attachment_post_idx
  ON community_post_attachment(post_id, position, attachment_id);
CREATE INDEX community_post_revision_attachment_lookup_idx
  ON community_post_revision_attachment(attachment_id, post_id, revision_number DESC);

CREATE TRIGGER community_profile_avatar_before_insert
BEFORE INSERT ON community_profile_avatar
WHEN NOT EXISTS (
  SELECT 1 FROM community_attachment AS attachment
  WHERE attachment.id = NEW.attachment_id
    AND attachment.owner_user_id = NEW.user_id
    AND attachment.purpose = 'avatar'
    AND attachment.status = 'ready'
    AND attachment.moderation_status = 'allow'
    AND attachment.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'avatar must be an allowed avatar attachment owned by the user');
END;
CREATE TRIGGER community_profile_avatar_before_update
BEFORE UPDATE OF user_id, attachment_id ON community_profile_avatar
WHEN NOT EXISTS (
  SELECT 1 FROM community_attachment AS attachment
  WHERE attachment.id = NEW.attachment_id
    AND attachment.owner_user_id = NEW.user_id
    AND attachment.purpose = 'avatar'
    AND attachment.status = 'ready'
    AND attachment.moderation_status = 'allow'
    AND attachment.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'avatar must be an allowed avatar attachment owned by the user');
END;

CREATE TRIGGER community_post_attachment_ready_before_insert
BEFORE INSERT ON community_post_attachment
WHEN NOT EXISTS (
  SELECT 1 FROM community_attachment AS attachment
  WHERE attachment.id = NEW.attachment_id
    AND attachment.purpose = 'post'
    AND attachment.status = 'ready'
    AND attachment.moderation_status = 'allow'
    AND attachment.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'attachment must be ready and allowed');
END;
CREATE TRIGGER community_post_attachment_owner_before_insert
BEFORE INSERT ON community_post_attachment
WHEN NOT EXISTS (
  SELECT 1 FROM community_attachment AS attachment
  JOIN community_post AS post ON post.id = NEW.post_id
  WHERE attachment.id = NEW.attachment_id
    AND attachment.owner_user_id = post.author_id
    AND post.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'attachment and post must share an owner');
END;
CREATE TRIGGER community_post_attachment_immutable
BEFORE UPDATE OF post_id, attachment_id ON community_post_attachment
WHEN NEW.post_id <> OLD.post_id OR NEW.attachment_id <> OLD.attachment_id
BEGIN
  SELECT RAISE(ABORT, 'attachment link identity is immutable');
END;
CREATE TRIGGER community_post_revision_attachment_sealed_before_insert
BEFORE INSERT ON community_post_revision_attachment
WHEN EXISTS (
  SELECT 1 FROM community_post_revision_seal
  WHERE post_id = NEW.post_id AND revision_number = NEW.revision_number
)
BEGIN
  SELECT RAISE(ABORT, 'sealed post revision attachment snapshots cannot be extended');
END;
CREATE TRIGGER community_post_revision_attachment_immutable_before_update
BEFORE UPDATE ON community_post_revision_attachment
BEGIN
  SELECT RAISE(ABORT, 'post revision attachment snapshots are immutable');
END;
CREATE TRIGGER community_post_revision_attachment_immutable_before_delete
BEFORE DELETE ON community_post_revision_attachment
BEGIN
  SELECT RAISE(ABORT, 'post revision attachment snapshots cannot be deleted');
END;

UPDATE community_work SET cover_attachment_id = (SELECT cover_attachment_id FROM community_work_cover_backup WHERE id = community_work.id) WHERE id IN (SELECT id FROM community_work_cover_backup);
DROP TABLE community_work_cover_backup;
PRAGMA foreign_key_check;
