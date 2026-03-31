import { seedProviders } from "./oauth-store.js";

/**
 * Protocol-level seed data for each well-known OAuth provider.
 *
 * These values are upserted into the `oauth_providers` SQLite table on
 * every startup. Only Vellum implementation fields (authUrl, tokenUrl,
 * tokenEndpointAuthMethod, userinfoUrl, extraParams,
 * pingUrl, pingMethod, pingHeaders, pingBody, managedServiceConfigKey,
 * loopbackPort, injectionTemplates, appType, setupNotes,
 * identityUrl, identityMethod, identityHeaders, identityBody,
 * identityResponsePaths, identityFormat, identityOkField, featureFlag)
 * and display metadata (displayName,
 * description, dashboardUrl, clientIdPlaceholder, requiresClientSecret)
 * are overwritten on subsequent startups — user-customizable
 * fields (defaultScopes, scopePolicy) are only
 * written on initial insert and preserved across restarts.
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
    pingMethod?: string;
    pingHeaders?: Record<string, string>;
    pingBody?: unknown;
    baseUrl?: string;
    defaultScopes: string[];
    scopePolicy: {
      allowAdditionalScopes: boolean;
      allowedOptionalScopes: string[];
      forbiddenScopes: string[];
    };
    extraParams?: Record<string, string>;
    managedServiceConfigKey?: string;
    displayName: string;
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
  }
> = {
  google: {
    providerKey: "google",
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
    appType: "Desktop app",
    identityUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    identityResponsePaths: ["email"],
  },

  slack: {
    providerKey: "slack",
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
    providerKey: "notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    pingUrl: "https://api.notion.com/v1/users/me",
    pingHeaders: { "Notion-Version": "2022-06-28" },
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
    providerKey: "twitter",
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
    loopbackPort: 17335,
    injectionTemplates: [
      {
        hostPattern: "api.x.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.x.com/2/users/me",
    identityResponsePaths: ["data.username"],
    identityFormat: "@${data.username}",
  },

  github: {
    providerKey: "github",
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
    providerKey: "linear",
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    pingUrl: "https://api.linear.app/graphql",
    pingMethod: "POST",
    pingHeaders: { "Content-Type": "application/json" },
    pingBody: { query: "{ viewer { id name email } }" },
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
    loopbackPort: 17324,
    injectionTemplates: [
      {
        hostPattern: "api.linear.app",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "OAuth application",
    identityUrl: "https://api.linear.app/graphql",
    identityMethod: "POST",
    identityHeaders: { "Content-Type": "application/json" },
    identityBody: { query: "{ viewer { email name } }" },
    identityResponsePaths: ["data.viewer.email", "data.viewer.name"],
  },

  spotify: {
    providerKey: "spotify",
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
    providerKey: "todoist",
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
    providerKey: "discord",
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
    providerKey: "dropbox",
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    pingUrl: "https://api.dropboxapi.com/2/users/get_current_account",
    pingMethod: "POST",
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
    providerKey: "asana",
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
    providerKey: "airtable",
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
    providerKey: "hubspot",
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
    providerKey: "figma",
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
    providerKey: "outlook",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    pingUrl: "https://graph.microsoft.com/v1.0/me",
    baseUrl: "https://graph.microsoft.com",
    displayName: "Outlook / Microsoft",
    description: "Email and calendar",
    dashboardUrl:
      "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    clientIdPlaceholder: "Application (client) ID from Azure portal",
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
    extraParams: { prompt: "consent" },
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
    featureFlag: "outlook-oauth-integration",
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

export const SEEDED_PROVIDER_KEYS = new Set(Object.keys(PROVIDER_SEED_DATA));

/**
 * Seed the oauth_providers table with well-known provider configurations.
 * Uses INSERT … ON CONFLICT DO UPDATE so seed-data corrections propagate
 * to existing installations. Safe to call on every startup.
 */
export function seedOAuthProviders(): void {
  seedProviders(Object.values(PROVIDER_SEED_DATA));
}
