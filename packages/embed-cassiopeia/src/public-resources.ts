/** Public media namespaces served by Haneoka, independent of author URLs. */
export function isHaneokaPublicResource(value: string): boolean {
  const url = new URL(value);
  return url.origin === "https://haneoka.org" && /^\/(?:assets|runtime|embed)\//u.test(url.pathname);
}

export function publicResourceRequest(request: Request): Request {
  return isHaneokaPublicResource(request.url) ? new Request(request, { referrerPolicy: "no-referrer" }) : request;
}

export function publicResourceType(value: string): string {
  const path = new URL(value).pathname;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        svg: "image/svg+xml",
        json: "application/json",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
