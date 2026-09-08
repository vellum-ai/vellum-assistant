/**
 * The shared tail of every sight source: a frame the gate kept becomes an
 * upload, the upload becomes a `sight_frame` the daemon persists as its own
 * user message, and nothing lands out of order, after consent was withdrawn,
 * or on a session other than the one the frame was taken for.
 *
 * Two sources feed it. The voice room samples the viewfinder it has on
 * screen, and the session's own camera (`use-live-voice-camera.ts`) samples a
 * stream no viewfinder shows. Where the JPEG comes from differs; everything
 * past it is the same, which is what this module is, so a guard tightened for
 * one source is tightened for both.
 *
 * ## Order
 *
 * Sends leave in the order the gate KEPT the frames, not the order their
 * uploads happened to finish. Uploads of overlapping keeps can finish in
 * either order, and the transcript is the record of what the call saw: the
 * model correlates a frame with speech by adjacency, so a scene persisted
 * after a newer one is read as the view the words that follow were about, and
 * there may be no later keep to correct it before the camera closes.
 *
 * Each capture takes a number when the gate fires, a finished capture waits
 * until the run of numbers before it is complete, and every exit path settles
 * its number, so a capture that fails, is refused, or is abandoned releases
 * the ones behind it instead of stranding them. Past
 * {@link MAX_PARKED_SIGHT_SENDS} the missing capture is written off and the
 * backlog goes through, so a hung upload costs the frames it overlapped rather
 * than the rest of the call.
 *
 * ## Consent
 *
 * A capture is refused before it is taken unless a sampling run has granted
 * consent, and every capture is stamped with an epoch on the way in and checked
 * against it on the way out. Revoking consent bumps the epoch in the same tick
 * as the act that takes it back, which is the whole point: a source's own
 * teardown is a render away, and a frame whose upload lands in that gap would
 * otherwise be shared after the user said stop. The epoch is also bumped for
 * every other way the world a capture was headed for can go (a flipped camera,
 * a transport dropping into a reconnect) by {@link SightCapture.invalidate}.
 *
 * The session generation covers none of those: each leaves the logical call
 * running, and a stalled upload from before any of them could otherwise be
 * persisted as a view of what the call is looking at now.
 */

import {
  deleteChatAttachment,
  uploadChatAttachment,
} from "@/domains/chat/api/messages";
import { prepareImageAttachmentForUpload } from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import { recordFrameGateKeep } from "@/lib/camera/frame-gate-debug";
import { captureError } from "@/lib/sentry/capture-error";

import { sendLiveVoiceSightFrame, useLiveVoiceStore } from "./live-voice-store";

/**
 * How many finished captures may wait on an unfinished older one.
 *
 * Overlap is naturally shallow: the gate's rate floor is seconds and an upload
 * is not, so at most one or two captures are usually in flight. The cap is for
 * the pathological case, an upload that hangs rather than fails, which would
 * otherwise hold every later keep behind it for the rest of the call.
 */
const MAX_PARKED_SIGHT_SENDS = 4;

/** A finished capture waiting for its turn in capture order. */
interface PendingSightSend {
  /** Send it, if the session and the camera it came from are still current. */
  readonly send: () => void;
  /** Give the upload back: this frame will never be sent. */
  readonly discard: () => void;
}

/** A frame the call was given. */
export interface SightSharedFrame {
  /** Id from the upload, which is what `sight_frame` named. */
  readonly attachmentId: string;
  /** The JPEG that was uploaded, for a source that shows what it shared. */
  readonly frame: File;
}

export interface SightCaptureRequest {
  /** The assistant the frame is uploaded against, which is the session's. */
  readonly assistantId: string;
  /**
   * The JPEG: the browser path encodes the `<video>` it is watching, the
   * native path wraps the sample the gate has already judged. Null is a frame
   * that could not be produced, which settles its place in the order and
   * sends nothing.
   */
  readonly produceFrame: (filename: string) => Promise<File | null>;
  /**
   * A frame the call has been given: sent, and only then. Called nowhere else,
   * so a source that shows the last shared frame shows only frames that were.
   */
  readonly onShared: (shared: SightSharedFrame) => void;
}

export interface SightCapture {
  /**
   * Take one kept frame all the way to the transcript. Never rejects: a
   * failure costs one frame and is filed, since nobody asked for it.
   */
  capture(request: SightCaptureRequest): Promise<void>;
  /** Raise consent, where a sampling run starts. */
  grantConsent(): void;
  /**
   * Withdraw consent from every frame captured but not yet shared, now.
   * Idempotent, and free when no run has granted it: an epoch churned for a
   * stop of something already stopped would void a capture nobody withdrew.
   */
  revokeConsent(): void;
  /**
   * Start the order again from whatever has not been captured yet.
   *
   * For the boundaries where waiting on an older capture stops making sense:
   * a new session, a flipped camera, a closed viewfinder. Anything parked is
   * given back rather than sent, since it would fail the guards at send time
   * anyway, and anything still in flight settles below the new turn and is
   * discarded when it lands.
   */
  rebaseSendOrder(): void;
  /**
   * Void every capture aimed at the world that just changed, consented or not,
   * and start the order again. For the changes that leave consent standing
   * and the frames in flight stale: a flipped camera, a transport reconnect.
   */
  invalidate(): void;
}

/**
 * Create one capture chain. `errorContext` is where a failure is filed, so the
 * tag says which source it came from.
 */
export function createSightCapture(errorContext: string): SightCapture {
  let frameCount = 0;
  let captureSeq = 0;
  let nextSendSeq = 0;
  const parked = new Map<number, PendingSightSend | null>();
  let epoch = 0;
  let consented = false;

  /**
   * Give an uploaded row back.
   *
   * Nothing else can: an attachment is collected when the message linking it
   * is deleted, or by the daemon reclaiming a frame it could not persist, and
   * an id that reaches neither is a row and its bytes kept for good.
   *
   * Called for the ids this module refuses itself, before the frame is sent.
   * NOT called for a frame an assistant that understands it could not
   * persist: that path reclaims on its own, so deleting would race it over a
   * row this module no longer owns.
   */
  function reclaimUpload(assistantId: string, attachmentId: string): void {
    void deleteChatAttachment(assistantId, attachmentId).then((ok) => {
      if (!ok) {
        captureError(new Error("sight frame delete refused"), {
          context: errorContext,
          bestEffort: true,
        });
      }
    });
  }

  /**
   * Send everything whose turn has come, oldest first, stopping at the first
   * number nobody has settled yet.
   */
  function drainSends(): void {
    for (;;) {
      while (parked.has(nextSendSeq)) {
        const pending = parked.get(nextSendSeq) ?? null;
        parked.delete(nextSendSeq);
        nextSendSeq += 1;
        pending?.send();
      }
      if (parked.size <= MAX_PARKED_SIGHT_SENDS) {
        return;
      }
      nextSendSeq = Math.min(...parked.keys());
    }
  }

  /**
   * Report what became of one capture, whether or not it produced a frame.
   * Called on every exit path, which is what keeps the order live.
   */
  function settleCapture(seq: number, pending: PendingSightSend | null): void {
    if (seq < nextSendSeq) {
      // The order has moved past this number: the cap wrote it off, or a
      // boundary re-based it. Sending now would put an older view after a
      // newer one, which is the whole thing being prevented.
      pending?.discard();
      return;
    }
    parked.set(seq, pending);
    drainSends();
  }

  function rebaseSendOrder(): void {
    for (const pending of parked.values()) {
      pending?.discard();
    }
    parked.clear();
    nextSendSeq = captureSeq;
  }

  async function capture({
    assistantId,
    produceFrame,
    onShared,
  }: SightCaptureRequest): Promise<void> {
    // Consent is already gone, and the loop has not been torn down yet. The
    // epoch cannot speak for this one: a capture beginning after the bump
    // reads the new number and would pass the guard on the way out, so a
    // frame taken after the user said stop is refused before it is taken.
    if (!consented) {
      return;
    }
    // Nothing this assistant is told about lands, and each attempt would
    // strand another upload, so the sampler runs on and every keep is
    // dropped here. See `sightFramesUnsupported` on the live-voice store.
    if (useLiveVoiceStore.getState().sightFramesUnsupported) {
      return;
    }
    // Read before the encode, not after the upload. Everything below can
    // outlive the session and the camera the frame was taken from, and
    // neither can be re-read afterwards without describing the wrong one.
    const sessionGeneration = useLiveVoiceStore.getState().sessionGeneration;
    const captureEpoch = epoch;
    // Taken here, at the moment the gate kept the frame, because that is the
    // order the scenes happened in and the order the transcript has to carry
    // them in.
    const seq = captureSeq;
    captureSeq += 1;
    let pending: PendingSightSend | null = null;
    try {
      frameCount += 1;
      const frame = await produceFrame(`sight-${frameCount}.jpg`);
      if (!frame) {
        return;
      }
      recordFrameGateKeep("voice", frame);

      // The same preparation a pasted image gets, for the same reason the
      // shutter does it: a high-resolution track behaves like every other
      // attachment rather than like a special case.
      const prepared = await prepareImageAttachmentForUpload(frame);
      const file = prepared.status === "failed" ? frame : prepared.file;

      const uploaded = await uploadChatAttachment(assistantId, file);
      if (!uploaded.ok) {
        return;
      }
      const abandonUpload = (): void => reclaimUpload(assistantId, uploaded.id);
      // The guards run when the turn comes, not now, so a frame that waited
      // is still checked against the session and camera of the moment it
      // would land in.
      pending = {
        discard: abandonUpload,
        send: () => {
          if (
            useLiveVoiceStore.getState().sessionGeneration !== sessionGeneration
          ) {
            abandonUpload();
            return;
          }
          // The camera this came from is closed or pointing elsewhere, so
          // this is a view of nothing the user is looking at now, and
          // persisting it would put that view in the transcript as the
          // current one.
          if (captureEpoch !== epoch) {
            abandonUpload();
            return;
          }
          // Sent before it is shown, and shown only if it was sent. During a
          // reconnect gap it has not been, and a frame that never left is this
          // module's to give back, since the daemon never saw it.
          if (!sendLiveVoiceSightFrame(uploaded.id, sessionGeneration)) {
            abandonUpload();
            return;
          }
          onShared({ attachmentId: uploaded.id, frame });
        },
      };
    } catch (cause) {
      // Best effort by design: nobody asked for this frame, so a failure
      // costs one frame and says nothing to the user.
      captureError(cause, { context: errorContext, bestEffort: true });
    } finally {
      // Every path, including the ones that produced nothing: a capture that
      // never sends must still release the captures behind it.
      settleCapture(seq, pending);
    }
  }

  return {
    capture,
    grantConsent() {
      consented = true;
    },
    revokeConsent() {
      if (!consented) {
        return;
      }
      consented = false;
      epoch += 1;
    },
    rebaseSendOrder,
    invalidate() {
      epoch += 1;
      rebaseSendOrder();
    },
  };
}
