/**
 * Origin switching for the assistant chooser. A remembered origin is a
 * separate SPA deployment, so selecting one is a full navigation to that
 * base, not an in-app route change. Native mobile shells swap the WKWebView's
 * configured origin instead, which keeps the switch inside the app.
 *
 * Kept dependency-light on the web path: the native seam is reached through a
 * dynamic import, so a browser surface never pulls the Capacitor plugin module
 * into its graph.
 */

import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import { isNativeMobile } from "@/runtime/platform-detection";
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
 */
export async function switchToOrigin(origin: RememberedOrigin): Promise<void> {
  const navigate = () =>
    window.location.assign(`${origin.url}${routes.assistant}`);
  if (!isNativeMobile()) {
    navigate();
    return;
  }
  const { nativeSwitchToOrigin } = await import(
    "@/runtime/self-hosted-servers"
  );
  if (!(await nativeSwitchToOrigin(origin.url))) {
    navigate();
  }
}

/**
 * Return a native mobile shell to its baked Vellum Cloud origin, resolving
 * whether the shell took the switch. Offered only where the baked origin is
 * known, which is a shell that carries the plugin.
 */
export async function switchToVellumCloud(): Promise<boolean> {
  const { nativeSwitchToOrigin } = await import(
    "@/runtime/self-hosted-servers"
  );
  return nativeSwitchToOrigin(null);
}

/**
 * Whether `origin` is the deployment serving the running app. In
 * remote-gateway mode the app's base carries the public path prefix, so the
 * comparison includes it.
 */
export function isCurrentOrigin(origin: RememberedOrigin): boolean {
  const currentBase = isRemoteGatewayMode()
    ? remoteGatewayPublicBaseUrl()
    : window.location.origin;
  return normalizeOriginUrl(origin.url) === currentBase;
}
