import { extractErrorMessage } from "@/utils/api-errors";

import type { GetAssistantResult } from "@/assistant/api";

export type ResolvedAssistantLifecycleState =
  | { kind: "active" }
  | { kind: "self_hosted" }
  | { kind: "initializing" }
  | { kind: "cleaning_up" }
  | { kind: "auto_hatch" }
  | { kind: "error"; message: string; transient?: boolean };

/**
 * Error code the Electron main process's platform proxy puts in its
 * synthesized 502 body when `net.fetch` itself failed (the request
 * never reached the platform — e.g. `net::ERR_NETWORK_CHANGED` while
 * Wi-Fi reassociates after sleep). Mirrors `PROXY_NETWORK_ERROR_CODE`
 * in `apps/macos/src/main/platform-forward.ts`; the two must stay in
 * sync, but there is no shared package between the renderer and the
 * Electron main bundle to host the constant.
 */
export const PROXY_NETWORK_ERROR_CODE = "proxy_network_error";

export const TRANSPORT_ERROR_MESSAGE =
  "Connection interrupted. Reconnecting…";

/**
 * Does this failed `/assistant/` result look like a transport failure
 * (device offline, network flapping on wake) rather than a server
 * answer? Two signals:
 *   - the structured code the Electron platform proxy attaches when
 *     its own `net.fetch` rejected, and
 *   - a raw Chromium `net::ERR_*` string in the detail (older
 *     Electron builds forwarded the error message verbatim).
 * Thrown fetches (the browser path) never reach this — they surface
 * via `checkAssistant`'s catch instead.
 */
export function isTransportShapedError(
  error: Record<string, unknown>,
): boolean {
  if (error.code === PROXY_NETWORK_ERROR_CODE) return true;
  const detail = typeof error.detail === "string" ? error.detail : "";
  return detail.includes("net::ERR_");
}

export function resolveAssistantLifecycleState(
  result: GetAssistantResult,
): ResolvedAssistantLifecycleState {
  if (result.ok) {
    switch (result.data.status) {
      case "active":
        if (result.data.is_local) {
          return { kind: "self_hosted" };
        }
        return { kind: "active" };
      case "initializing":
        return { kind: "initializing" };
      case "to_be_deleted":
        return { kind: "cleaning_up" };
      default:
        return {
          kind: "error",
          message: `Unexpected assistant status: ${result.data.status}`,
        };
    }
  }

  if (result.status === 404) {
    return { kind: "auto_hatch" };
  }

  // Transport-shaped failures get friendly copy (never a raw
  // `net::ERR_*` string) and the `transient` marker that drives the
  // lifecycle service's degrade-instead-of-error and auto-retry
  // behavior (LUM-2402).
  if (isTransportShapedError(result.error)) {
    return {
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    };
  }

  return {
    kind: "error",
    message: extractErrorMessage(
      result.error,
      undefined,
      "Failed to check assistant status.",
    ),
  };
}

export function shouldRecoverFromHatchFailure(status?: number): boolean {
  return status === undefined || status >= 500;
}

/**
 * The Django hatch endpoint returns 503 + `{ code: "platform_hosted_disabled" }`
 * when platform hosting is unavailable (global capacity kill-switch). The
 * onboarding flow surfaces this as a user-friendly message instead of
 * recovering / retrying.
 */
export const PLATFORM_HOSTED_DISABLED_CODE = "platform_hosted_disabled";

export const PLATFORM_HOSTED_DISABLED_MESSAGE =
  "We are at capacity for Vellum Managed Assistants, more will be available soon!";

export function isPlatformHostedDisabled(
  status: number | undefined,
  error: Record<string, unknown> | undefined,
): boolean {
  if (status !== 503) return false;
  return error?.code === PLATFORM_HOSTED_DISABLED_CODE;
}

/**
 * Backoff schedule for auto-retrying a transient (transport-shaped)
 * error state: 2s, 4s, 8s, … capped at 30s. Wake-time network flaps
 * usually resolve within a few seconds, so the early retries recover
 * the session without the user touching anything; the cap keeps a
 * long outage from polling aggressively forever.
 */
export const ERROR_RETRY_BASE_MS = 2_000;
export const ERROR_RETRY_MAX_MS = 30_000;

export function errorRetryDelayMs(attempt: number): number {
  return Math.min(ERROR_RETRY_BASE_MS * 2 ** attempt, ERROR_RETRY_MAX_MS);
}

export const INITIALIZING_TIMEOUT_MS = 300_000;

export function buildInitializingTimeoutError(): {
  kind: "error";
  message: string;
} {
  return {
    kind: "error",
    message:
      "Your assistant is taking longer than expected to start. Please try again, or check the community for help.",
  };
}
