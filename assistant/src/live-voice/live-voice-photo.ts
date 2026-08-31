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
 * The flag is taken by {@link acquireProcessingFlag}, which reads it free and
 * takes it in one synchronous step. That closes the half of the turn race this
 * module owns: no await sits between the read and the take, so a turn that
 * starts nearby either loses the flag to a keep that already holds it or holds
 * it before the keep looks, and a keep can never write over a turn that got
 * there first. Per `assistant/AGENTS.md`, a resource more than one caller
 * writes has to be serialised per resource; the chain does that between keeps
 * and the atomic take does it against turns.
 *
 * The other half is not this module's: turn startup takes the flag without
 * first asking whether anyone holds it (`persistUserMessage` in
 * `conversation-messaging.ts`), so a turn beginning while a keep is mid-write
 * still overwrites the keep's hold, and the keep's release then clears the
 * turn's. Fixing that means changing how every turn in the daemon acquires,
 * which belongs in `conversation.ts` rather than here.
 *
 * A persist that throws after its row landed is reported as the success it
 * is, because the transcript has the image and the client's view has to match
 * what a reload will show. The persist unwinds its own push before rethrowing,
 * so the resident history is left not matching the rows; rather than reach
 * into an array `persistQueuedMessageBody` owns, the recovery marks the
 * conversation's history stale, and the next turn's
 * `ensureActorScopedHistory` reloads from the DB and sees the frame.
 *
 * One thing is knowingly left behind: when the failure was a link write, the
 * persisted content can reference an attachment row with no link. The row
 * survives (nothing reclaims on a committed persist) and collection only ever
 * considers ids a caller hands it, so the reference keeps resolving.
 */

import { v7 as uuidv7 } from "uuid";

import {
  type PersistMessageOptions,
  persistQueuedMessageBody,
} from "../daemon/conversation-messaging.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import {
  deleteOrphanAttachments,
  resolveAttachmentsForPersist,
} from "../persistence/attachments-store.js";
import {
  getMessageById,
  recordConversationPersistedSeq,
} from "../persistence/conversation-crud.js";
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

/**
 * The wait actually applied. Mutable only so a test can reach the timeout
 * without holding a conversation busy for the full half minute.
 */
let processingWaitMs = PROCESSING_WAIT_MS;

/** Shorten the idle wait for a test. Returns the value it replaced. */
export function _setProcessingWaitMsForTests(ms: number): number {
  const previous = processingWaitMs;
  processingWaitMs = ms;
  return previous;
}
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
  queuedSightFrame: { superseded: boolean; attachmentId: string } | null;
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
  attachmentId: string,
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

  const ticket = { superseded: false, attachmentId };
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
        { conversationId, attachmentId: ticket.attachmentId },
        "A newer camera frame replaced one still waiting to persist",
      );
      reclaimDroppedFrame(ticket.attachmentId);
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

/**
 * Give up the upload behind a keep no message will ever carry: one a newer
 * frame replaced before it started, one whose wait for an idle conversation
 * ran out, and one whose write threw.
 *
 * The client uploaded it and then the daemon dropped it, so nothing else will
 * ever collect it: the client's own abandon-delete fires only when the send
 * fails, and attachment collection is candidate-driven with no sweep.
 *
 * Each caller owes the invariant in the first line. The supersede and timeout
 * paths have it by construction, neither having reached the persist; the
 * thrown path establishes it by checking that no row was inserted
 * ({@link messageMayExist}), because a persist can fail after `addMessage`
 * succeeded. {@link deleteOrphanAttachments} being link-aware is the second
 * backstop rather than the only one: a failure between the insert and the link
 * leaves a row that references the attachment with no link to protect it.
 *
 * The reclaim names the id the caller handed in, which is not always the id
 * the row ended up referencing: conversation scoping clones an attachment
 * already linked elsewhere, and the persisted block then names the clone. The
 * insert check still guards the case that matters, because without a clone the
 * two ids are the same one, and that is the dangling reference this protects.
 *
 * Keeps only. A photo is a deliberate upload the user watched themselves make,
 * and one that failed to persist is theirs to retry, not the daemon's to
 * delete.
 *
 * Best effort. Losing a row's bytes is not worth failing a call over.
 */
function reclaimDroppedFrame(attachmentId: string): void {
  try {
    deleteOrphanAttachments([attachmentId]);
  } catch (err) {
    log.warn(
      { err, attachmentId },
      "Could not reclaim a dropped live-voice camera frame",
    );
  }
}

/** Conversations with a standalone-image persist still in flight. */
export function _standaloneImageQueueSizeForTests(): number {
  return standaloneImageQueues.size;
}

/**
 * Take the conversation's processing flag once it is free, or return false on
 * timeout having taken nothing.
 *
 * The read and the take are one synchronous step on purpose. Run-to-completion
 * means nothing can interleave between them, so a turn cannot claim the flag
 * in the instant after this reads it free. Splitting them, with the read here
 * and the take in the caller, leaves an await between the two and a keep every
 * few seconds to land in it.
 *
 * Throws only if `setProcessing` does, which it does when the flag's persist
 * fails. That reverts the in-memory flag before rethrowing, so a throw here
 * means nothing was taken and nothing needs releasing.
 */
async function acquireProcessingFlag(conversation: {
  isProcessing: () => boolean;
  setProcessing: (value: boolean) => void;
}): Promise<boolean> {
  const deadline = Date.now() + processingWaitMs;
  for (;;) {
    if (!conversation.isProcessing()) {
      conversation.setProcessing(true);
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_POLL_MS));
  }
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
  return enqueueStandaloneImagePersist(conversationId, attachmentId, kind, () =>
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
  // The id the row is inserted under, so a failure can ask whether the insert
  // landed before deciding the frame is safe to reclaim.
  const requestId = uuidv7();
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
    if (!(await acquireProcessingFlag(conversation))) {
      log.warn(
        { conversationId, attachmentId, kind },
        "Live-voice image timed out waiting for the conversation to go idle",
      );
      if (kind === "sight_frame") {
        reclaimDroppedFrame(attachmentId);
      }
      return { ok: false };
    }

    try {
      const persisted = await persistQueuedMessageBody(conversation, {
        ...persistOptions,
        attachments,
        requestId,
      });

      announcePersistedImage(conversationId, content, persisted.id);

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
    const inserted = insertedMessageState(conversationId, requestId);
    if (inserted === "exists") {
      // The row is in the transcript, so the result has to say so whatever
      // went wrong afterwards. Reporting failure here loses the frame twice
      // over: the client retracts what it showed and stops treating it as
      // pending, and the row it was told never landed appears on the next
      // reload.
      //
      // The persist unwound its own push before rethrowing, so the resident
      // history no longer matches the rows. Same situation a channel edit or
      // reaction leaves behind, and the same fix: the next turn's
      // `ensureActorScopedHistory` reloads instead of reusing what it holds.
      findConversation(conversationId)?.markHistoryStale();
      try {
        announcePersistedImage(conversationId, content, requestId);
      } catch (announceErr) {
        log.warn(
          { err: announceErr, conversationId, messageId: requestId },
          "Persisted a live-voice image but could not announce it",
        );
      }
      return { ok: true, messageId: requestId };
    }
    if (kind === "sight_frame" && inserted === "absent") {
      reclaimDroppedFrame(attachmentId);
    }
    return { ok: false };
  }
}

/**
 * Tell the clients rendering this conversation that a row landed.
 *
 * No turn will announce it, so without this the image does not appear until
 * something else forces a refetch.
 */
function announcePersistedImage(
  conversationId: string,
  text: string,
  messageId: string,
): void {
  broadcastMessage({
    type: "user_message_echo",
    text,
    conversationId,
    messageId,
  });
  recordConversationPersistedSeq(conversationId, getCurrentSeq());
  publishConversationMessagesChanged(conversationId);
}

/**
 * Whether the persist's own row is in the conversation.
 *
 * A persist can fail well after `addMessage` succeeded: a link write that
 * fails is repaired by rewriting the content, and that rewrite can throw in
 * turn.
 *
 * Three-valued because its two readers need opposite answers under doubt, and
 * a boolean can only serve one of them. Reclaiming an attachment on a guess
 * deletes bytes a message may reference; reporting success on a guess tells
 * the client a frame landed when it may not have, and the client stops showing
 * it as pending and stops retrying on the strength of that word. Neither is
 * recoverable, so `unknown` refuses both: never act on a fact that could not
 * be read.
 *
 * A row found under this id is provably this persist's own. The deduplicating
 * branch of `addMessage` fires only for a `clientMessageId`, which no image
 * here sets, and it returns rather than throws, so it cannot leave a half
 * finished persist behind an id that resolves to someone else's row.
 */
function insertedMessageState(
  conversationId: string,
  messageId: string,
): "exists" | "absent" | "unknown" {
  try {
    return getMessageById(messageId, conversationId) !== null
      ? "exists"
      : "absent";
  } catch (err) {
    log.warn(
      { err, conversationId, messageId },
      "Could not tell whether a live-voice image persisted; keeping its attachment and reporting failure",
    );
    return "unknown";
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
    // The camera sampled this, nobody sent it. Indexing it would feed
    // extraction a frame every few seconds of whatever the room happens to
    // contain, and commit those visuals to long-term memory with no consent
    // surface: the design puts keeps in the TRANSCRIPT, which the user can see
    // and delete, and says nothing about memory. The text half is worthless to
    // search anyway, every row reading "(camera frame)".
    skipIndexing: true,
    sightFrameAttachmentIds: [attachmentId],
  });
}
