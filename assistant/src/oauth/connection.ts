export interface OAuthConnectionRequest {
  method: string;
  path: string; // relative, e.g. "/2/tweets"
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown; // JSON-serializable
  /**
   * Override the connection's default base URL for this request.
   * Required for providers that span multiple API hosts sharing
   * one OAuth token (e.g. Google: Gmail, Calendar, People all
   * use the same credential but different base URLs).
   */
  baseUrl?: string;
}

export interface OAuthConnectionResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface OAuthConnection {
  /** Make an authenticated HTTP request through this connection. */
  request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse>;

  /**
   * Execute a callback with a valid raw access token. This is an escape hatch
   * for provider-specific endpoints that don't fit the relative-path model
   * (e.g. Gmail batch API on a different host). Throws for platform connections
   * where raw tokens are not available locally.
   */
  withToken<T>(fn: (token: string) => Promise<T>): Promise<T>;

  readonly id: string;
  readonly provider: string;
  readonly accountInfo: string | null;
}
