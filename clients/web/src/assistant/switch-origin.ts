/**
 * Origin switching for the assistant chooser. A remembered origin is a
 * separate SPA deployment, so selecting one is a full navigation to that
 * base, not an in-app route change. Native mobile shells swap the WKWebView's
 * configured origin instead, which keeps the switch inside the app.
 */

import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import { isNativeMobile } from "@/runtime/platform-detection";
import { nativeSwitchToOrigin } from "@/runtime/self-hosted-servers";
import {
  normalizeOriginUrl,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";
import { routes } from "@/utils/routes";

/**
 * Navigate to the SPA root at the origin's base. An unpaired or expired
 * session bounces to that origin's own pair page via its resolver, which is
 * the intended degraded state.
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
 */
export async function switchToOrigin(origin: RememberedOrigin): Promise<void> {
  const navigate = () =>
    window.location.assign(`${origin.url}${routes.assistant}`);
  if (!isNativeMobile()) {
    navigate();
    return;
  }
  if (!(await nativeSwitchToOrigin(origin.url))) {
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
