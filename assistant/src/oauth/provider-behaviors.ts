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
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch(
          "https://www.googleapis.com/oauth2/v2/userinfo",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        if (resp.ok) {
          const body = (await resp.json()) as {
            email?: string;
            name?: string;
          };
          return body.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:slack": {
    service: "integration:slack",
    injectionTemplates: [
      {
        hostPattern: "slack.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "slack-oauth-setup",
    setup: {
      displayName: "Slack",
      dashboardUrl: "https://api.slack.com/apps",
      appType: "Slack App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            ok: boolean;
            user?: string;
            team?: string;
          };
          if (!body.ok) return undefined;
          if (body.user && body.team) return `@${body.user} (${body.team})`;
          if (body.user) return `@${body.user}`;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
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
    setupSkillId: "notion-oauth-setup",
    setup: {
      displayName: "Notion",
      dashboardUrl: "https://www.notion.so/profile/integrations",
      appType: "Public integration",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.notion.com/v1/users/me", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Notion-Version": "2022-06-28",
          },
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            name?: string;
            type?: string;
            person?: { email?: string };
          };
          return body.name ?? body.person?.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:twitter": {
    service: "integration:twitter",
    injectionTemplates: [
      {
        hostPattern: "api.x.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "twitter-oauth-setup",
    setup: {
      displayName: "Twitter / X",
      dashboardUrl: "https://developer.x.com/en/portal/dashboard",
      appType: "App",
      requiresClientSecret: true,
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
