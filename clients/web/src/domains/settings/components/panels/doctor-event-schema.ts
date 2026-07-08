/**
 * Zod-validated discriminated union for doctor SSE event payloads.
 *
 * Doctor events come from the platform Django backend (not the daemon),
 * so they are not in the daemon OpenAPI spec and require manual type
 * definitions with runtime validation at the trust boundary.
 */

import { z } from "zod";

const DoctorSourceEventFields = {
  source_event_id: z.string().nullable().optional(),
};

export const DoctorEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("message"),
    content: z.string(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("message_delta"),
    content: z.string(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("tool_call"),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    id: z.string(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("approval_required"),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    id: z.string(),
    description: z.string(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("backup_prompt"),
    toolName: z.string(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("feedback_prompt"),
    summary: z.string().optional(),
    reason: z.enum(["bug_report", "feature_request", "other"]).optional(),
    classification: z.enum(["bug_report", "feature_request", "other"]).optional(),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("status"),
    status: z.union([
      z.literal("active"),
      z.literal("completed"),
      z.literal("error"),
    ]),
  }),
  z.object({
    ...DoctorSourceEventFields,
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type DoctorEvent = z.infer<typeof DoctorEventSchema>;

/**
 * Parse a raw SSE payload into a validated DoctorEvent, or `null` if
 * the payload is invalid or represents an unknown event type (forward
 * compatibility — new event types are silently dropped).
 */
export function parseDoctorEvent(payload: Record<string, unknown> | string): DoctorEvent | null {
  try {
    const obj: unknown = typeof payload === "string" ? JSON.parse(payload) : payload;
    const result = DoctorEventSchema.safeParse(obj);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
