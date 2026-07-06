import { publish } from "@/lib/event-bus";
import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  parseOAuthCompleteDeepLink,
} from "@/runtime/native-deep-link";

/**
 * Capacitor iOS shell's `App.appUrlOpen` → deep-link routing.
 *
 * OAuth-complete URLs (`vellum-assistant://oauth-complete?…`) dispatch
 * the `OAUTH_COMPLETE_DEEP_LINK_EVENT` window CustomEvent that
 * `useOAuthCompleteDeepLinkListener` already consumes, making OAuth
 * completion event-driven instead of relying only on the
 * `browserFinished` poll fallback in `runtime/browser.ts` (which stays
 * in place as a safety net). Any other URL publishes
 * `deeplink.unknown { url }` on the bus — future URL kinds
 * (conversation universal links, quick actions) branch here.
 *
 * Off Capacitor iOS the function is a no-op — Electron deep links flow
 * through `publishElectronDeepLinksSource` instead.
 *
 * `subscribeCapacitorListener` owns the platform guard, the
 * unsubscribe-before-import-resolves race, and failure reporting; the
 * `@capacitor/app` import stays lazy and inline here per CAPACITOR.md's
 * "lazy-import rule".
 */
export function publishCapacitorDeepLinksSource(): () => void {
  return subscribeCapacitorListener("capacitor_deep_links", async () => {
    const { App } = await import("@capacitor/app");
    return App.addListener("appUrlOpen", ({ url }) => handleUrl(url));
  });
}

function handleUrl(url: string): void {
  const payload = parseOAuthCompleteDeepLink(url);
  if (payload !== null) {
    window.dispatchEvent(
      new CustomEvent(OAUTH_COMPLETE_DEEP_LINK_EVENT, { detail: payload }),
    );
    return;
  }
  publish("deeplink.unknown", { url });
}
