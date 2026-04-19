/**
 * Extension service-worker entry. Opens the native-messaging port to the
 * meet-bot, wires content scripts into it via {@link startContentBridge},
 * hooks in the avatar feature (Phase 4), and emits the `ready` handshake
 * so the bot knows the extension is alive.
 */
import { startAvatarFeature } from "./features/avatar.js";
import { startContentBridge } from "./messaging/content-bridge.js";
import { openNativePort } from "./messaging/native-port.js";

console.log("[meet-ext] background booted");

const port = openNativePort({});
startContentBridge(port);

// Phase 4 — avatar feature. Opens a pinned second Chrome tab when the
// bot sends `avatar.start` and forwards `avatar.push_viseme` into that
// tab. Outbound `avatar.started` / `avatar.frame` frames from the tab
// are validated and forwarded to the bot via the shared native port.
const avatar = startAvatarFeature({
  tabs: chrome.tabs,
  runtime: chrome.runtime,
  port,
});

// Route bot→extension avatar commands into the avatar feature. Other
// bot→extension commands (join/leave/send_chat) continue to flow
// through the content bridge to the Meet content script.
port.onMessage((msg) => {
  if (
    msg.type === "avatar.start" ||
    msg.type === "avatar.stop" ||
    msg.type === "avatar.push_viseme"
  ) {
    void avatar.handleBotCommand(msg);
  }
});

// Emit the ready handshake as soon as the port is open. The bot uses this as
// the signal that the in-container extension is attached and ready to
// receive join/leave/send_chat commands.
port.post({
  type: "ready",
  extensionVersion: chrome.runtime.getManifest().version,
});
