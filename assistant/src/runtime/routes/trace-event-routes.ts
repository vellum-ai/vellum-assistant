/**
 * Route handlers for trace event retrieval.
 *
 * GET /v1/trace-events — Returns persisted trace events for a conversation.
 */

import { z } from "zod";

import { getTraceEvents } from "../../memory/trace-event-store.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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
      events: z.array(z.unknown()).describe("Trace event objects"),
    }),
    handler: handleListTraceEvents,
  },
];
