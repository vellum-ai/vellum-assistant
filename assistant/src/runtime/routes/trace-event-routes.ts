/**
 * HTTP route handlers for trace event retrieval.
 *
 * GET /v1/trace-events — Returns persisted trace events for a conversation.
 */

import { getTraceEvents } from "../../memory/trace-event-store.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function traceEventRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "trace-events",
      method: "GET",
      summary: "List trace events",
      description: "Return persisted trace events for a conversation.",
      tags: ["trace"],
      queryParams: [
        {
          name: "conversationId",
          schema: { type: "string" },
          description: "Conversation ID (required)",
        },
        {
          name: "limit",
          schema: { type: "integer" },
          description: "Max events to return",
        },
        {
          name: "afterSequence",
          schema: { type: "integer" },
          description: "Return events after this sequence number",
        },
      ],
      responseBody: {
        type: "object",
        properties: {
          events: { type: "array", description: "Trace event objects" },
        },
      },
      handler: ({ url }) => {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          return httpError(
            "BAD_REQUEST",
            "conversationId query parameter is required",
            400,
          );
        }

        const limitParam = url.searchParams.get("limit");
        const afterSequenceParam = url.searchParams.get("afterSequence");

        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        if (limitParam && (isNaN(limit!) || limit! <= 0)) {
          return httpError(
            "BAD_REQUEST",
            "limit must be a positive integer",
            400,
          );
        }

        const afterSequence = afterSequenceParam
          ? parseInt(afterSequenceParam, 10)
          : undefined;
        if (
          afterSequenceParam &&
          (isNaN(afterSequence!) || afterSequence! < 0)
        ) {
          return httpError(
            "BAD_REQUEST",
            "afterSequence must be a non-negative integer",
            400,
          );
        }

        const events = getTraceEvents(conversationId, {
          limit,
          afterSequence,
        });

        return Response.json({ events });
      },
    },
  ];
}
