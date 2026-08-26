/**
 * Origin switching for the assistant chooser. A remembered origin is a
 * separate SPA deployment, so selecting one is a full navigation to that
 * base, not an in-app route change. Native mobile shells swap the WKWebView's
 * configured origin instead, which keeps the switch inside the app.
 */

import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import { isNativeMobile } from "@/runtime/platform-detection";
import {
  nativeSwitchToOrigin,
  nativeSwitchToOriginPath,
} from "@/runtime/self-hosted-servers";
import {
  normalizeOriginUrl,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";
import { pairingLinkForBase } from "@/utils/pairing-address";
import { routes } from "@/utils/routes";

/**
 * Navigate to the SPA root at the origin's base. An unpaired or expired
 * session bounces to that origin's own pair page via its resolver, which is
 * the intended degraded state.
 *
 * A `deviceCode` lands on that pair page directly instead, carrying the code
 * in the fragment so the already-approved pairing completes in one step rather
 * than minting a fresh challenge. The code is credential material: it is read
 * from the pasted link, never written to the origin store, and exists only for
 * the length of this navigation.
 *
 * On a native mobile shell the switch goes through the `SelfHostedServers`
 * plugin so the shell reloads in place. A shell too old to carry the plugin
 * falls back to the same navigation the web takes: leaving the app for the
 * system browser is degraded, but it is what the pair-page path already does
 * there.
 *
 * In Electron the navigation does not land in the app window either: the
 * main process's same-origin guard (`clients/macos/src/main/main-window.ts`)
 * ejects a cross-origin https target to the system browser.
 *
 * Everything the swap has to do before the shell leaves the origin, dropping
 * the iOS widget snapshot included, belongs to `nativeSwitchToOrigin`, so no
 * caller can leave one of them out.
 */
export async function switchToOrigin(
  origin: RememberedOrigin,
  deviceCode?: string,
): Promise<void> {
  const pairUrl = deviceCode
    ? pairingLinkForBase(origin.url, deviceCode)
    : null;
  const navigate = () =>
    window.location.assign(pairUrl ?? `${origin.url}${routes.assistant}`);
  // Nothing is awaited ahead of the web navigation: it is issued in the same
  // tick as the call, and the preparation the native swap needs lives behind
  // the fork, in `nativeSwitchToOrigin`.
  if (!isNativeMobile()) {
    navigate();
    return;
  }
  // The pair route relative to the shell's assistant entry, fragment and all.
  const switched =
    pairUrl === null
      ? await nativeSwitchToOrigin(origin.url)
      : await nativeSwitchToOriginPath(
          origin.url,
          `pair${new URL(pairUrl).hash}`,
        );
  if (!switched) {
    navigate();
  }
}

/**
 * Whether `origin` is the deployment serving the running app. Stored urls are
 * already canonical, so the running base is the side that needs normalizing.
 * In remote-gateway mode that base carries the public path prefix, so the
 * comparison includes it.
 */
export function isCurrentOrigin(origin: RememberedOrigin): boolean {
  const currentBase = isRemoteGatewayMode()
    ? remoteGatewayPublicBaseUrl()
    : window.location.origin;
  return normalizeOriginUrl(currentBase) === origin.url;
}
