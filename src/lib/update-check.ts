/** Offers a reload when a newer deployment is live, so an open tab never runs stale chunks. */
import { snackbar } from "./snackbar";
import { clientText } from "../i18n/client";

declare const __WEB_BUILD_ID__: string;

const CHECK_MS = 10 * 60 * 1000;
let last = 0;
let offered = false;

async function check() {
  if (offered || document.visibilityState !== "visible" || Date.now() - last < CHECK_MS) return;
  last = Date.now();
  try {
    const response = await fetch("/build.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) return;
    const { id, web } = (await response.json()) as { id?: string; web?: string };
    if (!id || web === __WEB_BUILD_ID__) return;
    offered = true;
    const locale = document.documentElement.lang || "ja";
    snackbar(clientText(locale, "common.states.updateAvailable", "A new version is available"), {
      durationMs: 0,
      action: { label: clientText(locale, "common.actions.reload", "Reload"), run: () => location.reload() },
    });
  } catch {
    return;
  }
}

export function installUpdateCheck() {
  if (import.meta.env.DEV) return;
  last = Date.now();
  document.addEventListener("visibilitychange", () => void check());
  setInterval(() => void check(), CHECK_MS);
}
