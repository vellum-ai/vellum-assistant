/** Opaque token representing a policy-checked authorization to use a credential. */
export interface UsageToken {
  tokenId: string;
  credentialId: string;
  service: string;
  field: string;
  toolName: string;
  /** Timestamp (epoch ms) when this token was created. */
  createdAt: number;
  /** Whether this token has been consumed (single-use). */
  consumed: boolean;
}

/** Request to authorize the use of a credential. */
export interface AuthorizeRequest {
  service: string;
  field: string;
  toolName: string;
  /** Optional domain for domain-policy checking (used by browser tools). */
  domain?: string;
}

/** Successful authorization result. */
export interface AuthorizeSuccess {
  authorized: true;
  token: UsageToken;
}

/** Denied authorization result. */
export interface AuthorizeDenied {
  authorized: false;
  reason: string;
}

export type AuthorizeResult = AuthorizeSuccess | AuthorizeDenied;

/** Result of consuming a token. */
export interface ConsumeResult {
  success: boolean;
  /** The storage key to read the secret from (only present on success). */
  storageKey?: string;
  /** The resolved value when a transient (one-time) credential was consumed. */
  value?: string;
  /** Error reason if consumption failed. */
  reason?: string;
}

/** Request for the broker to fill a browser field without exposing plaintext. */
export interface BrowserFillRequest {
  service: string;
  field: string;
  toolName: string;
  domain?: string;
  /**
   * Opaque fill callback - the broker calls this with the plaintext value internally.
   * The caller provides the fill function but never receives the secret value.
   */
  fill: (value: string) => Promise<void>;
}

/** Result of a broker-mediated browser fill - contains only metadata, never plaintext. */
export interface BrowserFillResult {
  success: boolean;
  reason?: string;
}

/** Request for the broker to use a credential server-side without exposing plaintext. */
export interface ServerUseRequest<T> {
  service: string;
  field: string;
  toolName: string;
  /**
   * Opaque callback - the broker calls this with the plaintext value internally.
   * The caller provides the function but never receives the secret value directly.
   */
  execute: (value: string) => Promise<T>;
}

/** Result of a broker-mediated server-side credential use - contains the callback result, never plaintext. */
export interface ServerUseResult<T> {
  success: boolean;
  result?: T;
  reason?: string;
}

/** Request to look up a credential by ID for proxy injection (no secret exposed). */
export interface ServerUseByIdRequest {
  credentialId: string;
  requestingTool: string;
}

/** Successful by-id lookup result - metadata + injection templates, never plaintext. */
export interface ServerUseByIdSuccess {
  success: true;
  credentialId: string;
  service: string;
  field: string;
  injectionTemplates: import("./policy-types.js").CredentialInjectionTemplate[];
}

/** Denied or not-found by-id lookup result. */
export interface ServerUseByIdDenied {
  success: false;
  reason: string;
}

export type ServerUseByIdResult = ServerUseByIdSuccess | ServerUseByIdDenied;
