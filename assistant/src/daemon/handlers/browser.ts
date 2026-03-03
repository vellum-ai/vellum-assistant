import { browserManager } from "../../tools/browser/browser-manager.js";
import { defineHandlers } from "./shared.js";

export const browserHandlers = defineHandlers({
  browser_cdp_response: (msg) => {
    browserManager.resolveCDPResponse(msg.sessionId, msg.success, msg.declined);
  },
});
