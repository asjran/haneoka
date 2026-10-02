export const COMMENT_LAST_EDITED_AT_SELECT = `COALESCE((
  SELECT current_revision.created_at
  FROM community_comment_revision AS current_revision
  WHERE current_revision.comment_id = comment.id
    AND current_revision.revision_number = comment.moderation_revision
    AND current_revision.source_kind = 'edit'
), comment.created_at)`;

export const POST_LAST_EDITED_AT_SELECT = `COALESCE((
  SELECT current_revision.created_at
  FROM community_post_revision AS current_revision
  WHERE current_revision.post_id = post.id
    AND current_revision.revision_number = post.moderation_revision
    AND current_revision.source_kind = 'edit'
), post.created_at)`;
