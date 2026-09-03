/**
 * The session's own camera: the device's camera opened by the window holding
 * the live-voice session, with no viewfinder anywhere, for as long as the user
 * asks the session to see and the session can be shown anything.
 *
 * What the companion's camera control on macOS drives. That surface is a
 * separate window that draws the call and holds none of it, and the voice room
 * is not open during a companion call, so the viewfinder the room's Live would
 * sample is nowhere. The camera is therefore opened here, beside the session,
 * and sampled the way the room samples its viewfinder: the gate
 * (`lib/camera/frame-gate.ts`) says which frames are worth keeping, and every
 * keep goes through `sight-capture.ts`, which the room shares, to be uploaded
 * and sent to the session as `sight_frame`. The daemon persists each as its
 * own user message, so the transcript is the record of what the call saw.
 *
 * ## No viewfinder, on purpose
 *
 * The `<video>` the sampler reads is created here and attached to nothing. It
 * plays, and `drawImage` reads its current picture, but the compositor never
 * presents a frame of it, which is why the sampler is paced by the display
 * rather than by the video (see `FrameSamplerOptions.pacing`). The main
 * window runs with background throttling off, so the animation frame keeps
 * firing while the window sits behind whatever the user is working in, which
 * during a companion call is where it is.
 *
 * ## What the control reads
 *
 * `cameraRequested` is the ask; `cameraStreaming` is the fact, raised once the
 * stream is open and the sampler running and lowered with it, and the fact is
 * what the companion's control draws as on. A camera that is refused (denied,
 * absent, in use) lowers the ask as well, so the control reads as off rather
 * than as an ask nothing is answering, and a later press asks afresh, which is
 * what raises the permission prompt again where the OS allows it.
 *
 * ## Consent
 *
 * Only a press on the control opens the camera, and the control shows the
 * camera as on for exactly as long as frames flow. The camera closes when the
 * user presses again, when the session ends or reconnects (the ask is session
 * state), when the assistant refuses the frame for the session, when this
 * hook unmounts, which is the chat layout going away, and when the track ends
 * from outside the app (a webcam unplugged, permission revoked mid-call),
 * the same interruption the sight store's viewfinder watches for. Each keep
 * lands in the transcript, where the user can see it and delete it.
 *
 * ## One camera at a time
 *
 * A viewfinder on screen owns the device. The room's Live and the composer's
 * photo overlay open the same camera through `useVoiceCamera`, which takes
 * this ask back the moment its viewfinder is up and refuses one raised while
 * it is, so the user is never looking at one preview while a hidden copy of
 * it is sampled for the call as well. The composer's Eyes yields the other
 * way, to the session itself (see `sight/sight-store.ts`).
 */

import { useEffect, useState } from "react";

import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { createSightCapture } from "@/domains/chat/voice/live-voice/sight-capture";
import {
  captureVideoFrame,
  classifyVoiceCameraError,
  requestVideoStream,
} from "@/domains/chat/voice/voice-room/voice-camera";
import { useSupportsSightStream } from "@/lib/backwards-compat/use-supports-sight-stream";
import { createFrameGate } from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  recordFrameGateDecision,
} from "@/lib/camera/frame-gate-debug";
import { createFrameSampler } from "@/lib/camera/frame-sampler";
import { captureError } from "@/lib/sentry/capture-error";

/** Where a failure is filed, so the tag says which source it came from. */
const ERROR_CONTEXT = "live-voice camera: sample/upload frame";

export function useLiveVoiceCamera(): void {
  const requested = useLiveVoiceStore.use.cameraRequested();
  const state = useLiveVoiceStore.use.state();
  const assistantId = useLiveVoiceStore.use.assistantId();
  const sightFramesUnsupported = useLiveVoiceStore.use.sightFramesUnsupported();
  const supportsFrames = useSupportsSightStream(assistantId);
  // Every term, so the camera is absent rather than half-present: the ask,
  // a session for the frames to land in, an assistant that understands the
  // frame, and a session that has not latched the frame as unsupported. The
  // last two are also what the mirror offers the control on, so a term going
  // false mid-run closes a camera whose control is about to disappear.
  const active =
    requested &&
    isLiveVoiceSessionActive(state) &&
    supportsFrames &&
    assistantId !== null &&
    !sightFramesUnsupported;

  // One for the mount: the assistant is handed to each capture by the run
  // that kept the frame, and each run re-bases the order on its way out.
  const [sight] = useState(() => createSightCapture(ERROR_CONTEXT));

  useEffect(() => {
    // `active` already has an assistant in it; the second test is for the
    // narrowing.
    if (!active || assistantId === null) {
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let stopSampling: (() => void) | null = null;
    let detachTrackEnded: (() => void) | null = null;

    const run = async (): Promise<void> => {
      let acquired: MediaStream;
      try {
        // The front camera, which on a laptop is the only one, and on a
        // desktop with several is the one looking at the user.
        acquired = await requestVideoStream("user");
      } catch (cause) {
        if (cancelled) {
          return;
        }
        // Not filed: a denied or missing camera is the user's or the
        // machine's answer, not a fault. Lowering the ask is what tells the
        // control, which reads as off, and a later press asks again.
        console.warn(
          `[live-voice camera] camera not opened: ${classifyVoiceCameraError(cause)}`,
        );
        useLiveVoiceStore.getState().setCameraRequested(false);
        return;
      }
      // Released by a stop that landed during the request. The cleanup ran
      // against nothing, so this is the one place the stream can be closed.
      if (cancelled) {
        for (const track of acquired.getTracks()) {
          track.stop();
        }
        return;
      }
      stream = acquired;
      // macOS can end the track from outside this hook: the webcam is
      // unplugged, or permission is revoked mid-call. `stop()` on our own
      // side does not fire `ended` (the spec says so), so this can only hear
      // an interruption, never the cleanup below. Lowering the ask runs this
      // effect's own cleanup, the same path a press on the control takes.
      const [track] = stream.getVideoTracks();
      if (track) {
        const onTrackEnded = (): void => {
          console.warn("[live-voice camera] camera track ended externally");
          useLiveVoiceStore.getState().setCameraRequested(false);
        };
        track.addEventListener("ended", onTrackEnded);
        detachTrackEnded = () =>
          track.removeEventListener("ended", onTrackEnded);
      }
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      try {
        await video.play();
      } catch (cause) {
        if (cancelled) {
          // A stream-backed element plays without a gesture; a refusal here
          // is an element that is going away, which this covers.
          return;
        }
        // Play never started, so no frame will ever reach the sampler below.
        // The same failure class as a denied acquisition: lowering the ask
        // is what tells the control, and this effect's own cleanup is what
        // gives the stream back.
        console.warn(
          `[live-voice camera] camera not opened: ${classifyVoiceCameraError(cause)}`,
        );
        useLiveVoiceStore.getState().setCameraRequested(false);
        return;
      }
      if (cancelled) {
        return;
      }
      sight.grantConsent();
      // The live options record rather than the defaults, so the tuning
      // readout can move a threshold without this effect rebuilding the gate.
      const gate = createFrameGate(FRAME_GATE_LIVE_OPTIONS);
      gate.reset(performance.now());
      const element = video;
      const sampler = createFrameSampler({
        gate,
        pacing: "display",
        onDecision: (decision, nowMs) => {
          recordFrameGateDecision("voice", decision, nowMs);
          if (!decision.keep) {
            return;
          }
          void sight.capture({
            assistantId,
            produceFrame: (filename) => captureVideoFrame(element, filename),
            // Nothing to show: there is no viewfinder to put a pulse on. The
            // transcript is where a keep is seen.
            onShared: () => undefined,
          });
        },
      });
      sampler.start(element);
      stopSampling = sampler.stop;
      useLiveVoiceStore.getState().setCameraStreaming(true);
    };
    run().catch((cause: unknown) => {
      // Past the two awaits, whose refusals are handled above: a fault in the
      // gate or the sampler coming up. Filed, since it is ours rather than the
      // user's, and the ask is lowered so the control reads as off and this
      // effect's own cleanup gives the stream back.
      if (cancelled) {
        return;
      }
      captureError(cause, { context: ERROR_CONTEXT, bestEffort: true });
      useLiveVoiceStore.getState().setCameraRequested(false);
    });

    return () => {
      cancelled = true;
      // The revocation is the bump that voids every capture in flight; the
      // re-base gives back what was parked behind them.
      sight.revokeConsent();
      sight.rebaseSendOrder();
      detachTrackEnded?.();
      stopSampling?.();
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      useLiveVoiceStore.getState().setCameraStreaming(false);
    };
  }, [active, assistantId, sight]);
}
