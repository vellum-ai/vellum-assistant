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
  /** Error reason if consumption failed. */
  reason?: string;
}
