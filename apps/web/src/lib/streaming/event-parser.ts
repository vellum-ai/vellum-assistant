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
 *   - `parse-interaction-events` — user-facing prompts
 *   - `parse-tool-events`        — tool execution lifecycle
 *   - `parse-surface-events`     — daemon-driven UI surfaces
 *   - `parse-subagent-events`    — subagent orchestration
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
} from "@/types/event-types";
import { AssistantEventSchema } from "@vellumai/assistant-api";
import { unknownEvent } from "@/lib/streaming/parse-helpers";

import {
  parseSecretRequest,
  parseConfirmationRequest,
  parseContactRequest,
  parseQuestionRequest,
} from "@/lib/streaming/parse-interaction-events";
import {
  parseToolUseStart,
  parseToolResult,
  parseToolProgress,
} from "@/lib/streaming/parse-tool-events";
import {
  parseUISurfaceShow,
  parseUISurfaceUpdate,
  parseUISurfaceDismiss,
  parseUISurfaceComplete,
} from "@/lib/streaming/parse-surface-events";
import {
  parseSubagentSpawned,
  parseSubagentStatusChanged,
  parseSubagentEvent,
} from "@/lib/streaming/parse-subagent-events";
import {
  parseSyncChanged,
  parseNotificationIntent,
  parseDiskPressureStatusChanged,
  parseDocumentEditorUpdate,
} from "@/lib/streaming/parse-resource-events";

/**
 * Unwrap envelope-shape payloads `{ message: { type, ...fields }, conversationId }`
 * into the inner event. Flat-shape payloads `{ type, ...fields }` pass
 * through unchanged.
 *
 * Pure unwrap: the envelope-level `conversationId` (SSE routing key)
 * is NOT merged onto the inner message. Strict-schema events that
 * don't declare `conversationId` stay strict; legacy events that need
 * envelope conversationId get it via `mergeEnvelopeConversationId`
 * along the fallback path.
 */
function unwrapEnvelope(data: Record<string, unknown>): {
  inner: Record<string, unknown>;
  envelopeConversationId: string | undefined;
} {
  const message = data.message;
  if (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    typeof (message as Record<string, unknown>).type === "string"
  ) {
    return {
      inner: message as Record<string, unknown>,
      envelopeConversationId:
        typeof data.conversationId === "string"
          ? data.conversationId
          : undefined,
    };
  }
  return { inner: data, envelopeConversationId: undefined };
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
 * Parse a raw SSE payload into a typed `AssistantEvent`. Owns envelope
 * unwrap, canonical-schema dispatch, legacy-event coercion, and
 * envelope-conversationId stamping. Tolerant of unknown event types —
 * returns an `UnknownEvent` for anything unrecognised so callers can
 * safely ignore it without crashing.
 */
export function parseAssistantEvent(
  data: Record<string, unknown>,
): AssistantEvent {
  const { inner, envelopeConversationId } = unwrapEnvelope(data);

  // Canonical schema first. The discriminated union in
  // `@vellumai/assistant-api` is the source of truth for any event
  // type it covers — when a member matches the `type` discriminator
  // and the shape validates, the parser is done. The schema sees the
  // pure inner message (no envelope merge): every wire-contract
  // schema declares the fields it requires (including
  // `conversationId` for conversation-scoped events), so the
  // envelope-level routing key never needs to be grafted on.
  const schemaResult = AssistantEventSchema.safeParse(inner);
  if (schemaResult.success) return schemaResult.data as AssistantEvent;

  // Legacy fallback. Merge the envelope conversationId in so legacy
  // case bodies just read `data.conversationId` — daemon emit sites
  // for legacy events aren't always disciplined about putting the
  // conversationId on the inner message.
  return parseLegacyEvent(
    mergeEnvelopeConversationId(inner, envelopeConversationId),
  );
}

function parseLegacyEvent(data: Record<string, unknown>): AssistantEvent {
  const rawType = typeof data.type === "string" ? data.type : "";

  switch (rawType) {
    // --- Interaction prompts ---
    case "secret_request":
      return parseSecretRequest(data);
    case "confirmation_request":
      return parseConfirmationRequest(data);
    case "contact_request":
      return parseContactRequest(data);
    case "question_request":
      return parseQuestionRequest(data);

    // --- Tool execution lifecycle ---
    case "tool_use_start":
      return parseToolUseStart(data);
    case "tool_result":
      return parseToolResult(data);
    case "tool_progress":
      return parseToolProgress(data);

    // --- UI surface lifecycle ---
    case "ui_surface_show":
      return parseUISurfaceShow(data);
    case "ui_surface_update":
      return parseUISurfaceUpdate(data);
    case "ui_surface_dismiss":
      return parseUISurfaceDismiss(data);
    case "ui_surface_complete":
      return parseUISurfaceComplete(data);

    // --- Subagent orchestration ---
    case "subagent_spawned":
      return parseSubagentSpawned(data);
    case "subagent_status_changed":
      return parseSubagentStatusChanged(data);
    case "subagent_event":
      return parseSubagentEvent(data);

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

    case "error":
      return {
        type: "error",
        code: typeof data.code === "string" ? data.code : undefined,
        ...(typeof data.errorCategory === "string"
          ? { errorCategory: data.errorCategory }
          : {}),
        message:
          typeof data.message === "string" ? data.message : "Unknown error",
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "conversation_error":
      return {
        type: "conversation_error",
        conversationId:
          typeof data.conversationId === "string" ? data.conversationId : "",
        code: typeof data.code === "string" ? data.code : "UNKNOWN",
        userMessage:
          typeof data.userMessage === "string"
            ? data.userMessage
            : "Something went wrong.",
        retryable: typeof data.retryable === "boolean" ? data.retryable : false,
        debugDetails:
          typeof data.debugDetails === "string" ? data.debugDetails : undefined,
        errorCategory:
          typeof data.errorCategory === "string"
            ? data.errorCategory
            : undefined,
      };

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
