/**
 * Persisting a photo taken during a live-voice call.
 *
 * A photo lands in the conversation as its own user message, the moment the
 * shutter fires, and **runs no turn**. That single choice is what makes the
 * order of shutter and speech irrelevant: whatever the user says next, before
 * or after the snap, is answered by a model whose history already contains the
 * image.
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
 */

import { v7 as uuidv7 } from "uuid";

import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import {
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../persistence/attachments-store.js";
import { recordConversationPersistedSeq } from "../persistence/conversation-crud.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("live-voice-photo");

/**
 * How long to wait for an in-flight turn before giving up on a photo.
 *
 * Persisting takes the conversation's processing lock, which a running turn
 * holds for as long as it runs, tools included. The wait is generous because
 * the alternative is dropping a photo the user watched themselves take, and
 * the photo is not urgent: nothing is blocked on it except the next thing they
 * say.
 */
const PROCESSING_WAIT_MS = 30_000;
const PROCESSING_POLL_MS = 100;

const PHOTO_MESSAGE_CONTENT = "here's a photo:";

export interface LiveVoicePhotoResult {
  readonly ok: boolean;
  readonly messageId?: string;
}

/**
 * Hydrate attachment ids into the shape `persistQueuedMessageBody` stores.
 * Mirrors the HTTP send path's own `resolveAttachments`, so a photo taken
 * mid-call is stored exactly like one attached to a typed message.
 */
function resolvePhotoAttachments(attachmentIds: string[]) {
  const resolved = getAttachmentsByIds(attachmentIds, {
    hydrateFileData: true,
  });
  const sourcePaths = getSourcePathsForAttachments(attachmentIds);
  return resolved.map((a) => ({
    id: a.id,
    filename: a.originalFilename,
    mimeType: a.mimeType,
    data: a.dataBase64,
    ...(sourcePaths.has(a.id) ? { filePath: sourcePaths.get(a.id) } : {}),
  }));
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
 * Persist a photo into the conversation as a user message, running no turn.
 *
 * Takes and releases the processing lock the way the built-in slash commands
 * do: they are the existing precedent for "persist a user message and answer
 * without the agent loop", and the lock is what keeps this write from
 * interleaving with a turn's own persist.
 *
 * Never throws. A photo that cannot be stored must not take the call down with
 * it, and the caller reports the failure to the user instead.
 */
export async function persistLiveVoicePhoto(
  conversationId: string,
  attachmentId: string,
): Promise<LiveVoicePhotoResult> {
  try {
    const attachments = resolvePhotoAttachments([attachmentId]);
    if (attachments.length === 0) {
      log.warn({ attachmentId }, "Live-voice photo attachment did not resolve");
      return { ok: false };
    }

    const conversation = await getOrCreateConversation(conversationId);

    // A turn holds the lock for its whole run. Waiting rather than queueing:
    // the conversation's queue drains into a turn, which is the one thing this
    // must not cause.
    if (!(await waitForIdle(conversation))) {
      log.warn(
        { conversationId, attachmentId },
        "Live-voice photo timed out waiting for the conversation to go idle",
      );
      return { ok: false };
    }

    conversation.setProcessing(true);
    try {
      const persisted = await persistQueuedMessageBody(conversation, {
        content: PHOTO_MESSAGE_CONTENT,
        attachments,
        requestId: uuidv7(),
        metadata: {
          // Marks the row as something the user did on a call rather than
          // typed, the same way a voice turn's own user message is marked.
          voiceSessionTurn: true,
          livePhoto: true,
        },
      });

      // The row exists but no turn will announce it, so the clients that
      // render this conversation have to be told directly, or the photo does
      // not appear until something else forces a refetch.
      broadcastMessage({
        type: "user_message_echo",
        text: PHOTO_MESSAGE_CONTENT,
        conversationId,
        messageId: persisted.id,
      });
      recordConversationPersistedSeq(conversationId, getCurrentSeq());
      publishConversationMessagesChanged(conversationId);

      return { ok: true, messageId: persisted.id };
    } finally {
      conversation.setProcessing(false);
      // Anything queued behind the lock we just held still has to run. Without
      // this a message queued during the photo's write sits until the next
      // turn ends.
      void conversation.kickDrainQueue("loop_complete", "live_voice_photo");
    }
  } catch (err) {
    log.warn(
      { err, conversationId, attachmentId },
      "Failed to persist a live-voice photo",
    );
    return { ok: false };
  }
}
