/** Destination identity stays available throughout Astro's document swap. */
let pendingDocumentUrl: URL | undefined;
let documentUrlListening = false;
let renderDocumentUrl: URL | undefined;

export function withDocumentUrl<T>(url: URL, render: () => T): T {
  const previous = renderDocumentUrl;
  renderDocumentUrl = url;
  try { return render(); }
  finally { renderDocumentUrl = previous; }
}

/**
 * Astro connects custom elements before it commits the browser URL. Base
 * marks the incoming document during before-swap and clears that attribute
 * during after-swap. Async controllers may resume between after-swap and
 * the URL commit, so retain the destination until page-load completes.
 */
export function navigationDocumentUrl(): URL {
  if (renderDocumentUrl) return new URL(renderDocumentUrl);
  if (!documentUrlListening) {
    documentUrlListening = true;
    document.addEventListener("astro:page-load", () => {
      pendingDocumentUrl = undefined;
    });
  }
  const marked = document.documentElement.dataset.navigationHref;
  if (marked) {
    try {
      const target = new URL(marked, location.href);
      if (target.origin === location.origin) pendingDocumentUrl = target;
    } catch {}
  }
  return pendingDocumentUrl ?? new URL(location.href);
}
