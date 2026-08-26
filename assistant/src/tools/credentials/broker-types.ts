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
