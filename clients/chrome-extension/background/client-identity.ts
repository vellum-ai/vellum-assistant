/**
 * Stable per-install client identity for the Chrome extension.
 *
 * Generates a UUID on first access and persists it to
 * `chrome.storage.local` so the daemon's event hub can track this
 * extension across SSE/WebSocket reconnects and browser restarts.
 *
 * The persisted client ID is separate from the `clientInstanceId` used
 * by the relay WebSocket handshake (which is scoped to the relay
 * connection lifecycle). This ID is sent as `X-Vellum-Client-Id` on all
 * SSE streaming connections for client registration in the daemon.
 */

const CHROME_EXT_INTERFACE_ID = 'chrome-extension';
const CLIENT_ID_STORAGE_KEY = 'vellum.clientId';

let cached: string | null = null;

/**
 * Returns a stable UUID identifying this Chrome extension installation.
 * Generated once and persisted in `chrome.storage.local`.
 *
 * Must be called with `await` — `chrome.storage.local` is asynchronous.
 */
export async function getClientId(): Promise<string> {
  if (cached) return cached;

  try {
    const result = await chrome.storage.local.get(CLIENT_ID_STORAGE_KEY);
    const stored = result[CLIENT_ID_STORAGE_KEY];
    if (typeof stored === 'string' && stored.length > 0) {
      cached = stored;
      return stored;
    }
  } catch {
    /* best-effort read */
  }

  const id = crypto.randomUUID();
  try {
    await chrome.storage.local.set({ [CLIENT_ID_STORAGE_KEY]: id });
  } catch {
    /* best-effort persist — transient id still works for this session */
  }

  cached = id;
  return id;
}

/**
 * Headers that identify this Chrome extension client to the assistant daemon.
 * Attach to SSE streaming connections so the event hub can track
 * connected clients and their capabilities.
 */
export async function getClientRegistrationHeaders(): Promise<Record<string, string>> {
  return {
    'X-Vellum-Client-Id': await getClientId(),
    'X-Vellum-Interface-Id': CHROME_EXT_INTERFACE_ID,
  };
}
