/**
 * SSE event parsing for the assistant chat stream.
 *
 * Exports `parseAssistantEvent` which converts raw SSE payloads into typed
 * `AssistantEvent` objects, plus helpers for attachment display conversion.
 * `readEventConversationKey` is also exported for use by the stream transport.
 */

import type {
  DiskPressureBlockedCapability,
  DiskPressureStatus,
} from "@/lib/assistants/types.js";
import type {
  AllowlistOption,
  AssistantActivityPhase,
  AssistantActivityReason,
  AssistantActivityStateEvent,
  AssistantEvent,
  AssistantOutboundAttachment,
  ConversationListInvalidatedReason,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionOption,
  ScopeOption,
  SubagentInnerEvent,
  SubagentStatus,
  UISurfaceShowEvent,
} from "@/domains/chat/lib/event-types.js";
import type { DisplayAttachment } from "@/domains/chat/lib/types.js";
import type { SyncInvalidationTag } from "@/lib/sync/types.js";

export function readEventConversationKey(
  data: Record<string, unknown>,
): string | undefined {
  if (typeof data.conversationKey === "string" && data.conversationKey) {
    return data.conversationKey;
  }
  // Daemon emits `conversationId` for many events. In the web client this maps
  // 1:1 to the conversation key used by the sidebar/history APIs.
  if (typeof data.conversationId === "string" && data.conversationId) {
    return data.conversationId;
  }
  return undefined;
}

function withParsedConversationKey<T extends AssistantEvent>(
  event: T,
  data: Record<string, unknown>,
): T {
  const conversationKey = readEventConversationKey(data);
  if (!conversationKey || event.conversationKey) {
    return event;
  }
  return { ...event, conversationKey } as T;
}

/**
 * Parse a raw wire payload into a typed AssistantEvent.
 * Tolerant of unknown event types — returns an `UnknownEvent` for anything
 * unrecognised so callers can safely ignore it without crashing.
 */
export function parseAssistantEvent(
  rawType: string,
  data: Record<string, unknown>,
): AssistantEvent {
  const parsed = ((): AssistantEvent => {
    switch (rawType) {
    case "assistant_text_delta":
      return {
        type: "assistant_text_delta",
        text: typeof data.text === "string" ? data.text : "",
        messageId:
          typeof data.messageId === "string" ? data.messageId : undefined,
      };

    case "message_complete":
      return {
        type: "message_complete",
        messageId:
          typeof data.messageId === "string" ? data.messageId : undefined,
        ...(typeof data.displayMessageId === "string"
          ? { displayMessageId: data.displayMessageId }
          : {}),
        content:
          typeof data.content === "string" ? data.content : undefined,
        attachments: parseOutboundAttachments(data.attachments),
      };

    case "generation_handoff":
      return {
        type: "generation_handoff",
        messageId:
          typeof data.messageId === "string" ? data.messageId : undefined,
        ...(typeof data.displayMessageId === "string"
          ? { displayMessageId: data.displayMessageId }
          : {}),
        attachments: parseOutboundAttachments(data.attachments),
      };

    case "generation_cancelled":
      return { type: "generation_cancelled" };

    case "sync_changed": {
      const tags = data.tags;
      if (
        !Array.isArray(tags) ||
        !tags.every((tag): tag is string => typeof tag === "string")
      ) {
        return { type: "unknown", rawType, data };
      }
      return {
        type: "sync_changed",
        tags: tags as SyncInvalidationTag[],
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
        return { type: "unknown", rawType, data };
      }
      return {
        type: "assistant_activity_state",
        activityVersion,
        phase: phase as AssistantActivityPhase,
        anchor: anchor as AssistantActivityStateEvent["anchor"],
        reason: reason as AssistantActivityReason,
        ...(typeof data.requestId === "string"
          ? { requestId: data.requestId }
          : {}),
        ...(typeof data.statusText === "string"
          ? { statusText: data.statusText }
          : {}),
      };
    }

    case "open_url": {
      const url = typeof data.url === "string" ? data.url : "";
      if (!url) {
        return { type: "unknown", rawType, data };
      }
      return {
        type: "open_url",
        url,
        title: typeof data.title === "string" ? data.title : undefined,
      };
    }

    case "navigate_settings": {
      const tab = typeof data.tab === "string" ? data.tab : "";
      if (!tab) {
        return { type: "unknown", rawType, data };
      }
      return {
        type: "navigate_settings",
        tab,
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
          typeof data.message === "string"
            ? data.message
            : "Unknown error",
      };

    case "secret_request":
      return {
        type: "secret_request",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        service: typeof data.service === "string" ? data.service : undefined,
        field: typeof data.field === "string" ? data.field : undefined,
        label: typeof data.label === "string" ? data.label : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
        placeholder: typeof data.placeholder === "string" ? data.placeholder : undefined,
        allowOneTimeSend: typeof data.allowOneTimeSend === "boolean" ? data.allowOneTimeSend : undefined,
        allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools as string[] : undefined,
        allowedDomains: Array.isArray(data.allowedDomains) ? data.allowedDomains as string[] : undefined,
        purpose: typeof data.purpose === "string" ? data.purpose : undefined,
      };

    case "confirmation_request":
      return {
        type: "confirmation_request",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        title: typeof data.title === "string" ? data.title : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
        confirmLabel: typeof data.confirmLabel === "string" ? data.confirmLabel : undefined,
        denyLabel: typeof data.denyLabel === "string" ? data.denyLabel : undefined,
        toolName: typeof data.toolName === "string" ? data.toolName : undefined,
        executionTarget: typeof data.executionTarget === "string" ? data.executionTarget : undefined,
        riskLevel: typeof data.riskLevel === "string" ? data.riskLevel : undefined,
        riskReason: typeof data.riskReason === "string" ? data.riskReason : undefined,
        allowlistOptions: Array.isArray(data.allowlistOptions)
          ? (data.allowlistOptions as AllowlistOption[])
          : undefined,
        scopeOptions: Array.isArray(data.scopeOptions)
          ? (data.scopeOptions as ScopeOption[])
          : undefined,
        directoryScopeOptions: Array.isArray(data.directoryScopeOptions)
          ? (data.directoryScopeOptions as DirectoryScopeOption[])
          : undefined,
        persistentDecisionsAllowed: typeof data.persistentDecisionsAllowed === "boolean"
          ? data.persistentDecisionsAllowed
          : undefined,
        input: typeof data.input === "object" && data.input !== null && !Array.isArray(data.input)
          ? (data.input as Record<string, unknown>)
          : undefined,
        toolUseId: typeof data.toolUseId === "string" ? data.toolUseId : undefined,
      };

    case "contact_request":
      return {
        type: "contact_request",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        channel: typeof data.channel === "string" ? data.channel : undefined,
        placeholder: typeof data.placeholder === "string" ? data.placeholder : undefined,
        label: typeof data.label === "string" ? data.label : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
        role: typeof data.role === "string" ? data.role : undefined,
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
        question:
          typeof data.question === "string" ? data.question : undefined,
        description:
          typeof data.description === "string" ? data.description : undefined,
        options,
        freeTextPlaceholder:
          typeof data.freeTextPlaceholder === "string"
            ? data.freeTextPlaceholder
            : undefined,
        toolUseId:
          typeof data.toolUseId === "string" ? data.toolUseId : undefined,
      };
    }

    case "ui_surface_show":
      return {
        type: "ui_surface_show",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        surfaceType: typeof data.surfaceType === "string" ? data.surfaceType : "card",
        title: typeof data.title === "string" ? data.title : undefined,
        data: typeof data.data === "object" && data.data !== null
          ? (data.data as Record<string, unknown>)
          : {},
        actions: Array.isArray(data.actions)
          ? (data.actions as UISurfaceShowEvent["actions"])
          : undefined,
        display: data.display === "inline" || data.display === "panel"
          ? data.display
          : undefined,
        messageId: typeof data.messageId === "string" ? data.messageId : undefined,
      };

    case "ui_surface_update":
      return {
        type: "ui_surface_update",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        data: typeof data.data === "object" && data.data !== null
          ? (data.data as Record<string, unknown>)
          : {},
      };

    case "ui_surface_dismiss":
      return {
        type: "ui_surface_dismiss",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
      };

    case "ui_surface_complete":
      return {
        type: "ui_surface_complete",
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
        summary: typeof data.summary === "string" ? data.summary : "",
        submittedData: typeof data.submittedData === "object" && data.submittedData !== null
          ? (data.submittedData as Record<string, unknown>)
          : undefined,
      };

    case "tool_use_start":
      return {
        type: "tool_use_start",
        toolName: typeof data.toolName === "string" ? data.toolName : "unknown",
        input: typeof data.input === "object" && data.input !== null
          ? (data.input as Record<string, unknown>)
          : {},
        toolUseId: typeof data.toolUseId === "string" ? data.toolUseId : undefined,
      };

    case "tool_result":
      return {
        type: "tool_result",
        toolName: typeof data.toolName === "string" ? data.toolName : "unknown",
        result: typeof data.result === "string" ? data.result : "",
        isError: typeof data.isError === "boolean" ? data.isError : undefined,
        toolUseId: typeof data.toolUseId === "string" ? data.toolUseId : undefined,
        conversationKey: typeof data.conversationKey === "string" ? data.conversationKey : undefined,
        riskLevel: typeof data.riskLevel === "string" ? data.riskLevel : undefined,
        riskReason: typeof data.riskReason === "string" ? data.riskReason : undefined,
        matchedTrustRuleId: typeof data.matchedTrustRuleId === "string" ? data.matchedTrustRuleId : undefined,
        approvalMode: typeof data.approvalMode === "string" ? data.approvalMode : undefined,
        approvalReason: typeof data.approvalReason === "string" ? data.approvalReason : undefined,
        riskThreshold: typeof data.riskThreshold === "string" ? data.riskThreshold : undefined,
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
      };

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
      };
    }

    case "conversation_title_updated": {
      // Daemon emits `conversationId` (the internal ID), which for web maps
      // 1:1 to the `conversationKey` the sidebar indexes by — the client
      // never sees a separate conversationId because our only create path
      // is POST /v1/messages with a client-chosen key.
      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId : "";
      const title = typeof data.title === "string" ? data.title : "";
      if (!conversationId) {
        return { type: "unknown", rawType, data };
      }
      return { type: "conversation_title_updated", conversationId, title };
    }

    case "notification_intent": {
      const title = typeof data.title === "string" ? data.title : "";
      const body = typeof data.body === "string" ? data.body : "";
      const sourceEventName =
        typeof data.sourceEventName === "string" ? data.sourceEventName : "";
      if (!title || !sourceEventName) {
        return { type: "unknown", rawType, data };
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

    case "conversation_error":
      return {
        type: "conversation_error",
        conversationId: typeof data.conversationId === "string" ? data.conversationId : "",
        code: typeof data.code === "string" ? data.code : "UNKNOWN",
        userMessage: typeof data.userMessage === "string" ? data.userMessage : "Something went wrong.",
        retryable: typeof data.retryable === "boolean" ? data.retryable : false,
        debugDetails: typeof data.debugDetails === "string" ? data.debugDetails : undefined,
        errorCategory: typeof data.errorCategory === "string" ? data.errorCategory : undefined,
        conversationKey: typeof data.conversationKey === "string" ? data.conversationKey : undefined,
      };

    case "compaction_circuit_open":
      return {
        type: "compaction_circuit_open",
        conversationId: typeof data.conversationId === "string" ? data.conversationId : "",
        reason: typeof data.reason === "string" ? data.reason : "",
        openUntil: typeof data.openUntil === "number" ? data.openUntil : 0,
        conversationKey: typeof data.conversationKey === "string" ? data.conversationKey : undefined,
      };

    case "compaction_circuit_closed":
      return {
        type: "compaction_circuit_closed",
        conversationId: typeof data.conversationId === "string" ? data.conversationId : "",
        conversationKey: typeof data.conversationKey === "string" ? data.conversationKey : undefined,
      };

    case "disk_pressure_status_changed":
      return {
        type: "disk_pressure_status_changed",
        status: parseDiskPressureStatus(
          Object.prototype.hasOwnProperty.call(data, "status")
            ? data.status
            : data,
        ),
        conversationKey: typeof data.conversationKey === "string" ? data.conversationKey : undefined,
      };

    case "message_queued":
      return {
        type: "message_queued",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        position: typeof data.position === "number" ? data.position : 0,
      };

    case "message_dequeued":
      return {
        type: "message_dequeued",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
      };

    case "message_queued_deleted":
      return {
        type: "message_queued_deleted",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
      };

    case "message_request_complete":
      return {
        type: "message_request_complete",
        requestId: typeof data.requestId === "string" ? data.requestId : "",
        runStillActive: typeof data.runStillActive === "boolean" ? data.runStillActive : undefined,
      };

    case "home_feed_updated":
      return {
        type: "home_feed_updated",
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
        newItemCount: typeof data.newItemCount === "number" ? data.newItemCount : 0,
      };

    case "relationship_state_updated":
      return {
        type: "relationship_state_updated",
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
      };

    case "subagent_spawned": {
      const subagentId = typeof data.subagentId === "string" ? data.subagentId : "";
      const label = typeof data.label === "string" ? data.label : "";
      if (!subagentId || !label) {
        return { type: "unknown", rawType, data };
      }
      return {
        type: "subagent_spawned",
        subagentId,
        parentConversationId:
          typeof data.parentConversationId === "string" ? data.parentConversationId : undefined,
        label,
        objective: typeof data.objective === "string" ? data.objective : "",
        isFork: typeof data.isFork === "boolean" ? data.isFork : undefined,
      };
    }

    case "subagent_status_changed": {
      const subagentId = typeof data.subagentId === "string" ? data.subagentId : "";
      const status = typeof data.status === "string" ? data.status : "";
      if (!subagentId || !status) {
        return { type: "unknown", rawType, data };
      }
      const usage = data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
        ? (data.usage as Record<string, unknown>)
        : null;
      return {
        type: "subagent_status_changed",
        subagentId,
        status: status as SubagentStatus,
        error: typeof data.error === "string" ? data.error : undefined,
        inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined,
        outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined,
        totalCost: typeof usage?.estimatedCost === "number" ? usage.estimatedCost : undefined,
      };
    }

    case "subagent_event": {
      const subagentId = typeof data.subagentId === "string" ? data.subagentId : "";
      const event = data.event;
      if (!subagentId || !event || typeof event !== "object" || Array.isArray(event)) {
        return { type: "unknown", rawType, data };
      }
      return {
        type: "subagent_event",
        subagentId,
        conversationId:
          typeof data.conversationId === "string" ? data.conversationId : undefined,
        event: event as SubagentInnerEvent,
      };
    }

    default:
      return { type: "unknown", rawType, data };
    }
  })();

  return withParsedConversationKey(parsed, data);
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
 * Parse an optional `attachments` payload from an SSE event into a typed array.
 * Returns `undefined` when no valid attachments are present.
 */
function parseOutboundAttachments(
  raw: unknown,
): AssistantOutboundAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const result: AssistantOutboundAttachment[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).filename === "string" &&
      typeof (item as Record<string, unknown>).mimeType === "string"
    ) {
      const a = item as Record<string, unknown>;
      result.push({
        id: typeof a.id === "string" ? a.id : undefined,
        filename: a.filename as string,
        mimeType: a.mimeType as string,
        data: typeof a.data === "string" ? a.data : "",
        sourceType:
          a.sourceType === "sandbox_file" ||
          a.sourceType === "host_file" ||
          a.sourceType === "tool_block"
            ? a.sourceType
            : undefined,
        sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : undefined,
        thumbnailData:
          typeof a.thumbnailData === "string" ? a.thumbnailData : undefined,
        fileBacked: typeof a.fileBacked === "boolean" ? a.fileBacked : undefined,
      });
    }
  }
  return result.length > 0 ? result : undefined;
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
      sizeBytes: att.sizeBytes ?? (att.data ? Math.floor((att.data.length * 3) / 4) : 0),
      previewUrl,
    };
  });
}
