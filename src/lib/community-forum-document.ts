export function isCommunityForumDetailPath(pathname: string): boolean {
  return /^\/(?:ja|en|zh-TW|zh-CN|ko)\/community\/forums\/[^/]+\/?$/u.test(pathname);
}

/** Reuse the forum directory's application shell for a live forum feed. */
export function restoreCommunityForumDetailShell(html: string): string {
  const body = html.indexOf("<body");
  if (body < 0) return html;
  const bodyStart = html.indexOf(">", body);
  if (bodyStart < 0) return html;
  const workspace = html.indexOf("<community-workspace", bodyStart + 1);
  if (workspace < 0) return html;
  const openingEnd = html.indexOf(">", workspace);
  const closing = html.indexOf("</community-workspace>", openingEnd + 1);
  if (openingEnd < 0 || closing < 0) return html;
  const opening = html.slice(workspace, openingEnd + 1).replace(
    /\sdata-(?:prerendered|page-data)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gu,
    "",
  );
  let restored = html.slice(0, workspace) + opening + html.slice(closing);
  let script = restored.indexOf("<script", bodyStart + 1);
  while (script >= 0) {
    const openingEnd = restored.indexOf(">", script);
    if (openingEnd < 0) break;
    const closing = restored.indexOf("</script>", openingEnd + 1);
    if (closing < 0) break;
    const opening = restored.slice(script, openingEnd + 1);
    if (/\sid=(?:"community-forums-page"|'community-forums-page')(?=\s|>)/u.test(opening)) {
      restored = restored.slice(0, script) + restored.slice(closing + "</script>".length);
      break;
    }
    script = restored.indexOf("<script", closing + "</script>".length);
  }
  return restored;
}
