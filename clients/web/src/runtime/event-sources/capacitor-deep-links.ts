import { captureError } from "@/lib/sentry/capture-error";
import type { PluginListenerHandle } from "@capacitor/core";

import { publish } from "@/lib/event-bus";
import { isNativePlatform } from "@/runtime/native-auth";
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
 * Off Capacitor iOS the function is a no-op (`isNativePlatform()`
 * returns false) — Electron deep links flow through
 * `publishElectronDeepLinksSource` instead.
 *
 * The `@capacitor/app` plugin import is lazy (per CAPACITOR.md's
 * "lazy-import rule"), and the sync return + internal `cancelled` flag
 * covers unsubscribing before the import resolves — both mirror
 * `publishCapacitorAppStateSource`.
 */
export function publishCapacitorDeepLinksSource(): () => void {
  if (!isNativePlatform()) return () => undefined;

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  import("@capacitor/app")
    .then(({ App }) =>
      App.addListener("appUrlOpen", ({ url }) => handleUrl(url)),
    )
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
        return;
      }
      handle = registered;
    })
    .catch((err) => {
      captureError(err, { context: "capacitor_deep_links", level: "warning" });
    });

  return () => {
    cancelled = true;
    void handle?.remove();
  };
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
