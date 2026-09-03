/**
 * Persisting a camera image on its own, outside any turn.
 *
 * Two kinds arrive this way and both take the same route: a photo the user
 * snapped with the shutter on a call, and an ambient camera frame the client's
 * gate kept, which arrives from a call and from the text-chat composer alike.
 * Each lands in the conversation as its own user message, the moment it
 * arrives, and **runs no turn**. That single choice is what makes the order of
 * image and message irrelevant: whatever the user says or types next, before
 * or after, is answered by a model whose history already contains the picture.
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
import {
  getConversationIfExists,
  isSameIncarnation,
} from "../daemon/conversation-store.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  deleteOrphanAttachments,
  resolveAttachmentsForPersist,
} from "../persistence/attachments-store.js";
import {
  getConversation,
  getMessageById,
  MessageInsertPreconditionError,
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
  queuedSightFrame: {
    superseded: boolean;
    attachmentId: string;
    content: string;
  } | null;
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
  content: string,
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

  const ticket = { superseded: false, attachmentId, content };
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
      reclaimOrDefer(
        conversationId,
        [ticket.attachmentId],
        ticket.content,
        uuidv7(),
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

/**
 * How long a launching voice turn waits on a standalone image already in
 * flight for its conversation.
 *
 * Sized for a write whose only remaining wait is the processing flag, which
 * {@link acquireProcessingFlag} takes within a {@link PROCESSING_POLL_MS}
 * poll of the turn leaving it free. Anything slower is a stalled store rather
 * than the ordinary case, and the speaker gets an answer instead of a pause.
 */
export const SIGHT_FRAME_TURN_HOLD_MS = 800;

/**
 * The standalone-image persists this conversation has in flight, or null when
 * it has none.
 *
 * For a caller deciding whether to wait for the picture before reading the
 * conversation's history: a keep the client sent moments ago is counted from
 * the tick its socket message was handled, well before any of it is written.
 * The lookup is synchronous, so a conversation with nothing in flight pays one
 * map read.
 *
 * The promise covers exactly the work queued when it was asked for. An image
 * enqueued afterwards extends the chain past the tail this names, and belongs
 * to whatever asks next.
 *
 * Settles, never rejects: the caller is choosing how long to wait, not whether
 * the image landed.
 */
export function pendingStandaloneImagePersist(
  conversationId: string,
): Promise<void> | null {
  const queue = standaloneImageQueues.get(conversationId);
  if (!queue || queue.outstanding === 0) {
    return null;
  }
  return queue.tail.then(
    () => undefined,
    () => undefined,
  );
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
 * ({@link insertedMessageState}), because a persist can fail after `addMessage`
 * succeeded, and a path that cannot read that answer waits for it through
 * {@link deferFrameReclaimDecision} rather than guessing.
 * {@link deleteOrphanAttachments} being link-aware is the second backstop
 * rather than the only one: a failure between the insert and the link leaves a
 * row that references the attachment with no link to protect it.
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
 * Never throws, and reports whether the store answered. A delete can fail on
 * the same contention the rest of this module waits out, and the caller owes
 * the upload an outcome rather than a log line.
 */
function reclaimDroppedFrame(attachmentIds: readonly string[]): boolean {
  try {
    deleteOrphanAttachments([...attachmentIds]);
    return true;
  } catch (err) {
    log.warn(
      { err, attachmentIds },
      "Could not reclaim a dropped camera frame",
    );
    return false;
  }
}

/**
 * Give the upload up, and hand it to the recheck when the store refuses.
 *
 * `messageId` is the id the row would carry, so a later pass asks the right
 * question: a caller that attempted an insert passes the id it used, and one
 * that never reached an insert passes a fresh id, which reads absent as soon as
 * the store is readable and so retries exactly this delete.
 */
function reclaimOrDefer(
  conversationId: string,
  attachmentIds: readonly string[],
  content: string,
  messageId: string,
): void {
  if (reclaimDroppedFrame(attachmentIds)) {
    return;
  }
  deferFrameReclaimDecision(conversationId, messageId, attachmentIds, content);
}

/** Conversations with a standalone-image persist still in flight. */
export function _standaloneImageQueueSizeForTests(): number {
  return standaloneImageQueues.size;
}

/**
 * How long to wait before asking the store again about a frame whose fate it
 * could not report.
 *
 * The quick cadence covers the ordinary outage, a migration or a writer holding
 * the database, which clears in seconds. One that outlasts those passes steps
 * down to a cadence that can wait all day without filling the log. There is no
 * final pass: giving the record up is the one outcome that loses the bytes for
 * good, nothing else in the daemon collecting an attachment no caller names.
 */
const RECLAIM_RECHECK_MS = 30_000;
const RECLAIM_RECHECK_SLOW_MS = 300_000;
/** Passes at the quick cadence before a record steps down to the slow one. */
const RECLAIM_RECHECK_QUICK_PASSES = 10;

interface PendingFrameReclaim {
  conversationId: string;
  messageId: string;
  /**
   * Every id this attempt is answerable for: the one the caller handed in, and
   * any the persist materialized for itself. A pre-uploaded frame already
   * linked to another conversation is cloned into this one under a fresh id,
   * and the caller's id reclaims nothing for it, that row still being linked
   * where it came from.
   */
  attachmentIds: readonly string[];
  /** Row text, so a frame found to have landed can still be announced. */
  content: string;
  attempts: number;
}

/**
 * Frames waiting on an answer, held for as long as this process lives.
 *
 * In memory on purpose: the record exists because the store could not be read,
 * so writing it to that store is circular. A process that dies inside the
 * outage therefore loses it, which leaves the upload in the same position as
 * every other attachment nothing links, since the daemon has no orphan sweep.
 */
const pendingFrameReclaims: PendingFrameReclaim[] = [];
let reclaimRecheckTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hold a frame whose outcome the store would not report, and settle it once
 * the store answers.
 *
 * Both the refusal a caller sees and the upload behind it are this module's to
 * settle: a refused frame is reported as handled, and nothing else in the
 * daemon collects an attachment no caller names, collection being
 * candidate-driven with no sweep. Reclaiming on the spot is the other wrong
 * answer, because "could not read" is not "no row", and a row that landed can
 * reference the bytes through content whose link write failed. So the question
 * is asked again later and only an answer decides it.
 *
 * `messageId` is the id the row would carry. A path that never reached an
 * insert passes the id it would have used, which reads absent the moment the
 * store is readable, and readable is the whole of what that path is waiting
 * for.
 */
function deferFrameReclaimDecision(
  conversationId: string,
  messageId: string,
  attachmentIds: readonly string[],
  content: string,
): void {
  pendingFrameReclaims.push({
    conversationId,
    messageId,
    attachmentIds,
    content,
    attempts: 0,
  });
  scheduleFrameReclaimRecheck();
}

/**
 * The wait before the next pass: quick while any record is still in its early
 * passes, slow once every one of them has outlasted those.
 */
function nextFrameReclaimRecheckDelay(): number {
  return pendingFrameReclaims.some(
    (pending) => pending.attempts < RECLAIM_RECHECK_QUICK_PASSES,
  )
    ? RECLAIM_RECHECK_MS
    : RECLAIM_RECHECK_SLOW_MS;
}

function scheduleFrameReclaimRecheck(): void {
  if (reclaimRecheckTimer || pendingFrameReclaims.length === 0) {
    return;
  }
  reclaimRecheckTimer = setTimeout(() => {
    reclaimRecheckTimer = null;
    drainFrameReclaimRechecks();
  }, nextFrameReclaimRecheckDelay());
  // A pending reclaim is never a reason to keep the process alive.
  reclaimRecheckTimer.unref?.();
}

/**
 * Deliver a row the client was told had not landed.
 *
 * The refusal it got is not destructive: it retracts a frame the client was
 * showing as pending and does nothing else, so this arrives as an ordinary
 * event for a message the client has never seen and the transcript converges
 * without a reload. A row that reads as existing is proof its conversation is
 * there too, the message being a foreign key into it, so what the announce
 * writes has somewhere to go.
 *
 * The persist unwound its own history push before it threw, so the resident
 * history no longer matches the rows and the next turn reloads rather than
 * reusing what it holds.
 */
function announceDeferredImage(pending: PendingFrameReclaim): void {
  findConversation(pending.conversationId)?.markHistoryStale();
  try {
    announcePersistedImage(
      pending.conversationId,
      pending.content,
      pending.messageId,
    );
  } catch (err) {
    log.warn(
      {
        err,
        conversationId: pending.conversationId,
        messageId: pending.messageId,
      },
      "Persisted a standalone image but could not announce it",
    );
  }
}

/**
 * Ask the store again about every frame waiting on it.
 *
 * A row that exists means the frame reached the transcript, so its bytes are
 * spoken for and the client is told about the row it was never given. Absent
 * means the write never landed and the upload is this module's to give up. A
 * store that still will not answer, and a delete that answers by failing, are
 * the same situation here: ask again, for as long as that takes.
 */
function drainFrameReclaimRechecks(): void {
  for (const pending of pendingFrameReclaims.splice(0)) {
    const inserted = insertedMessageState(
      pending.conversationId,
      pending.messageId,
    );
    if (inserted === "exists") {
      announceDeferredImage(pending);
      continue;
    }
    if (inserted === "absent" && reclaimDroppedFrame(pending.attachmentIds)) {
      continue;
    }
    keepWaitingForStore(pending);
  }
  scheduleFrameReclaimRecheck();
}

/**
 * Put a record back for another pass, counting the attempt so the cadence can
 * step down. The record is never dropped: it is the only handle on an upload
 * nothing else in the daemon would collect.
 */
function keepWaitingForStore(pending: PendingFrameReclaim): void {
  pending.attempts += 1;
  if (pending.attempts === RECLAIM_RECHECK_QUICK_PASSES) {
    log.warn(
      {
        conversationId: pending.conversationId,
        attachmentIds: pending.attachmentIds,
      },
      "Still cannot settle a camera frame; asking less often until the store answers",
    );
  }
  pendingFrameReclaims.push(pending);
}

/** Frames whose outcome the store has not reported yet. */
export function _pendingFrameReclaimCountForTests(): number {
  return pendingFrameReclaims.length;
}

/** The wait the next recheck pass would use. */
export function _nextFrameReclaimRecheckDelayForTests(): number {
  return nextFrameReclaimRecheckDelay();
}

/** Ask the store now rather than on the recheck timer. */
export function _drainFrameReclaimRechecksForTests(): void {
  drainFrameReclaimRechecks();
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
  acquireProcessingFenced: () => Promise<number | null>;
}): Promise<number | null> {
  const deadline = Date.now() + processingWaitMs;
  for (;;) {
    // Fenced, so a frame never writes into a turn no reader can see. A marker
    // that refuses to persist gives the hold back and drops the frame; a
    // conversation that belongs to someone else is waited out below.
    let owner: number | null;
    try {
      owner = await conversation.acquireProcessingFenced();
    } catch (err) {
      log.warn(
        { err },
        "Standalone image gave up its hold: the processing marker would not persist",
      );
      return null;
    }
    if (owner !== null) {
      return owner;
    }
    if (Date.now() >= deadline) {
      return null;
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
 *
 * Every later check answers for the one incarnation the image was accepted
 * for, which is read before anything is queued. Reading it inside the job
 * instead would read whatever holds the id by the time the job runs: the chain
 * can hold a frame behind another image for as long as a turn runs, and a
 * conversation deleted and recreated in that time would be captured as the
 * incarnation the frame was taken in, leaving every check comparing the
 * replacement against itself.
 *
 * `acceptedIncarnation` is that value read by the caller, for one whose own
 * acceptance is earlier than this call: the HTTP door answers 404 from a row
 * it reads before resolving the request's actor, so the row it accepted is the
 * one it read there rather than whatever survives that resolution. A caller
 * with nothing between its acceptance and this call omits it, and the read
 * below is that same moment.
 */
function persistStandaloneImage(
  conversationId: string,
  attachmentId: string,
  kind: "photo" | "sight_frame",
  persistOptions: Omit<
    PersistMessageOptions,
    | "attachments"
    | "requestId"
    | "insertPrecondition"
    | "onUndiscardedAttachments"
  >,
  acceptedIncarnation?: number,
): Promise<LiveVoicePhotoResult> {
  let incarnation: number | null;
  try {
    incarnation =
      acceptedIncarnation ?? getConversation(conversationId)?.createdAt ?? null;
  } catch (err) {
    // This read is the one thing here that runs outside the job's own catch,
    // and the contract above is that an image never takes its caller down: the
    // socket attaches no handler for a rejection. Reported as the refusal it
    // is, and the upload is held rather than deleted, because a store that
    // cannot be read is not evidence the conversation is gone. Nothing was
    // inserted, so the recheck reclaims as soon as the store answers at all.
    log.warn(
      { err, conversationId, attachmentId, kind },
      "Could not read the conversation a standalone image names",
    );
    if (kind === "sight_frame") {
      deferFrameReclaimDecision(
        conversationId,
        uuidv7(),
        [attachmentId],
        persistOptions.content,
      );
    }
    return Promise.resolve({ ok: false });
  }
  if (incarnation === null) {
    log.warn(
      { conversationId, attachmentId, kind },
      "Standalone image dropped: it names no conversation",
    );
    if (kind === "sight_frame") {
      reclaimOrDefer(
        conversationId,
        [attachmentId],
        persistOptions.content,
        uuidv7(),
      );
    }
    return Promise.resolve({ ok: false });
  }
  return enqueueStandaloneImagePersist(
    conversationId,
    attachmentId,
    kind,
    persistOptions.content,
    () =>
      writeStandaloneImage(
        conversationId,
        attachmentId,
        kind,
        incarnation,
        persistOptions,
      ),
  );
}

/**
 * Report and give up on an image whose conversation is no longer the
 * incarnation it was accepted for.
 *
 * Keeps only, per {@link reclaimDroppedFrame}: a photo that failed to land is
 * the user's to retry rather than the daemon's to delete.
 */
function dropReplacedImage(
  conversationId: string,
  attachmentId: string,
  kind: "photo" | "sight_frame",
  content: string,
): LiveVoicePhotoResult {
  log.warn(
    { conversationId, attachmentId, kind },
    "Standalone image dropped: its conversation was replaced before the write",
  );
  if (kind === "sight_frame") {
    reclaimOrDefer(conversationId, [attachmentId], content, uuidv7());
  }
  return { ok: false };
}

async function writeStandaloneImage(
  conversationId: string,
  attachmentId: string,
  kind: "photo" | "sight_frame",
  incarnation: number,
  persistOptions: Omit<
    PersistMessageOptions,
    | "attachments"
    | "requestId"
    | "insertPrecondition"
    | "onUndiscardedAttachments"
  >,
): Promise<LiveVoicePhotoResult> {
  const { content } = persistOptions;
  // The id the row is inserted under, so a failure can ask whether the insert
  // landed before deciding the frame is safe to reclaim.
  const requestId = uuidv7();
  // Ids the persist materialized for this attempt and then could not delete.
  // A frame already linked elsewhere is cloned into this conversation under a
  // fresh id, and nothing but the persist knows it: reclaiming under the id
  // this module holds would leave the clone behind for good.
  const strandedClones: string[] = [];
  try {
    const attachments = resolveAttachmentsForPersist([attachmentId]);
    if (attachments.length === 0) {
      log.warn(
        { attachmentId, kind },
        "Standalone image attachment did not resolve",
      );
      return { ok: false };
    }

    // A queued job starts long after its caller checked, so the conversation
    // can be gone by now. The acquire creates nothing, which is what keeps a
    // delete final for everything already queued: the creating acquire would
    // write the row back and bring the conversation home carrying nothing but
    // camera frames. A delete that lands after the acquire is fenced by the
    // messages foreign key instead, and the failure path below reclaims the
    // upload once it reads that no row was inserted.
    const conversation = await getConversationIfExists(conversationId);
    if (!conversation) {
      log.warn(
        { conversationId, attachmentId, kind },
        "Standalone image dropped: its conversation was deleted while it waited",
      );
      if (kind === "sight_frame") {
        reclaimOrDefer(conversationId, [attachmentId], content, uuidv7());
      }
      return { ok: false };
    }

    // The acquire answers for the row it found, which for a job the chain held
    // behind another image can be a conversation created under this id since.
    // Asked before the idle wait so a replacement is answered now rather than
    // after holding a stranger's lock for the length of a turn.
    if (!isSameIncarnation(conversationId, incarnation)) {
      return dropReplacedImage(conversationId, attachmentId, kind, content);
    }

    // A turn holds the lock for its whole run. Waiting rather than queueing:
    // the conversation's queue drains into a turn, which is the one thing this
    // must not cause.
    const owner = await acquireProcessingFlag(conversation);
    if (owner === null) {
      log.warn(
        { conversationId, attachmentId, kind },
        "Standalone image timed out waiting for the conversation to go idle",
      );
      if (kind === "sight_frame") {
        reclaimOrDefer(conversationId, [attachmentId], content, uuidv7());
      }
      return { ok: false };
    }

    try {
      // The wait can outlast the conversation, and this job holds an instance
      // rather than re-reading, so a delete alone would be caught only by the
      // messages foreign key. A delete followed by a recreate under the same
      // id restores that foreign key's target, and the row would land in a
      // conversation created after the deletion. Both kinds check: a photo
      // persisted into a stranger that inherited the name is the same wrong.
      // The same question rides the persist below as its insert precondition,
      // which is what covers a replacement landing while the write runs.
      if (!isSameIncarnation(conversationId, incarnation)) {
        return dropReplacedImage(conversationId, attachmentId, kind, content);
      }

      const persisted = await persistQueuedMessageBody(conversation, {
        ...persistOptions,
        attachments,
        requestId,
        // Asked again in the insert's own tick, about both things that can
        // stop being true across the awaits the persist takes to materialize
        // the attachment and build its content.
        //
        // A delete and recreate under the same id leaves a valid foreign-key
        // target, so without the first term the frame joins a conversation it
        // was never taken in. A Stop on this hold force-clears the flag, since
        // no turn owns it, and the next request acquires, so without the
        // second the frame writes under a dead claim alongside that turn. The
        // release afterwards is refused either way, but a refused release
        // cannot undo a row.
        //
        // Refusing is also the right reading of the Stop: the user asked the
        // conversation to stop, and this frame is the camera's, not theirs.
        insertPrecondition: () =>
          isSameIncarnation(conversationId, incarnation) &&
          conversation.holdsProcessingClaim(owner),
        onUndiscardedAttachments: (ids) => {
          strandedClones.push(...ids);
        },
      });

      // The row just joined the resident history, and this write ran outside
      // any turn, so nothing scoped that history for the actor it names. A
      // frame posted by one actor into a conversation resident under another
      // would otherwise reach the model inside a scope a reload filters it out
      // of.
      conversation.markHistoryStaleForForeignScope(persistOptions.trustContext);

      announcePersistedImage(conversationId, content, persisted.id);

      return { ok: true, messageId: persisted.id };
    } finally {
      // Only this job's own hold is released. A turn that claimed the flag
      // away mid-write owns it now, and clearing there would free a turn that
      // is still running.
      if (conversation.releaseProcessing(owner)) {
        // Anything queued behind the lock we just held still has to run.
        // Without this a message queued during the image's write sits until
        // the next turn ends.
        void conversation.kickDrainQueue("loop_complete", `standalone_${kind}`);
      }
    }
  } catch (err) {
    if (err instanceof MessageInsertPreconditionError) {
      log.warn(
        { conversationId, attachmentId, kind },
        "Standalone image dropped: its conversation was replaced during the write",
      );
    } else {
      log.warn(
        { err, conversationId, attachmentId, kind },
        "Failed to persist a standalone image",
      );
    }
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
          "Persisted a standalone image but could not announce it",
        );
      }
      return { ok: true, messageId: requestId };
    }
    if (kind === "sight_frame") {
      if (inserted === "absent") {
        reclaimOrDefer(
          conversationId,
          [attachmentId, ...strandedClones],
          content,
          requestId,
        );
      } else {
        // The store would not say whether the row landed. The refusal below
        // reports the frame as handled, so the upload cannot simply be left,
        // and a row that turns out to have landed was never announced. Both
        // wait on the same answer.
        deferFrameReclaimDecision(
          conversationId,
          requestId,
          [attachmentId, ...strandedClones],
          content,
        );
      }
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
      "Could not tell whether a standalone image persisted; keeping its attachment and reporting failure",
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

/** Which client surface the camera's gate was running on. */
export type SightFrameSurface = "voice" | "chat";

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
 * took, and activation counts turns that claim they were typed. The pair of
 * `scripted` and the tag is also the signature the memory-privacy guard
 * (`messageMetadataIsAmbientSightKeep`) reads, so both surfaces stamp both.
 *
 * The surface decides one key and nothing else. `voiceSessionTurn` says a
 * reply to this row is spoken back over a session that is still open, which is
 * true of a keep taken on a call and false of one taken beside the composer,
 * so only the voice caller stamps it.
 *
 * `trustContext` is the requester's own trust, for a caller that resolved one
 * from the actor it verified. The row's provenance is stamped from it, so a
 * conversation whose resting trust names an earlier actor cannot claim this
 * frame. A caller that holds no per-request actor omits it and the persist
 * attributes the row to the conversation, which is the right answer for a
 * session that owns the conversation's trust for its whole life.
 *
 * `acceptedIncarnation` is the `created_at` of the conversation the caller
 * accepted the frame for, for one that resolved that trust between reading the
 * row and calling here: the frame belongs to the row the caller answered on,
 * not to whatever holds the id once the resolution returns. A caller with no
 * such gap omits it. See {@link persistStandaloneImage}.
 */
export async function persistAmbientSightFrame(
  conversationId: string,
  attachmentId: string,
  surface: SightFrameSurface,
  trustContext?: TrustContext,
  acceptedIncarnation?: number,
): Promise<LiveVoicePhotoResult> {
  return persistStandaloneImage(
    conversationId,
    attachmentId,
    "sight_frame",
    {
      content: SIGHT_FRAME_MESSAGE_CONTENT,
      metadata: surface === "voice" ? { voiceSessionTurn: true } : {},
      ...(trustContext ? { trustContext } : {}),
      scripted: true,
      // The camera sampled this, nobody sent it. Indexing it would feed
      // extraction a frame every few seconds of whatever the room happens to
      // contain, and commit those visuals to long-term memory with no consent
      // surface: the design puts keeps in the TRANSCRIPT, which the user can
      // see and delete, and says nothing about memory. The text half is
      // worthless to search anyway, every row reading "(camera frame)".
      skipIndexing: true,
      sightFrameAttachmentIds: [attachmentId],
    },
    acceptedIncarnation,
  );
}
