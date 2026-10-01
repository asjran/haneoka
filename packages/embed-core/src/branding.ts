/** Existing Haneoka favicon, embedded so hosts need no asset request. */
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 696 696" role="img" aria-label="haneoka shooting star">\n  <defs>\n    <filter id="softGlow" x="-80%" y="-80%" width="260%" height="260%">\n      <feGaussianBlur stdDeviation="5" result="blur" />\n      <feMerge>\n        <feMergeNode in="blur" />\n        <feMergeNode in="SourceGraphic" />\n      </feMerge>\n    </filter>\n    <filter id="trailGlow" x="-15%" y="-30%" width="130%" height="160%">\n      <feGaussianBlur stdDeviation="3.2" result="blur" />\n      <feMerge>\n        <feMergeNode in="blur" />\n        <feMergeNode in="SourceGraphic" />\n      </feMerge>\n    </filter>\n    <filter id="starGlow" x="-20%" y="-20%" width="140%" height="140%">\n      <feGaussianBlur in="SourceAlpha" stdDeviation="3.5" result="blur" />\n      <feFlood flood-color="#fff4d6" flood-opacity="0.72" />\n      <feComposite in2="blur" operator="in" />\n      <feMerge>\n        <feMergeNode />\n        <feMergeNode in="SourceGraphic" />\n      </feMerge>\n    </filter>\n  </defs>\n\n  <g>\n    <circle cx="347" cy="348" r="344" fill="#31356e" />\n\n    <!-- Distant stars, preserved in their original positions and colours. -->\n    <g filter="url(#softGlow)">\n      <circle cx="170" cy="114" r="10" fill="#79bbc8" opacity="0.88" />\n      <path d="M170 96l4.5 13.5L188 114l-13.5 4.5L170 132l-4.5-13.5L152 114l13.5-4.5z" fill="#86cbd0" opacity="0.58" />\n      <circle cx="370" cy="59" r="7" fill="#97a9d3" opacity="0.85" />\n      <path d="M370 47l3 9 9 3-9 3-3 9-3-9-9-3 9-3z" fill="#c2d8e1" opacity="0.5" />\n      <circle cx="503" cy="129" r="7.5" fill="#8c85c0" opacity="0.9" />\n      <path d="M503 118l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#b9a4d2" opacity="0.48" />\n      <circle cx="387" cy="526" r="8" fill="#c370b7" opacity="0.94" />\n      <path d="M387 514l3.2 8.8 8.8 3.2-8.8 3.2-3.2 8.8-3.2-8.8-8.8-3.2 8.8-3.2z" fill="#d376bd" opacity="0.55" />\n      <circle cx="534" cy="558" r="11" fill="none" stroke="#3a4d84" stroke-width="3" opacity="0.54" />\n      <circle cx="534" cy="558" r="4" fill="#2a3d73" opacity="0.8" />\n      <circle cx="575" cy="412" r="6" fill="#92a4d1" opacity="0.8" />\n      <path d="M575 402l2.6 7.4 7.4 2.6-7.4 2.6-2.6 7.4-2.6-7.4-7.4-2.6 7.4-2.6z" fill="#a8cada" opacity="0.52" />\n    </g>\n\n    <g fill="#9ab5d4">\n      <circle cx="302" cy="25" r="4" opacity="0.2" />\n      <circle cx="441" cy="87" r="2.6" opacity="0.22" />\n      <circle cx="303" cy="187" r="2.6" opacity="0.24" />\n      <circle cx="317" cy="256" r="4" opacity="0.48" />\n      <circle cx="283" cy="303" r="3" opacity="0.58" />\n      <circle cx="226" cy="357" r="4.5" opacity="0.52" />\n      <circle cx="113" cy="280" r="6.5" opacity="0.14" />\n      <circle cx="658" cy="303" r="3.6" opacity="0.42" />\n      <circle cx="658" cy="334" r="3" opacity="0.44" />\n      <circle cx="621" cy="365" r="4.5" opacity="0.56" />\n      <circle cx="445" cy="455" r="2.8" opacity="0.38" />\n      <circle cx="445" cy="490" r="4" opacity="0.5" />\n      <circle cx="500" cy="600" r="3" opacity="0.25" />\n      <circle cx="275" cy="626" r="4.5" opacity="0.21" />\n      <circle cx="659" cy="452" r="2.8" opacity="0.28" />\n      <circle cx="331" cy="482" r="2.3" opacity="0.3" />\n      <circle cx="58" cy="239" r="2.5" opacity="0.18" />\n    </g>\n\n    <g fill="#dce5e8" filter="url(#softGlow)">\n      <path d="M240 309l3.2 8.8 8.8 3.2-8.8 3.2-3.2 8.8-3.2-8.8-8.8-3.2 8.8-3.2z" opacity="0.94" />\n      <path d="M322 384l2.8 7.2 7.2 2.8-7.2 2.8-2.8 7.2-2.8-7.2-7.2-2.8 7.2-2.8z" opacity="0.72" />\n    </g>\n\n    <!-- Three tapered, curved comet trails. -->\n    <g fill="#edf0d8" filter="url(#trailGlow)">\n      <path d="M216 397C282 329 346 267 390 242C435 216 500 190 605 160L600 180C520 198 456 223 400 252C345 285 296 325 251 365C235 381 225 391 216 397Z" />\n      <path d="M216 405C277 356 330 320 393 287C461 255 542 235 621 219L614 240C570 247 530 254 494 264C398 292 313 334 238 392C230 398 223 402 216 405Z" />\n      <path d="M219 414C324 355 382 329 447 309C502 294 551 284 590 282L601 286L593 301C531 310 481 318 434 326C367 345 317 365 277 385C250 397 233 406 219 414Z" />\n    </g>\n\n    <!-- Foreground five-point shooting star. -->\n    <path\n      d="M169 370L134 417L70 419L105 464L86 529L151 513L196 550L201 488L250 449L191 427Z"\n      fill="#ecd8be"\n      stroke="#f3dfc8"\n      stroke-width="3"\n      stroke-linejoin="round"\n      filter="url(#starGlow)"\n    />\n  </g>\n</svg>';
let sequence = 0;

export type HaneokaBrandCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Pure on import; the caller mounts and removes this accessible brand link. */
export function createHaneokaBranding(
  document: Document,
  options: { readonly corner?: HaneokaBrandCorner } = {},
): HTMLAnchorElement {
  const corner = options.corner ?? "top-left";
  const anchor = document.createElement("a");
  anchor.href = "https://haneoka.org/";
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.setAttribute("aria-label", "Haneoka");
  anchor.title = "Haneoka";
  anchor.dataset.haneokaBrand = "";
  const vertical = corner.startsWith("top") ? "top" : "bottom";
  const horizontal = corner.endsWith("left") ? "left" : "right";
  anchor.style.cssText = `position:absolute;${vertical}:env(safe-area-inset-${vertical},0px);${horizontal}:env(safe-area-inset-${horizontal},0px);z-index:60;display:grid;place-items:center;width:48px;height:48px;box-sizing:border-box;border-radius:var(--md-sys-shape-corner-full,999px);color:var(--md-sys-color-on-surface,CanvasText);background:transparent;text-decoration:none;touch-action:manipulation;`;
  const template = document.createElement("template");
  const id = `haneoka-embed-brand-${++sequence}`;
  template.innerHTML = ICON.replace(/(?:softGlow|trailGlow|starGlow)/gu, (name) => `${id}-${name}`);
  const svg = template.content.querySelector("svg")!;
  svg.removeAttribute("aria-label");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "28");
  svg.style.opacity = "0.55";
  anchor.append(svg);
  const stop = (event: Event) => event.stopPropagation();
  for (const type of ["click", "pointerdown", "pointerup", "touchstart", "touchend", "keydown", "keyup"])
    anchor.addEventListener(type, stop);
  anchor.addEventListener("focus", () => {
    anchor.style.outline = "2px solid var(--md-sys-color-primary,Highlight)";
    anchor.style.outlineOffset = "-2px";
  });
  anchor.addEventListener("blur", () => {
    anchor.style.outline = "";
  });
  return anchor;
}
