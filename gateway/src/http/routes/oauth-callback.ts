import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { forwardOAuthCallback } from "../../runtime/client.js";

const log = getLogger("oauth-callback");

// Minimum length for the state parameter. The runtime generates 32 hex chars
// (16 random bytes); reject anything shorter to block trivially guessable values.
const MIN_STATE_LENGTH = 32;

// Track consumed state tokens to prevent replay attacks. Each entry has a TTL
// so the set doesn't grow unboundedly.
const CONSUMED_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONSUMED_STATES = 1000;
const consumedStates = new Map<string, ReturnType<typeof setTimeout>>();

function markStateConsumed(state: string): void {
  // Evict oldest entry if at capacity to prevent unbounded memory growth
  if (consumedStates.size >= MAX_CONSUMED_STATES) {
    const oldest = consumedStates.keys().next().value;
    if (oldest !== undefined) {
      clearTimeout(consumedStates.get(oldest)!);
      consumedStates.delete(oldest);
    }
  }

  const timer = setTimeout(() => {
    consumedStates.delete(state);
  }, CONSUMED_STATE_TTL_MS);
  // Unref so the timer doesn't prevent process exit
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  consumedStates.set(state, timer);
}

function rollBackConsumedState(state: string): void {
  const timer = consumedStates.get(state);
  if (timer !== undefined) {
    clearTimeout(timer);
    consumedStates.delete(state);
  }
}

/** Exported for testing — clears all consumed state entries. */
export function _resetConsumedStates(): void {
  for (const timer of consumedStates.values()) clearTimeout(timer);
  consumedStates.clear();
}

export function createOAuthCallbackHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (!state) {
      return new Response(renderErrorPage("Missing state parameter"), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (state.length < MIN_STATE_LENGTH) {
      log.warn({ stateLength: state.length }, "OAuth state too short");
      return new Response(renderErrorPage("Invalid state parameter"), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (consumedStates.has(state)) {
      log.warn("OAuth state replay attempt blocked");
      return new Response(renderErrorPage("State parameter already used"), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Optimistically mark consumed so concurrent duplicate callbacks are
    // blocked while the runtime processes this one. Rolled back on transient
    // failures (5xx, transport errors, 401/403 auth failures) — deterministic
    // rejections (other 4xx) keep state consumed to prevent replay attacks.
    markStateConsumed(state);

    try {
      const response = await forwardOAuthCallback(
        config,
        state,
        code || undefined,
        error || undefined,
      );

      if (response.status >= 200 && response.status < 300) {
        return new Response(renderSuccessPage(), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      // Roll back consumed state for transient failures so the user can retry.
      // 401/403 are transient auth failures (token/secret mismatch) where the
      // runtime rejected the request before processing the callback state.
      // 5xx are server errors. Both are safe to retry.
      // Other 4xx (400/404/422) are deterministic rejections — keep state
      // consumed to prevent replay/spam.
      if (response.status >= 500 || response.status === 401 || response.status === 403) {
        rollBackConsumedState(state);
      }
      return new Response(
        renderErrorPage("Authorization failed. Please try again."),
        { status: 400, headers: { "Content-Type": "text/html" } },
      );
    } catch (err) {
      // Transport errors are transient — roll back so the callback can be retried.
      rollBackConsumedState(state);
      log.error({ err }, "Failed to forward OAuth callback to runtime");
      return new Response(
        renderErrorPage("Authorization failed. Please try again."),
        { status: 502, headers: { "Content-Type": "text/html" } },
      );
    }
  };
}

function renderSuccessPage(): string {
  return `<!DOCTYPE html><html><head><title>Authorization Successful</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}</style></head><body><div><h1>Authorization Successful</h1><p>You can close this tab and return to the app.</p></div></body></html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html><html><head><title>Authorization Failed</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}</style></head><body><div><h1>Authorization Failed</h1><p>${message}</p></div></body></html>`;
}
