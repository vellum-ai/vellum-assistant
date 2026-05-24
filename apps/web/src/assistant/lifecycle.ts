import { extractErrorMessage } from "@/lib/api-errors.js";

import type { GetAssistantResult } from "@/assistant/api.js";

export type ResolvedAssistantLifecycleState =
  | { kind: "active" }
  | { kind: "self_hosted" }
  | { kind: "initializing" }
  | { kind: "cleaning_up" }
  | { kind: "auto_hatch" }
  | { kind: "error"; message: string };

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
 * when the `platform-hosted-enabled` feature flag is off (global capacity
 * kill-switch). The onboarding flow surfaces this as a user-friendly message
 * instead of recovering / retrying.
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

export const INITIALIZING_TIMEOUT_MS = 300_000;

export function buildInitializingTimeoutError(): {
  kind: "error";
  message: string;
} {
  return {
    kind: "error",
    message:
      "Your assistant is taking longer than expected to start. Please try again, or contact support@vellum.ai if the issue persists.",
  };
}
