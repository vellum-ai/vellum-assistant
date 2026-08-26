import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installDownloads } from "@vellumai/electron-desktop/downloads";

import { handle } from "../ipc.client";

/**
 * Windows downloads feature: the shared handler files renderer downloads into
 * the user's Downloads folder and reports each outcome to the originating
 * window, matching the macOS shell (minus the Dock bounce, which is a macOS
 * API). Distinct from `share.ts`, the "send elsewhere" intent served by a
 * Save As dialog.
 */
const downloads: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "downloads",
  install: () => {
    installDownloads({ handle });
  },
};

export default downloads;
