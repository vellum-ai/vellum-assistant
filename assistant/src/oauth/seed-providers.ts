import { seedProviders } from "./oauth-store.js";

/**
 * Protocol-level seed data for each well-known OAuth provider.
 *
 * These values are upserted into the `oauth_providers` SQLite table on
 * every startup. Only Vellum implementation fields (authorizeUrl, tokenExchangeUrl,
 * refreshUrl, tokenEndpointAuthMethod, userinfoUrl, authorizeParams,
 * pingUrl, pingMethod, pingHeaders, pingBody, revokeUrl, revokeBodyTemplate,
 * managedServiceConfigKey,
 * loopbackPort, injectionTemplates, appType, setupNotes,
 * identityUrl, identityMethod, identityHeaders, identityBody,
 * identityResponsePaths, identityFormat, identityOkField, featureFlag,
 * scopeSeparator)
 * and display metadata (displayLabel,
 * description, dashboardUrl, clientIdPlaceholder, requiresClientSecret,
 * logoUrl)
 * are overwritten on subsequent startups — user-customizable
 * fields (defaultScopes, scopePolicy) are only
 * written on initial insert and preserved across restarts.
 */
export const PROVIDER_SEED_DATA: Record<
  string,
  {
    provider: string;
    authorizeUrl: string;
    tokenExchangeUrl: string;
    refreshUrl?: string;
    tokenEndpointAuthMethod?: string;
    tokenExchangeBodyFormat?: string;
    userinfoUrl?: string;
    pingUrl?: string;
    pingMethod?: string;
    pingHeaders?: Record<string, string>;
    pingBody?: unknown;
    revokeUrl?: string;
    revokeBodyTemplate?: Record<string, string>;
    baseUrl?: string;
    defaultScopes: string[];
    scopePolicy: {
      allowAdditionalScopes: boolean;
      allowedOptionalScopes: string[];
      forbiddenScopes: string[];
    };
    scopeSeparator?: string;
    authorizeParams?: Record<string, string>;
    managedServiceConfigKey?: string;
    displayLabel: string;
    description: string;
    dashboardUrl: string | null;
    clientIdPlaceholder: string | null;
    requiresClientSecret?: boolean;
    loopbackPort?: number;
    injectionTemplates?: Array<{
      hostPattern: string;
      injectionType: string;
      headerName: string;
      valuePrefix: string;
    }>;
    appType?: string;
    setupNotes?: string[];
    identityUrl?: string;
    identityMethod?: string;
    identityHeaders?: Record<string, string>;
    identityBody?: unknown;
    identityResponsePaths?: string[];
    identityFormat?: string;
    identityOkField?: string;
    featureFlag?: string;
    logoUrl?: string;
  }
> = {
  google: {
    provider: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenExchangeUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    displayLabel: "Google",
    description: "Gmail, Calendar, and Contacts",
    dashboardUrl: "https://console.cloud.google.com/apis/credentials",
    clientIdPlaceholder: "123456789.apps.googleusercontent.com",
    logoUrl: "https://cdn.simpleicons.org/google",
    defaultScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.settings.basic",
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
    authorizeParams: { access_type: "offline", prompt: "consent" },
    loopbackPort: 17321,
    managedServiceConfigKey: "google-oauth",
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
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    revokeBodyTemplate: { token: "{access_token}" },
    appType: "Desktop app",
    identityUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    identityResponsePaths: ["email"],
  },

  slack: {
    provider: "slack",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenExchangeUrl: "https://slack.com/api/oauth.v2.access",
    pingUrl: "https://slack.com/api/auth.test",
    baseUrl: "https://slack.com/api",
    displayLabel: "Slack",
    description: "Workspace messaging",
    dashboardUrl: "https://api.slack.com/apps",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/slack",
    defaultScopes: [
      "channels:join",
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
    authorizeParams: {
      user_scope:
        "channels:read,channels:history,groups:read,groups:history,im:read,im:history,im:write,mpim:read,mpim:history,users:read,chat:write,search:read,reactions:write",
    },
    loopbackPort: 17322,
    injectionTemplates: [
      {
        hostPattern: "slack.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "Slack App",
    identityUrl: "https://slack.com/api/auth.test",
    identityOkField: "ok",
    identityResponsePaths: ["user", "team"],
    identityFormat: "@${user} (${team})",
  },

  notion: {
    provider: "notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenExchangeUrl: "https://api.notion.com/v1/oauth/token",
    pingUrl: "https://api.notion.com/v1/users/me",
    pingHeaders: { "Notion-Version": "2022-06-28" },
    baseUrl: "https://api.notion.com",
    displayLabel: "Notion",
    description: "Pages and databases",
    dashboardUrl: "https://www.notion.so/my-integrations",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/notion",
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    authorizeParams: { owner: "user" },
    tokenEndpointAuthMethod: "client_secret_basic",
    tokenExchangeBodyFormat: "json",
    managedServiceConfigKey: "notion-oauth",
    loopbackPort: 17323,
    injectionTemplates: [
      {
        hostPattern: "api.notion.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "Public integration",
    identityUrl: "https://api.notion.com/v1/users/me",
    identityHeaders: { "Notion-Version": "2022-06-28" },
    identityResponsePaths: ["name", "person.email"],
  },

  twitter: {
    provider: "twitter",
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenExchangeUrl: "https://api.x.com/2/oauth2/token",
    pingUrl: "https://api.x.com/2/users/me",
    baseUrl: "https://api.x.com",
    displayLabel: "Twitter",
    description: "Posts and direct messages",
    dashboardUrl: "https://developer.twitter.com/en/portal/dashboard",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/x",
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
    loopbackPort: 17335,
    managedServiceConfigKey: "twitter-oauth",
    featureFlag: "managed-x-oauth-integration",
    injectionTemplates: [
      {
        hostPattern: "api.x.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    revokeUrl: "https://api.x.com/2/oauth2/revoke",
    revokeBodyTemplate: {
      token: "{access_token}",
      token_type_hint: "access_token",
      client_id: "{client_id}",
    },
    appType: "App",
    identityUrl: "https://api.x.com/2/users/me",
    identityResponsePaths: ["data.username"],
    identityFormat: "@${data.username}",
  },

  github: {
    provider: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenExchangeUrl: "https://github.com/login/oauth/access_token",
    pingUrl: "https://api.github.com/user",
    baseUrl: "https://api.github.com",
    displayLabel: "GitHub",
    description: "Repositories and issues",
    dashboardUrl: "https://github.com/settings/developers",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/github",
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
    managedServiceConfigKey: "github-oauth",
    loopbackPort: 17332,
    injectionTemplates: [
      {
        hostPattern: "api.github.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "OAuth App",
    identityUrl: "https://api.github.com/user",
    identityResponsePaths: ["login"],
    identityFormat: "@${login}",
  },

  linear: {
    provider: "linear",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenExchangeUrl: "https://api.linear.app/oauth/token",
    pingUrl: "https://api.linear.app/graphql",
    pingMethod: "POST",
    pingHeaders: { "Content-Type": "application/json" },
    pingBody: { query: "{ viewer { id name email } }" },
    baseUrl: "https://api.linear.app",
    displayLabel: "Linear",
    description: "Issues and projects",
    dashboardUrl: "https://linear.app/settings/api",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/linear",
    defaultScopes: ["read", "write", "issues:create"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    scopeSeparator: ",",
    authorizeParams: { prompt: "consent" },
    loopbackPort: 17324,
    managedServiceConfigKey: "linear-oauth",
    injectionTemplates: [
      {
        hostPattern: "api.linear.app",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    revokeUrl: "https://api.linear.app/oauth/revoke",
    revokeBodyTemplate: { token: "{access_token}" },
    appType: "OAuth application",
    identityUrl: "https://api.linear.app/graphql",
    identityMethod: "POST",
    identityHeaders: { "Content-Type": "application/json" },
    identityBody: { query: "{ viewer { email name } }" },
    identityResponsePaths: ["data.viewer.email", "data.viewer.name"],
  },

  spotify: {
    provider: "spotify",
    authorizeUrl: "https://accounts.spotify.com/authorize",
    tokenExchangeUrl: "https://accounts.spotify.com/api/token",
    pingUrl: "https://api.spotify.com/v1/me",
    baseUrl: "https://api.spotify.com/v1",
    displayLabel: "Spotify",
    description: "Music and playlists",
    dashboardUrl: "https://developer.spotify.com/dashboard",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/spotify",
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
    loopbackPort: 17333,
    injectionTemplates: [
      {
        hostPattern: "api.spotify.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.spotify.com/v1/me",
    identityResponsePaths: ["display_name", "email"],
  },

  todoist: {
    provider: "todoist",
    authorizeUrl: "https://todoist.com/oauth/authorize",
    tokenExchangeUrl: "https://todoist.com/oauth/access_token",
    pingUrl: "https://api.todoist.com/rest/v2/projects",
    baseUrl: "https://api.todoist.com/rest/v2",
    displayLabel: "Todoist",
    description: "Tasks and projects",
    dashboardUrl: "https://developer.todoist.com/appconsole.html",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/todoist",
    defaultScopes: ["data:read_write"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: ["data:delete"],
    },
    loopbackPort: 17325,
    injectionTemplates: [
      {
        hostPattern: "api.todoist.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.todoist.com/sync/v9/sync",
    identityMethod: "POST",
    identityHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
    identityBody: "sync_token=*&resource_types=[%22user%22]",
    identityResponsePaths: ["user.full_name", "user.email"],
  },

  discord: {
    provider: "discord",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenExchangeUrl: "https://discord.com/api/v10/oauth2/token",
    pingUrl: "https://discord.com/api/v10/users/@me",
    baseUrl: "https://discord.com/api/v10",
    displayLabel: "Discord",
    description: "Servers and messages",
    dashboardUrl: "https://discord.com/developers/applications",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/discord",
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
    loopbackPort: 17326,
    injectionTemplates: [
      {
        hostPattern: "discord.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "Application",
    identityUrl: "https://discord.com/api/v10/users/@me",
    identityResponsePaths: ["global_name", "username"],
  },

  dropbox: {
    provider: "dropbox",
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenExchangeUrl: "https://api.dropboxapi.com/oauth2/token",
    pingUrl: "https://api.dropboxapi.com/2/users/get_current_account",
    pingMethod: "POST",
    baseUrl: "https://api.dropboxapi.com/2",
    displayLabel: "Dropbox",
    description: "Files and folders",
    dashboardUrl: "https://www.dropbox.com/developers/apps",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/dropbox",
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
    authorizeParams: { token_access_type: "offline" },
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
    appType: "Scoped access app",
    identityUrl: "https://api.dropboxapi.com/2/users/get_current_account",
    identityMethod: "POST",
    identityResponsePaths: ["name.display_name", "email"],
  },

  asana: {
    provider: "asana",
    authorizeUrl: "https://app.asana.com/-/oauth_authorize",
    tokenExchangeUrl: "https://app.asana.com/-/oauth_token",
    pingUrl: "https://app.asana.com/api/1.0/users/me",
    baseUrl: "https://app.asana.com/api/1.0",
    displayLabel: "Asana",
    description: "Tasks and projects",
    dashboardUrl: "https://app.asana.com/0/my-apps",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/asana",
    defaultScopes: ["default"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    loopbackPort: 17328,
    injectionTemplates: [
      {
        hostPattern: "app.asana.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://app.asana.com/api/1.0/users/me",
    identityResponsePaths: ["data.name", "data.email"],
  },

  airtable: {
    provider: "airtable",
    authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenExchangeUrl: "https://airtable.com/oauth2/v1/token",
    pingUrl: "https://api.airtable.com/v0/meta/whoami",
    baseUrl: "https://api.airtable.com/v0",
    displayLabel: "Airtable",
    description: "Bases and records",
    dashboardUrl: "https://airtable.com/create/tokens",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/airtable",
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
    loopbackPort: 17329,
    injectionTemplates: [
      {
        hostPattern: "api.airtable.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "OAuth integration",
    identityUrl: "https://api.airtable.com/v0/meta/whoami",
    identityResponsePaths: ["email"],
  },

  hubspot: {
    provider: "hubspot",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenExchangeUrl: "https://api.hubapi.com/oauth/v1/token",
    pingUrl: "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
    baseUrl: "https://api.hubapi.com",
    displayLabel: "HubSpot",
    description: "CRM contacts and deals",
    dashboardUrl: "https://developers.hubspot.com/",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/hubspot",
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
    loopbackPort: 17330,
    injectionTemplates: [
      {
        hostPattern: "api.hubapi.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}",
    identityResponsePaths: ["user", "hub_domain"],
  },

  figma: {
    provider: "figma",
    authorizeUrl: "https://www.figma.com/oauth",
    tokenExchangeUrl: "https://api.figma.com/v1/oauth/token",
    pingUrl: "https://api.figma.com/v1/me",
    baseUrl: "https://api.figma.com/v1",
    displayLabel: "Figma",
    description: "Design files and comments",
    dashboardUrl: "https://www.figma.com/developers/apps",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/figma",
    defaultScopes: ["files:read", "file_comments:write"],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
    tokenEndpointAuthMethod: "client_secret_basic",
    loopbackPort: 17331,
    injectionTemplates: [
      {
        hostPattern: "api.figma.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.figma.com/v1/me",
    identityResponsePaths: ["handle", "email"],
  },

  outlook: {
    provider: "outlook",
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenExchangeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    pingUrl: "https://graph.microsoft.com/v1.0/me",
    baseUrl: "https://graph.microsoft.com",
    displayLabel: "Outlook / Microsoft",
    description: "Email and calendar",
    dashboardUrl:
      "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    clientIdPlaceholder: "Application (client) ID from Azure portal",
    logoUrl: "https://cdn.simpleicons.org/microsoftoutlook",
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.Read",
      "Calendars.ReadWrite",
      "MailboxSettings.ReadWrite",
    ],
    scopePolicy: {
      allowAdditionalScopes: true,
      allowedOptionalScopes: ["Contacts.Read", "Files.Read", "Tasks.ReadWrite"],
      forbiddenScopes: [],
    },
    authorizeParams: { prompt: "consent" },
    tokenEndpointAuthMethod: "client_secret_post",
    loopbackPort: 17334,
    managedServiceConfigKey: "outlook-oauth",
    injectionTemplates: [
      {
        hostPattern: "graph.microsoft.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App registration",
    identityUrl: "https://graph.microsoft.com/v1.0/me",
    identityResponsePaths: ["mail", "userPrincipalName"],
  },

  // Manual-token providers: these don't use OAuth2 flows but need provider
  // rows so that oauth_app and oauth_connection FK chains can reference them.
  // The authorizeUrl/tokenExchangeUrl values are placeholders — never used at runtime.
  slack_channel: {
    provider: "slack_channel",
    authorizeUrl: "urn:manual-token",
    tokenExchangeUrl: "urn:manual-token",
    pingUrl: "https://slack.com/api/auth.test",
    baseUrl: "https://slack.com/api",
    displayLabel: "Slack Channel",
    description: "Channel bot token",
    dashboardUrl: null,
    clientIdPlaceholder: null,
    requiresClientSecret: false,
    logoUrl: "https://cdn.simpleicons.org/slack",
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
  },

  telegram: {
    provider: "telegram",
    authorizeUrl: "urn:manual-token",
    tokenExchangeUrl: "urn:manual-token",
    baseUrl: "https://api.telegram.org",
    displayLabel: "Telegram",
    description: "Bot messaging",
    dashboardUrl: null,
    clientIdPlaceholder: null,
    requiresClientSecret: false,
    logoUrl: "https://cdn.simpleicons.org/telegram",
    defaultScopes: [],
    scopePolicy: {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
  },
};

export const SEEDED_PROVIDER_KEYS = new Set(Object.keys(PROVIDER_SEED_DATA));

/**
 * Seed the oauth_providers table with well-known provider configurations.
 * Uses INSERT … ON CONFLICT DO UPDATE so seed-data corrections propagate
 * to existing installations. Safe to call on every startup.
 */
export function seedOAuthProviders(): void {
  seedProviders(Object.values(PROVIDER_SEED_DATA));
}
