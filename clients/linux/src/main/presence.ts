import {
  createDesktopPresenceMonitor,
  IDLE_THRESHOLD_MS,
} from "@vellumai/electron-desktop/desktop-presence-monitor";

import log from "./logger";

export { IDLE_THRESHOLD_MS };

export const installPresenceMonitor = createDesktopPresenceMonitor(log);
