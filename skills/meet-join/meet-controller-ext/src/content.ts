/**
 * Meet content-script entry.
 *
 * Runs in the Google Meet page world at `document_idle`. Listens for
 * {@link BotToExtensionMessage} frames forwarded by the background
 * service worker's native-messaging bridge, and runs per-meeting
 * feature modules once the bot asks us to join.
 *
 * ## Meeting session lifecycle
 *
 * `startMeetingSession` owns the in-page feature handles (participant
 * scraper, speaker scraper, chat reader). The returned `stop()` disposes
 * every handle. We intentionally keep this local-in-module-scope so
 * parallel PRs can extend the factory without touching the listener
 * wiring.
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
 * Called from the bot→extension `join` handler below, after any join
 * flow completes successfully. Additional features layer into the
 * returned handle — extend this factory rather than the listener wiring
 * so session teardown stays in one place.
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
      const meetingId = deriveMeetingId();
      activeSession?.stop();
      // NOTE: PR 9 will run the actual join flow (fill name, click
      // join now, wait for leave button) before we start the session.
      // For now we wire the scrapers directly against the current DOM
      // so the participant/speaker/chat features are exercised end-to-end
      // once PR 9 lands. Leaving this as a single call makes the PR-9
      // insertion a local edit.
      activeSession = startMeetingSession({
        meetingId,
        displayName: msg.displayName,
      });
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
