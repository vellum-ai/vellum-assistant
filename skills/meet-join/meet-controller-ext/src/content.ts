/**
 * Content script entry point.
 *
 * Runs inside every `https://meet.google.com/*` tab (declared in
 * `manifest.json`). Responsible for:
 *
 * - Forwarding inbound Meet chat messages to the background service worker
 *   (which relays them over the native-messaging port as
 *   `chat.inbound` events).
 * - Handling `send_chat` commands dispatched from the background and
 *   replying with `send_chat_result`.
 *
 * The join-flow wiring (PR 9) and participant/speaker scrapers (PRs 10-11)
 * will hook into the same lifecycle path and share this file. Until that
 * lands, the chat reader starts unconditionally on mount — the content
 * script is only injected into Meet pages, so there's no risk of firing
 * outside a meeting context.
 */
import type {
  BotSendChatCommand,
  BotToExtensionMessage,
  ExtensionSendChatResultMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import { BotToExtensionMessageSchema } from "../../contracts/native-messaging.js";

import { sendChat, startChatReader } from "./features/chat.js";

console.log("[meet-ext] content script loaded on", location.href);

/**
 * Extract the Meet meeting ID from the current URL.
 *
 * Meet URLs have the shape `https://meet.google.com/<code>?...`; the code
 * segment is the meeting's opaque identifier. We use it to stamp every
 * outbound event. Falls back to an empty string if the path is somehow
 * unexpected — the contract schemas enforce a non-empty ID so the bot will
 * drop the frame rather than pollute the event stream with bogus IDs.
 */
function currentMeetingId(): string {
  // Meet paths: `/<code>` for new meetings, `/<code>?authuser=...`, etc.
  const segment = location.pathname.split("/").filter(Boolean)[0] ?? "";
  return segment;
}

/**
 * Start the chat reader and keep the handle in module scope. When PR 9
 * lands the join-flow hook, this will move under a `joined` lifecycle
 * transition; until then, firing on content-script mount is safe because
 * the content script is only injected on Meet URLs.
 */
const meetingId = currentMeetingId();
if (meetingId) {
  startChatReader({
    meetingId,
    // TODO(meet-ext): plumb the real bot display name through from the
    // join command (PR 9). For now, self-filter by an empty string — the
    // DOM-level `data-is-self="true"` path still handles the common case,
    // and the name-based fallback kicks in once PR 9 threads the name
    // through.
    selfName: "",
    onEvent: (ev: ExtensionToBotMessage) => {
      try {
        chrome.runtime.sendMessage(ev);
      } catch (err) {
        console.warn("[meet-ext] failed to forward chat event:", err);
      }
    },
  });
}

/**
 * Background -> content router. The background fans out validated
 * {@link BotToExtensionMessage} frames to every Meet tab via
 * `chrome.tabs.sendMessage`; this listener validates the frame against
 * the shared schema and dispatches to the feature handler.
 */
chrome.runtime.onMessage.addListener(
  (
    raw: unknown,
    _sender: chrome.runtime.MessageSender,
    _sendResponse: (response?: unknown) => void,
  ): boolean => {
    const result = BotToExtensionMessageSchema.safeParse(raw);
    if (!result.success) {
      // Not for us, or malformed. Either way there's nothing to do — the
      // background is the validator on the outbound path, so a mismatch
      // here almost always means the frame is a content-script-only ping
      // (e.g. a future in-extension message). Log at debug level and drop.
      return false;
    }
    const msg = result.data;
    if (msg.type === "send_chat") {
      void handleSendChat(msg);
    }
    // No synchronous response — all replies go back through
    // `chrome.runtime.sendMessage` (which routes via the content bridge to
    // the native port).
    return false;
  },
);

/**
 * Execute a {@link BotSendChatCommand} and emit a matching
 * {@link ExtensionSendChatResultMessage} back to the background. Errors
 * are caught and surfaced via `ok: false` so the bot can correlate the
 * failure with the originating request.
 */
async function handleSendChat(cmd: BotSendChatCommand): Promise<void> {
  let reply: ExtensionSendChatResultMessage;
  try {
    await sendChat(cmd.text);
    reply = {
      type: "send_chat_result",
      requestId: cmd.requestId,
      ok: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply = {
      type: "send_chat_result",
      requestId: cmd.requestId,
      ok: false,
      error: message,
    };
  }
  try {
    chrome.runtime.sendMessage(reply);
  } catch (err) {
    console.warn("[meet-ext] failed to send send_chat_result:", err);
  }
}
