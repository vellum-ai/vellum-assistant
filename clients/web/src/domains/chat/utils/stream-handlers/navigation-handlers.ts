import {
  getHttpUrl,
  getSameOriginRoutePath,
  openOAuthUrlInPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import { getSettingsRouteForClientTab } from "@/utils/settings-navigation";
import { openUrl } from "@/runtime/browser";
import { isSetupChannelId } from "@/types/channel-types";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useViewerStore } from "@/stores/viewer-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type {
  NavigateSettingsEvent,
  OpenPanelEvent,
  OpenUrlEvent,
} from "@vellumai/assistant-api";

export function handleOpenUrl(
  event: OpenUrlEvent,
  ctx: StreamHandlerContext,
): void {
  const sameOriginRoutePath = getSameOriginRoutePath(event.url);
  if (sameOriginRoutePath) {
    ctx.router.push(sameOriginRoutePath);
    return;
  }

  if (openOAuthUrlInPopup(event.url)) {
    return;
  }

  const url = getHttpUrl(event.url);
  if (!url) {
    ctx.setError({
      message: "This link cannot be opened from the web app.",
    });
    return;
  }

  if (ctx.isNative) {
    void openUrl(url);
    return;
  }

  const popup = window.open(url, "_blank");
  if (popup === null) {
    ctx.setError({
      message: "Popup blocked. Please allow popups for Vellum and try again.",
    });
    return;
  }

  popup.focus();
}

export function handleNavigateSettings(
  event: NavigateSettingsEvent,
  ctx: StreamHandlerContext,
): void {
  const route = getSettingsRouteForClientTab(event.tab);
  if (!route) {
    ctx.setError({ message: `Unknown settings tab: ${event.tab}` });
    return;
  }
  ctx.router.push(route);
}

export function handleOpenPanel(event: OpenPanelEvent): void {
  if (event.panelType === "channel_setup") {
    const rawChannel =
      typeof event.data?.channel === "string" ? event.data.channel : undefined;
    const channel =
      rawChannel && isSetupChannelId(rawChannel) ? rawChannel : "slack";
    const { assistants, activeAssistantId } =
      useResolvedAssistantsStore.getState();
    if (!activeAssistantId) {
      return;
    }
    // The identity store carries the assistant's self-chosen name from
    // IDENTITY.md; the platform record name can be a placeholder
    // (e.g. "New Assistant"), so it is only a fallback.
    const identityName = useAssistantIdentityStore.getState().name;
    const assistantName =
      identityName?.trim() ||
      assistants.find((a) => a.id === activeAssistantId)?.name ||
      "Assistant";
    useViewerStore.getState().openChannelSetup({
      channel,
      assistantId: activeAssistantId,
      assistantName,
    });
  }
}
