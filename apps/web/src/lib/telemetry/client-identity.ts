const STORAGE_KEY = "vellum_client_id";

let cached: string | null = null;

/**
 * Returns a stable per-browser UUID identifying this web client installation.
 * Generated once and persisted in localStorage so the daemon's ClientRegistry
 * can track this browser across SSE reconnects and page reloads.
 */
export function getClientId(): string {
  if (cached) return cached;

  if (typeof window !== "undefined" && window.localStorage) {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    cached = id;
    return id;
  }

  // SSR / non-browser — return a transient id (won't be persisted).
  const id = crypto.randomUUID();
  cached = id;
  return id;
}

/**
 * Headers that identify this web client to the assistant daemon.
 * Attach to all SSE streaming connections so the ClientRegistry can
 * track connected clients and their capabilities.
 */
export function getClientRegistrationHeaders(): Record<string, string> {
  return {
    "X-Vellum-Client-Id": getClientId(),
    "X-Vellum-Interface-Id": "vellum",
  };
}
