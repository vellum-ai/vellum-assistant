// TODO: port from platform
import type { GetAssistantResult } from "./api.js";

export type ResolvedAssistantLifecycleState =
  | { kind: "active"; isLocal?: boolean; maintenanceMode?: { enabled: boolean | undefined } }
  | { kind: "self_hosted" }
  | { kind: "initializing" }
  | { kind: "auto_hatch" }
  | { kind: "error"; message: string };

export type AssistantLifecycleState = ResolvedAssistantLifecycleState | { kind: "connecting" } | { kind: "disconnected" };
export type AssistantState = AssistantLifecycleState;

export function resolveAssistantLifecycleState(_result: GetAssistantResult): ResolvedAssistantLifecycleState {
  return { kind: "active" };
}

export function shouldRecoverFromHatchFailure(_status?: number): boolean { return false; }

export const PLATFORM_HOSTED_DISABLED_CODE = "platform_hosted_disabled";
export const PLATFORM_HOSTED_DISABLED_MESSAGE = "We are at capacity for Vellum Managed Assistants, more will be available soon!";

export function isPlatformHostedDisabled(_status: number | undefined, _error: Record<string, unknown> | undefined): boolean {
  return false;
}

export const INITIALIZING_TIMEOUT_MS = 300_000;

export function buildInitializingTimeoutError(): { kind: "error"; message: string } {
  return { kind: "error", message: "Your assistant is taking longer than expected to start." };
}
