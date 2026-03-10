/**
 * GCP OAuth setup API endpoints and query signatures.
 *
 * The OauthEntityService uses pre-compiled query signatures (base64 hashes)
 * instead of inline GraphQL query strings. These signatures are stable across
 * sessions but may change when Google deploys new Console versions.
 */

// ---------------------------------------------------------------------------
// API keys and base URLs
// ---------------------------------------------------------------------------

/**
 * GCP Console public API key, extracted at runtime from the page.
 * Mutable — set by `extractApiKey()` on first CDP call.
 */
export let GCP_API_KEY = "";

/**
 * Set the API key (called after extracting from Chrome page context).
 */
export function setApiKey(key: string): void {
  GCP_API_KEY = key;
}

/** OAuth client CRUD (REST). */
export const CLIENT_AUTH_CONFIG_BASE =
  "https://clientauthconfig.clients6.google.com";

/** OauthEntityService GraphQL-style batch endpoint. */
export const OAUTH_ENTITY_SERVICE_BASE =
  "https://cloudconsole-pa.clients6.google.com/v3/entityServices/OauthEntityService/schemas/OAUTH_GRAPHQL:batchGraphql";

/** Operations polling endpoint. */
export const OPERATIONS_SERVICE_BASE =
  "https://cloudconsole-pa.clients6.google.com/v3/entityServices/OperationsEntityService/schemas/OPERATIONS_GRAPHQL:batchGraphql";

/** Entity endpoint for full app registration. */
export const ENTITY_SERVICE_BASE =
  "https://cloudconsole-pa.clients6.google.com/v3/entityServices/OauthEntityService/entities/OAUTH_APP_REGISTRATION_WITH_OPTIONS:get";

// ---------------------------------------------------------------------------
// Query signatures (OauthEntityService batchGraphql operations)
// ---------------------------------------------------------------------------

export const QUERY_SIGNATURES = {
  GetBrandInfo: "2/+rizMIOedfS942Fr49v/Rbil6FmD25AmUGoFQ/GpcGo=",
  GetClientsMetadata: "2/Ctk9Q6tSyPwEcGmGgncEOqLqOMjxpHhSk1jjyb7DmL0=",
  GetVerificationCompliance: "2/wtk2XQBVubutPXg8iodeG3JrqOkuBUV9i5rVInP0Wbg=",
  ListGoogleGroups: "2/MoQKXyTY3BYtHhtGgHgta25GclR+H0thwo6DKdoqQdY=",
  GetUserStats: "2/4eUSKdy2D5JnFTzTkRhhmKwQIm5qk6hZchUMkm1jJEU=",
  GetTrustedUserList: "2/MOTEiszs0jB3+r4gNdOqOHc6zxU1rHoLGwOZgzGJWNo=",
  SetTrustedUserList: "2/7gA8JWHyqFx3hPWBgvLvbsZAwIBEI2HTpajRUpYPVZM=",
  ListClientIds: "2/lBGTKaHUAHxFzstiaP69Jm/5wJGHDsth1NOFp4jaev0=",
  BatchGetClientHealthSignals: "2/aPAsOOb2fx/NN8LVlu4snyzE6eGkeBSxYCSiBkM3qZM=",
  GetBrandCompliance: "2//v+n4sGZ+EsAdU3Lr4kN0HsbCRzHEws7t0q6d46N3v8=",
  UpdateBrandInfo: "2/MM6ZawoD+IzNDI6fjPdEd+Hfw0gna5CXbTn/GvCy/pQ=",
  GetScopesInfo: "2/MCHr7hSfp2UDBq/yeuxc87sjvAWcNRoZdyRMATYmWYs=",
} as const;

// ---------------------------------------------------------------------------
// Known scope codes for Gmail, Calendar, and userinfo
// ---------------------------------------------------------------------------

export const GMAIL_CALENDAR_SCOPE_CODES = {
  "https://www.googleapis.com/auth/userinfo.email": 202,
  "https://www.googleapis.com/auth/gmail.readonly": 701,
  "https://www.googleapis.com/auth/gmail.modify": 752,
  "https://www.googleapis.com/auth/gmail.send": 301,
  "https://www.googleapis.com/auth/calendar.readonly": 310,
  "https://www.googleapis.com/auth/calendar.events": 311,
} as const;

/** All scope codes we need configured on the consent screen. */
export const REQUIRED_SCOPE_CODES = Object.values(
  GMAIL_CALENDAR_SCOPE_CODES,
) as number[];

/** Cloud Resource Manager — project CRUD (via Console proxy, accepts SAPISIDHASH). */
export const CLOUD_RESOURCE_MANAGER_BASE =
  "https://cloudresourcemanager.clients6.google.com";

/** Service Usage — enable/disable APIs (via Console proxy, accepts SAPISIDHASH). */
export const SERVICE_USAGE_BASE =
  "https://serviceusage.clients6.google.com";

/** APIs to enable for Gmail + Calendar integration. */
export const REQUIRED_APIS = [
  "gmail.googleapis.com",
  "calendar-json.googleapis.com",
] as const;

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

export function listClientsUrl(projectNumber: string): string {
  const params = new URLSearchParams({
    projectNumber,
    readMask:
      "client_id,redirect_uris,post_message_origins,type,auth_type,native_app_info,creation_time,display_name,domain_wide_delegation,restrict_deletion_to_loas_owner,client_secrets",
    "readOptions.staleness": "0.02s",
    returnDisabledClients: "true",
    key: GCP_API_KEY,
  });
  return `${CLIENT_AUTH_CONFIG_BASE}/v1/clients?${params}`;
}

export function createClientUrl(): string {
  return `${CLIENT_AUTH_CONFIG_BASE}/v1/clients?key=${GCP_API_KEY}`;
}

export function oauthEntityServiceUrl(): string {
  return `${OAUTH_ENTITY_SERVICE_BASE}?key=${GCP_API_KEY}&prettyPrint=false`;
}

export function operationsServiceUrl(): string {
  return `${OPERATIONS_SERVICE_BASE}?key=${GCP_API_KEY}&prettyPrint=false`;
}

export function entityGetUrl(): string {
  return `${ENTITY_SERVICE_BASE}?key=${GCP_API_KEY}&alt=json&prettyPrint=false`;
}

export function listProjectsUrl(filter = "lifecycleState:ACTIVE"): string {
  const params = new URLSearchParams({ filter, key: GCP_API_KEY });
  return `${CLOUD_RESOURCE_MANAGER_BASE}/v1/projects?${params}`;
}

export function createProjectUrl(): string {
  return `${CLOUD_RESOURCE_MANAGER_BASE}/v1/projects?key=${GCP_API_KEY}`;
}

export function getProjectUrl(projectId: string): string {
  return `${CLOUD_RESOURCE_MANAGER_BASE}/v1/projects/${projectId}?key=${GCP_API_KEY}`;
}

export function getProjectOperationUrl(operationName: string): string {
  return `${CLOUD_RESOURCE_MANAGER_BASE}/v1/${operationName}?key=${GCP_API_KEY}`;
}

export function enableApiUrl(projectNumber: string, api: string): string {
  return `${SERVICE_USAGE_BASE}/v1/projects/${projectNumber}/services/${api}:enable?key=${GCP_API_KEY}`;
}
