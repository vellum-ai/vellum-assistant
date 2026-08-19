/**
 * The timeline a watch session writes: what the user narrated, and what was on
 * their screen while they narrated it, as ordinary user messages on the
 * session's conversation.
 *
 * Every entry lands the moment it is captured and **runs no turn**, for the
 * reasons `live-voice/live-voice-photo.ts` sets out at length and which apply
 * here unchanged. The entry has to already be in history when a later turn
 * reads it: the retro at the end of the session is exactly that turn, and an
 * entry attached to some future send is an entry the retro cannot see.
 * Dispatching a turn per entry is the other failure: observations arrive on a
 * cadence the user does not control, so a turn per entry would answer the
 * sentence the user is halfway through saying, over and over, during a session
 * whose whole premise is that the assistant stays silent.
 *
 * Ordering is the property the retro depends on and the one that arrival order
 * does not give for free: a narration final and the observation it triggered
 * are two independent async writes. Two things hold it. Appends are serialized
 * per conversation, so rows land in call order; and every entry renders its own
 * `[t+MM:SS]` offset into the message text, so the model reads one interleaved
 * timeline even where a row's position and its capture moment disagree.
 *
 * Observations render the AX tree inside an `<ax-tree>` block so
 * `context/outbound-sanitize.ts`'s `compactAxTreeHistory` collapses all but the
 * most recent few. That is the whole context story for a watch session: a
 * half-hour of observations is bounded by machinery that already exists, and
 * the offset prefix and the diff survive the collapse, so a compacted entry
 * still tells the retro when it happened and what moved.
 */

import { escapeAxTreeContent } from "../context/outbound-sanitize.js";
import type { Conversation } from "../daemon/conversation.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("watch-timeline");

/**
 * How long to wait for an in-flight turn before giving up on an entry.
 *
 * Shorter than the live-voice photo's wait: a dropped observation costs one
 * frame of a timeline that has many, and the session's cadence will produce
 * another shortly, so blocking the append chain for half a minute is the worse
 * trade.
 */
const PROCESSING_WAIT_MS = 10_000;

const NARRATION_LABEL = "narration:";
const OBSERVATION_LABEL = "screen:";

const SCREENSHOT_MIME = "image/jpeg";

/**
 * The screen observation a timeline entry renders, structurally the result the
 * host computer-use proxy already returns (`CU_RESULT_SCHEMA` in
 * `packages/electron-desktop/src/host-proxy/cu-executor.ts`). Declared here
 * over exactly those field names rather than invented: the observation reaches
 * this module straight off the wire, and a shape of our own would be a second
 * definition to keep in step with the first.
 */
export interface WatchObservationInput {
  readonly axTree?: string;
  readonly axDiff?: string;
  readonly screenshot?: string;
  readonly screenshotWidthPx?: number;
  readonly screenshotHeightPx?: number;
  readonly screenWidthPt?: number;
  readonly screenHeightPt?: number;
  readonly executionError?: string;
}

type WatchEntryKind = "narration" | "observation";

export interface WatchTimelineResult {
  readonly ok: boolean;
  readonly messageId?: string;
}

const FAILED: WatchTimelineResult = { ok: false };

/**
 * Render `atMs` (milliseconds since the session started) as the `[t+MM:SS]`
 * prefix every entry carries. Hours appear only once there are any, so a
 * typical session reads as `[t+04:12]` rather than `[t+00:04:12]`.
 */
function formatOffset(atMs: number): string {
  const totalSeconds = Number.isFinite(atMs)
    ? Math.max(0, Math.floor(atMs / 1000))
    : 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = pad(totalSeconds % 60);
  const minutes = pad(Math.floor(totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `[t+${pad(hours)}:${minutes}:${seconds}]`
    : `[t+${minutes}:${seconds}]`;
}

/**
 * Render an observation, or null when it carries nothing worth a row.
 *
 * AX tree first, deliberately: it is both the substance of the observation and
 * the part `compactAxTreeHistory` knows how to collapse, so putting it first
 * leaves the offset prefix and the diff intact once it is collapsed.
 */
function renderObservation(
  atMs: number,
  observation: WatchObservationInput,
): string | null {
  const parts = [`${formatOffset(atMs)} ${OBSERVATION_LABEL}`];
  if (observation.axTree) {
    parts.push(
      "<ax-tree>",
      escapeAxTreeContent(observation.axTree),
      "</ax-tree>",
    );
  }
  if (observation.axDiff) {
    parts.push(
      `changed since the previous observation:\n${observation.axDiff}`,
    );
  }
  if (observation.screenshot) {
    parts.push("a screenshot of this moment is attached.");
  }
  return parts.length > 1 ? parts.join("\n") : null;
}

/**
 * Per-conversation append chains, so concurrent appends persist in call order.
 *
 * Without this the ordering guarantee is lost twice over: two appends would
 * race to the idle wait and both take the processing lock, and the rows would
 * land in whatever order their awaits happened to resolve. An entry is removed
 * once its chain drains, so a finished session leaves nothing behind.
 */
const appendChains = new Map<string, Promise<unknown>>();

function serializePerConversation<T>(
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = appendChains.get(conversationId) ?? Promise.resolve();
  const result = prior.then(task);
  // The chain the next append waits on never rejects, so one failed entry
  // cannot strand every entry queued behind it.
  const chain = result.then(
    () => {},
    () => {},
  );
  appendChains.set(conversationId, chain);
  void chain.then(() => {
    if (appendChains.get(conversationId) === chain) {
      appendChains.delete(conversationId);
    }
  });
  return result;
}

/**
 * Take the conversation's processing lock, or false once `timeoutMs` elapses
 * without getting it.
 *
 * The recheck and the claim sit in one synchronous step with no await between
 * them, so a turn that starts while we were waiting cannot have its flag
 * overwritten: losing that race sends us back to waiting rather than into the
 * write. Only a call that returns true holds the lock, and only that call may
 * release it.
 */
async function acquireProcessing(
  conversation: Conversation,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!conversation.isProcessing()) {
      conversation.setProcessing(true);
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    if (!(await conversation.waitForIdle({ timeoutMs: remainingMs }))) {
      return false;
    }
  }
}

/**
 * Persist one rendered entry as a user message, running no turn.
 *
 * Holds the conversation's processing lock across the write, which is what
 * keeps it from interleaving with a turn's own persist. That matters at the
 * two ends of a session, where the retro's turn and a late-arriving entry can
 * overlap.
 *
 * Never throws. A watch session degrades to a shorter timeline; it does not
 * fall over because one entry could not be stored.
 */
async function persistEntry(
  conversationId: string,
  entry: {
    kind: WatchEntryKind;
    atMs: number;
    content: string;
    attachments: UserMessageAttachment[];
  },
): Promise<WatchTimelineResult> {
  try {
    const conversation = await getOrCreateConversation(conversationId);

    if (!(await acquireProcessing(conversation, PROCESSING_WAIT_MS))) {
      log.warn(
        { conversationId, kind: entry.kind },
        "Watch timeline entry timed out waiting for the conversation to go idle",
      );
      return FAILED;
    }

    try {
      const persisted = await persistQueuedMessageBody(conversation, {
        content: entry.content,
        attachments: entry.attachments,
        // A watch entry is ambient capture, not a turn the user typed. It must
        // not read as activation, and a session's worth of AX trees must not
        // enter memory or the search index.
        scripted: true,
        skipIndexing: true,
        metadata: {
          watchSession: true,
          watchEntry: entry.kind,
          watchAtMs: entry.atMs,
        },
      });

      // No turn will announce the row, so anything rendering the conversation
      // has to be told to refetch. Unlike a live-voice photo there is no echo
      // broadcast: a session is silent by design, and echoing raw AX trees
      // into an open thread is the opposite of that.
      publishConversationMessagesChanged(conversationId);

      return { ok: true, messageId: persisted.id };
    } finally {
      conversation.setProcessing(false);
      // Anything queued behind the lock we just held still has to run, or a
      // message queued during this write sits until the next turn ends.
      void conversation.kickDrainQueue("loop_complete", "watch_timeline");
    }
  } catch (err) {
    log.warn(
      { err, conversationId, kind: entry.kind },
      "Failed to persist a watch timeline entry",
    );
    return FAILED;
  }
}

/** Append what the user said at `atMs` milliseconds into the session. */
export function appendNarration(
  conversationId: string,
  options: { text: string; atMs: number },
): Promise<WatchTimelineResult> {
  const text = options.text.trim();
  if (text.length === 0) {
    return Promise.resolve(FAILED);
  }
  return serializePerConversation(conversationId, () =>
    persistEntry(conversationId, {
      kind: "narration",
      atMs: options.atMs,
      content: `${formatOffset(options.atMs)} ${NARRATION_LABEL} ${text}`,
      attachments: [],
    }),
  );
}

/**
 * Append what was on screen at `atMs` milliseconds into the session.
 *
 * A failed or empty observation appends nothing: a row saying the screen could
 * not be read is a row the retro has to reason about, and the honest timeline
 * of a session where observation stalled is simply a sparser one.
 *
 * The screenshot rides along only when the observation actually carries one.
 * Attaching pixels to every entry is what makes a long session unaffordable:
 * `stripOldMediaBlocks` only reaches media on tool results, so an image on a
 * plain user message stays in context for the life of the conversation.
 */
export function appendObservation(
  conversationId: string,
  options: { observation: WatchObservationInput; atMs: number },
): Promise<WatchTimelineResult> {
  const { observation, atMs } = options;
  if (observation.executionError) {
    log.debug(
      { conversationId, executionError: observation.executionError },
      "Skipping a failed watch observation",
    );
    return Promise.resolve(FAILED);
  }

  const content = renderObservation(atMs, observation);
  if (content === null) {
    return Promise.resolve(FAILED);
  }

  const attachments: UserMessageAttachment[] = observation.screenshot
    ? [
        {
          filename: `watch-screen-${Math.max(0, Math.floor(atMs))}.jpg`,
          mimeType: SCREENSHOT_MIME,
          data: observation.screenshot,
        },
      ]
    : [];

  return serializePerConversation(conversationId, () =>
    persistEntry(conversationId, {
      kind: "observation",
      atMs,
      content,
      attachments,
    }),
  );
}
