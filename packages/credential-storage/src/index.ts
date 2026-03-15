/**
 * @vellumai/credential-storage
 *
 * Local credential persistence and materialization primitives.
 *
 * This package provides neutral interfaces for:
 * - Local static credential metadata records
 * - OAuth connection records persisted on the local runtime
 * - Secure-key lookup abstractions
 * - Token persistence and refresh helpers
 *
 * It is explicitly scoped to LOCAL storage and runtime concerns.
 * It must NOT import from the assistant daemon, CES, or any
 * service-specific module. Later extraction PRs will move existing
 * assistant logic into this package without changing behavior.
 */

// ---------------------------------------------------------------------------
// Static credential metadata
// ---------------------------------------------------------------------------

/**
 * Non-secret metadata about a locally stored credential.
 * Secret values remain in the secure-key backend only.
 */
export interface StaticCredentialRecord {
  /** Opaque identifier for this credential. */
  credentialId: string;
  /** Service name (e.g. "github", "fal"). */
  service: string;
  /** Field name within the service (e.g. "api_key", "password"). */
  field: string;
  /** Tools permitted to consume this credential. */
  allowedTools: string[];
  /** Domains where this credential may be used. */
  allowedDomains: string[];
  /** Human-readable description of intended usage. */
  usageDescription?: string;
  /** Human-friendly alias (e.g. "fal-primary"). */
  alias?: string;
  /** Templates describing how to inject this credential into proxied requests. */
  injectionTemplates?: InjectionTemplate[];
  /** Epoch ms when the record was created. */
  createdAt: number;
  /** Epoch ms when the record was last updated. */
  updatedAt: number;
}

/**
 * Describes how to inject a credential value into an outbound request
 * matching a specific host pattern.
 */
export interface InjectionTemplate {
  /** Glob pattern for matching request hosts (e.g. "*.fal.ai"). */
  hostPattern: string;
  /** Where the credential value is injected. */
  injectionType: "header" | "query";
  /** Header name when injectionType is "header" (e.g. "Authorization"). */
  headerName?: string;
  /** Prefix prepended to the secret value (e.g. "Key ", "Bearer "). */
  valuePrefix?: string;
  /** Query parameter name when injectionType is "query". */
  queryParamName?: string;
}

// ---------------------------------------------------------------------------
// Secure-key lookup
// ---------------------------------------------------------------------------

/**
 * Result of a secure-key deletion attempt.
 */
export type SecureKeyDeleteResult = "deleted" | "not-found" | "error";

/**
 * Abstraction over the underlying secure-key backend (e.g. macOS Keychain,
 * encrypted file store). Implementations handle platform-specific details.
 */
export interface SecureKeyBackend {
  /** Retrieve a secret value by key. Returns undefined if not found. */
  get(key: string): Promise<string | undefined>;
  /** Store a secret value. Returns true on success. */
  set(key: string, value: string): Promise<boolean>;
  /** Delete a secret. */
  delete(key: string): Promise<SecureKeyDeleteResult>;
  /** List all stored key names. */
  list(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// OAuth connection records (local persistence)
// ---------------------------------------------------------------------------

/**
 * Record of a locally persisted OAuth connection.
 * Represents a user's authorization grant for a specific provider.
 */
export interface OAuthConnectionRecord {
  /** Unique identifier for this connection. */
  id: string;
  /** Provider key (e.g. "integration:google", "integration:slack"). */
  providerKey: string;
  /** Account identifier (e.g. email address). */
  accountInfo: string | null;
  /** OAuth scopes that were granted. */
  grantedScopes: string[];
  /** Secure-key path where the access token is stored. */
  accessTokenPath: string;
  /** Whether a refresh token is stored for this connection. */
  hasRefreshToken: boolean;
  /** Epoch ms when the token expires (null if unknown). */
  expiresAt: number | null;
  /** Epoch ms when the connection was created. */
  createdAt: number;
  /** Epoch ms when the connection was last updated. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

/**
 * Result of a token refresh attempt.
 */
export type TokenRefreshResult =
  | { success: true; accessToken: string; expiresAt: number | null }
  | { success: false; error: string };

/**
 * Abstraction for persisting and refreshing OAuth tokens locally.
 * Implementations handle token storage, expiry checking, and refresh flows.
 */
export interface TokenPersistence {
  /**
   * Retrieve a valid access token for a connection, refreshing if necessary.
   * Returns the access token string or throws if the token cannot be obtained.
   */
  getAccessToken(connectionId: string): Promise<string>;

  /**
   * Persist a new token set (access token, optional refresh token, expiry).
   */
  persistTokens(
    connectionId: string,
    tokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number | null;
    },
  ): Promise<void>;

  /**
   * Attempt to refresh the access token for a connection.
   */
  refreshToken(connectionId: string): Promise<TokenRefreshResult>;

  /**
   * Revoke and delete all tokens for a connection.
   */
  revokeTokens(connectionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Credential key format
// ---------------------------------------------------------------------------

/**
 * Build a credential key for the secure-key store.
 *
 * Keys follow the pattern: `credential/{service}/{field}`
 */
export function credentialKey(service: string, field: string): string {
  return `credential/${service}/${field}`;
}
