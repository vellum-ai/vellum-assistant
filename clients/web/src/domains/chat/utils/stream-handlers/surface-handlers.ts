import {
  classifySurfaceDisplay,
  isSurfaceInteractive,
  type Surface,
} from "@/domains/chat/types/types";
import { saveDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import { isSetupChannelId } from "@/types/channel-types";
import { useViewerStore } from "@/stores/viewer-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type {
  UISurfaceCompleteEvent,
  UISurfaceDismissEvent,
  UISurfaceShowEvent,
  UISurfaceUpdateEvent,
} from "@vellumai/assistant-api";

// Surface content (attach / update / dismiss / complete) is folded onto the
// assistant row in the materialized snapshot by the rolling-snapshot reducer.
// These handlers own only the turn-state surface counters, the asset-refresh
// signal, and dismissed-id persistence.

export function handleUISurfaceShow(
  event: UISurfaceShowEvent,
  ctx: StreamHandlerContext,
): void {
  if (event.surfaceType === "channel_setup") {
    const data = event.data as Record<string, unknown> | undefined;
    const rawChannel =
      typeof data?.channel === "string" ? data.channel : undefined;
    const channel = rawChannel && isSetupChannelId(rawChannel) ? rawChannel : "slack";
    const { assistants, activeAssistantId } =
      useResolvedAssistantsStore.getState();
    if (!activeAssistantId) return;
    const assistantName =
      assistants.find((a) => a.id === activeAssistantId)?.name ?? "Assistant";
    useViewerStore.getState().openChannelSetup({
      channel,
      assistantId: activeAssistantId,
      assistantName,
    });
    return;
  }
  if (
    event.surfaceType === "dynamic_page" ||
    event.surfaceType === "document_preview"
  ) {
    ctx.setAssetsRefreshKey((k) => k + 1);
  }
  const surfaceObj: Surface = {
    surfaceId: event.surfaceId,
    surfaceType: event.surfaceType,
    title: event.title,
    data: event.data,
    actions: event.actions,
    display: event.display,
  };
  surfaceObj.display = classifySurfaceDisplay(surfaceObj);
  ctx.turnActions.showSurface(isSurfaceInteractive(surfaceObj));
}

export function handleUISurfaceUpdate(
  _event: UISurfaceUpdateEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.updateSurface();
}

export function handleUISurfaceDismiss(
  event: UISurfaceDismissEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.dismissSurface();
  ctx.addDismissedSurfaceId(event.surfaceId);
  const streamCtx = ctx.streamContext;
  if (streamCtx) {
    saveDismissedSurfaceIds(
      streamCtx.assistantId,
      streamCtx.conversationId,
      useChatSessionStore.getState().dismissedSurfaceIds,
    );
  }
}

export function handleUISurfaceComplete(
  event: UISurfaceCompleteEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.completeSurface();
  // Read the surface type off the materialized snapshot (where the reducer
  // folded it) to decide whether to bump the asset-refresh key.
  const completedSurface = (
    useChatSessionStore.getState().snapshot?.messages ?? []
  )
    .flatMap((m) => m.surfaces ?? [])
    .find((s) => s.surfaceId === event.surfaceId);
  if (
    completedSurface?.surfaceType === "dynamic_page" ||
    completedSurface?.surfaceType === "document_preview"
  ) {
    ctx.setAssetsRefreshKey((k) => k + 1);
  }
}
