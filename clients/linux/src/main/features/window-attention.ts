import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installWindowAttention } from "@vellumai/electron-desktop/window-attention";

/**
 * Publishes each window's visible / focused / minimized state to the renderer
 * that owns it. Vellum windows disable background throttling, which disables
 * the Page Visibility API with it, so main is the only side that can answer
 * where a window is.
 *
 * Its own capability rather than a line inside notifications: the renderer
 * spends this signal on presence reporting, which decides whether a reply is
 * pushed to the user's phone, so turning toasts off must not also tell the
 * daemon that a minimized desktop is watching. macOS installs it
 * independently for the same reason.
 */
const windowAttention: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "window-attention",
  install: () => {
    const teardown = installWindowAttention();
    app.once("before-quit", teardown);
  },
};

export default windowAttention;
