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

const PROVIDER_BEHAVIORS: Record<string, OAuthProviderBehavior> = {
  "integration:google": {
    service: "integration:google",
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
    loopbackPort: 17322,
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
    loopbackPort: 17323,
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
  "integration:github": {
    service: "integration:github",
    loopbackPort: 17332,
    injectionTemplates: [
      {
        hostPattern: "api.github.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "github-oauth-setup",
    setup: {
      displayName: "GitHub",
      dashboardUrl: "https://github.com/settings/developers",
      appType: "OAuth App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as { login?: string };
          return body.login ? `@${body.login}` : undefined;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:linear": {
    service: "integration:linear",
    loopbackPort: 17324,
    injectionTemplates: [
      {
        hostPattern: "api.linear.app",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "linear-oauth-setup",
    setup: {
      displayName: "Linear",
      dashboardUrl: "https://linear.app/settings/api",
      appType: "OAuth application",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: "{ viewer { email name } }" }),
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            data?: { viewer?: { email?: string; name?: string } };
          };
          return body.data?.viewer?.email ?? body.data?.viewer?.name;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:spotify": {
    service: "integration:spotify",
    loopbackPort: 17333,
    injectionTemplates: [
      {
        hostPattern: "api.spotify.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "spotify-oauth-setup",
    setup: {
      displayName: "Spotify",
      dashboardUrl: "https://developer.spotify.com/dashboard",
      appType: "App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.spotify.com/v1/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            display_name?: string;
            email?: string;
          };
          return body.display_name ?? body.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:todoist": {
    service: "integration:todoist",
    loopbackPort: 17325,
    injectionTemplates: [
      {
        hostPattern: "api.todoist.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "todoist-oauth-setup",
    setup: {
      displayName: "Todoist",
      dashboardUrl: "https://developer.todoist.com/appconsole.html",
      appType: "App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.todoist.com/sync/v9/sync", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "sync_token=*&resource_types=[%22user%22]",
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            user?: { email?: string; full_name?: string };
          };
          return body.user?.full_name ?? body.user?.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:discord": {
    service: "integration:discord",
    loopbackPort: 17326,
    injectionTemplates: [
      {
        hostPattern: "discord.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "discord-oauth-setup",
    setup: {
      displayName: "Discord",
      dashboardUrl: "https://discord.com/developers/applications",
      appType: "Application",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            username?: string;
            global_name?: string;
          };
          return body.global_name ?? body.username;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:dropbox": {
    service: "integration:dropbox",
    loopbackPort: 17327,
    injectionTemplates: [
      {
        hostPattern: "api.dropboxapi.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "content.dropboxapi.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "dropbox-oauth-setup",
    setup: {
      displayName: "Dropbox",
      dashboardUrl: "https://www.dropbox.com/developers/apps",
      appType: "Scoped access app",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch(
          "https://api.dropboxapi.com/2/users/get_current_account",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        if (resp.ok) {
          const body = (await resp.json()) as {
            name?: { display_name?: string };
            email?: string;
          };
          return body.name?.display_name ?? body.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:asana": {
    service: "integration:asana",
    loopbackPort: 17328,
    injectionTemplates: [
      {
        hostPattern: "app.asana.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "asana-oauth-setup",
    setup: {
      displayName: "Asana",
      dashboardUrl: "https://app.asana.com/0/my-apps",
      appType: "App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://app.asana.com/api/1.0/users/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            data?: { name?: string; email?: string };
          };
          return body.data?.name ?? body.data?.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:airtable": {
    service: "integration:airtable",
    loopbackPort: 17329,
    injectionTemplates: [
      {
        hostPattern: "api.airtable.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "airtable-oauth-setup",
    setup: {
      displayName: "Airtable",
      dashboardUrl: "https://airtable.com/create/oauth",
      appType: "OAuth integration",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.airtable.com/v0/meta/whoami", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as { email?: string };
          return body.email;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:hubspot": {
    service: "integration:hubspot",
    loopbackPort: 17330,
    injectionTemplates: [
      {
        hostPattern: "api.hubapi.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "hubspot-oauth-setup",
    setup: {
      displayName: "HubSpot",
      dashboardUrl: "https://app.hubspot.com/developer",
      appType: "App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch(
          "https://api.hubapi.com/oauth/v1/access-tokens/" + accessToken,
        );
        if (resp.ok) {
          const body = (await resp.json()) as {
            user?: string;
            hub_domain?: string;
          };
          return body.user ?? body.hub_domain;
        }
      } catch {
        // Non-fatal — identity verification is best-effort
      }
      return undefined;
    },
  },

  "integration:figma": {
    service: "integration:figma",
    loopbackPort: 17331,
    injectionTemplates: [
      {
        hostPattern: "api.figma.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    setupSkillId: "figma-oauth-setup",
    setup: {
      displayName: "Figma",
      dashboardUrl: "https://www.figma.com/developers/apps",
      appType: "App",
      requiresClientSecret: true,
    },
    identityVerifier: async (
      accessToken: string,
    ): Promise<string | undefined> => {
      try {
        const resp = await fetch("https://api.figma.com/v1/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (resp.ok) {
          const body = (await resp.json()) as {
            handle?: string;
            email?: string;
          };
          return body.handle ?? body.email;
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
  gmail: "integration:google",
  google: "integration:google",
  slack: "integration:slack",
  notion: "integration:notion",
  twitter: "integration:twitter",
  github: "integration:github",
  linear: "integration:linear",
  spotify: "integration:spotify",
  todoist: "integration:todoist",
  discord: "integration:discord",
  dropbox: "integration:dropbox",
  asana: "integration:asana",
  airtable: "integration:airtable",
  hubspot: "integration:hubspot",
  figma: "integration:figma",
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
