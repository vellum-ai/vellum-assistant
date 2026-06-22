/**
 * Surface updaters for SSE stream events.
 *
 * Handles: ui_surface_show, ui_surface_update, ui_surface_dismiss,
 * ui_surface_complete.
 *
 * Each exported function has the signature
 * `(prev: DisplayMessage[], ...args) => DisplayMessage[]`.
 */

import type { DisplayMessage, Surface } from "@/domains/chat/types/types";
import {
  removeSurfaceBlock,
  upsertSurfaceBlock,
} from "@/domains/chat/utils/map-message-surfaces";
import {
  findAssistantRowIndexByMessageId,
  withMergedAlias,
} from "@/domains/chat/utils/stream-updaters/shared";

// ---------------------------------------------------------------------------
// ui_surface_show
// ---------------------------------------------------------------------------

/** Attach a new surface to the appropriate assistant message. */
export function attachSurface(
  prev: DisplayMessage[],
  surface: Surface,
  messageId?: string,
): DisplayMessage[] {
  let targetIdx = -1;

  if (messageId) {
    targetIdx = findAssistantRowIndexByMessageId(prev, messageId);
  }
  if (targetIdx === -1) {
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i]?.role === "assistant") {
        targetIdx = i;
        break;
      }
    }
  }

  const updated = [...prev];
  if (targetIdx === -1) {
    updated.push({
      id: messageId ?? crypto.randomUUID(),
      ...(messageId ? {} : { isOptimistic: true }),
      role: "assistant" as const,
      surfaces: [surface],
      contentOrder: [{ type: "surface", id: surface.surfaceId }],
      contentBlocks: [{ type: "surface", surface }],
      timestamp: Date.now(),
    });
  } else {
    const target = withMergedAlias(prev[targetIdx]!, messageId);
    if (
      target.contentOrder?.some(
        (e) => e.type === "surface" && e.id === surface.surfaceId,
      ) ||
      target.surfaces?.some((s) => s.surfaceId === surface.surfaceId)
    ) {
      return prev;
    }
    updated[targetIdx] = {
      ...target,
      surfaces: [...(target.surfaces ?? []), surface],
      contentOrder: [
        ...(target.contentOrder ?? []),
        { type: "surface", id: surface.surfaceId },
      ],
      contentBlocks: upsertSurfaceBlock(target.contentBlocks, surface),
    };
  }
  return updated;
}

// ---------------------------------------------------------------------------
// ui_surface_update
// ---------------------------------------------------------------------------

/** Merge new data into an existing surface. */
export function updateSurfaceData(
  prev: DisplayMessage[],
  surfaceId: string,
  data: Record<string, unknown>,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const msg = prev[i]!;
    const surfIdx =
      msg.surfaces?.findIndex((s) => s.surfaceId === surfaceId) ?? -1;
    if (surfIdx === -1) continue;

    const surface = msg.surfaces![surfIdx]!;
    const mergedData = { ...surface.data, ...data };
    if (
      surface.data.templateData &&
      data.templateData &&
      typeof surface.data.templateData === "object" &&
      typeof data.templateData === "object"
    ) {
      mergedData.templateData = {
        ...(surface.data.templateData as Record<string, unknown>),
        ...(data.templateData as Record<string, unknown>),
      };
    }
    const updatedSurface = { ...surface, data: mergedData };
    const updated = [...prev];
    const newSurfaces = [...msg.surfaces!];
    newSurfaces[surfIdx] = updatedSurface;
    updated[i] = {
      ...msg,
      surfaces: newSurfaces,
      contentBlocks: upsertSurfaceBlock(msg.contentBlocks, updatedSurface),
    };
    return updated;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// ui_surface_dismiss
// ---------------------------------------------------------------------------

/** Remove a dismissed surface from its message. */
export function dismissSurface(
  prev: DisplayMessage[],
  surfaceId: string,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (!prev[i]!.surfaces?.some((s) => s.surfaceId === surfaceId)) continue;
    const updated = [...prev];
    updated[i] = {
      ...prev[i]!,
      surfaces: prev[i]!.surfaces?.filter((s) => s.surfaceId !== surfaceId),
      contentOrder: prev[i]!.contentOrder?.filter(
        (e) => !(e.type === "surface" && e.id === surfaceId),
      ),
      contentBlocks: removeSurfaceBlock(prev[i]!.contentBlocks, surfaceId),
    };
    return updated;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// ui_surface_complete
// ---------------------------------------------------------------------------

/** Mark a surface as completed with an optional summary. */
export function completeSurface(
  prev: DisplayMessage[],
  surfaceId: string,
  summary?: string,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const surface = prev[i]!.surfaces?.find((s) => s.surfaceId === surfaceId);
    if (!surface) continue;
    const completedSurface: Surface = {
      ...surface,
      completed: true,
      completionSummary: summary,
    };
    const updated = [...prev];
    updated[i] = {
      ...prev[i]!,
      surfaces: prev[i]!.surfaces?.map((s) =>
        s.surfaceId === surfaceId ? completedSurface : s,
      ),
      contentBlocks: upsertSurfaceBlock(prev[i]!.contentBlocks, completedSurface),
    };
    return updated;
  }
  return prev;
}
