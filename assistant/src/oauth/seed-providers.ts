import { seedProviders } from "./oauth-store.js";

/**
 * Protocol-level seed data for each well-known OAuth provider.
 *
 * These values are upserted into the `oauth_providers` SQLite table on
 * every startup. Only Vellum implementation fields (authUrl, tokenUrl,
 * tokenEndpointAuthMethod, userinfoUrl, extraParams, callbackTransport,
 * pingUrl, managedServiceConfigKey) and display metadata (displayName,
 * description, dashboardUrl, clientIdPlaceholder, requiresClientSecret)
 * are overwritten on subsequent startups — user-customizable
 * fields (defaultScopes, scopePolicy, baseUrl) are only
 * written on initial insert and preserved across restarts.
 *
 * Code-side behavioral fields (identityVerifier, injectionTemplates,
 * setup, etc.) live in `provider-behaviors.ts` and are never persisted
 * to the DB.
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
    managedServiceConfigKey?: string;
    displayName: string;
    description: string;
    dashboardUrl: string | null;
    clientIdPlaceholder: string | null;
    requiresClientSecret?: boolean;
  }
> = {
  "integration:google": {
    providerKey: "integration:google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    displayName: "Google",
    description: "Gmail, Calendar, and Contacts",
    dashboardUrl: "https://console.cloud.google.com/apis/credentials",
    clientIdPlaceholder: "123456789.apps.googleusercontent.com",
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
      allowAdditionalScopes: true,
      allowedOptionalScopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ],
      forbiddenScopes: [],
    },
    extraParams: { access_type: "offline", prompt: "consent" },
    callbackTransport: "loopback",
    managedServiceConfigKey: "google-oauth",
  },

  "integration:slack": {
    providerKey: "integration:slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    pingUrl: "https://slack.com/api/auth.test",
    baseUrl: "https://slack.com/api",
    displayName: "Slack",
    description: "Workspace messaging",
    dashboardUrl: "https://api.slack.com/apps",
    clientIdPlaceholder: null,
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
  },

  "integration:notion": {
    providerKey: "integration:notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    pingUrl: "https://api.notion.com/v1/users/me",
    baseUrl: "https://api.notion.com",
    displayName: "Notion",
    description: "Pages and databases",
    dashboardUrl: "https://www.notion.so/my-integrations",
    clientIdPlaceholder: null,
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    extraParams: { owner: "user" },
    tokenEndpointAuthMethod: "client_secret_basic",
    callbackTransport: "loopback",
  },

  "integration:twitter": {
    providerKey: "integration:twitter",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    pingUrl: "https://api.x.com/2/users/me",
    baseUrl: "https://api.x.com",
    displayName: "Twitter",
    description: "Posts and direct messages",
    dashboardUrl: "https://developer.twitter.com/en/portal/dashboard",
    clientIdPlaceholder: null,
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
    managedServiceConfigKey: "twitter-oauth",
  },

  "integration:github": {
    providerKey: "integration:github",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    pingUrl: "https://api.github.com/user",
    baseUrl: "https://api.github.com",
    displayName: "GitHub",
    description: "Repositories and issues",
    dashboardUrl: "https://github.com/settings/developers",
    clientIdPlaceholder: null,
    defaultScopes: ["repo", "read:user", "notifications"],
    scopePolicy: {
      allowAdditionalScopes: true,
      allowedOptionalScopes: [
        "read:org",
        "write:discussion",
        "gist",
        "project",
      ],
      forbiddenScopes: ["delete_repo", "admin:org"],
    },
    callbackTransport: "loopback",
  },

  "integration:linear": {
    providerKey: "integration:linear",
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    pingUrl: "https://api.linear.app/graphql",
    baseUrl: "https://api.linear.app",
    displayName: "Linear",
    description: "Issues and projects",
    dashboardUrl: "https://linear.app/settings/api",
    clientIdPlaceholder: null,
    defaultScopes: ["read", "write", "issues:create"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    extraParams: { prompt: "consent" },
    callbackTransport: "loopback",
  },

  "integration:spotify": {
    providerKey: "integration:spotify",
    authUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    pingUrl: "https://api.spotify.com/v1/me",
    baseUrl: "https://api.spotify.com/v1",
    displayName: "Spotify",
    description: "Music and playlists",
    dashboardUrl: "https://developer.spotify.com/dashboard",
    clientIdPlaceholder: null,
    defaultScopes: [
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "user-read-recently-played",
      "playlist-read-private",
      "playlist-modify-public",
      "playlist-modify-private",
      "user-library-read",
      "user-library-modify",
    ],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    tokenEndpointAuthMethod: "client_secret_basic",
    callbackTransport: "loopback",
  },

  "integration:todoist": {
    providerKey: "integration:todoist",
    authUrl: "https://todoist.com/oauth/authorize",
    tokenUrl: "https://todoist.com/oauth/access_token",
    pingUrl: "https://api.todoist.com/rest/v2/projects",
    baseUrl: "https://api.todoist.com/rest/v2",
    displayName: "Todoist",
    description: "Tasks and projects",
    dashboardUrl: "https://developer.todoist.com/appconsole.html",
    clientIdPlaceholder: null,
    defaultScopes: ["data:read_write"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: ["data:delete"],
    },
    callbackTransport: "loopback",
  },

  "integration:discord": {
    providerKey: "integration:discord",
    authUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/v10/oauth2/token",
    pingUrl: "https://discord.com/api/v10/users/@me",
    baseUrl: "https://discord.com/api/v10",
    displayName: "Discord",
    description: "Servers and messages",
    dashboardUrl: "https://discord.com/developers/applications",
    clientIdPlaceholder: null,
    defaultScopes: [
      "identify",
      "guilds",
      "guilds.members.read",
      "messages.read",
    ],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: ["bot"],
      forbiddenScopes: [],
    },
    callbackTransport: "loopback",
  },

  "integration:dropbox": {
    providerKey: "integration:dropbox",
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    pingUrl: "https://api.dropboxapi.com/2/users/get_current_account",
    baseUrl: "https://api.dropboxapi.com/2",
    displayName: "Dropbox",
    description: "Files and folders",
    dashboardUrl: "https://www.dropbox.com/developers/apps",
    clientIdPlaceholder: null,
    defaultScopes: [
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
      "sharing.read",
    ],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    extraParams: { token_access_type: "offline" },
    callbackTransport: "loopback",
  },

  "integration:asana": {
    providerKey: "integration:asana",
    authUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    pingUrl: "https://app.asana.com/api/1.0/users/me",
    baseUrl: "https://app.asana.com/api/1.0",
    displayName: "Asana",
    description: "Tasks and projects",
    dashboardUrl: "https://app.asana.com/0/my-apps",
    clientIdPlaceholder: null,
    defaultScopes: ["default"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    callbackTransport: "loopback",
  },

  "integration:airtable": {
    providerKey: "integration:airtable",
    authUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    pingUrl: "https://api.airtable.com/v0/meta/whoami",
    baseUrl: "https://api.airtable.com/v0",
    displayName: "Airtable",
    description: "Bases and records",
    dashboardUrl: "https://airtable.com/create/tokens",
    clientIdPlaceholder: null,
    defaultScopes: [
      "data.records:read",
      "data.records:write",
      "schema.bases:read",
    ],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    tokenEndpointAuthMethod: "client_secret_basic",
    callbackTransport: "loopback",
  },

  "integration:hubspot": {
    providerKey: "integration:hubspot",
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    pingUrl: "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
    baseUrl: "https://api.hubapi.com",
    displayName: "HubSpot",
    description: "CRM contacts and deals",
    dashboardUrl: "https://developers.hubspot.com/",
    clientIdPlaceholder: null,
    defaultScopes: [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
      "crm.objects.companies.read",
    ],
    scopePolicy: {
      allowAdditionalScopes: true,
      allowedOptionalScopes: [
        "crm.objects.companies.write",
        "crm.objects.owners.read",
      ],
      forbiddenScopes: [],
    },
    callbackTransport: "loopback",
  },

  "integration:figma": {
    providerKey: "integration:figma",
    authUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    pingUrl: "https://api.figma.com/v1/me",
    baseUrl: "https://api.figma.com/v1",
    displayName: "Figma",
    description: "Design files and comments",
    dashboardUrl: "https://www.figma.com/developers/apps",
    clientIdPlaceholder: null,
    defaultScopes: ["files:read", "file_comments:write"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    tokenEndpointAuthMethod: "client_secret_basic",
    callbackTransport: "loopback",
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
    displayName: "Slack Channel",
    description: "Channel bot token",
    dashboardUrl: null,
    clientIdPlaceholder: null,
    requiresClientSecret: false,
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
    displayName: "Telegram",
    description: "Bot messaging",
    dashboardUrl: null,
    clientIdPlaceholder: null,
    requiresClientSecret: false,
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
