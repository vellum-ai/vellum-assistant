import { Capacitor } from "@capacitor/core";

import { publish } from "@/lib/event-bus";
import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import {
  OAUTH_COMPLETE_DEEP_LINK_EVENT,
  parseBillingCheckoutCompleteDeepLink,
  parseOAuthCompleteDeepLink,
  parseOpenThreadDeepLink,
  parseStartVoiceDeepLink,
} from "@/runtime/native-deep-link";

/**
 * Capacitor shell deep-link routing.
 *
 * OAuth-complete URLs (`vellum-assistant://oauth-complete?…`) dispatch
 * the `OAUTH_COMPLETE_DEEP_LINK_EVENT` window CustomEvent that
 * `useOAuthCompleteDeepLinkListener` already consumes;
 * `vellum-assistant://billing/checkout-complete?…` publishes
 * `deeplink.billingCheckoutComplete` (the same event the Electron shell
 * emits, consumed by `useGlobalDeepLinkConsumer`);
 * `vellum-assistant://voice?mode=…` publishes `deeplink.startVoice`;
 * `vellum-assistant://thread/<id>?message=…` publishes
 * `deeplink.sendToThread` (or `deeplink.openThread` when it carries no
 * usable message); any other URL publishes `deeplink.unknown { url }`
 * on the bus (query/fragment stripped).
 *
 * Off Capacitor the function is a no-op; Electron deep links flow
 * through `publishElectronDeepLinksSource` instead.
 *
 * Lazy inline `@capacitor/app` import per CAPACITOR.md's "lazy-import rule".
 */
export function publishCapacitorDeepLinksSource(): () => void {
  return subscribeCapacitorListener("capacitor_deep_links", async () => {
    const { App } = await import("@capacitor/app");
    const listener = await App.addListener("appUrlOpen", ({ url }) =>
      handleUrl(url),
    );
    try {
      // iOS replays cold-launch URLs through AppDelegate. Its last URL remains
      // cached for the process, so reading it here would deliver it twice.
      if (Capacitor.getPlatform() === "android") {
        const launch = await App.getLaunchUrl();
        if (launch?.url) {
          handleUrl(launch.url);
        }
      }
      return listener;
    } catch (error) {
      await listener.remove();
      throw error;
    }
  });
}

/**
 * Whether the running shell can vouch for a command URL's provenance marker.
 * Only the iOS `AppDelegate` strips the marker at its external entry points
 * (`CommandURLProvenance.swift`), so only there does its presence mean "an
 * App Intent produced this". Android registers the same scheme (for the auth
 * callback host today) and strips nothing, so it must never be trusted here,
 * even if a future intent-filter widens which URLs it accepts. Read once per
 * URL rather than at module load so tests can swap the platform.
 */
function shellVouchesForProvenance(): boolean {
  return Capacitor.getPlatform() === "ios";
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
  // Also before the `unknown` fallback: the stripped query would take `mode`
  // with it.
  const parseOptions = { acceptProvenance: shellVouchesForProvenance() };
  const startVoice = parseStartVoiceDeepLink(url, parseOptions);
  if (startVoice !== null) {
    publish("deeplink.startVoice", startVoice);
    return;
  }

  // Same placement reason (`message` rides the query). A thread link whose
  // message failed sanitization degrades to the same `deeplink.openThread` a
  // notification tap publishes: opening the chat the user picked beats
  // dropping the whole command.
  const openThread = parseOpenThreadDeepLink(url, parseOptions);
  if (openThread !== null) {
    if (openThread.message !== null) {
      publish("deeplink.sendToThread", {
        threadId: openThread.threadId,
        message: openThread.message,
        provenance: openThread.provenance,
      });
    } else {
      publish("deeplink.openThread", { threadId: openThread.threadId });
    }
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
