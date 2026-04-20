/**
 * Router that glues together Meet content scripts and the native-messaging
 * port. The background service worker owns the single native port; content
 * scripts ride a standard `chrome.runtime` message channel to interact with
 * it.
 *
 * Direction of flow:
 *
 *   - **Content → Bot**: `chrome.runtime.onMessage` messages that validate as
 *     {@link ExtensionToBotMessage} are forwarded to the native port. Invalid
 *     frames are logged and dropped; we never surface the error back to the
 *     content script because there is no shared recovery path.
 *   - **Bot → Content**: every validated {@link BotToExtensionMessage} fanned
 *     out to every Meet tab (`https://meet.google.com/*`). If no tab matches,
 *     we warn and drop the frame — the content script has not yet mounted
 *     during early startup and there is nothing to deliver to.
 */
import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";
import { ExtensionToBotMessageSchema } from "../../../contracts/native-messaging.js";

import type { NativePort } from "./native-port.js";

/** URL pattern used to locate Meet tabs when fanning out bot commands. */
export const MEET_TAB_URL_PATTERN = "https://meet.google.com/*";

/** Wire up the content-script ↔ native-port router for the life of the SW. */
export function startContentBridge(port: NativePort): void {
  // Content scripts post messages up to the service worker via
  // chrome.runtime.sendMessage; we validate and forward to the native host.
  chrome.runtime.onMessage.addListener(
    (
      raw: unknown,
      _sender: chrome.runtime.MessageSender,
      _sendResponse: (response?: unknown) => void,
    ): boolean => {
      const result = ExtensionToBotMessageSchema.safeParse(raw);
      if (!result.success) {
        console.warn(
          "[meet-ext] dropped invalid content->bot message:",
          result.error.message,
        );
        return false;
      }
      try {
        port.post(result.data as ExtensionToBotMessage);
      } catch (err) {
        console.warn("[meet-ext] failed to forward to native port:", err);
      }
      return false;
    },
  );

  // Bot commands from the native port fan out to every open Meet tab. The
  // content script mounts on `document_idle`, so during very early startup no
  // tab will match — we log and drop rather than throw because the bot
  // treats commands as fire-and-forget.
  //
  // `avatar.*` frames are intentionally skipped: those are delivered to the
  // separate avatar tab by the background's avatar feature (see
  // `features/avatar.ts`) and the Meet content script has no switch case for
  // them, so fanning them out here is ~20 pointless `chrome.tabs.sendMessage`
  // calls/sec per Meet tab at TTS viseme cadence.
  port.onMessage((msg: BotToExtensionMessage) => {
    if (msg.type.startsWith("avatar.")) return;
    void fanOutToMeetTabs(msg);
  });
}

/**
 * Retry schedule for content-script delivery. The background SW wins the
 * race with the content script at startup — Chrome mounts content scripts
 * on `document_idle`, which fires after the native-messaging handshake
 * resolves. `sendMessage` to a not-yet-mounted content script rejects
 * with "Could not establish connection. Receiving end does not exist",
 * so we retry with exponential backoff for up to ~10s.
 */
const DELIVERY_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 2000, 2000, 2000];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fanOutToMeetTabs(msg: BotToExtensionMessage): Promise<void> {
  for (let attempt = 0; attempt <= DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({ url: MEET_TAB_URL_PATTERN });
    } catch (err) {
      console.warn("[meet-ext] tabs.query failed:", err);
      return;
    }
    if (tabs.length === 0) {
      if (attempt === DELIVERY_RETRY_DELAYS_MS.length) {
        console.warn(
          `[meet-ext] no Meet tab open after ${attempt} retries; dropping bot->content message type=${msg.type}`,
        );
        return;
      }
      await sleep(DELIVERY_RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    let anyDelivered = false;
    let lastError: unknown;
    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      try {
        await chrome.tabs.sendMessage(tab.id, msg);
        anyDelivered = true;
      } catch (err) {
        lastError = err;
      }
    }
    if (anyDelivered) return;
    if (attempt === DELIVERY_RETRY_DELAYS_MS.length) {
      console.warn(
        `[meet-ext] tabs.sendMessage failed after ${attempt} retries; dropping bot->content message type=${msg.type}:`,
        lastError,
      );
      return;
    }
    await sleep(DELIVERY_RETRY_DELAYS_MS[attempt]!);
  }
}
