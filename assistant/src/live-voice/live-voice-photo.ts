/**
 * Persisting an image that arrives during a live-voice call, on its own.
 *
 * Two kinds arrive this way and both take the same route: a photo the user
 * snapped with the shutter, and an ambient camera frame the client's gate kept.
 * Each lands in the conversation as its own user message, the moment it
 * arrives, and **runs no turn**. That single choice is what makes the order of
 * image and speech irrelevant: whatever the user says next, before or after,
 * is answered by a model whose history already contains the picture.
 *
 * A kept frame carries the sight tag as well, which is what lets retention age
 * it out of the model's context while the transcript keeps it. A shutter photo
 * carries no tag: the user chose to take it, so it is not the retention pass's
 * to trim.
 *
 * The alternatives were both worse and both were tried. Attaching the photo to
 * the *next* spoken turn strands it whenever the user speaks first: the
 * question "what's this?" dispatches without an image and the photo waits for
 * a sentence that has already been said. Dispatching a turn *for* the photo
 * races the sentence the user is in the middle of saying, so the assistant
 * answers the picture and the words separately.
 *
 * The cost, accepted: media survives a context-overflow retry only on the most
 * recent user message (`conversation-media-retry.ts`), so on a long call a
 * photo can be stripped where one riding the spoken turn would have survived.
 * Stranding is the worse failure, and it happens every time rather than only
 * under overflow.
 *
 * Persists are serialized per conversation ({@link enqueueStandaloneImagePersist}),
 * because the processing flag they take is a boolean rather than a counted
 * lock. Two images in flight at once interleave across the awaits that sit
 * between reading the flag and taking it, so both read idle and both take it.
 * The first to finish then clears it while the second is still writing, which
 * leaves a spoken turn free to launch into a half-written row, and the second
 * finisher goes on to clear THAT turn's flag. Ambient frames make this
 * routine rather than exotic: they arrive every few seconds for as long as
 * the camera is up, and a shutter photo can land between any two of them. The
 * chain holds the flag to one standalone job at a time, which is what makes
 * the set/clear pairing correct rather than merely usually correct.
 *
 * A narrower race is left alone: a real turn can still start inside the 100 ms
 * gap between the idle poll and `setProcessing(true)`. Closing it means
 * changing what the flag is in `conversation.ts`, which governs every turn in
 * the daemon, not just these writes.
 */

import { v7 as uuidv7 } from "uuid";

import {
  type PersistMessageOptions,
  persistQueuedMessageBody,
} from "../daemon/conversation-messaging.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import { resolveAttachmentsForPersist } from "../persistence/attachments-store.js";
import { recordConversationPersistedSeq } from "../persistence/conversation-crud.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-voice-photo");

/**
 * How long to wait for an in-flight turn before giving up on an image.
 *
 * Persisting takes the conversation's processing lock, which a running turn
 * holds for as long as it runs, tools included. The wait is generous because
 * the alternative is dropping a photo the user watched themselves take, and
 * the image is not urgent: nothing is blocked on it except the next thing they
 * say.
 */
const PROCESSING_WAIT_MS = 30_000;
const PROCESSING_POLL_MS = 100;

const PHOTO_MESSAGE_CONTENT = "here's a photo:";

/**
 * Text the kept frame's row carries. Neutral rather than first person: nobody
 * spoke this message, the camera simply had something worth showing.
 */
const SIGHT_FRAME_MESSAGE_CONTENT = "(camera frame)";

export interface LiveVoicePhotoResult {
  readonly ok: boolean;
  readonly messageId?: string;
}

/**
 * One conversation's chain of standalone-image persists.
 *
 * `queuedSightFrame` holds the keep that is chained but has not begun, and is
 * what bounds the chain: keeps arrive every few seconds while each job can
 * wait out a turn for {@link PROCESSING_WAIT_MS}, so without replacement the
 * chain grows for as long as a turn runs. A job clears the slot as it starts,
 * so the slot only ever refers to work that can still be called off.
 */
interface StandaloneImageQueue {
  tail: Promise<void>;
  queuedSightFrame: { superseded: boolean } | null;
  outstanding: number;
}

const standaloneImageQueues = new Map<string, StandaloneImageQueue>();

/**
 * Run `job` after every standalone-image persist already queued for this
 * conversation has settled.
 *
 * Keeps are latest-wins while they wait: a new one supersedes a queued keep
 * that has not begun, which resolves `ok: false` so its caller reports the one
 * lost frame. The camera is about to shoot another anyway, and what matters is
 * the view at the moment the user speaks. Photos are never superseded: the
 * user watched themselves take each one.
 *
 * The map entry is dropped once the chain drains, so a conversation that ends
 * leaves nothing behind.
 */
async function enqueueStandaloneImagePersist(
  conversationId: string,
  kind: "photo" | "sight_frame",
  job: () => Promise<LiveVoicePhotoResult>,
): Promise<LiveVoicePhotoResult> {
  let queue = standaloneImageQueues.get(conversationId);
  if (!queue) {
    queue = {
      tail: Promise.resolve(),
      queuedSightFrame: null,
      outstanding: 0,
    };
    standaloneImageQueues.set(conversationId, queue);
  }
  const chained = queue;

  const ticket = { superseded: false };
  if (kind === "sight_frame") {
    if (chained.queuedSightFrame) {
      chained.queuedSightFrame.superseded = true;
    }
    chained.queuedSightFrame = ticket;
  }

  chained.outstanding += 1;
  const running = chained.tail.then(() => {
    // Started, so nothing can call it off from here on.
    if (chained.queuedSightFrame === ticket) {
      chained.queuedSightFrame = null;
    }
    if (ticket.superseded) {
      log.debug(
        { conversationId },
        "A newer camera frame replaced one still waiting to persist",
      );
      return { ok: false };
    }
    return job();
  });
  // The tail must survive a failed job, or one rejection would strand every
  // image queued behind it.
  chained.tail = running.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await running;
  } finally {
    chained.outstanding -= 1;
    if (
      chained.outstanding === 0 &&
      standaloneImageQueues.get(conversationId) === chained
    ) {
      standaloneImageQueues.delete(conversationId);
    }
  }
}

/** Conversations with a standalone-image persist still in flight. */
export function _standaloneImageQueueSizeForTests(): number {
  return standaloneImageQueues.size;
}

/** Resolve once the conversation is not mid-turn, or false on timeout. */
async function waitForIdle(conversation: {
  isProcessing: () => boolean;
}): Promise<boolean> {
  const deadline = Date.now() + PROCESSING_WAIT_MS;
  while (conversation.isProcessing()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_POLL_MS));
  }
  return true;
}

/**
 * Persist one image into the conversation as a user message, running no turn.
 *
 * Takes and releases the processing lock the way the built-in slash commands
 * do: they are the existing precedent for "persist a user message and answer
 * without the agent loop", and the lock is what keeps this write from
 * interleaving with a turn's own persist. An image that arrives mid-reply
 * therefore lands after that reply's rows rather than between them.
 *
 * Queued behind this conversation's other standalone images, so only one of
 * them ever holds the flag. Never throws. An image that cannot be stored must
 * not take the call down with it, and the caller reports the failure to the
 * user instead.
 */
function persistStandaloneImage(
  conversationId: string,
  attachmentId: string,
  kind: "photo" | "sight_frame",
  persistOptions: Omit<PersistMessageOptions, "attachments" | "requestId">,
): Promise<LiveVoicePhotoResult> {
  return enqueueStandaloneImagePersist(conversationId, kind, () =>
    writeStandaloneImage(conversationId, attachmentId, kind, persistOptions),
  );
}

async function writeStandaloneImage(
  conversationId: string,
  attachmentId: string,
  kind: "photo" | "sight_frame",
  persistOptions: Omit<PersistMessageOptions, "attachments" | "requestId">,
): Promise<LiveVoicePhotoResult> {
  const { content } = persistOptions;
  try {
    const attachments = resolveAttachmentsForPersist([attachmentId]);
    if (attachments.length === 0) {
      log.warn(
        { attachmentId, kind },
        "Live-voice image attachment did not resolve",
      );
      return { ok: false };
    }

    const conversation = await getOrCreateConversation(conversationId);

    // A turn holds the lock for its whole run. Waiting rather than queueing:
    // the conversation's queue drains into a turn, which is the one thing this
    // must not cause.
    if (!(await waitForIdle(conversation))) {
      log.warn(
        { conversationId, attachmentId, kind },
        "Live-voice image timed out waiting for the conversation to go idle",
      );
      return { ok: false };
    }

    conversation.setProcessing(true);
    try {
      const persisted = await persistQueuedMessageBody(conversation, {
        ...persistOptions,
        attachments,
        requestId: uuidv7(),
      });

      // The row exists but no turn will announce it, so the clients that
      // render this conversation have to be told directly, or the image does
      // not appear until something else forces a refetch.
      broadcastMessage({
        type: "user_message_echo",
        text: content,
        conversationId,
        messageId: persisted.id,
      });
      recordConversationPersistedSeq(conversationId, getCurrentSeq());
      publishConversationMessagesChanged(conversationId);

      return { ok: true, messageId: persisted.id };
    } finally {
      conversation.setProcessing(false);
      // Anything queued behind the lock we just held still has to run. Without
      // this a message queued during the image's write sits until the next
      // turn ends.
      void conversation.kickDrainQueue("loop_complete", `live_voice_${kind}`);
    }
  } catch (err) {
    log.warn(
      { err, conversationId, attachmentId, kind },
      "Failed to persist a live-voice image",
    );
    return { ok: false };
  }
}

/**
 * Persist a photo the user took mid-call.
 *
 * Carries `livePhoto`, which is what the client reads to show the snap on its
 * receipt strip, and no sight tag: a deliberate photo is not retention's to
 * age out.
 */
export async function persistLiveVoicePhoto(
  conversationId: string,
  attachmentId: string,
): Promise<LiveVoicePhotoResult> {
  return persistStandaloneImage(conversationId, attachmentId, "photo", {
    content: PHOTO_MESSAGE_CONTENT,
    metadata: {
      // Marks the row as something the user did on a call rather than
      // typed, the same way a voice turn's own user message is marked.
      voiceSessionTurn: true,
      livePhoto: true,
    },
  });
}

/**
 * Persist an ambient camera frame the client's gate kept.
 *
 * The sight tag names the attachment on the row that carries it, because an
 * attachment holds no metadata of its own. Retention reads the tag to decide
 * which images a turn still sends in full and which become timestamped stubs,
 * so an untagged frame would sit in every later request forever. The persist
 * stamps it, from the id materialization ended up storing rather than the one
 * asked for here.
 *
 * `scripted` because the camera's gate sent this, not the user: a keep every
 * few seconds would otherwise read downstream as that many turns the user
 * took, and activation counts turns that claim they were typed.
 */
export async function persistLiveVoiceSightFrame(
  conversationId: string,
  attachmentId: string,
): Promise<LiveVoicePhotoResult> {
  return persistStandaloneImage(conversationId, attachmentId, "sight_frame", {
    content: SIGHT_FRAME_MESSAGE_CONTENT,
    metadata: { voiceSessionTurn: true },
    scripted: true,
    sightFrameAttachmentIds: [attachmentId],
  });
}
