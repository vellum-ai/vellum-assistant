/**
 * URL registry for the docs app: only what docs pages consume.
 * Internal paths are typedRoutes-verified at each Link callsite;
 * app destinations are cross-app absolute URLs.
 */

import { WWW_DOMAIN } from "@/lib/domains";

export const routes = {
  docs: {
    legal: {
      privacyPolicy: "/docs/privacy-policy",
      termsOfUse: "/docs/vellum-terms-of-use",
      prohibitedUse: "/docs/prohibited-use",
      privacyAndData: "/docs/trust-security/privacy-and-data",
    },
  },

  // Cross-app destinations served by other Vellum apps.
  signup: `https://${WWW_DOMAIN}/account/signup`,
  login: `https://${WWW_DOMAIN}/account/login`,
  assistant: `https://${WWW_DOMAIN}/assistant`,
  plugins: `https://${WWW_DOMAIN}/plugins`,
  downloads: `https://${WWW_DOMAIN}/downloads`,
  iosAppStore: "https://apps.apple.com/us/app/vellum-assistant/id6759934423",
  androidPlayStore:
    "https://play.google.com/store/apps/details?id=ai.vellum.assistant",
  chromeWebStore:
    "https://chromewebstore.google.com/detail/vellum-assistant-browser/hphbdmpffeigpcdjkckleobjmhhokpne",
} as const;
