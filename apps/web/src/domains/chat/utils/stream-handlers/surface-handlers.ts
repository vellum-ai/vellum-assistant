import {
  classifySurfaceDisplay,
  isSurfaceInteractive,
  type Surface,
} from "@/domains/chat/types/types";
import { saveDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  attachSurface,
  completeSurface,
  dismissSurface,
  updateSurfaceData,
} from "@/domains/chat/utils/stream-updaters/surface-updaters";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  UISurfaceCompleteEvent,
  UISurfaceDismissEvent,
  UISurfaceShowEvent,
  UISurfaceUpdateEvent,
} from "@vellumai/assistant-api";

export function handleUISurfaceShow(
  event: UISurfaceShowEvent,
  ctx: StreamHandlerContext,
): void {
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
  ctx.setMessages((prev) =>
    attachSurface(prev, surfaceObj, event.messageId),
  );
}

export function handleUISurfaceUpdate(
  event: UISurfaceUpdateEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.updateSurface();
  ctx.setMessages((prev) =>
    updateSurfaceData(prev, event.surfaceId, event.data),
  );
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
  ctx.setMessages((prev) => dismissSurface(prev, event.surfaceId));
}

export function handleUISurfaceComplete(
  event: UISurfaceCompleteEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.turnActions.completeSurface();
  const completedSurface = ctx.messages
    .flatMap((m) => m.surfaces ?? [])
    .find((s) => s.surfaceId === event.surfaceId);
  if (
    completedSurface?.surfaceType === "dynamic_page" ||
    completedSurface?.surfaceType === "document_preview"
  ) {
    ctx.setAssetsRefreshKey((k) => k + 1);
  }
  ctx.setMessages((prev) =>
    completeSurface(prev, event.surfaceId, event.summary),
  );
}
