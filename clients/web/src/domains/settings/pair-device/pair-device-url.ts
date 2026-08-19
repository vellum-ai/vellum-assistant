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
  normalizePairingBaseUrl,
  resolvePublicBaseUrl,
  type PublicBaseUrlRejection,
  type PublicBaseUrlResult,
} from "@vellumai/service-contracts/remote-web-pairing";

import {
  tunnelProviderWebsiteName,
  type PublicBaseUrlRejection,
} from "@vellumai/service-contracts/remote-web-pairing";

import { t } from "@/i18n";

/**
 * Inline validation message for each rejection reason. `value` is the raw input
 * that was rejected, used to name the specific vendor for a service-website URL.
 */
export function publicBaseUrlRejectionMessage(
  reason: PublicBaseUrlRejection,
  value?: string,
): string {
  switch (reason) {
    case "unparseable":
      return t("settings:pairDeviceUrl.unparseable");
    case "loopback":
      return t("settings:pairDeviceUrl.loopback");
    case "non-https":
      return t("settings:pairDeviceUrl.nonHttps");
    case "service-website": {
      const service =
        (value && tunnelProviderWebsiteName(value)) ||
        t("settings:pairDeviceUrl.serviceFallbackName");
      return t("settings:pairDeviceUrl.serviceWebsite", { service });
    }
  }
}
