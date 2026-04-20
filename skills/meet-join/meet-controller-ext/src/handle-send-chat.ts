/**
 * Runtime tool-path handlers for `send_chat` and `camera.*` commands.
 *
 * Split out from `content.ts` so the content-script entrypoint can stay
 * side-effect-only with no top-level `export` tokens. Chrome loads
 * `content_scripts` as classic scripts; any `export` in `content.js`
 * makes the whole bundle fail to parse at load time, silently killing
 * every Meet handler in production. Tests import the handlers from this
 * module directly instead of the entrypoint.
 */
import type {
  BotCameraDisableCommand,
  BotCameraEnableCommand,
  BotSendChatCommand,
  ExtensionCameraResultMessage,
  ExtensionSendChatResultMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";

import { disableCamera, enableCamera } from "./features/camera.js";
import { sendChat } from "./features/chat.js";

/**
 * Execute a {@link BotSendChatCommand} and emit a matching
 * {@link ExtensionSendChatResultMessage} back to the background. Errors
 * are caught and surfaced via `ok: false` so the bot can correlate the
 * failure with the originating request.
 *
 * Threads an `onEvent` sink + `window` reference through to
 * {@link sendChat} so the runtime `meet_send_chat` tool path emits
 * `trusted_type` (for the composer) and `trusted_click` (for the send
 * button) just like the consent-post path does inside `runJoinFlow`.
 * Without this, Meet's `isTrusted` gate silently swallows both the
 * synthetic composer input and the JS `.click()` on the send button —
 * every post-admission send would no-op on production Meet builds that
 * enforce the gate.
 */
export async function handleSendChat(cmd: BotSendChatCommand): Promise<void> {
  const sendToBot = (event: ExtensionToBotMessage): void => {
    try {
      void chrome.runtime.sendMessage(event);
    } catch (err) {
      console.warn("[meet-ext] sendMessage failed:", err);
    }
  };

  let reply: ExtensionSendChatResultMessage;
  try {
    await sendChat(cmd.text, {
      onEvent: sendToBot,
      // Pass the live `window` so `sendChat` can compute screen-space
      // coordinates for the send button's `trusted_click`. Mirrors the
      // fallback that `postConsentMessage` relies on in `features/join.ts`.
      window: globalThis as unknown as {
        screenX: number;
        screenY: number;
        outerHeight: number;
        innerHeight: number;
      },
    });
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

/**
 * Execute a {@link BotCameraEnableCommand} / {@link BotCameraDisableCommand}
 * and emit a matching {@link ExtensionCameraResultMessage} back to the
 * background. Mirrors {@link handleSendChat}: forwards a trusted_click via
 * `onEvent` so the bot drives the click through xdotool (Meet's isTrusted
 * gate rejects synthetic clicks on bottom-toolbar controls in general, so
 * we assume the camera toggle is gated too and route through xdotool by
 * default). Errors are surfaced via `ok: false` with a descriptive reason.
 */
export async function handleCameraToggle(
  cmd: BotCameraEnableCommand | BotCameraDisableCommand,
): Promise<void> {
  const sendToBot = (event: ExtensionToBotMessage): void => {
    try {
      void chrome.runtime.sendMessage(event);
    } catch (err) {
      console.warn("[meet-ext] sendMessage failed:", err);
    }
  };

  let reply: ExtensionCameraResultMessage;
  try {
    const run = cmd.type === "camera.enable" ? enableCamera : disableCamera;
    const result = await run({
      onEvent: sendToBot,
      // Pass the live `window` so the camera feature can compute screen-
      // space coordinates for the toggle's `trusted_click`. Mirrors the
      // fallback that `postConsentMessage` / `sendChat` rely on.
      window: globalThis as unknown as {
        screenX: number;
        screenY: number;
        outerHeight: number;
        innerHeight: number;
      },
    });
    reply = {
      type: "camera_result",
      requestId: cmd.requestId,
      ok: true,
      changed: result.changed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply = {
      type: "camera_result",
      requestId: cmd.requestId,
      ok: false,
      error: message,
    };
  }
  try {
    chrome.runtime.sendMessage(reply);
  } catch (err) {
    console.warn("[meet-ext] failed to send camera_result:", err);
  }
}

/**
 * Per-tab serialization chain for `send_chat` handling. `sendChat` mutates
 * a single shared textarea (`.value = text`) and then clicks the send
 * button, so overlapping requests would otherwise race on the composer.
 * Chaining onto this promise forces strict arrival-order processing while
 * leaving the `onMessage` listener synchronous (the listener returns
 * immediately; handling happens off-thread).
 */
let sendChatQueue: Promise<void> = Promise.resolve();

/**
 * Chain a `send_chat` invocation onto the per-tab queue so it runs
 * strictly after any prior in-flight `sendChat` call has completed.
 * Extracted from the inline listener wiring so tests can drive the queue
 * directly (Bun caches ESM modules across tests, so the listener's
 * `chrome.runtime.onMessage.addListener` registration happens once at
 * first-import time — not re-runnable against a fresh fake chrome on
 * each test).
 */
export function enqueueSendChat(cmd: BotSendChatCommand): Promise<void> {
  sendChatQueue = sendChatQueue
    .catch(() => {
      // A prior `handleSendChat` rejection must not poison subsequent
      // sends — the handler catches its own errors and reports them via
      // `send_chat_result(ok=false)`, so any rejection here is a bug we
      // still want to isolate from the next request.
    })
    .then(() => handleSendChat(cmd));
  return sendChatQueue;
}
