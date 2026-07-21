import type { ReturnTargetEnum } from "@/generated/api/types.gen";
import { isElectron } from "@/runtime/is-electron";

/**
 * Where the platform should send the browser when Stripe Checkout finishes.
 *
 * The Electron shell opens Checkout in the *system browser* (see
 * `runtime/browser.ts`), so a web return URL strands the user in that browser
 * and the app never learns checkout completed. `"native"` makes the platform
 * bounce the browser to `<scheme>://billing/checkout-complete`, which the macOS
 * shell routes back into the app (`clients/macos/src/main/deep-links.ts`).
 *
 * Every other host takes the web return: a browser cannot open a `vellum://`
 * URL, and the Capacitor iOS shell keeps Checkout inside an in-app
 * `SFSafariViewController` whose dismissal it already observes.
 */
export function checkoutReturnTarget(): ReturnTargetEnum {
  return isElectron() ? "native" : "web";
}
