import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export type AnnouncementBodyNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      tag: string;
      attributes: Record<string, string>;
      children: AnnouncementBodyNode[];
    };

const allowedTags = new Set([
  "a",
  "p",
  "div",
  "span",
  "br",
  "hr",
  "wbr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "small",
  "mark",
  "sub",
  "sup",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "img",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "ruby",
  "rt",
  "rp",
]);
const discardedTags = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "head",
  "title",
  "meta",
  "link",
  "base",
  "frame",
  "frameset",
  "textarea",
  "select",
  "button",
]);
const mediaPath = /^\/api\/v1\/announcements\/media\/[a-z0-9-]+\/[a-f0-9]+\.(?:png|jpe?g|webp|gif|avif)$/i;
const htmlNamespace = "http://www.w3.org/1999/xhtml";

export function safeAnnouncementUrl(value: string, image = false): string {
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u001f\u007f\\]/.test(candidate)) return "";
  if (image && mediaPath.test(candidate)) return candidate;
  if (!image && (/^\/(?!\/)/.test(candidate) || candidate.startsWith("#"))) {
    try {
      const url = new URL(candidate, "https://haneoka.invalid");
      return url.origin === "https://haneoka.invalid" ? candidate : "";
    } catch {
      return "";
    }
  }
  if (!/^https?:\/\//i.test(candidate)) return "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    if (image && url.hostname === "haneoka.org" && mediaPath.test(url.pathname) && !url.search && !url.hash)
      return url.pathname;
    return url.href;
  } catch {
    return "";
  }
}

function integerAttribute(value: string, minimum: number, maximum: number): string {
  if (!/^-?\d+$/.test(value)) return "";
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? String(number) : "";
}

function safeAttributes(element: DefaultTreeAdapterTypes.Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of element.attrs) {
    if (attribute.namespace || attribute.prefix) continue;
    const { name, value } = attribute;
    if (name === "lang" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) attributes.lang = value;
    if (name === "dir" && ["ltr", "rtl", "auto"].includes(value)) attributes.dir = value;
    if (name === "title") attributes.title = value;
    if (element.tagName === "a" && name === "href") {
      const href = safeAnnouncementUrl(value);
      if (href) {
        attributes.href = href;
        if (/^https?:\/\//i.test(href)) {
          attributes.target = "_blank";
          attributes.rel = "noopener noreferrer";
        }
      }
    }
    if (element.tagName === "img") {
      if (name === "src") {
        const src = safeAnnouncementUrl(value, true);
        if (src) attributes.src = src;
      }
      if (name === "alt") attributes.alt = value;
      if (name === "width" || name === "height") {
        const size = integerAttribute(value, 1, 32768);
        if (size) attributes[name] = size;
      }
    }
    if ((element.tagName === "th" || element.tagName === "td") && ["colspan", "rowspan"].includes(name)) {
      const span = integerAttribute(value, 1, 1000);
      if (span) attributes[name] = span;
    }
    if (element.tagName === "th" && name === "scope" && ["row", "col", "rowgroup", "colgroup"].includes(value))
      attributes.scope = value;
    if (element.tagName === "col" && name === "span") {
      const span = integerAttribute(value, 1, 1000);
      if (span) attributes.span = span;
    }
    if ((element.tagName === "ol" && name === "start") || (element.tagName === "li" && name === "value")) {
      const number = integerAttribute(value, -1000000, 1000000);
      if (number) attributes[name] = number;
    }
    if (element.tagName === "ol" && name === "reversed") attributes.reversed = "";
  }
  if (element.tagName === "img") {
    attributes.alt ??= "";
    attributes.loading = "lazy";
    attributes.decoding = "async";
  }
  return attributes;
}

/** Parse authored HTML into an exact allowlist, independent of the browser DOM. */
export function parseAnnouncementBody(html: string): AnnouncementBodyNode[] {
  const fragment = parseFragment(html);
  const sanitize = (nodes: DefaultTreeAdapterTypes.ChildNode[], depth = 0): AnnouncementBodyNode[] => {
    if (depth > 100) return [];
    return nodes.flatMap((node): AnnouncementBodyNode[] => {
      if (node.nodeName === "#text") return [{ type: "text", value: (node as DefaultTreeAdapterTypes.TextNode).value }];
      if (!("tagName" in node)) return [];
      if (node.namespaceURI !== htmlNamespace || discardedTags.has(node.tagName)) return [];
      const children = sanitize(node.childNodes, depth + 1);
      if (!allowedTags.has(node.tagName)) return children;
      const attributes = safeAttributes(node);
      if (node.tagName === "img" && !attributes.src) return [];
      const authoredClasses = node.attrs.find((attribute) => attribute.name === "class")?.value.split(/\s+/) || [];
      const tag =
        node.tagName === "h1" || (node.tagName === "div" && authoredClasses.includes("news-title"))
          ? "h2"
          : node.tagName === "div" && authoredClasses.includes("news-subtitle")
            ? "h3"
            : node.tagName;
      return [{ type: "element", tag, attributes, children }];
    });
  };
  return sanitize(fragment.childNodes);
}

/** Construct safe native nodes; authored markup never enters an HTML DOM sink. */
export function announcementBodyFragment(html: string, tableLabel: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const append = (parent: Node, nodes: AnnouncementBodyNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        parent.appendChild(document.createTextNode(node.value));
        continue;
      }
      const element = document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attributes)) element.setAttribute(name, value);
      append(element, node.children);
      if (node.tag === "table") {
        const region = document.createElement("div");
        region.className = "announcement-table-scroll";
        region.setAttribute("role", "region");
        region.setAttribute("aria-label", tableLabel);
        region.tabIndex = 0;
        region.appendChild(element);
        parent.appendChild(region);
      } else parent.appendChild(element);
    }
  };
  append(fragment, parseAnnouncementBody(html));
  return fragment;
}
