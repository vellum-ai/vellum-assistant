import { captureError } from "@/lib/sentry/capture-error";

import { publish } from "@/lib/event-bus";
import {
  drainPendingDeepLinks,
  subscribeToDeepLinks,
  type DeepLink,
} from "@/runtime/deep-links";

/**
 * Electron `vellum://` deep-link bridge → typed bus events:
 * `deeplink.send { message }` / `deeplink.openThread { threadId }`
 * / `deeplink.unknown { url }`.
 *
 * Two surfaces because deep links can arrive BEFORE the renderer
 * exists (OS launches the app via a `vellum://` click → `open-url`
 * fires before `whenReady`):
 *
 *   - **Subscribe** for live links via the runtime wrapper.
 *   - **Drain** the main-side buffer for links that arrived during
 *     startup (pre-renderer-ready backlog).
 *
 * Subscribe-then-drain order is load-bearing: a link landing between
 * drain completion and subscription would be lost otherwise. The
 * helper subscribes synchronously and fires the drain in the
 * background. Duplicate delivery is prevented main-side: pending
 * buffering only happens when `subscribers.size === 0` at the moment
 * of arrival (see `apps/macos/src/main/deep-links.ts`). Once a
 * subscriber is registered, in-flight links go via broadcast only,
 * and `drainPendingDeepLinks` returns the pre-subscribe backlog.
 *
 * Off Electron the wrappers are no-ops and the returned unsubscribe
 * drops through cleanly.
 */
export function publishElectronDeepLinksSource(): () => void {
  const publishDeepLink = (link: DeepLink): void => {
    switch (link.kind) {
      case "send":
        publish("deeplink.send", { message: link.message });
        break;
      case "openThread":
        publish("deeplink.openThread", { threadId: link.threadId });
        break;
      case "unknown":
        publish("deeplink.unknown", { url: link.url });
        break;
    }
  };

  const unsubscribe = subscribeToDeepLinks(publishDeepLink);

  void drainPendingDeepLinks()
    .then((pending) => {
      for (const link of pending) publishDeepLink(link);
    })
    .catch((err) => {
      captureError(err, { context: "deep_link_drain", level: "warning" });
    });

  return unsubscribe;
}
