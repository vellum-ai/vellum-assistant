/**
 * SSE event parsing for the assistant chat stream.
 *
 * Exports `parseAssistantEvent`, which takes a raw SSE payload and
 * returns a typed `AssistantEvent`. The parser unwraps the
 * envelope/flat shape, tries the canonical `AssistantEventSchema`
 * from `@vellumai/assistant-api` first, and falls back to hand-rolled
 * coercion for legacy events not yet covered by a schema.
 *
 * Legacy coercion is split across focused sub-modules by event group:
 *   - `parse-tool-events`        — tool execution lifecycle
 *   - `parse-resource-events`    — cache invalidation / push signals
 *
 * Events that migrate to `@vellumai/assistant-api` Zod schemas bypass
 * the legacy switch entirely — the canonical path takes precedence.
 */

import type {
  AssistantActivityPhase,
  AssistantActivityReason,
  AssistantActivityStateEvent,
  AssistantEvent,
  AssistantEventEnvelope,
} from "@/types/event-types";
import { AssistantEventSchema } from "@vellumai/assistant-api";
import { unknownEvent } from "@/lib/streaming/parse-helpers";

import {
  parseToolUseStart,
  parseToolResult,
} from "@/lib/streaming/parse-tool-events";

import {
  parseSyncChanged,
  parseNotificationIntent,
  parseDiskPressureStatusChanged,
  parseDocumentEditorUpdate,
} from "@/lib/streaming/parse-resource-events";

interface UnwrappedEnvelope {
  inner: Record<string, unknown>;
  id: string | undefined;
  conversationId: string | undefined;
  seq: number | undefined;
  emittedAt: string | undefined;
}

/**
 * Unwrap envelope-shape payloads `{ id, conversationId, seq, emittedAt, message: { type, ...fields } }`
 * into the inner event plus envelope-level metadata. Flat-shape payloads
 * `{ type, ...fields }` pass through unchanged with no envelope metadata.
 */
function unwrapEnvelope(data: Record<string, unknown>): UnwrappedEnvelope {
  const message = data.message;
  if (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    typeof (message as Record<string, unknown>).type === "string"
  ) {
    return {
      inner: message as Record<string, unknown>,
      id: typeof data.id === "string" ? data.id : undefined,
      conversationId:
        typeof data.conversationId === "string"
          ? data.conversationId
          : undefined,
      seq: typeof data.seq === "number" ? data.seq : undefined,
      emittedAt:
        typeof data.emittedAt === "string" ? data.emittedAt : undefined,
    };
  }
  return {
    inner: data,
    id: undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
    seq: undefined,
    emittedAt: undefined,
  };
}

/**
 * Merge the envelope-level `conversationId` onto the inner data when
 * the inner doesn't already declare one. Used only on the legacy
 * fallback path — strict-schema events skip this step so the envelope
 * routing key never leaks onto the parsed event.
 */
function mergeEnvelopeConversationId(
  inner: Record<string, unknown>,
  envelopeConversationId: string | undefined,
): Record<string, unknown> {
  if (envelopeConversationId && typeof inner.conversationId !== "string") {
    return { ...inner, conversationId: envelopeConversationId };
  }
  return inner;
}

/**
 * Parse a raw SSE payload into a typed `AssistantEventEnvelope`. Owns
 * envelope unwrap, canonical-schema dispatch, legacy-event coercion,
 * and envelope-conversationId stamping. Tolerant of unknown event
 * types — returns an `UnknownEvent` inner for anything unrecognised
 * so callers can safely ignore it without crashing.
 */
export function parseAssistantEvent(
  data: Record<string, unknown>,
): AssistantEventEnvelope {
  const { inner, id, conversationId, seq, emittedAt } =
    unwrapEnvelope(data);

  // Canonical schema first. The discriminated union in
  // `@vellumai/assistant-api` is the source of truth for any event
  // type it covers — when a member matches the `type` discriminator
  // and the shape validates, the parser is done. The schema sees the
  // pure inner message (no envelope merge): every wire-contract
  // schema declares the fields it requires (including
  // `conversationId` for conversation-scoped events), so the
  // envelope-level routing key never needs to be grafted on.
  const schemaResult = AssistantEventSchema.safeParse(inner);
  const message: AssistantEvent = schemaResult.success
    ? (schemaResult.data as AssistantEvent)
    : parseLegacyEvent(
        mergeEnvelopeConversationId(inner, conversationId),
      );

  return {
    id,
    conversationId:
      conversationId ??
      (typeof inner.conversationId === "string"
        ? inner.conversationId
        : undefined),
    seq,
    emittedAt,
    message,
  };
}

function parseLegacyEvent(data: Record<string, unknown>): AssistantEvent {
  const rawType = typeof data.type === "string" ? data.type : "";

  switch (rawType) {
    // --- Tool execution lifecycle ---
    case "tool_use_start":
      return parseToolUseStart(data);
    case "tool_result":
      return parseToolResult(data);

    // --- Resource invalidation / push signals ---
    case "sync_changed":
      return parseSyncChanged(data);
    case "notification_intent":
      return parseNotificationIntent(data);
    case "disk_pressure_status_changed":
      return parseDiskPressureStatusChanged(data);
    case "document_editor_update":
      return parseDocumentEditorUpdate(data);

    // --- Inline cases (small, no cohesive group) ---

    case "assistant_activity_state": {
      const phase = typeof data.phase === "string" ? data.phase : "";
      const anchor = typeof data.anchor === "string" ? data.anchor : "";
      const reason = typeof data.reason === "string" ? data.reason : "";
      const activityVersion =
        typeof data.activityVersion === "number" ? data.activityVersion : 0;
      const validPhases: AssistantActivityPhase[] = [
        "idle",
        "thinking",
        "streaming",
        "tool_running",
        "awaiting_confirmation",
      ];
      const validAnchors = ["assistant_turn", "user_turn", "global"];
      const validReasons: AssistantActivityReason[] = [
        "message_dequeued",
        "thinking_delta",
        "first_text_delta",
        "tool_use_start",
        "preview_start",
        "tool_result_received",
        "confirmation_requested",
        "confirmation_resolved",
        "context_compacting",
        "message_complete",
        "generation_cancelled",
        "error_terminal",
      ];
      if (
        !validPhases.includes(phase as AssistantActivityPhase) ||
        !validAnchors.includes(anchor) ||
        !validReasons.includes(reason as AssistantActivityReason)
      ) {
        return unknownEvent(rawType, data);
      }
      return {
        type: "assistant_activity_state",
        activityVersion,
        phase: phase as AssistantActivityPhase,
        anchor: anchor as AssistantActivityStateEvent["anchor"],
        reason: reason as AssistantActivityReason,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
        ...(typeof data.requestId === "string"
          ? { requestId: data.requestId }
          : {}),
        ...(typeof data.statusText === "string"
          ? { statusText: data.statusText }
          : {}),
      };
    }

    case "navigate_settings": {
      const tab = typeof data.tab === "string" ? data.tab : "";
      if (!tab) {
        return unknownEvent(rawType, data);
      }
      return {
        type: "navigate_settings",
        tab,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };
    }

    case "usage_update": {
      const readNumber = (key: string): number | undefined => {
        const value = data[key];
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : undefined;
      };
      return {
        type: "usage_update",
        inputTokens: readNumber("inputTokens"),
        outputTokens: readNumber("outputTokens"),
        cachedInputTokens: readNumber("cachedInputTokens"),
        cacheCreationInputTokens: readNumber("cacheCreationInputTokens"),
        contextWindowTokens: readNumber("contextWindowTokens"),
        contextWindowMaxTokens: readNumber("contextWindowMaxTokens"),
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };
    }

    case "turn_profile_auto_routed": {
      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId : "";
      const profile = typeof data.profile === "string" ? data.profile : "";
      const profileLabel =
        typeof data.profileLabel === "string" ? data.profileLabel : "";
      if (!profileLabel) return unknownEvent(rawType, data);
      return {
        type: "turn_profile_auto_routed",
        conversationId,
        profile,
        profileLabel,
        conversationKey:
          typeof data.conversationKey === "string"
            ? data.conversationKey
            : undefined,
      };
    }

    default:
      return unknownEvent(rawType, data);
  }
}
