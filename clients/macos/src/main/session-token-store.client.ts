import {
  __resetForTesting,
  clearSessionToken,
  getSessionToken,
  onSessionTokenChange,
  saveSessionToken,
  setSessionTokenLogger,
} from "@vellumai/electron-desktop/session-token-store";

import log from "./logger";

setSessionTokenLogger(log);

export {
  __resetForTesting,
  clearSessionToken,
  getSessionToken,
  onSessionTokenChange,
  saveSessionToken,
};
