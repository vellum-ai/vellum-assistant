/**
 * Extension service-worker entry. Opens the native-messaging port to the
 * meet-bot, wires content scripts into it via {@link startContentBridge}, and
 * emits the `ready` handshake so the bot knows the extension is alive.
 */
import { startContentBridge } from "./messaging/content-bridge.js";
import { openNativePort } from "./messaging/native-port.js";

console.log("[meet-ext] background booted");

const port = openNativePort({});
startContentBridge(port);

// Emit the ready handshake as soon as the port is open. The bot uses this as
// the signal that the in-container extension is attached and ready to
// receive join/leave/send_chat commands.
port.post({
  type: "ready",
  extensionVersion: chrome.runtime.getManifest().version,
});
