/**
 * GCP OAuth setup API response types.
 * Mirrors the structures returned by clientauthconfig and OauthEntityService APIs.
 */

// ---------------------------------------------------------------------------
// clientauthconfig.clients6.google.com — OAuth Client CRUD
// ---------------------------------------------------------------------------

export interface GCPClientSecret {
  clientSecret?: string; // Only present on creation response
  createTime: string;
  state: string;
  clientSecretSuffix: string;
  id: string;
}

export interface GCPOAuthClient {
  clientId: string;
  projectNumber: string;
  brandId: string;
  postMessageOrigins?: string[];
  redirectUris?: string[];
  type: "WEB" | "NATIVE_DESKTOP" | string;
  authType: string;
  nativeAppInfo?: Record<string, unknown>;
  updateTime?: string;
  creationTime: string;
  displayName: string;
  threeLeggedOauth?: string;
  domainWideDelegation?: string;
  adminState?: { updateTime: string };
  assertionMatchExistingGrant?: string;
  clientSecrets: GCPClientSecret[];
}

export interface ListClientsResponse {
  clients: GCPOAuthClient[];
}

export interface CreateClientRequest {
  type: "WEB" | "NATIVE_DESKTOP";
  displayName: string;
  redirectUris?: string[];
  postMessageOrigins?: string[];
  authType: "SHARED_SECRET";
  brandId: string;
  projectNumber: string;
}

// ---------------------------------------------------------------------------
// OauthEntityService (cloudconsole-pa) — GraphQL-style batch operations
// ---------------------------------------------------------------------------

export interface BatchGraphQLRequest {
  requestContext: RequestContext;
  querySignature: string;
  operationName: string;
  variables: Record<string, unknown>;
}

export interface RequestContext {
  platformMetadata: { platformType: string };
  p2Metadata: {
    feature: string;
    environment: string;
    release: string;
    extension: string;
  };
  clientVersion: string;
  pagePath: string;
  projectId: string;
  selectedPurview: { projectId: string };
  jurisdiction: string;
  localizationData: { locale: string; timezone: string };
}

export interface BatchGraphQLResponse<T = unknown> {
  results: Array<{
    data: T;
    path: unknown[];
  }>;
  responseContext?: { eti?: string };
}

// Brand / consent screen types
export interface BrandInfo {
  isBrandConfigured: boolean;
  brand?: {
    brandId: string;
    displayName: string;
    supportEmail: string;
  };
  brandPolicy?: {
    publishState: string;
    visibility: string;
    verificationState: string;
    scopes: Array<{
      scopeCode: number;
      riskLevel: string;
    }>;
    developerEmails: string[];
  };
}

export interface TrustedUserList {
  userAccount: Array<{
    email: string;
  }>;
}

export interface ScopeInfo {
  scopeCode: number;
  riskLevel: string;
  developerCode: string;
  description: string;
  apiTitle?: string;
}

export interface UpdateBrandInfoResult {
  name: string; // operation name like "operations/flow/..."
  done: boolean;
  result: string;
  error?: { code: number; message: string; details: unknown[] };
}

export interface GetOperationResult {
  name: string;
  metadata?: {
    code: string;
    description?: { descriptionKey: string };
    flowType?: string;
  };
  done: boolean;
  result: string;
  response?: Record<string, unknown>;
}

export interface ClientsMetadata {
  hasClients: boolean;
  nonSslClientIds?: string[];
  domainClientsMap?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cloud Resource Manager — Project CRUD
// ---------------------------------------------------------------------------

export interface GCPProject {
  projectNumber: string;
  projectId: string;
  lifecycleState: "ACTIVE" | "DELETE_REQUESTED" | string;
  name: string;
  createTime: string;
}

export interface GCPOperation {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: Record<string, unknown>;
}

// Project configuration persisted locally
export interface GCPProjectConfig {
  projectId: string;
  projectNumber: string;
  savedAt: string;
}
