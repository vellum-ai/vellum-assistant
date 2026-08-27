import type { AvailableScopes } from "./connect-types.js";
import { migrateProviderBaseUrl, seedProviders } from "./oauth-store.js";

/**
 * Base URL the google provider was seeded with before it multiplexed products
 * behind the host-only `https://www.googleapis.com` base. Rows carrying exactly
 * this value are advanced to the current default on startup; user-customized
 * base URLs are left alone.
 */
const STALE_GOOGLE_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Protocol-level seed data for each well-known OAuth provider.
 *
 * These values are upserted into the `oauth_providers` SQLite table on
 * every startup. Only Vellum implementation fields (authorizeUrl, tokenExchangeUrl,
 * refreshUrl, tokenEndpointAuthMethod, userinfoUrl, authorizeParams,
 * pingUrl, pingMethod, pingHeaders, pingBody, revokeUrl, revokeBodyTemplate,
 * managedServiceConfigKey, managedServiceIsPaid,
 * loopbackPort, injectionTemplates, appType, setupNotes,
 * identityUrl, identityMethod, identityHeaders, identityBody,
 * identityResponsePaths, identityFormat, identityOkField, featureFlag,
 * scopeSeparator)
 * and display metadata (displayLabel,
 * description, dashboardUrl, clientIdPlaceholder, requiresClientSecret,
 * logoUrl)
 * are overwritten on subsequent startups.
 * defaultScopes and availableScopes are also overwritten on subsequent
 * startups so that upstream scope additions (e.g. new Gmail API scopes)
 * propagate to existing installations.
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
    availableScopes?: AvailableScopes;
    scopeSeparator?: string;
    authorizeParams?: Record<string, string>;
    managedServiceConfigKey?: string;
    managedServiceIsPaid?: boolean;
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
    // Google multiplexes many products behind one OAuth token, each on its own
    // path under the generic API host: Gmail (/gmail/v1/...), Calendar
    // (/calendar/v3/...), Drive (/drive/v3/...), userinfo (/oauth2/v2/...).
    // A host-only base URL lets a relative request path select the product,
    // so `oauth request --provider google /calendar/v3/...` resolves the
    // same way as `/gmail/v1/...`. Internal Gmail callers pass a mailbox-scoped
    // base URL override (see GMAIL_API_BASE_URL) for their short paths.
    baseUrl: "https://www.googleapis.com",
    displayLabel: "Google",
    description: "Gmail, Calendar, Drive, Docs, Sheets, Slides, and Contacts",
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
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
    availableScopes:
      "https://developers.google.com/identity/protocols/oauth2/scopes",
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
      {
        hostPattern: "docs.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      // The Sheets and Slides APIs accept the auth/drive scope, so the
      // existing token covers them; only the hosts need injection entries.
      {
        hostPattern: "sheets.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "slides.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "tasks.googleapis.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "calendar.googleapis.com",
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
    logoUrl:
      "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/slack/default.svg",
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
    availableScopes: "https://api.slack.com/scopes",
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
    setupNotes: [
      "Enable Token Rotation on your Notion integration (developer dashboard → your integration → Configuration → Token rotation). Without it, Notion does not issue a refresh token and the connection cannot auto-recover if Notion revokes the access token server-side — you will silently lose access and need to reconnect manually.",
    ],
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
      "like.read",
      "bookmark.read",
      "offline.access",
    ],
    availableScopes:
      "https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code",
    tokenEndpointAuthMethod: "client_secret_basic",
    loopbackPort: 17335,
    managedServiceConfigKey: "twitter-oauth",
    managedServiceIsPaid: true,
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
    availableScopes:
      "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps",
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
    availableScopes: [
      { scope: "read", description: "Read access for the user's account" },
      { scope: "write", description: "Write access for the user's account" },
      {
        scope: "issues:create",
        description: "Create new issues and attachments",
      },
      { scope: "comments:create", description: "Create new issue comments" },
      {
        scope: "timeSchedule:write",
        description: "Create and modify time schedules",
      },
      { scope: "admin", description: "Full access to admin-level endpoints" },
    ],
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
    availableScopes:
      "https://developer.spotify.com/documentation/web-api/concepts/scopes",
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
    availableScopes: [
      {
        scope: "data:read",
        description: "Read-only access to tasks and projects",
      },
      {
        scope: "data:read_write",
        description: "Read and write access to tasks and projects",
      },
      { scope: "data:delete", description: "Delete tasks and projects" },
      { scope: "project:delete", description: "Delete entire projects" },
    ],
    loopbackPort: 17325,
    managedServiceConfigKey: "todoist-oauth",
    injectionTemplates: [
      {
        hostPattern: "api.todoist.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.todoist.com/api/v1/sync",
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
    // Your servers, not their contents. These scopes reach the guild list and
    // your membership in one; reading messages is not among them. Discord
    // documents `messages.read` as local RPC only, so requesting it would put
    // a permission on the consent screen that grants nothing here.
    description: "Your servers and profile",
    dashboardUrl: "https://discord.com/developers/applications",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/discord",
    defaultScopes: ["identify", "guilds", "guilds.members.read"],
    availableScopes:
      "https://discord.com/developers/docs/topics/oauth2#shared-resources-oauth2-scopes",
    loopbackPort: 17326,
    managedServiceConfigKey: "discord-oauth",
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
    availableScopes: "https://developers.dropbox.com/oauth-guide",
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
    availableScopes: "https://developers.asana.com/docs/oauth-scopes",
    loopbackPort: 17328,
    managedServiceConfigKey: "asana-oauth",
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
    availableScopes: "https://airtable.com/developers/web/api/scopes",
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
    availableScopes:
      "https://developers.hubspot.com/docs/guides/apps/authentication/scopes",
    loopbackPort: 17330,
    managedServiceConfigKey: "hubspot-oauth",
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

  salesforce: {
    provider: "salesforce",
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenExchangeUrl: "https://login.salesforce.com/services/oauth2/token",
    refreshUrl: "https://login.salesforce.com/services/oauth2/token",
    pingUrl: "https://login.salesforce.com/services/oauth2/userinfo",
    // baseUrl points at the login domain — correct for the OAuth handshake
    // and for ``/services/oauth2/userinfo``/``revoke`` calls. REST API calls
    // to ``/services/data/...`` go to the per-org instance host returned in
    // the token response as ``instance_url`` and stored on
    // ``oauth_connection.metadata``. ``connection-resolver.ts`` substitutes
    // that instance URL when constructing the BYO connection so callers
    // don't need to override ``baseUrl`` per request.
    baseUrl: "https://login.salesforce.com",
    displayLabel: "Salesforce",
    description: "CRM contacts, leads, and opportunities",
    dashboardUrl:
      "https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm&type=5",
    clientIdPlaceholder: null,
    logoUrl:
      "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/salesforce/default.svg",
    defaultScopes: ["api", "refresh_token", "openid", "email", "profile"],
    availableScopes:
      "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_tokens_scopes.htm",
    authorizeParams: { prompt: "consent" },
    tokenEndpointAuthMethod: "client_secret_post",
    loopbackPort: 17336,
    // Salesforce REST traffic goes to per-org instance hosts like
    // ``acme.my.salesforce.com`` and ``acme.lightning.force.com``.
    // ``matchHostPattern`` only treats ``*.<domain>`` as a wildcard match —
    // bare ``salesforce.com`` would only match the apex. Use wildcards so
    // ``Authorization: Bearer`` injection actually fires on tenant hosts.
    injectionTemplates: [
      {
        hostPattern: "*.salesforce.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
      {
        hostPattern: "*.force.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    revokeUrl: "https://login.salesforce.com/services/oauth2/revoke",
    revokeBodyTemplate: { token: "{access_token}" },
    appType: "Connected App",
    identityUrl: "https://login.salesforce.com/services/oauth2/userinfo",
    identityResponsePaths: ["email", "preferred_username"],
  },

  monday: {
    provider: "monday",
    authorizeUrl: "https://auth.monday.com/oauth2/authorize",
    tokenExchangeUrl: "https://auth.monday.com/oauth2/token",
    pingUrl: "https://api.monday.com/v2",
    pingMethod: "POST",
    pingHeaders: { "Content-Type": "application/json" },
    pingBody: { query: "{ me { id name email } }" },
    baseUrl: "https://api.monday.com",
    displayLabel: "monday.com",
    description: "Boards, items, docs, and updates",
    dashboardUrl: "https://auth.monday.com/apps",
    clientIdPlaceholder: null,
    // Simple Icons does not host a monday.com mark (both `monday` and
    // `mondaydotcom` 404 on the CDN), so use the documented thesvg fallback.
    logoUrl:
      "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/monday/default.svg",
    // monday tokens do not expire under the legacy OAuth flow and no refresh
    // token is issued, so there is no refreshUrl. The newer OAuth 2.1 flow
    // adds expiry/refresh/revocation but is opt-in per app version in the
    // Developer Center and posts JSON (not form-encoded) credentials, so it
    // is deliberately not used here.
    defaultScopes: [
      "me:read",
      "account:read",
      "users:read",
      "teams:read",
      "workspaces:read",
      "boards:read",
      "boards:write",
      "docs:read",
      "updates:read",
      "updates:write",
      "assets:read",
      "tags:read",
      "notifications:write",
    ],
    availableScopes: [
      { scope: "me:read", description: "Read the user's profile information" },
      {
        scope: "account:read",
        description: "Read general information about the account",
      },
      {
        scope: "users:read",
        description: "Read profile information of the account's users",
      },
      {
        scope: "users:write",
        description: "Modify profile information of the account's users",
      },
      {
        scope: "teams:read",
        description: "Read information about the account's teams",
      },
      { scope: "teams:write", description: "Modify the account's teams" },
      {
        scope: "workspaces:read",
        description: "Read a user's workspaces data",
      },
      {
        scope: "workspaces:write",
        description: "Modify a user's workspaces data",
      },
      { scope: "boards:read", description: "Read a user's board data" },
      { scope: "boards:write", description: "Modify a user's board data" },
      { scope: "docs:read", description: "Read a user's docs" },
      { scope: "docs:write", description: "Modify a user's docs" },
      {
        scope: "updates:read",
        description: "Read updates and replies the user can see",
      },
      {
        scope: "updates:write",
        description: "Post or edit updates on behalf of the user",
      },
      {
        scope: "assets:read",
        description: "Read data from assets the user has access to",
      },
      { scope: "tags:read", description: "Read the account's tags" },
      {
        scope: "notifications:write",
        description: "Send notifications on behalf of the user",
      },
      {
        scope: "webhooks:read",
        description: "Read existing webhooks configuration",
      },
      {
        scope: "webhooks:write",
        description: "Create and modify webhooks",
      },
      {
        scope: "departments:read",
        description: "Read the account's department data",
      },
      {
        scope: "departments:write",
        description: "Modify the account's departments",
      },
    ],
    tokenEndpointAuthMethod: "client_secret_post",
    // 17337/17338 are taken by eventbrite/calendly (all three providers
    // landed in parallel and independently picked the next free port at the
    // time); 17339 is the real next-free slot once all three are seeded
    // together.
    loopbackPort: 17339,
    managedServiceConfigKey: "monday-oauth",
    injectionTemplates: [
      {
        hostPattern: "api.monday.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://api.monday.com/v2",
    identityMethod: "POST",
    identityHeaders: { "Content-Type": "application/json" },
    identityBody: { query: "{ me { id name email } }" },
    identityResponsePaths: ["data.me.name", "data.me.email"],
    featureFlag: "monday-oauth",
  },

  eventbrite: {
    provider: "eventbrite",
    authorizeUrl: "https://www.eventbrite.com/oauth/authorize",
    tokenExchangeUrl: "https://www.eventbrite.com/oauth/token",
    refreshUrl: "https://www.eventbrite.com/oauth/token",
    pingUrl: "https://www.eventbriteapi.com/v3/users/me/",
    baseUrl: "https://www.eventbriteapi.com",
    displayLabel: "Eventbrite",
    description: "Events, attendees, and ticket orders",
    dashboardUrl: "https://www.eventbrite.com/platform/api-keys/",
    clientIdPlaceholder: null,
    // Simple Icons does not host an Eventbrite mark (cdn.simpleicons.org
    // 404s), so use the documented thesvg fallback.
    logoUrl:
      "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/eventbrite/default.svg",
    // Eventbrite has no granular OAuth scope system: an access token carries
    // the full permissions of the user who authorized it, and the authorize
    // endpoint ignores a `scope` parameter. Seed an empty set rather than
    // inventing scope strings the provider would silently drop (same shape
    // as Notion).
    defaultScopes: [],
    tokenEndpointAuthMethod: "client_secret_post",
    loopbackPort: 17337,
    managedServiceConfigKey: "eventbrite-oauth",
    injectionTemplates: [
      {
        hostPattern: "www.eventbriteapi.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    appType: "App",
    identityUrl: "https://www.eventbriteapi.com/v3/users/me/",
    identityResponsePaths: ["name", "first_name"],
  },

  calendly: {
    provider: "calendly",
    authorizeUrl: "https://auth.calendly.com/oauth/authorize",
    tokenExchangeUrl: "https://auth.calendly.com/oauth/token",
    pingUrl: "https://api.calendly.com/users/me",
    baseUrl: "https://api.calendly.com",
    displayLabel: "Calendly",
    description: "Scheduling links and meetings",
    dashboardUrl: "https://calendly.com/integrations/api_webhooks",
    clientIdPlaceholder: null,
    logoUrl: "https://cdn.simpleicons.org/calendly",
    // A :write scope implicitly grants the matching :read in the same domain,
    // so the baseline stays at the six that map to reading schedule data and
    // creating bookings/links. Organization-wide visibility is opt-in.
    defaultScopes: [
      "users:read",
      "event_types:read",
      "scheduled_events:read",
      "availability:read",
      "scheduled_events:write",
      "scheduling_links:write",
    ],
    availableScopes: [
      { scope: "users:read", description: "Read the connected user's profile" },
      {
        scope: "event_types:read",
        description: "Read event types and their available times",
      },
      {
        scope: "event_types:write",
        description: "Create and update event types",
      },
      {
        scope: "scheduled_events:read",
        description: "Read scheduled events and invitees",
      },
      {
        scope: "scheduled_events:write",
        description: "Create invitees, cancel events, mark no-shows",
      },
      {
        scope: "availability:read",
        description: "Read busy times and availability schedules",
      },
      {
        scope: "availability:write",
        description: "Update event type availability",
      },
      {
        scope: "scheduling_links:write",
        description: "Create single-use scheduling links",
      },
      {
        scope: "shares:write",
        description: "Create customized single-use scheduling links",
      },
      {
        scope: "organizations:read",
        description: "Read organization data and memberships",
      },
      {
        scope: "groups:read",
        description: "Read group details and relationships",
      },
      {
        scope: "webhooks:read",
        description: "Read webhook subscriptions",
      },
      {
        scope: "webhooks:write",
        description: "Create and delete webhook subscriptions",
      },
      { scope: "contacts:read", description: "Read contact details" },
      {
        scope: "contacts:write",
        description: "Create, update, and delete contacts",
      },
    ],
    tokenEndpointAuthMethod: "client_secret_basic",
    // 17337 is taken by eventbrite (both providers landed in parallel and
    // independently picked the next free port at the time); 17338 is the
    // real next-free slot once both are seeded together.
    loopbackPort: 17338,
    managedServiceConfigKey: "calendly-oauth",
    injectionTemplates: [
      {
        hostPattern: "api.calendly.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    revokeUrl: "https://auth.calendly.com/oauth/revoke",
    revokeBodyTemplate: { token: "{access_token}" },
    appType: "App",
    identityUrl: "https://api.calendly.com/users/me",
    identityResponsePaths: ["resource.email", "resource.name"],
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
    availableScopes: "https://developers.figma.com/docs/rest-api/scopes/",
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
    logoUrl:
      "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/microsoft-outlook/default.svg",
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
    availableScopes:
      "https://learn.microsoft.com/en-us/graph/permissions-reference",
    // `select_account`, not `consent`: the Microsoft identity platform accepts
    // a single prompt value, and `consent` honours an existing session cookie —
    // it re-asks for consent but never for *which* account, so a user who
    // already signed in cannot connect a second mailbox. `select_account`
    // always shows the account picker with its "Use another account" option.
    // Consent is still collected for an account that has not granted it, and
    // refresh tokens come from the `offline_access` scope above, so nothing is
    // lost by dropping `consent`.
    authorizeParams: { prompt: "select_account" },
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
    logoUrl:
      "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/slack/default.svg",
    defaultScopes: [],
    injectionTemplates: [
      {
        hostPattern: "slack.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
  },

  // The bot that sits in a server and talks to people there, which is a
  // different thing from the `discord` integration above and starts at the
  // same Discord authorize URL. Both are reasonably called "connecting
  // Discord", so each has to be nameable on its own. The bot token is already
  // stored under this key by `skills/discord-app-setup`; seeding the provider
  // is what lets the product tell the two apart.
  discord_channel: {
    provider: "discord_channel",
    authorizeUrl: "urn:manual-token",
    tokenExchangeUrl: "urn:manual-token",
    pingUrl: "https://discord.com/api/v10/users/@me",
    baseUrl: "https://discord.com/api/v10",
    displayLabel: "Discord Server",
    description: "A bot in your server",
    dashboardUrl: "https://discord.com/developers/applications",
    clientIdPlaceholder: null,
    requiresClientSecret: false,
    logoUrl: "https://cdn.simpleicons.org/discord",
    defaultScopes: [],
    injectionTemplates: [
      {
        hostPattern: "discord.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bot ",
      },
    ],
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
  },

  sanity: {
    provider: "sanity",
    authorizeUrl: "urn:manual-token",
    tokenExchangeUrl: "urn:manual-token",
    baseUrl: "https://api.sanity.io",
    displayLabel: "Sanity",
    description: "Content management platform",
    dashboardUrl: "https://www.sanity.io/manage",
    clientIdPlaceholder: null,
    requiresClientSecret: false,
    logoUrl: "https://cdn.simpleicons.org/sanity",
    defaultScopes: [],
    injectionTemplates: [
      {
        hostPattern: "*.sanity.io",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
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

  // seedProviders preserves an existing baseUrl via COALESCE, so a corrected
  // seed default never reaches rows created with the old value. Advance the
  // google row off its stale mailbox-scoped default without clobbering a
  // user-customized base URL.
  const nextGoogleBaseUrl = PROVIDER_SEED_DATA.google.baseUrl;
  if (nextGoogleBaseUrl) {
    migrateProviderBaseUrl({
      provider: "google",
      staleBaseUrl: STALE_GOOGLE_BASE_URL,
      nextBaseUrl: nextGoogleBaseUrl,
    });
  }
}
