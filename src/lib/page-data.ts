export function serializePageData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
const parsedPages = new WeakMap<Element, Map<string, unknown>>();
export function readPageData<T>(owner: Element, attribute = "data-page-data"): T | undefined {
  const cached = parsedPages.get(owner);
  if (cached?.has(attribute)) return cached.get(attribute) as T;
  const id = owner.getAttribute(attribute);
  const element = id ? owner.ownerDocument.getElementById(id) : null;
  if (!element?.textContent) return undefined;
  try {
    const data = JSON.parse(element.textContent) as T;
    const pages = cached || new Map<string, unknown>();
    pages.set(attribute, data);
    parsedPages.set(owner, pages);
    if (owner.isConnected) element.remove();
    return data;
  } catch {
    return undefined;
  }
}
