import { browserManager } from "../../tools/browser/browser-manager.js";
import { defineHandlers, log } from "./shared.js";

export const browserHandlers = defineHandlers({
  browser_cdp_response: (msg) => {
    browserManager.resolveCDPResponse(msg.sessionId, msg.success, msg.declined);
  },

  browser_interactive_mode: (msg, socket, ctx) => {
    log.info(
      { sessionId: msg.sessionId, enabled: msg.enabled },
      "Interactive mode toggled",
    );
    browserManager.setInteractiveMode(msg.sessionId, msg.enabled);
    ctx.send(socket, {
      type: "browser_interactive_mode_changed",
      sessionId: msg.sessionId,
      surfaceId: msg.surfaceId,
      enabled: msg.enabled,
    });
  },
});
