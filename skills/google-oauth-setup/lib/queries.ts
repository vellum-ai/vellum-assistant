/**
 * GCP OAuth setup API endpoints and query signatures.
 *
 * Only includes the OauthEntityService (cloudconsole-pa) endpoints that work
 * with SAPISIDHASH auth. The clientauthconfig, serviceusage, and
 * cloudresourcemanager endpoints are excluded since they 403.
 */

// ---------------------------------------------------------------------------
// API key (extracted from Chrome page context at runtime)
// ---------------------------------------------------------------------------

export let GCP_API_KEY = "";

export function setApiKey(key: string): void {
  GCP_API_KEY = key;
}

// ---------------------------------------------------------------------------
// OauthEntityService GraphQL-style batch endpoint
// ---------------------------------------------------------------------------

export const OAUTH_ENTITY_SERVICE_BASE =
  "https://cloudconsole-pa.clients6.google.com/v3/entityServices/OauthEntityService/schemas/OAUTH_GRAPHQL:batchGraphql";

export function oauthEntityServiceUrl(): string {
  return `${OAUTH_ENTITY_SERVICE_BASE}?key=${GCP_API_KEY}&prettyPrint=false`;
}

// ---------------------------------------------------------------------------
// Query signatures (stable hashes for OauthEntityService operations)
// ---------------------------------------------------------------------------

export const QUERY_SIGNATURES = {
  GetBrandInfo: "2/+rizMIOedfS942Fr49v/Rbil6FmD25AmUGoFQ/GpcGo=",
  UpdateBrandInfo: "2/MM6ZawoD+IzNDI6fjPdEd+Hfw0gna5CXbTn/GvCy/pQ=",
  GetTrustedUserList: "2/MOTEiszs0jB3+r4gNdOqOHc6zxU1rHoLGwOZgzGJWNo=",
  SetTrustedUserList: "2/7gA8JWHyqFx3hPWBgvLvbsZAwIBEI2HTpajRUpYPVZM=",
  ListClientIds: "2/lBGTKaHUAHxFzstiaP69Jm/5wJGHDsth1NOFp4jaev0=",
} as const;

// ---------------------------------------------------------------------------
// Scope codes for Gmail, Calendar, and userinfo
// ---------------------------------------------------------------------------

export const GMAIL_CALENDAR_SCOPE_CODES = {
  "https://www.googleapis.com/auth/userinfo.email": 202,
  "https://www.googleapis.com/auth/gmail.readonly": 701,
  "https://www.googleapis.com/auth/gmail.modify": 752,
  "https://www.googleapis.com/auth/gmail.send": 301,
  "https://www.googleapis.com/auth/calendar.readonly": 310,
  "https://www.googleapis.com/auth/calendar.events": 311,
} as const;

export const REQUIRED_SCOPE_CODES = Object.values(
  GMAIL_CALENDAR_SCOPE_CODES,
) as number[];
