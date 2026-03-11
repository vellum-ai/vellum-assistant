/**
 * Shared OAuth provider profile registry.
 *
 * Contains well-known OAuth provider configurations ported from vault.ts,
 * plus new providers (e.g. Twitter). This module is the single source of
 * truth for provider metadata — both the credential vault tool and the
 * future OAuth orchestrator consume it.
 */

import type {
  OAuthProviderProfile,
  OAuthScopePolicy,
} from "./connect-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default scope policy: no additional scopes allowed, none forbidden. */
const DEFAULT_SCOPE_POLICY: OAuthScopePolicy = {
  allowAdditionalScopes: false,
  allowedOptionalScopes: [],
  forbiddenScopes: [],
};

// ---------------------------------------------------------------------------
// Provider profiles
// ---------------------------------------------------------------------------

export const PROVIDER_PROFILES: Record<string, OAuthProviderProfile> = {
  "integration:gmail": {
    service: "integration:gmail",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
    scopePolicy: DEFAULT_SCOPE_POLICY,
    userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
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
    extraParams: { access_type: "offline", prompt: "consent" },
    callbackTransport: "loopback",
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
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: [
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:read",
      "im:history",
      "im:write",
      "mpim:read",
      "mpim:history",
      "users:read",
      "chat:write",
      "search:read",
      "reactions:write",
    ],
    scopePolicy: DEFAULT_SCOPE_POLICY,
    extraParams: {
      user_scope:
        "channels:read,channels:history,groups:read,groups:history,im:read,im:history,im:write,mpim:read,mpim:history,users:read,chat:write,search:read,reactions:write",
    },
    callbackTransport: "loopback",
    loopbackPort: 17322,
  },

  "integration:notion": {
    service: "integration:notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    defaultScopes: [],
    scopePolicy: DEFAULT_SCOPE_POLICY,
    extraParams: { owner: "user" },
    tokenEndpointAuthMethod: "client_secret_basic",
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
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    defaultScopes: [
      "tweet.read",
      "tweet.write",
      "users.read",
      "offline.access",
    ],
    scopePolicy: DEFAULT_SCOPE_POLICY,
    tokenEndpointAuthMethod: "client_secret_basic",
    callbackTransport: "gateway",
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
 * prefix for providers registered in PROVIDER_PROFILES without a
 * SERVICE_ALIASES entry.
 */
export function resolveService(service: string): string {
  if (SERVICE_ALIASES[service]) return SERVICE_ALIASES[service];
  if (!service.includes(":") && PROVIDER_PROFILES[`integration:${service}`])
    return `integration:${service}`;
  return service;
}

/** Look up a provider profile by canonical service name. */
export function getProviderProfile(
  service: string,
): OAuthProviderProfile | undefined {
  return PROVIDER_PROFILES[service];
}
