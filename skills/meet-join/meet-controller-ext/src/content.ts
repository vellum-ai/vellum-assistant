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
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";
import { BotToExtensionMessageSchema } from "../../contracts/native-messaging.js";

import {
  enqueueSendChat,
  handleCameraToggle,
} from "./handle-send-chat.js";
import { type ChatReader, startChatReader } from "./features/chat.js";
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
 * Monotonic counter that invalidates in-flight `handleJoin` invocations.
 *
 * `runJoinFlow` can take up to ~125s (5s media-prompt + 30s prejoin + 90s
 * admission) and `handleJoin` is fire-and-forget. Without a guard, a
 * `leave` or a second `join` arriving mid-flow has no way to cancel the
 * pending flow: the `leave` handler sees `activeSession === null` (cleared
 * at the top of `handleJoin`) and no-ops, then when `runJoinFlow`
 * eventually resolves the original invocation installs scrapers the
 * daemon already thinks are gone — or clobbers the scrapers that a newer
 * `join` installed. Every mutation that should invalidate the current
 * join increments this counter; `handleJoin` captures the value at entry
 * and skips its post-await side effects (session install, `joined` event)
 * once the counter has moved on.
 */
let joinGeneration = 0;

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
      // Bump the generation so any in-flight `handleJoin` awaiting
      // `runJoinFlow` aborts its post-await session install instead of
      // resurrecting scrapers after the daemon has asked the bot to leave.
      joinGeneration += 1;
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
 * Cancellation: `runJoinFlow` can take up to ~125s, during which a
 * `leave` or a second `join` command may arrive. Both paths bump
 * {@link joinGeneration}; when the in-flight invocation's captured
 * generation no longer matches, it skips the session install, the
 * `joined` emit, and (for errors) the `error` emit — leaving whatever
 * the newer command installed untouched. The prior session (if any)
 * is still torn down synchronously at the top of each join so a fresh
 * join does not overlap scrapers with the previous meeting's DOM.
 */
async function handleJoin(
  meetingUrl: string,
  displayName: string,
  consentMessage: string,
): Promise<void> {
  const meetingId = deriveMeetingId();
  joinGeneration += 1;
  const generation = joinGeneration;
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
    // A newer leave/join has already bumped the generation and
    // emitted its own lifecycle — swallow the stale error instead of
    // confusing the daemon with a late `error` for an invocation it
    // no longer cares about.
    if (generation !== joinGeneration) return;
    const detail =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    try {
      chrome.runtime.sendMessage(lifecycleMessage("error", meetingId, detail));
    } catch (sendErr) {
      console.warn("[meet-ext] lifecycle(error) send failed:", sendErr);
    }
    return;
  }

  // If a leave or newer join landed while runJoinFlow was awaiting,
  // the daemon no longer expects us to install scrapers for this
  // meeting. Bailing out here avoids both (a) resurrecting a session
  // after `leave` and (b) clobbering the session that a newer `join`
  // installed.
  if (generation !== joinGeneration) return;

  // Join succeeded — install per-meeting scrapers and emit "joined".
  activeSession = startMeetingSession({ meetingId, displayName });
  try {
    chrome.runtime.sendMessage(lifecycleMessage("joined", meetingId));
  } catch (err) {
    console.warn("[meet-ext] lifecycle(joined) send failed:", err);
  }
}

