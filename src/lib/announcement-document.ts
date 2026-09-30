import { isLocale } from "@haneoka/i18n";
import { isReleaseServer } from "./resource-route.ts";

/** Operational detail documents use the shared shell independently of Master releases. */
export function announcementDocumentRequest(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (
    parts.length !== 4 ||
    !isReleaseServer(parts[0]) ||
    !isLocale(parts[1]) ||
    parts[2] !== "announcements" ||
    !/^[1-9]\d*$/u.test(parts[3] || "") ||
    !Number.isSafeInteger(Number(parts[3]))
  )
    return undefined;
  return {
    shellPath: `/${parts[0]}/${parts[1]}/announcements/detail/`,
    id: parts[3]!,
  };
}

export function rewriteAnnouncementDocument(html: string, id: string): string {
  return html.replaceAll("/announcements/detail/", `/announcements/${id}/`);
}
