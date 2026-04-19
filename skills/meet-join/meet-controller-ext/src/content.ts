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
  BotSendChatCommand,
  BotToExtensionMessage,
  ExtensionSendChatResultMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import { BotToExtensionMessageSchema } from "../../contracts/native-messaging.js";

import {
  type ChatReader,
  sendChat,
  startChatReader,
} from "./features/chat.js";
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
      void handleJoin(msg.meetingUrl, msg.displayName, msg.consentMessage);
      return false;
    }

    if (msg.type === "leave") {
      activeSession?.stop();
      activeSession = null;
      return false;
    }

    if (msg.type === "send_chat") {
      void handleSendChat(msg);
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
