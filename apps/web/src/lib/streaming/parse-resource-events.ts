/**
 * Legacy parsers for resource invalidation and push-signal events.
 *
 * These events notify the client about server-side state changes
 * (cache invalidation tags, identity/avatar refreshes, conversation
 * renames, notification intents, disk pressure) so the appropriate
 * TanStack Query keys or Zustand stores can be updated. None of
 * these carry chat-turn content — they are broadcast signals.
 */

import type {
  DiskPressureBlockedCapability,
  DiskPressureStatus,
} from "@/assistant/types";
import type { AssistantEvent } from "@/types/event-types";
import type { SyncInvalidationTag } from "@/lib/sync/types";
import { unknownEvent } from "@/lib/streaming/parse-helpers";

export function parseSyncChanged(
  data: Record<string, unknown>,
): AssistantEvent {
  const tags = data.tags;
  if (
    !Array.isArray(tags) ||
    !tags.every((tag): tag is string => typeof tag === "string")
  ) {
    return unknownEvent("sync_changed", data);
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

// `identity_changed`, `avatar_updated`, `conversation_title_updated`, and
// `conversation_list_invalidated` are now schema-validated via canonical
// schemas in `@vellumai/assistant-api`. The legacy parser functions
// previously here are gone — `event-parser.ts` no longer dispatches
// these cases; `parseAssistantEvent` resolves them through
// `AssistantEventSchema` before reaching the legacy switch.

export function parseNotificationIntent(
  data: Record<string, unknown>,
): AssistantEvent {
  const title = typeof data.title === "string" ? data.title : "";
  const body = typeof data.body === "string" ? data.body : "";
  const sourceEventName =
    typeof data.sourceEventName === "string" ? data.sourceEventName : "";
  if (!title || !sourceEventName) {
    return unknownEvent("notification_intent", data);
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

export function parseDiskPressureStatusChanged(
  data: Record<string, unknown>,
): AssistantEvent {
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
}

export function parseDocumentEditorUpdate(
  data: Record<string, unknown>,
): AssistantEvent {
  const surfaceId =
    typeof data.surfaceId === "string" ? data.surfaceId : "";
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  const mode = typeof data.mode === "string" ? data.mode : "replace";
  const conversationId =
    typeof data.conversationId === "string"
      ? data.conversationId
      : undefined;
  if (!surfaceId) {
    return unknownEvent("document_editor_update", data);
  }
  return {
    type: "document_editor_update",
    surfaceId,
    markdown,
    mode,
    conversationId,
  };
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
