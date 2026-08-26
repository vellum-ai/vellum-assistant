import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installDownloads } from "@vellumai/electron-desktop/downloads";

/**
 * Files renderer downloads into the user's Downloads folder with uniquified
 * names instead of prompting a Save dialog for each one. Distinct from
 * `share.ts`, which is the explicit "save elsewhere" intent.
 */
const downloads: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "downloads",
  install: () => {
    installDownloads();
  },
};

export default downloads;
