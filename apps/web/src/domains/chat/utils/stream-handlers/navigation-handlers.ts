import {
  getHttpUrl,
  getSameOriginRoutePath,
  openOAuthUrlInPopup,
} from "@/domains/chat/utils/oauth-popup-links";
import { getSettingsRouteForClientTab } from "@/utils/settings-navigation";
import { openUrl } from "@/runtime/browser";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { OpenUrlEvent } from "@vellumai/assistant-api";
import type { NavigateSettingsEvent } from "@/types/event-types";

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
      message:
        "Popup blocked. Please allow popups for Vellum and try again.",
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
