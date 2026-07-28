import { publish } from "@/lib/event-bus";
import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  parseBillingCheckoutCompleteDeepLink,
  parseOAuthCompleteDeepLink,
} from "@/runtime/native-deep-link";

/**
 * Capacitor iOS shell's `App.appUrlOpen` → deep-link routing.
 *
 * OAuth-complete URLs (`vellum-assistant://oauth-complete?…`) dispatch
 * the `OAUTH_COMPLETE_DEEP_LINK_EVENT` window CustomEvent that
 * `useOAuthCompleteDeepLinkListener` already consumes;
 * `vellum-assistant://billing/checkout-complete?…` publishes
 * `deeplink.billingCheckoutComplete` (the same event the Electron shell
 * emits, consumed by `useGlobalDeepLinkConsumer`); any other URL
 * publishes `deeplink.unknown { url }` on the bus (query/fragment
 * stripped).
 *
 * Off Capacitor iOS the function is a no-op — Electron deep links flow
 * through `publishElectronDeepLinksSource` instead.
 *
 * Lazy inline `@capacitor/app` import per CAPACITOR.md's "lazy-import rule".
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

  // Must precede the `unknown` fallback: that path strips the query, which
  // would destroy the Session id the billing consumer needs to open the Pro
  // onboarding wizard.
  const checkout = parseBillingCheckoutCompleteDeepLink(url);
  if (checkout !== null) {
    publish("deeplink.billingCheckoutComplete", checkout);
    return;
  }
  // A malformed OAuth-complete URL can carry one-time auth codes in its
  // query/fragment — strip both so they never reach telemetry breadcrumbs.
  publish("deeplink.unknown", { url: sanitizeUnknownUrl(url) });
}

function sanitizeUnknownUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}
