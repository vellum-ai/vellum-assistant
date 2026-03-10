/**
 * Types for GCP OAuth setup — consent screen / brand API only.
 * Project management and OAuth client CRUD types are excluded since those
 * endpoints don't work with SAPISIDHASH auth.
 */

// ---------------------------------------------------------------------------
// OauthEntityService request context
// ---------------------------------------------------------------------------

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
  localizationData: {
    locale: string;
    timezone: string;
  };
}

// ---------------------------------------------------------------------------
// Brand / Consent Screen
// ---------------------------------------------------------------------------

export interface BrandInfo {
  isBrandConfigured: boolean;
  brandPolicy: {
    scopes?: number[];
    unreviewedConfig?: { scopes?: number[] };
  };
  [key: string]: unknown;
}

export interface UpdateBrandInfoResult {
  name?: string;
  done?: boolean;
  [key: string]: unknown;
}

export interface TrustedUserList {
  userAccount?: unknown[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session / config
// ---------------------------------------------------------------------------

export interface GCPProjectConfig {
  projectId: string;
  projectNumber: string;
  savedAt: string;
}
