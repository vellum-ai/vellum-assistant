/**
 * Shared helpers for the OAuth popup completion flow. Used by:
 * - `DesktopOAuthCompletePage` (the popup landing page that sends the result)
 * - `GoogleConnectScreen` (the opener that listens for the result)
 * - `IntegrationDetailModal` (settings page integration connection flow)
 *
 * The popup writes its result via `postMessage` to `window.opener` and a
 * `localStorage` item as a cross-tab fallback. The opener listens for both
 * and reconciles whichever arrives first.
 */

export interface OAuthCompletePayload {
  type: "vellum:oauth-complete";
  requestId?: string | null;
  oauthStatus?: string | null;
  oauthProvider?: string | null;
  oauthCode?: string | null;
}

export function oauthCompletionStorageKey(requestId: string): string {
  return `vellum:oauth-complete:${requestId}`;
}

export function isOAuthCompletePayloadForRequest(
  payload: unknown,
  requestId: string,
): payload is OAuthCompletePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as OAuthCompletePayload).type === "vellum:oauth-complete" &&
    (payload as OAuthCompletePayload).requestId === requestId
  );
}

export function getOAuthCompleteMessagePayload(
  event: MessageEvent,
  expectedOrigin: string,
  requestId: string,
): OAuthCompletePayload | null {
  if (event.origin !== expectedOrigin) {
    return null;
  }

  if (!isOAuthCompletePayloadForRequest(event.data, requestId)) {
    return null;
  }

  return event.data as OAuthCompletePayload;
}

/**
 * Parse a raw JSON string into an OAuthCompletePayload, returning null on
 * malformed input. Use this instead of `JSON.parse(...) as OAuthCompletePayload`
 * when reading from runtime boundaries (localStorage, postMessage fallback).
 */
export function parseOAuthCompletePayload(
  raw: string,
): OAuthCompletePayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as OAuthCompletePayload).type !== "vellum:oauth-complete"
    ) {
      return null;
    }
    const payload = parsed as OAuthCompletePayload;
    if (
      payload.requestId !== undefined &&
      payload.requestId !== null &&
      typeof payload.requestId !== "string"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function getOAuthCompleteStoragePayload(
  event: StorageEvent,
  requestId: string,
): OAuthCompletePayload | null {
  if (
    event.key !== oauthCompletionStorageKey(requestId) ||
    event.newValue === null
  ) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(event.newValue);
    return isOAuthCompletePayloadForRequest(payload, requestId)
      ? payload
      : null;
  } catch {
    return null;
  }
}
