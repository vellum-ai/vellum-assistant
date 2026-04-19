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
 * `startMeetingSession` owns the in-page feature handles (speaker
 * scraper today; participant scraper, chat bridge, etc. in follow-up
 * PRs). The returned `stop()` disposes every handle. We intentionally
 * keep this local-in-module-scope so parallel PRs can extend the
 * factory without touching the listener wiring.
 */
import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import { BotToExtensionMessageSchema } from "../../contracts/native-messaging.js";

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
 * Start all per-meeting scrapers + bridges for a freshly-joined meeting.
 *
 * Called from the bot→extension `join` handler below, after any join
 * flow completes successfully. Additional features (participants, chat)
 * will layer into the returned handle in subsequent PRs — extend this
 * factory rather than the listener wiring so session teardown stays in
 * one place.
 */
function startMeetingSession(meetingId: string): MeetingSessionHandle {
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

  const speaker: SpeakerScraperHandle = startSpeakerScraper({
    meetingId,
    onEvent: sendToBot,
  });
  handles.push(speaker);

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
      // so PR 11's speaker scraper is exercised end-to-end once PR 9
      // lands. Leaving this as a single call makes the PR-9 insertion
      // a local edit.
      activeSession = startMeetingSession(meetingId);
      return false;
    }

    if (msg.type === "leave") {
      activeSession?.stop();
      activeSession = null;
      return false;
    }

    // `send_chat` lands in PR 12.
    return false;
  },
);
