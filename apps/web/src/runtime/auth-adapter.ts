export type RuntimeAuthMode = "hosted" | "local" | "self-hosted" | "none";

/**
 * Adapter that lets apps/web run under different auth/runtime configurations
 * without baking hosted Vellum login into the app shell.
 *
 * No implementation is provided at this scaffold stage. Hosted auth lands
 * with the assistant code port; local/self-hosted/no-login runtimes plug in
 * through this same interface from their respective hosts (e.g. Electron
 * wrapper, local daemon).
 */
export interface RuntimeAuthAdapter {
  readonly mode: RuntimeAuthMode;

  /**
   * Resolves once the runtime has determined whether the user has an active
   * session. Implementations should perform any startup token exchange or
   * cookie probe before resolving.
   */
  ensureSession(): Promise<{ authenticated: boolean }>;

  /**
   * Returns the Authorization header value the runtime expects, or `null`
   * when the runtime does not use a header (e.g. cookie-based, no-auth).
   */
  getAuthHeader(): string | null;
}
