import { seedProviders } from "./oauth-store.js";

/**
 * Protocol-level seed data for each well-known OAuth provider.
 *
 * These values are upserted into the `oauth_providers` SQLite table on
 * every startup so that corrections (e.g. a fixed baseUrl) propagate to
 * existing installations. Code-side behavioral fields (identityVerifier,
 * injectionTemplates, setup, etc.) live in `provider-behaviors.ts` and
 * are never persisted to the DB.
 */
const PROVIDER_SEED_DATA: Record<
  string,
  {
    providerKey: string;
    authUrl: string;
    tokenUrl: string;
    tokenEndpointAuthMethod?: string;
    userinfoUrl?: string;
    pingUrl?: string;
    baseUrl?: string;
    defaultScopes: string[];
    scopePolicy: {
      allowAdditionalScopes: boolean;
      allowedOptionalScopes: string[];
      forbiddenScopes: string[];
    };
    extraParams?: Record<string, string>;
    callbackTransport?: string;
    loopbackPort?: number;
  }
> = {
  "integration:gmail": {
    providerKey: "integration:gmail",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    defaultScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    extraParams: { access_type: "offline", prompt: "consent" },
    callbackTransport: "loopback",
  },

  "integration:slack": {
    providerKey: "integration:slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    pingUrl: "https://slack.com/api/auth.test",
    baseUrl: "https://slack.com/api",
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
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    extraParams: {
      user_scope:
        "channels:read,channels:history,groups:read,groups:history,im:read,im:history,im:write,mpim:read,mpim:history,users:read,chat:write,search:read,reactions:write",
    },
    callbackTransport: "loopback",
    loopbackPort: 17322,
  },

  "integration:notion": {
    providerKey: "integration:notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    pingUrl: "https://api.notion.com/v1/users/me",
    baseUrl: "https://api.notion.com",
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    extraParams: { owner: "user" },
    tokenEndpointAuthMethod: "client_secret_basic",
  },

  "integration:twitter": {
    providerKey: "integration:twitter",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    pingUrl: "https://api.x.com/2/users/me",
    baseUrl: "https://api.x.com",
    defaultScopes: [
      "tweet.read",
      "tweet.write",
      "users.read",
      "offline.access",
    ],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    tokenEndpointAuthMethod: "client_secret_basic",
    callbackTransport: "gateway",
  },

  // Manual-token providers: these don't use OAuth2 flows but need provider
  // rows so that oauth_app and oauth_connection FK chains can reference them.
  // The authUrl/tokenUrl values are placeholders — never used at runtime.
  slack_channel: {
    providerKey: "slack_channel",
    authUrl: "urn:manual-token",
    tokenUrl: "urn:manual-token",
    pingUrl: "https://slack.com/api/auth.test",
    baseUrl: "https://slack.com/api",
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
  },

  telegram: {
    providerKey: "telegram",
    authUrl: "urn:manual-token",
    tokenUrl: "urn:manual-token",
    baseUrl: "https://api.telegram.org",
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
  },
};

/**
 * Seed the oauth_providers table with well-known provider configurations.
 * Uses INSERT … ON CONFLICT DO UPDATE so seed-data corrections propagate
 * to existing installations. Safe to call on every startup.
 */
export function seedOAuthProviders(): void {
  seedProviders(Object.values(PROVIDER_SEED_DATA));
}
