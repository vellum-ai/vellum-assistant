/**
 * Route handlers for trace event retrieval.
 *
 * GET /v1/trace-events — Returns persisted trace events for a conversation.
 */

import { z } from "zod";

import { getTraceEvents } from "../../telemetry/trace-event-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const traceEventKindSchema = z.enum([
  "request_received",
  "request_queued",
  "request_dequeued",
  "llm_call_started",
  "llm_call_finished",
  "assistant_message",
  "tool_started",
  "tool_permission_requested",
  "tool_permission_decided",
  "tool_finished",
  "tool_failed",
  "generation_handoff",
  "message_complete",
  "generation_cancelled",
  "request_error",
  "tool_profiling_summary",
]);

const traceEventRowSchema = z.object({
  eventId: z.string(),
  conversationId: z.string(),
  requestId: z.string().optional(),
  timestampMs: z.number(),
  sequence: z.number(),
  kind: traceEventKindSchema,
  status: z.enum(["info", "success", "warning", "error"]).optional(),
  summary: z.string(),
  attributes: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
});

function handleListTraceEvents({ queryParams }: RouteHandlerArgs) {
  const conversationId = queryParams?.conversationId;
  if (!conversationId) {
    throw new BadRequestError("conversationId query parameter is required");
  }

  const limitParam = queryParams?.limit;
  const afterSequenceParam = queryParams?.afterSequence;

  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  if (limitParam && (isNaN(limit!) || limit! <= 0)) {
    throw new BadRequestError("limit must be a positive integer");
  }

  const afterSequence = afterSequenceParam
    ? parseInt(afterSequenceParam, 10)
    : undefined;
  if (afterSequenceParam && (isNaN(afterSequence!) || afterSequence! < 0)) {
    throw new BadRequestError("afterSequence must be a non-negative integer");
  }

  const events = getTraceEvents(conversationId, {
    limit,
    afterSequence,
  });

  return { events };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "trace_events_list",
    endpoint: "trace-events",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List trace events",
    description: "Return persisted trace events for a conversation.",
    tags: ["trace"],
    queryParams: [
      {
        name: "conversationId",
        description: "Conversation ID (required)",
      },
      {
        name: "limit",
        type: "integer",
        description: "Max events to return",
      },
      {
        name: "afterSequence",
        type: "integer",
        description: "Return events after this sequence number",
      },
    ],
    responseBody: z.object({
      events: z.array(traceEventRowSchema).describe("Trace event objects"),
    }),
    handler: handleListTraceEvents,
  },
];
