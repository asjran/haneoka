import { isLocale, localeFromPath, localePath } from "../i18n/locales";

export function audioTrackDetailPath(
  track: { id: string; songKey?: string; detailPath?: string },
  locale: string,
): string {
  if (track.detailPath)
    return isLocale(locale) && localeFromPath(track.detailPath)
      ? localePath(track.detailPath, locale)
      : track.detailPath;

  // Older saved queues have game identity but no catalogue detail path.
  const provider = /^(gbp|sekai):(?:[^:]+:)?([^:]+)$/u.exec(track.songKey || "");
  if (provider) return `/${locale}/community/${provider[1]}/songs/detail/?song=${encodeURIComponent(provider[2]!)}`;

  return `/catalog/songs?song=${encodeURIComponent(track.id)}`;
}
