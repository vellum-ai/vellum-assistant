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
} as const;
