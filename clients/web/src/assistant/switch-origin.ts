/**
 * Origin switching for the assistant chooser. A remembered origin is a
 * separate SPA deployment, so selecting one is a full navigation to that
 * base, not an in-app route change. Kept dependency-light: native shells
 * fork this module for their own navigation primitive.
 */

import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import {
  normalizeOriginUrl,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";
import { routes } from "@/utils/routes";

/**
 * Navigate to the SPA root at the origin's base. An unpaired or expired
 * session bounces to that origin's own pair page via its resolver, which is
 * the intended degraded state.
 */
export function switchToOrigin(origin: RememberedOrigin): void {
  window.location.assign(`${origin.url}${routes.assistant}`);
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
