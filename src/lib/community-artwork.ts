type PostRecord = Record<string, unknown>;

export function communityPostMedia(post: PostRecord): PostRecord[] {
  if (Array.isArray(post.attachments)) {
    return post.attachments.filter(
      (attachment): attachment is PostRecord =>
        Boolean(attachment) && typeof attachment === "object" && /^(image|video)\//u.test(String(attachment.mediaType)),
    );
  }
  return typeof post.coverUrl === "string" && post.coverUrl
    ? [{ contentUrl: post.coverUrl, width: post.coverWidth, height: post.coverHeight }]
    : [];
}

export function communityMediaThumbnail(media: PostRecord): string {
  return (
    [media.thumbnailUrl, media.posterUrl, media.previewUrl, media.contentUrl].find(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    ) || ""
  );
}
