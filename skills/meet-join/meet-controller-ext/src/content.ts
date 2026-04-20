/**
 * Meet content-script entry.
 *
 * Runs in the Google Meet page world at `document_idle`. Listens for
 * {@link BotToExtensionMessage} frames forwarded by the background
 * service worker's native-messaging bridge, drives the Meet prejoin UI
 * on `join`, and runs per-meeting feature modules once the bot is in
 * the meeting room.
 *
 * ## Meeting session lifecycle
 *
 * `startMeetingSession` owns the in-page feature handles (participant
 * scraper, speaker scraper, chat reader). The returned `stop()` disposes
 * every handle. We intentionally keep this local-in-module-scope so
 * parallel PRs can extend the factory without touching the listener
 * wiring.
 *
 * On `join` we emit a `lifecycle { state: "joining" }` event up-front so
 * the daemon sees the transition even if `runJoinFlow` throws during
 * its first DOM query, then emit `joined` after the flow resolves and
 * the session factory has been installed. An unhandled rejection from
 * `runJoinFlow` surfaces as `lifecycle { state: "error" }` with the
 * error's message in `detail` — the session factory is NOT installed
 * in that case because the scrapers require an admitted meeting.
 */
import type {
  BotCameraDisableCommand,
  BotCameraEnableCommand,
  BotSendChatCommand,
  BotToExtensionMessage,
  ExtensionCameraResultMessage,
  ExtensionSendChatResultMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import { BotToExtensionMessageSchema } from "../../contracts/native-messaging.js";

import { disableCamera, enableCamera } from "./features/camera.js";
import { type ChatReader, sendChat, startChatReader } from "./features/chat.js";
import { runJoinFlow } from "./features/join.js";
import {
  startParticipantScraper,
  type ParticipantScraperHandle,
} from "./features/participants.js";
import {
  startSpeakerScraper,
  type SpeakerScraperHandle,
} from "./features/speaker.js";

console.log("[meet-ext] content script loaded on", location.href);

/**
 * Extract the meeting id from the current page URL.
 *
 * Google Meet URLs take the form `https://meet.google.com/<id>` where
 * `<id>` is a short code like `abc-defg-hij`. We strip the leading slash
 * and any trailing query so downstream consumers get a clean opaque
 * identifier. Falls back to the full pathname when we cannot find a
 * segment — the content script would never be injected on a non-meet
 * URL, so any ambiguity here surfaces as a diagnostic rather than a
 * silent mismatch.
 */
function deriveMeetingId(): string {
  const path = location.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return path || location.pathname;
}

/**
 * Extract the meeting id from a Meet join URL.
 *
 * The background bridge fans every bot command out to every open
 * `https://meet.google.com/*` tab, so a stray lobby tab in the same
 * Chrome profile would otherwise start its own speaker scraper and mix
 * `speaker.change` events from an unrelated meeting into the session
 * stream. Tabs self-filter by comparing this value against
 * {@link deriveMeetingId} before acting on a `join` command.
 *
 * Returns `null` when the URL cannot be parsed or has no path segment;
 * callers treat that as "does not match any tab" so a malformed command
 * cannot inadvertently drive every Meet tab.
 */
function extractMeetingIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segment = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return segment || null;
}

/**
 * Build a timestamped, meeting-scoped lifecycle message.
 *
 * Extracted to a helper so every lifecycle emit site (joining, joined,
 * error) stays in lockstep on the timestamp/meetingId shape required by
 * `ExtensionLifecycleMessageSchema`.
 */
function lifecycleMessage(
  state: "joining" | "joined" | "left" | "error",
  meetingId: string,
  detail?: string,
): ExtensionToBotMessage {
  const msg: ExtensionToBotMessage = {
    type: "lifecycle",
    state,
    meetingId,
    timestamp: new Date().toISOString(),
  };
  if (detail !== undefined) {
    (msg as { detail?: string }).detail = detail;
  }
  return msg;
}

interface MeetingSessionHandle {
  stop: () => void;
}

/**
 * Options carried through to the session factory. `displayName` comes
 * from the bot's `join` command so the chat reader and participant
 * scraper can self-filter the bot's own outbound activity.
 */
interface MeetingSessionOptions {
  meetingId: string;
  displayName: string;
}

/**
 * Start all per-meeting scrapers + bridges for a freshly-joined meeting.
 *
 * Called from the bot→extension `join` handler below, after `runJoinFlow`
 * has driven the prejoin UI and confirmed admission. Additional features
 * layer into the returned handle — extend this factory rather than the
 * listener wiring so session teardown stays in one place.
 */
function startMeetingSession(
  opts: MeetingSessionOptions,
): MeetingSessionHandle {
  const handles: Array<{ stop: () => void }> = [];

  const sendToBot = (event: ExtensionToBotMessage): void => {
    try {
      // Fire-and-forget — the background bridge validates and forwards
      // to the native port. No response expected.
      void chrome.runtime.sendMessage(event);
    } catch (err) {
      console.warn("[meet-ext] sendMessage failed:", err);
    }
  };

  const participants: ParticipantScraperHandle = startParticipantScraper({
    meetingId: opts.meetingId,
    selfName: opts.displayName,
    onEvent: sendToBot,
  });
  handles.push(participants);

  const speaker: SpeakerScraperHandle = startSpeakerScraper({
    meetingId: opts.meetingId,
    onEvent: sendToBot,
  });
  handles.push(speaker);

  const chat: ChatReader = startChatReader({
    meetingId: opts.meetingId,
    selfName: opts.displayName,
    onEvent: sendToBot,
  });
  handles.push(chat);

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const handle of handles) {
        try {
          handle.stop();
        } catch (err) {
          console.warn("[meet-ext] handle.stop threw:", err);
        }
      }
    },
  };
}

/**
 * Currently-active meeting session, if any. We keep at most one at a
 * time — a fresh `join` command while a prior session is live tears
 * down the old handles before installing new ones.
 */
let activeSession: MeetingSessionHandle | null = null;

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
function enqueueSendChat(cmd: BotSendChatCommand): Promise<void> {
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

chrome.runtime.onMessage.addListener(
  (
    raw: unknown,
    _sender: chrome.runtime.MessageSender,
    _sendResponse: (response?: unknown) => void,
  ): boolean => {
    const parsed = BotToExtensionMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // The background bridge fans out every bot→extension frame to
      // every Meet tab, including frames intended for sibling tabs. A
      // parse miss is expected noise; log at debug rather than warn.
      console.debug(
        "[meet-ext] ignoring non-bot-command message:",
        parsed.error.message,
      );
      return false;
    }
    const msg: BotToExtensionMessage = parsed.data;

    if (msg.type === "join") {
      // The background bridge broadcasts every bot command to every open
      // Meet tab. Only the tab whose URL matches the target meeting
      // should start a session — otherwise a stray lobby tab in the same
      // Chrome profile would spin up its own speaker scraper and mix
      // telemetry from unrelated meetings into the bot's event stream.
      const targetMeetingId = extractMeetingIdFromUrl(msg.meetingUrl);
      const currentMeetingId = deriveMeetingId();
      if (targetMeetingId === null || targetMeetingId !== currentMeetingId) {
        console.debug(
          "[meet-ext] ignoring join for non-matching tab:",
          `target=${targetMeetingId ?? "<unparseable>"}`,
          `current=${currentMeetingId}`,
        );
        return false;
      }
      void handleJoin(msg.meetingUrl, msg.displayName, msg.consentMessage);
      return false;
    }

    if (msg.type === "leave") {
      activeSession?.stop();
      activeSession = null;
      return false;
    }

    if (msg.type === "send_chat") {
      // Serialize send_chat handling per tab. `sendChat` mutates a single
      // shared textarea (`.value = text`) and then clicks the send button,
      // so two overlapping commands would race on the composer — the
      // second call's value-write can clobber the first before its click
      // lands, posting the wrong text while both requests still report
      // ok=true. `enqueueSendChat` chains invocations onto a per-tab
      // Promise so they run strictly in arrival order.
      void enqueueSendChat(msg);
      return false;
    }

    if (msg.type === "camera.enable" || msg.type === "camera.disable") {
      void handleCameraToggle(msg);
      return false;
    }

    return false;
  },
);

/**
 * Drive the Meet prejoin UI, then start per-meeting scrapers.
 *
 * Lifecycle fanout:
 *
 *   - `joining` is emitted synchronously so the daemon sees the
 *     transition even if `runJoinFlow` throws on its first DOM query.
 *   - `joined` is emitted after the flow resolves and the session
 *     factory has been installed.
 *   - `error` is emitted if the flow rejects; the session factory is
 *     NOT installed because the scrapers require an admitted meeting.
 *
 * The prior session (if any) is torn down synchronously before the
 * new flow kicks off so overlapping joins cannot double-install
 * scrapers against the same DOM.
 */
async function handleJoin(
  meetingUrl: string,
  displayName: string,
  consentMessage: string,
): Promise<void> {
  const meetingId = deriveMeetingId();
  activeSession?.stop();
  activeSession = null;

  // Emit "joining" up front so the daemon records the transition even
  // if runJoinFlow throws before any event reaches onEvent.
  try {
    chrome.runtime.sendMessage(lifecycleMessage("joining", meetingId));
  } catch (err) {
    console.warn("[meet-ext] lifecycle(joining) send failed:", err);
  }

  try {
    await runJoinFlow({
      meetingUrl,
      displayName,
      consentMessage,
      meetingId,
      onEvent: (event) => {
        try {
          chrome.runtime.sendMessage(event);
        } catch (err) {
          console.warn("[meet-ext] runJoinFlow event send failed:", err);
        }
      },
    });
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    try {
      chrome.runtime.sendMessage(lifecycleMessage("error", meetingId, detail));
    } catch (sendErr) {
      console.warn("[meet-ext] lifecycle(error) send failed:", sendErr);
    }
    return;
  }

  // Join succeeded — install per-meeting scrapers and emit "joined".
  activeSession = startMeetingSession({ meetingId, displayName });
  try {
    chrome.runtime.sendMessage(lifecycleMessage("joined", meetingId));
  } catch (err) {
    console.warn("[meet-ext] lifecycle(joined) send failed:", err);
  }
}

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
async function handleSendChat(cmd: BotSendChatCommand): Promise<void> {
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
async function handleCameraToggle(
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

// Export the send-chat + camera-toggle handlers for unit testing. They are
// wired into `chrome.runtime.onMessage` above when the script loads; the
// tests import them directly to drive the tool paths end-to-end without
// needing to fake the chrome.runtime.onMessage dispatcher. Not part of the
// extension's public surface — the background SW never imports content.ts.
export { handleSendChat as __handleSendChat };
export { handleCameraToggle as __handleCameraToggle };
// Exported so the per-tab serialization queue can be exercised directly
// by tests. The `chrome.runtime.onMessage` listener is registered once at
// module-load time (Bun's ESM cache prevents re-running module top level
// across tests), so tests that want to assert ordering for overlapping
// `send_chat` frames drive this helper instead of the raw listener.
export { enqueueSendChat as __enqueueSendChat };
