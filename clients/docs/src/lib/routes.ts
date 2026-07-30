/**
 * URL registry for the docs app — only what docs pages consume.
 * Internal paths are cast `as Route` (the legal pages land in later PRs of
 * this migration); app destinations are cross-app absolute URLs.
 */

import type { Route } from "next";

import { WWW_DOMAIN } from "@/lib/domains";

export const routes = {
  docs: {
    legal: {
      privacyPolicy: "/docs/privacy-policy" as Route,
      termsOfUse: "/docs/vellum-terms-of-use" as Route,
      prohibitedUse: "/docs/prohibited-use" as Route,
      privacyAndData: "/docs/trust-security/privacy-and-data" as Route,
    },
  },

  // Cross-app destinations served by other Vellum apps.
  signup: `https://${WWW_DOMAIN}/account/signup`,
  login: `https://${WWW_DOMAIN}/account/login`,
  assistant: `https://${WWW_DOMAIN}/assistant`,
} as const;
