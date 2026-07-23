/**
 * Public-URL validation and pair-link construction for the "Pair a device"
 * settings section. The implementations live in
 * `@vellumai/service-contracts/remote-web-pairing` and are shared with the
 * `vellum pair --qr` CLI flow, so both mints accept the same URLs and produce
 * the same pair links. This module re-exports them and adds the UI copy.
 */

export {
  buildRemoteWebPairingUrl,
  isLoopbackPublicUrl as isLoopbackUrl,
  normalizePublicBaseUrl,
  resolvePublicBaseUrl,
  type PublicBaseUrlRejection,
  type PublicBaseUrlResult,
} from "@vellumai/service-contracts/remote-web-pairing";

import type { PublicBaseUrlRejection } from "@vellumai/service-contracts/remote-web-pairing";

/** Inline validation message for each rejection reason. */
export function publicBaseUrlRejectionMessage(
  reason: PublicBaseUrlRejection,
): string {
  switch (reason) {
    case "unparseable":
      return "Enter a valid URL, e.g. https://your-assistant.ts.net.";
    case "loopback":
      return "This is a loopback address your phone can't reach. Enter the assistant's public https URL.";
    case "non-https":
      return "The URL must use https so your phone can connect securely.";
  }
}

