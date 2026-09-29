export function serializePageData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
const parsedPages = new WeakMap<Element, unknown>();
export function readPageData<T>(owner: Element): T | undefined {
  if (parsedPages.has(owner)) return parsedPages.get(owner) as T;
  const id = owner.getAttribute("data-page-data");
  const element = id ? owner.ownerDocument.getElementById(id) : null;
  if (!element?.textContent) return undefined;
  try {
    const data = JSON.parse(element.textContent) as T;
    parsedPages.set(owner, data);
    if (owner.isConnected) element.remove();
    return data;
  } catch {
    return undefined;
  }
}
