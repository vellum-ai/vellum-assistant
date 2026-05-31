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
 *   - `parse-resource-events`    — cache invalidation / push signals
 *
 * Events that migrate to `@vellumai/assistant-api` Zod schemas bypass
 * the legacy switch entirely — the canonical path takes precedence.
 */

import type { AssistantEvent } from "@/types/event-types";
import { AssistantEventSchema } from "@vellumai/assistant-api";
import { unknownEvent } from "@/lib/streaming/parse-helpers";

import {
  parseSyncChanged,
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
    // --- Resource invalidation / push signals ---
    case "sync_changed":
      return parseSyncChanged(data);
    case "disk_pressure_status_changed":
      return parseDiskPressureStatusChanged(data);
    case "document_editor_update":
      return parseDocumentEditorUpdate(data);

    // --- Inline cases (small, no cohesive group) ---

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
