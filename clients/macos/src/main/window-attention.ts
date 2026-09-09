import { app } from "electron";

import { installWindowAttention } from "@vellumai/electron-desktop/window-attention";

/**
 * Publishes each window's visible / focused / minimized state to the renderer
 * that owns it. Vellum windows disable background throttling, which disables
 * the Page Visibility API with it, so main is the only side that can answer
 * where a window is.
 *
 * Installed independently of notifications: the renderer spends this signal
 * on presence reporting, which decides whether a reply is pushed to the
 * user's phone, so turning toasts off must not also tell the daemon that a
 * minimized desktop is watching. Windows and Linux carry the same split as
 * their own capability module.
 */
export const installWindowAttentionFeature = (): void => {
  const teardown = installWindowAttention();
  app.once("before-quit", teardown);
};
