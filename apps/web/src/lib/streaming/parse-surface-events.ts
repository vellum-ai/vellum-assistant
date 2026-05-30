/**
 * Legacy parsers for daemon-driven UI surface lifecycle events.
 *
 * Surfaces are ephemeral UI widgets the daemon projects into the chat
 * view. The four events cover the full lifecycle: show → update →
 * dismiss/complete.
 */

import type {
  AssistantEvent,
  UISurfaceShowEvent,
} from "@/types/event-types";

export function parseUISurfaceShow(
  data: Record<string, unknown>,
): AssistantEvent {
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
}

export function parseUISurfaceUpdate(
  data: Record<string, unknown>,
): AssistantEvent {
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
}

export function parseUISurfaceDismiss(
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "ui_surface_dismiss",
    surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : "",
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
  };
}

export function parseUISurfaceComplete(
  data: Record<string, unknown>,
): AssistantEvent {
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
}
