/**
 * OAuth provider behavior registry.
 *
 * Contains code-side behavioral configuration for well-known OAuth
 * providers. Protocol-level fields (authUrl, tokenUrl, scopes, etc.)
 * are stored in the `oauth_providers` SQLite table and seeded by
 * `seed-providers.ts`. This module contains only fields that require
 * code references (functions, templates, skill IDs) and cannot be
 * serialised to a DB row.
 */

import type { OAuthProviderBehavior } from "./connect-types.js";

// ---------------------------------------------------------------------------
// Provider behaviors
// ---------------------------------------------------------------------------

export const PROVIDER_BEHAVIORS: Record<string, OAuthProviderBehavior> = {
  "integration:gmail": {
    service: "integration:gmail",
    // Google APIs for Gmail/Calendar/Contacts span multiple hosts; register
    // all of them so proxied bash can inject the OAuth bearer token reliably.
    injectionTemplates: [
      {
        hostPattern: "gmail.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "www.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "people.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "google-oauth-applescript",
    setup: {
      displayName: "Google (Gmail & Calendar)",
      dashboardUrl: "https://console.cloud.google.com/apis/credentials",
      appType: "Desktop app",
      requiresClientSecret: true,
    },
  },

  "integration:slack": {
    service: "integration:slack",
  },

  "integration:notion": {
    service: "integration:notion",
    injectionTemplates: [
      {
        hostPattern: "api.notion.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
  },

  "integration:twitter": {
    service: "integration:twitter",
    setup: {
      displayName: "Twitter / X",
      dashboardUrl: "https://developer.x.com/en/portal/dashboard",
      appType: "App",
      requiresClientSecret: false,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.x.com/2/users/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as { data?: { username?: string } };
          return body.data?.username ? `@${body.data.username}` : undefined;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },
};

// ---------------------------------------------------------------------------
// Aliases & resolution
// ---------------------------------------------------------------------------

/** Map shorthand aliases to canonical service names. */
export const SERVICE_ALIASES: Record<string, string> = {
  gmail: "integration:gmail",
  slack: "integration:slack",
  notion: "integration:notion",
  twitter: "integration:twitter",
};

/**
 * Resolve a service name through aliases, then fall back to `integration:`
 * prefix for providers registered in PROVIDER_BEHAVIORS without a
 * SERVICE_ALIASES entry.
 */
export function resolveService(service: string): string {
  if (SERVICE_ALIASES[service]) return SERVICE_ALIASES[service];
  if (!service.includes(":") && PROVIDER_BEHAVIORS[`integration:${service}`])
    return `integration:${service}`;
  return service;
}

/** Look up a provider behavior by canonical service name. */
export function getProviderBehavior(
  service: string,
): OAuthProviderBehavior | undefined {
  return PROVIDER_BEHAVIORS[service];
}
