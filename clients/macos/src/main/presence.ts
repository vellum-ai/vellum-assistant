import {
  createDesktopPresenceMonitor,
  IDLE_THRESHOLD_MS,
  POLL_INTERVAL_MS,
  type PresenceState,
} from "@vellumai/electron-desktop/desktop-presence-monitor";

import log from "./logger";

export { IDLE_THRESHOLD_MS, POLL_INTERVAL_MS, type PresenceState };

export const installPresenceMonitor = createDesktopPresenceMonitor(log);
