/**
 * The composer's ambient keep stream: while the Eyes viewfinder is open, every
 * frame the gate keeps becomes its own message in the conversation on screen.
 *
 * The toggle next door answers "look at this while I send it". This answers
 * "here is what I am holding while we talk about it", which the send path
 * cannot express: a frame only reaches the assistant when a message carries it,
 * so everything the camera saw between two messages is lost, and the one frame
 * that does ride a send is whichever the gate happened to be holding when the
 * user pressed enter.
 *
 * Persisting on the way past removes the question. The transcript becomes the
 * record of what the camera has seen, in the order it saw it, and the model
 * correlates a frame with the surrounding text by adjacency rather than by any
 * attachment to a turn. What it costs is transcript volume, which retention
 * answers: the daemon tags each keep so the newest few stay images to the model
 * and older ones become timestamped stubs, while the transcript keeps every one.
 *
 * ## Order, and what enforces it
 *
 * Each keep is appended to one promise chain, so persists reach the daemon in
 * the order the gate kept the frames rather than the order their uploads
 * happened to finish. Adjacency is the whole correlation, so a scene persisted
 * after a newer one reads as the view the words that follow were about.
 *
 * The chain is all the ordering machinery there is. The HTTP response is this
 * frame's acknowledgement, so nothing is parked waiting for one, nothing is
 * retracted, and a keep that fails costs itself and nothing behind it. (The
 * voice room's `use-voice-room-sight.ts` sends over a socket that acknowledges
 * nothing per frame, which is what its parked-send ledger is for.)
 *
 * ## Consent
 *
 * There is no second camera and no hidden one. This samples the viewfinder the
 * user raised, so frames flow exactly while the tile is on screen showing what
 * is being sampled, and each one lands somewhere they can see it and delete it.
 * Closing the tile gives the camera back and stops them at once.
 */

import { useEffect, useRef } from "react";

import {
  deleteChatAttachment,
  uploadChatAttachment,
} from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import {
  useSightStore,
  type SightKeptFrame,
} from "@/domains/chat/sight/sight-store";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";
import { conversationsByIdSightframePost } from "@/generated/daemon/sdk.gen";
import {
  isVisionModeOn,
  useVisionModeVariant,
} from "@/hooks/use-vision-mode-flag";
import { useSupportsSightPersist } from "@/lib/backwards-compat/use-supports-sight-persist";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** Prefix on every log line from this stream, so one grep finds them all. */
const LOG_PREFIX = "sight keep";

interface PersistKeepArgs {
  readonly keep: SightKeptFrame;
  readonly assistantId: string;
  readonly conversationId: string;
  /**
   * Whether this keep still belongs where it was headed: the stream is running
   * and the conversation it was captured under is the one on screen. Asked
   * again after every await, since each one is a window the user can navigate,
   * switch assistants, or close the camera inside.
   */
  readonly isCurrent: () => boolean;
}

/**
 * Upload one kept frame and hand it to the daemon as a standalone message.
 *
 * Who owns the uploaded row is the whole of the failure handling. A 200 says
 * the daemon took the frame from here whatever `persisted` reports: on a drop
 * it has already released the upload, so deleting would race a row this no
 * longer owns. A transport failure or a 4xx leaves the row with this caller,
 * and nothing else will ever come for it: attachments are collected when the
 * message linking them is deleted, and one that reached no message reaches no
 * collection. `deleteChatAttachment` folds the still-referenced 409 into
 * `false`, so giving the row back is safe even where the persist did land and
 * only its response was lost.
 */
async function persistKeep({
  keep,
  assistantId,
  conversationId,
  isCurrent,
}: PersistKeepArgs): Promise<void> {
  if (!isCurrent()) {
    return;
  }
  let uploadedId: string | null = null;
  try {
    // The same preparation a pasted image gets, and a preparation that fails is
    // not a reason to drop the frame: the original uploads instead, exactly as
    // the picker path does.
    const prepared = await prepareImageAttachmentForUpload(keep.file);
    const file = prepared.status === "failed" ? keep.file : prepared.file;
    if (!isCurrent()) {
      return;
    }

    const uploaded = await uploadChatAttachment(assistantId, file);
    if (!uploaded.ok) {
      // Nothing was stored, so there is nothing to give back. Logged rather
      // than reported: nobody asked for this frame, another is seconds away,
      // and a camera left open through an outage would file one issue per
      // frame.
      console.warn(`${LOG_PREFIX}: upload refused`, uploaded.error.detail);
      return;
    }
    uploadedId = uploaded.id;

    // The upload is a window of its own, and the frame is about to be written
    // into a conversation by id. Landing it in the one the user moved to would
    // put a view they took elsewhere into a transcript that never saw it, so
    // the row goes back instead.
    if (!isCurrent()) {
      await deleteChatAttachment(assistantId, uploadedId);
      return;
    }

    const { data, response } = await conversationsByIdSightframePost({
      path: { assistant_id: assistantId, id: conversationId },
      body: { attachmentId: uploadedId },
      throwOnError: false,
    });
    if (!response?.ok) {
      // A refusal is answered before the persist runs, so the row is still
      // this caller's.
      console.warn(`${LOG_PREFIX}: persist refused`, response?.status);
      await deleteChatAttachment(assistantId, uploadedId);
      return;
    }
    if (data?.persisted !== true) {
      // The daemon dropped the frame and released the upload on its way out.
      // Nothing to delete, and nothing to retry: a newer keep is the honest
      // replacement for one that could not be written.
      return;
    }

    // The frame is in the transcript, so the send path must not attach it as
    // well. Keyed on the file, so a keep made since this one started is left
    // alone and the next send still carries the freshest view.
    useSightStore.getState().consumeKeep(keep.file);
  } catch (cause) {
    console.warn(`${LOG_PREFIX}: persist failed`, cause);
    if (uploadedId) {
      await deleteChatAttachment(assistantId, uploadedId);
    }
  }
}

/**
 * Persist every frame the composer's camera keeps, for as long as the camera is
 * open on a conversation whose assistant serves the route.
 *
 * All five terms, so the feature is absent rather than half-present: a camera
 * that is not running has no consent behind it, a flag that is off is not
 * shipped, an assistant below the gate answers 404 to every keep, and a keep
 * with no conversation to land in has nowhere to go.
 */
export function useSightKeeps(): void {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const conversationId = useConversationStore.use.activeConversationId();
  const status = useSightStore.use.status();
  const latestKeep = useSightStore.use.latestKeep();
  const visionMode = useVisionModeVariant();
  const supportsPersist = useSupportsSightPersist(assistantId);

  const active =
    status === "on" &&
    isVisionModeOn(visionMode) &&
    supportsPersist &&
    !!assistantId &&
    !!conversationId;

  /**
   * Tail of the persist chain: each keep is appended to it, so persists leave
   * in the order the gate kept the frames. Advanced with a continuation that
   * cannot reject, so one failed keep does not wedge the ones behind it.
   */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * The keep already handed to the chain. The store replaces the whole object
   * on every keep, so identity is what separates a new frame from a re-render
   * holding the same one.
   */
  const enqueuedRef = useRef<SightKeptFrame | null>(null);
  /**
   * Which run of the stream the queued keeps belong to. Bumped when the stream
   * stops or the conversation under it changes, so a keep whose upload is still
   * in flight can tell that the world it was headed for is gone.
   */
  const runRef = useRef(0);

  // Separate from the enqueueing effect below, which re-runs on every keep: a
  // cleanup there would void the keep still uploading each time a newer one
  // arrived, and overlapping keeps are exactly what the chain exists to carry.
  useEffect(() => {
    return () => {
      runRef.current += 1;
    };
  }, [active, assistantId, conversationId]);

  useEffect(() => {
    if (!active || !assistantId || !conversationId || !latestKeep) {
      return;
    }
    if (enqueuedRef.current === latestKeep) {
      return;
    }
    enqueuedRef.current = latestKeep;

    const run = runRef.current;
    // Read through `getState` at the moment it is asked, not from this render:
    // a queued keep is checked against the conversation standing when its turn
    // comes, which is the one it would be written into.
    const isCurrent = () =>
      run === runRef.current &&
      isAsyncChatScopeCurrent({
        currentAssistantId:
          useResolvedAssistantsStore.getState().activeAssistantId,
        currentConversationId:
          useConversationStore.getState().activeConversationId,
        requestAssistantId: assistantId,
        requestConversationId: conversationId,
      });

    const persist = () =>
      persistKeep({ keep: latestKeep, assistantId, conversationId, isCurrent });
    const link = chainRef.current.then(persist, persist);
    chainRef.current = link.then(
      () => {},
      () => {},
    );
  }, [active, assistantId, conversationId, latestKeep]);
}
