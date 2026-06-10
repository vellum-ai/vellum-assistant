import { buildVellumHeaders } from "@/lib/auth/request-headers";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const APPROVAL_RESPONSES = new Set([
  "approve",
  "approve all exec",
  "approve all future exec commands",
  "approve_all_exec",
  "deny",
]);

export type DoctorEvent =
  | { type: "message"; content: string }
  | { type: "message_delta"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      input: Record<string, unknown>;
      id: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: "approval_required";
      toolName: string;
      input: Record<string, unknown>;
      id: string;
      description: string;
    }
  | { type: "backup_prompt"; toolName: string }
  | { type: "status"; status: "active" | "completed" | "error" }
  | { type: "error"; message: string };

const VALID_EVENT_TYPES = new Set([
  "message",
  "message_delta",
  "tool_call",
  "tool_result",
  "approval_required",
  "backup_prompt",
  "status",
  "error",
]);

/**
 * Parse a raw SSE data payload into a DoctorEvent, returning null on
 * malformed input. Validates that the `type` field is a known event type.
 */
export function parseDoctorEvent(raw: string): DoctorEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string" || !VALID_EVENT_TYPES.has(obj.type)) {
      return null;
    }
    return obj as unknown as DoctorEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

export function buildDoctorSSEHeaders(): Record<string, string> {
  return buildVellumHeaders({
    Accept: "text/event-stream",
    ...getClientRegistrationHeaders(),
  });
}
