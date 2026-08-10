import { Capacitor } from "@capacitor/core";

import type { ReturnTargetEnum } from "@/generated/api/types.gen";
import { detectElectronHostOS } from "@/runtime/platform-detection";

/**
 * Where the platform should send the browser when Stripe Checkout finishes.
 *
 * The macOS Electron shell opens Checkout in the *system browser* (see
 * `runtime/browser.ts`), so a web return URL strands the user in that browser
 * and the app never learns checkout completed. `"native"` makes the platform
 * bounce the browser to `<scheme>://billing/checkout-complete`, which the macOS
 * shell routes back into the app (`clients/macos/src/main/deep-links.ts`).
 *
 * The Windows Electron shell stays on the web return: its preload stubs
 * `deepLinks` (no `vellum://` protocol registration or second-instance argv
 * parsing yet, see `clients/windows/src/preload/index.ts`), so a native bounce
 * would land on a custom-scheme URL nothing consumes. Flip Windows to
 * `"native"` once the deep-link bridge is ported.
 *
 * Capacitor iOS takes the native return. Checkout opens in an in-app
 * `SFSafariViewController`, so a web return URL would load *inside* that sheet
 * and the `session_id` would never reach the app. The custom-scheme bounce is
 * Apple's prescribed hand-off: it dismisses the sheet and routes the URL in via
 * `appUrlOpen`, which `capacitor-deep-links.ts` turns into
 * `deeplink.billingCheckoutComplete`. The platform derives the scheme
 * server-side per environment, matching each iOS target's `BUNDLE_URL_SCHEME`.
 *
 * Plain web takes the web return; a browser cannot open a custom-scheme URL.
 */
export function checkoutReturnTarget(): ReturnTargetEnum {
  return detectElectronHostOS() === "macos" || Capacitor.isNativePlatform()
    ? "native"
    : "web";
}
