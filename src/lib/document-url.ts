/**
 * Astro connects the incoming document's custom elements before it commits
 * the browser URL. Base marks that document during before-swap so callers can
 * resolve identity and query state against the destination instead of the
 * previous location.
 */
export function navigationDocumentUrl(): URL {
  const marked = document.documentElement.dataset.navigationHref;
  if (marked) {
    try {
      const target = new URL(marked, location.href);
      if (target.origin === location.origin && target.pathname !== location.pathname) return target;
    } catch {}
  }
  return new URL(location.href);
}
