import type { MouseEvent } from "react";

import { openUrl } from "@/runtime/browser";
import { isNativePlatform } from "@/runtime/native-auth";

/**
 * Click handler for external `target="_blank"` anchors that must also work
 * in the iOS Capacitor shell. On iOS WKWebView without a
 * `WKUIDelegate createWebViewWith` implementation, `target="_blank"` links
 * silently do nothing — the webview won't open a new "tab". Route through
 * Capacitor's `SFSafariViewController` instead so the user actually sees
 * the destination. Web and Electron keep the default new-tab behavior
 * (right-click → copy link still works because the `href` is preserved).
 */
export function handleNativeAnchorClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
): void {
  if (!href || !isNativePlatform()) {
    return;
  }
  event.preventDefault();
  void openUrl(href);
}
