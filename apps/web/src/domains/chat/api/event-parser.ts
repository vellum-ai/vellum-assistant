/**
 * SSE event parsing for the assistant chat stream.
 *
 * Exports `parseAssistantEvent`, which takes a raw SSE payload and
 * returns a typed `AssistantEvent`. The parser unwraps the
 * envelope/flat shape, tries the canonical `AssistantEventSchema`
 * from `@vellumai/assistant-api` first, and falls back to hand-rolled
 * coercion for legacy events not yet covered by a schema.
 */

import type {
  DiskPressureBlockedCapability,
  DiskPressureStatus,
} from "@/assistant/types";
import type {
  AssistantActivityPhase,
  AssistantActivityReason,
  AssistantActivityStateEvent,
  AssistantEvent,
  ConversationListInvalidatedReason,
  UISurfaceShowEvent,
} from "@/types/event-types";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionOption,
  ScopeOption,
  SubagentInnerEvent,
  SubagentStatus,
} from "@/types/interaction-ui-types";
import type { AssistantOutboundAttachment } from "@vellumai/assistant-api";
import { AssistantEventSchema } from "@vellumai/assistant-api";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import type { SyncInvalidationTag } from "@/lib/sync/types";

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
 * Build the `unknown` fallback event, preserving the raw type, the
 * original payload, and any conversation scope so downstream filters
 * (e.g. per-conversation SSE subscribers) still route correctly.
 */
function unknownEvent(
  rawType: string,
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "unknown",
    rawType,
    data,
    conversationId:
      typeof data.conversationId === "string" ? data.conversationId : undefined,
  };
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
    case "sync_changed": {
      const tags = data.tags;
      if (
        !Array.isArray(tags) ||
        !tags.every((tag): tag is string => typeof tag === "string")
      ) {
        return unknownEvent(rawType, data);
      }
      const rawOriginClientId =
        typeof data.originClientId === "string"
          ? data.originClientId.trim()
          : "";
      return {
        type: "sync_changed",
        tags: tags as SyncInvalidationTag[],
        ...(rawOriginClientId ? { originClientId: rawOriginClientId } : {}),
      };
    }

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

    case "secret_request":
      return {
        type: "secret_request",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        service: typeof data.service === "string" ? data.service : undefined,
        field: typeof data.field === "string" ? data.field : undefined,
        label: typeof data.label === "string" ? data.label : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        placeholder:
          typeof data.placeholder === "string" ? data.placeholder : undefined,
        allowOneTimeSend:
          typeof data.allowOneTimeSend === "boolean"
            ? data.allowOneTimeSend
            : undefined,
        allowedTools: Array.isArray(data.allowedTools)
          ? (data.allowedTools as string[])
          : undefined,
        allowedDomains: Array.isArray(data.allowedDomains)
          ? (data.allowedDomains as string[])
          : undefined,
        purpose: typeof data.purpose === "string" ? data.purpose : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "confirmation_request":
      return {
        type: "confirmation_request",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        title: typeof data.title === "string" ? data.title : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        confirmLabel:
          typeof data.confirmLabel === "string" ? data.confirmLabel : undefined,
        denyLabel:
          typeof data.denyLabel === "string" ? data.denyLabel : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
        toolName: typeof data.toolName === "string" ? data.toolName : undefined,
        executionTarget:
          typeof data.executionTarget === "string"
            ? data.executionTarget
            : undefined,
        riskLevel:
          typeof data.riskLevel === "string" ? data.riskLevel : undefined,
        riskReason:
          typeof data.riskReason === "string" ? data.riskReason : undefined,
        allowlistOptions: Array.isArray(data.allowlistOptions)
          ? (data.allowlistOptions as AllowlistOption[])
          : undefined,
        scopeOptions: Array.isArray(data.scopeOptions)
          ? (data.scopeOptions as ScopeOption[])
          : undefined,
        directoryScopeOptions: Array.isArray(data.directoryScopeOptions)
          ? (data.directoryScopeOptions as DirectoryScopeOption[])
          : undefined,
        persistentDecisionsAllowed:
          typeof data.persistentDecisionsAllowed === "boolean"
            ? data.persistentDecisionsAllowed
            : undefined,
        input:
          typeof data.input === "object" &&
          data.input !== null &&
          !Array.isArray(data.input)
            ? (data.input as Record<string, unknown>)
            : undefined,
        toolUseId:
          typeof data.toolUseId === "string" ? data.toolUseId : undefined,
      };

    case "contact_request":
      return {
        type: "contact_request",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        channel: typeof data.channel === "string" ? data.channel : undefined,
        placeholder:
          typeof data.placeholder === "string" ? data.placeholder : undefined,
        label: typeof data.label === "string" ? data.label : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        role: typeof data.role === "string" ? data.role : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "question_request": {
      const requestId =
        typeof data.requestId === "string" ? data.requestId : "";
      // Pass through both shapes: the new `questions` array (batched) and the
      // legacy flat fields. `normalizeQuestionRequest` (in event-types) picks
      // whichever is present; legacy daemons emit only the flat fields, newer
      // daemons emit both for back-compat.
      const options: QuestionOption[] | undefined = Array.isArray(data.options)
        ? (data.options as QuestionOption[])
        : undefined;
      const questions: QuestionEntry[] | undefined = Array.isArray(
        data.questions,
      )
        ? (data.questions as QuestionEntry[])
        : undefined;
      return {
        type: "question_request",
        requestId,
        questions,
        question: typeof data.question === "string" ? data.question : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        options,
        freeTextPlaceholder:
          typeof data.freeTextPlaceholder === "string"
            ? data.freeTextPlaceholder
            : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
        toolUseId:
          typeof data.toolUseId === "string" ? data.toolUseId : undefined,
      };
    }

    case "ui_surface_show":
      return {
        type: "ui_surface_show",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        surfaceType:
          typeof data.surfaceType === "string" ? data.surfaceType : "card",
        title: typeof data.title === "string" ? data.title : undefined,
        data:
          typeof data.data === "object" && data.data !== null
            ? (data.data as Record<string, unknown>)
            : {},
        actions: Array.isArray(data.actions)
          ? (data.actions as UISurfaceShowEvent["actions"])
          : undefined,
        display:
          data.display === "inline" || data.display === "panel"
            ? data.display
            : undefined,
        messageId:
          typeof data.messageId === "string" ? data.messageId : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "ui_surface_update":
      return {
        type: "ui_surface_update",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        data:
          typeof data.data === "object" && data.data !== null
            ? (data.data as Record<string, unknown>)
            : {},
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "ui_surface_dismiss":
      return {
        type: "ui_surface_dismiss",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "ui_surface_complete":
      return {
        type: "ui_surface_complete",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        summary: typeof data.summary === "string" ? data.summary : "",
        submittedData:
          typeof data.submittedData === "object" && data.submittedData !== null
            ? (data.submittedData as Record<string, unknown>)
            : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "tool_use_start":
      return {
        type: "tool_use_start",
        toolName: typeof data.toolName === "string" ? data.toolName : "unknown",
        input:
          typeof data.input === "object" && data.input !== null
            ? (data.input as Record<string, unknown>)
            : {},
        toolUseId:
          typeof data.toolUseId === "string" ? data.toolUseId : undefined,
        messageId:
          typeof data.messageId === "string" ? data.messageId : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "tool_result":
      return {
        type: "tool_result",
        toolName: typeof data.toolName === "string" ? data.toolName : "unknown",
        result: typeof data.result === "string" ? data.result : "",
        isError: typeof data.isError === "boolean" ? data.isError : undefined,
        toolUseId:
          typeof data.toolUseId === "string" ? data.toolUseId : undefined,
        messageId:
          typeof data.messageId === "string" ? data.messageId : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
        riskLevel:
          typeof data.riskLevel === "string" ? data.riskLevel : undefined,
        riskReason:
          typeof data.riskReason === "string" ? data.riskReason : undefined,
        matchedTrustRuleId:
          typeof data.matchedTrustRuleId === "string"
            ? data.matchedTrustRuleId
            : undefined,
        approvalMode:
          typeof data.approvalMode === "string" ? data.approvalMode : undefined,
        approvalReason:
          typeof data.approvalReason === "string"
            ? data.approvalReason
            : undefined,
        riskThreshold:
          typeof data.riskThreshold === "string"
            ? data.riskThreshold
            : undefined,
        // The daemon emits two semantically distinct arrays on tool_result:
        //   - `riskAllowlistOptions`  → Minimatch-glob save-path patterns (the
        //     ones that get persisted as a trust rule's `pattern`). This is
        //     what the rule editor's "Apply to" radio group needs.
        //   - `riskScopeOptions`      → display-only ladder, can carry
        //     regex-flavored descriptors that are NOT valid trust rule
        //     patterns. We deliberately do not feed these into the save path.
        // (Pre-PR-29826 the wire collapsed both into `riskScopeOptions` and
        // we cast that into `allowlistOptions` — a silent shape/contract bug
        // that produced unmatchable rules. See `assistant/src/tools/types.ts`.)
        allowlistOptions: Array.isArray(data.riskAllowlistOptions)
          ? (data.riskAllowlistOptions as AllowlistOption[])
          : undefined,
        directoryScopeOptions: Array.isArray(data.riskDirectoryScopeOptions)
          ? (data.riskDirectoryScopeOptions as DirectoryScopeOption[])
          : undefined,
        // Daemon emits `activityMetadata` on tool_result for tools that report
        // structured activity (currently Anthropic-native web_search). Treated
        // as opaque on the wire — the downstream consumer (turn-state) keys
        // off the discriminated child fields (webSearch/webFetch).
        activityMetadata:
          typeof data.activityMetadata === "object" &&
          data.activityMetadata !== null &&
          !Array.isArray(data.activityMetadata)
            ? (data.activityMetadata as ToolActivityMetadata)
            : undefined,
      };

    case "tool_progress": {
      const toolName =
        typeof data.toolName === "string" ? data.toolName : "unknown";
      const elapsedSec =
        typeof data.elapsedSec === "number" ? data.elapsedSec : 0;
      const timeoutSec =
        typeof data.timeoutSec === "number" ? data.timeoutSec : 0;
      return {
        type: "tool_progress",
        toolName,
        elapsedSec,
        timeoutSec,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
        toolUseId:
          typeof data.toolUseId === "string" ? data.toolUseId : undefined,
      };
    }

    case "conversation_list_invalidated": {
      const rawReason = typeof data.reason === "string" ? data.reason : "";
      const reason: ConversationListInvalidatedReason =
        rawReason === "created" ||
        rawReason === "renamed" ||
        rawReason === "deleted" ||
        rawReason === "reordered" ||
        rawReason === "seen_changed"
          ? rawReason
          : "created";
      return { type: "conversation_list_invalidated", reason };
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

    case "conversation_title_updated": {
      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId : "";
      const title = typeof data.title === "string" ? data.title : "";
      if (!conversationId) {
        return unknownEvent(rawType, data);
      }
      return { type: "conversation_title_updated", conversationId, title };
    }

    case "notification_intent": {
      const title = typeof data.title === "string" ? data.title : "";
      const body = typeof data.body === "string" ? data.body : "";
      const sourceEventName =
        typeof data.sourceEventName === "string" ? data.sourceEventName : "";
      if (!title || !sourceEventName) {
        return unknownEvent(rawType, data);
      }
      const deepLinkMetadata =
        typeof data.deepLinkMetadata === "object" &&
        data.deepLinkMetadata !== null &&
        !Array.isArray(data.deepLinkMetadata)
          ? (data.deepLinkMetadata as Record<string, unknown>)
          : undefined;
      return {
        type: "notification_intent",
        deliveryId:
          typeof data.deliveryId === "string" ? data.deliveryId : undefined,
        sourceEventName,
        title,
        body,
        deepLinkMetadata,
        targetGuardianPrincipalId:
          typeof data.targetGuardianPrincipalId === "string"
            ? data.targetGuardianPrincipalId
            : undefined,
      };
    }

    case "identity_changed":
      return { type: "identity_changed" };

    case "avatar_updated":
      return { type: "avatar_updated" };

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

    case "disk_pressure_status_changed":
      return {
        type: "disk_pressure_status_changed",
        status: parseDiskPressureStatus(
          Object.prototype.hasOwnProperty.call(data, "status")
            ? data.status
            : data,
        ),
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };

    case "subagent_spawned": {
      const subagentId =
        typeof data.subagentId === "string" ? data.subagentId : "";
      const label = typeof data.label === "string" ? data.label : "";
      if (!subagentId || !label) {
        return unknownEvent(rawType, data);
      }
      return {
        type: "subagent_spawned",
        subagentId,
        parentConversationId:
          typeof data.parentConversationId === "string"
            ? data.parentConversationId
            : undefined,
        label,
        objective: typeof data.objective === "string" ? data.objective : "",
        isFork: typeof data.isFork === "boolean" ? data.isFork : undefined,
        parentToolUseId:
          typeof data.parentToolUseId === "string"
            ? data.parentToolUseId
            : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };
    }

    case "subagent_status_changed": {
      const subagentId =
        typeof data.subagentId === "string" ? data.subagentId : "";
      const status = typeof data.status === "string" ? data.status : "";
      if (!subagentId || !status) {
        return unknownEvent(rawType, data);
      }
      const usage =
        data.usage &&
        typeof data.usage === "object" &&
        !Array.isArray(data.usage)
          ? (data.usage as Record<string, unknown>)
          : null;
      return {
        type: "subagent_status_changed",
        subagentId,
        status: status as SubagentStatus,
        error: typeof data.error === "string" ? data.error : undefined,
        inputTokens:
          typeof usage?.inputTokens === "number"
            ? usage.inputTokens
            : undefined,
        outputTokens:
          typeof usage?.outputTokens === "number"
            ? usage.outputTokens
            : undefined,
        totalCost:
          typeof usage?.estimatedCost === "number"
            ? usage.estimatedCost
            : undefined,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
      };
    }

    case "subagent_event": {
      const subagentId =
        typeof data.subagentId === "string" ? data.subagentId : "";
      const event = data.event;
      if (
        !subagentId ||
        !event ||
        typeof event !== "object" ||
        Array.isArray(event)
      ) {
        return unknownEvent(rawType, data);
      }
      return {
        type: "subagent_event",
        subagentId,
        conversationId:
          typeof data.conversationId === "string"
            ? data.conversationId
            : undefined,
        event: event as SubagentInnerEvent,
      };
    }

    case "document_editor_update": {
      const surfaceId =
        typeof data.surfaceId === "string" ? data.surfaceId : "";
      const markdown = typeof data.markdown === "string" ? data.markdown : "";
      const mode = typeof data.mode === "string" ? data.mode : "replace";
      const conversationId =
        typeof data.conversationId === "string"
          ? data.conversationId
          : undefined;
      if (!surfaceId) {
        return unknownEvent(rawType, data);
      }
      return {
        type: "document_editor_update",
        surfaceId,
        markdown,
        mode,
        conversationId,
      };
    }

    default:
      return unknownEvent(rawType, data);
  }
}

function parseDiskPressureStatus(raw: unknown): DiskPressureStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const state =
    data.state === "disabled" ||
    data.state === "ok" ||
    data.state === "critical" ||
    data.state === "unknown"
      ? data.state
      : "unknown";

  const finiteNumberOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const blockedCapabilities: DiskPressureBlockedCapability[] = Array.isArray(
    data.blockedCapabilities,
  )
    ? data.blockedCapabilities.filter(
        (capability): capability is DiskPressureBlockedCapability =>
          capability === "agent-turns" ||
          capability === "background-work" ||
          capability === "remote-ingress",
      )
    : [];

  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : false,
    state,
    locked: typeof data.locked === "boolean" ? data.locked : false,
    acknowledged:
      typeof data.acknowledged === "boolean" ? data.acknowledged : false,
    overrideActive:
      typeof data.overrideActive === "boolean" ? data.overrideActive : false,
    effectivelyLocked:
      typeof data.effectivelyLocked === "boolean"
        ? data.effectivelyLocked
        : false,
    lockId: typeof data.lockId === "string" ? data.lockId : null,
    usagePercent: finiteNumberOrNull(data.usagePercent),
    thresholdPercent: finiteNumberOrNull(data.thresholdPercent) ?? 0,
    path: typeof data.path === "string" ? data.path : null,
    lastCheckedAt:
      typeof data.lastCheckedAt === "string" ? data.lastCheckedAt : null,
    blockedCapabilities,
    error: typeof data.error === "string" ? data.error : null,
  };
}

/**
 * Convert backend `AssistantOutboundAttachment` objects into `DisplayAttachment`
 * objects suitable for rendering in chat message bubbles. When inline base64
 * data is available, a data-URI `previewUrl` is created for all MIME types so
 * the preview modal can render or download the content without a separate fetch.
 * When only a thumbnail is available (e.g. video with omitted data), the
 * thumbnail is used as a fallback preview. Files with `fileBacked: true` and no
 * inline data rely on the daemon's `/v1/attachments/:id/content` endpoint —
 * the modal fetches content lazily via the assistantId-scoped proxy URL.
 */
export function toDisplayAttachments(
  attachments: AssistantOutboundAttachment[] | undefined,
): DisplayAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att) => {
    let previewUrl: string | null = null;
    if (att.data) {
      previewUrl = `data:${att.mimeType};base64,${att.data}`;
    } else if (att.thumbnailData) {
      previewUrl = `data:image/jpeg;base64,${att.thumbnailData}`;
    }
    return {
      id: att.id ?? att.filename,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes:
        att.sizeBytes ?? (att.data ? Math.floor((att.data.length * 3) / 4) : 0),
      previewUrl,
    };
  });
}
