/**
 * Sight in the voice room: when it samples, what it shares, and what it refuses
 * to share.
 *
 * The sampler, the encoder, the resize and the upload are all replaced. None of
 * them can do its real work here (happy-dom has no video decode, no canvas
 * readback and no daemon), and each is covered by its own suite, so what is
 * under test is the wiring between them: which conditions open the camera path,
 * which frames reach the session, and which are refused on the way.
 *
 * The store side is real. The generation rules are the whole reason a frame
 * cannot be sent from a callback, so they are exercised through the actual
 * `sendLiveVoiceSightFrame` rather than around it.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { useEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { UploadAttachmentResult } from "@/domains/chat/api/messages";
import type { FrameSamplerOptions } from "@/lib/camera/frame-sampler";
import type { NativeFrameSourceOptions } from "@/lib/camera/native-frame-source";

import type { VoiceRoomSight } from "./use-voice-room-sight";

let samplerOptions: FrameSamplerOptions | null = null;
const samplerStart = mock((_video: HTMLVideoElement) => {});
const samplerStop = mock(() => {});
mock.module("@/lib/camera/frame-sampler", () => ({
  createFrameSampler: (options: FrameSamplerOptions) => {
    samplerOptions = options;
    return { start: samplerStart, stop: samplerStop };
  },
}));

let nativeSourceOptions: NativeFrameSourceOptions | null = null;
const nativeStart = mock(() => {});
const nativeStop = mock(() => {});
const nativeInvalidate = mock(() => {});
const nativeSampleNow = mock(() => {});
mock.module("@/lib/camera/native-frame-source", () => ({
  createNativeFrameSource: (options: NativeFrameSourceOptions) => {
    nativeSourceOptions = options;
    return {
      start: nativeStart,
      sampleNow: nativeSampleNow,
      invalidate: nativeInvalidate,
      stop: nativeStop,
    };
  },
}));

const captureNativeVoiceCameraSample = mock(async (_quality: number) =>
  btoa("native-sample"),
);
mock.module("@/runtime/native-voice-camera", () => ({
  captureNativeVoiceCameraSample,
}));

const captureVideoFrame = mock(
  async (_video: HTMLVideoElement, filename: string) =>
    new File([new Uint8Array([1, 2, 3])], filename, { type: "image/jpeg" }),
);
/**
 * The quality the camera module shares between a photo and a Live keep.
 *
 * A literal here because the module it comes from is replaced: what the cases
 * below check is that the hook passes the shared value through untouched, which
 * is the wiring. Whether 85 is the right number is `voice-camera`'s business.
 */
const NATIVE_CAPTURE_QUALITY = 85;
mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  captureVideoFrame,
  NATIVE_CAPTURE_QUALITY,
}));

mock.module(
  "@/domains/chat/components/chat-attachments/attachment-image-resize",
  () => ({
    prepareImageAttachmentForUpload: async (file: File) => ({
      status: "unchanged" as const,
      file,
    }),
  }),
);

/** Uploads in flight, so a test can resolve them out of order. */
let pendingUploads: Array<(result: UploadAttachmentResult) => void> = [];
let autoUploadId = 0;
/** When false, every upload parks in `pendingUploads` until released. */
let uploadsResolveImmediately = true;
const uploadChatAttachment = mock(
  (_assistantId: string, _file: File): Promise<UploadAttachmentResult> => {
    if (uploadsResolveImmediately) {
      autoUploadId += 1;
      return Promise.resolve({ ok: true, id: `att-${autoUploadId}` });
    }
    return new Promise((resolve) => {
      pendingUploads.push(resolve);
    });
  },
);
const deleteChatAttachment = mock(
  async (_assistantId: string, _attachmentId: string) => true,
);
mock.module("@/domains/chat/api/messages", () => ({
  uploadChatAttachment,
  deleteChatAttachment,
}));

/**
 * The keep's own feedback, replaced because the real one lazy-imports a
 * Capacitor plugin that has no bridge here. What the cases check is which
 * frames it fires for, which is the wiring; whether a light impact is the right
 * effect is the haptics util's business.
 */
const hapticLight = mock(async () => {});
mock.module("@/utils/haptics", () => ({
  haptic: { light: hapticLight },
}));

const { useVoiceRoomSight } = await import("./use-voice-room-sight");
const { publish } = await import("@/lib/event-bus");
const { minimizeVoiceRoom, restoreVoiceRoom, useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { makeControlsSpies, seedLiveVoiceSession } =
  await import("@/domains/chat/voice/live-voice/live-voice-fakes.test-helper");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

const ASSISTANT_ID = "asst_sight";
/** A dev build off `main` published after the `sight_frame` handler merged. */
const SUPPORTING_VERSION = "0.11.7-dev.202609010300.b432fb7";

const KEEP = {
  keep: true,
  reason: "novel" as const,
  motion: null,
  novelty: 0.9,
  detail: 40,
};
const SKIP = { ...KEEP, keep: false, reason: "unchanged" as const };

let controls = makeControlsSpies();

/** Let the microtasks behind an `onDecision` capture run. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Resume a settled upload without letting React commit anything.
 *
 * The consent cases below live in the gap between the act that ends Live and
 * the render it schedules: an upload landing there is exactly the frame that
 * must not be shared. `act` closes that gap by flushing the effects, so it is
 * deliberately not used, and only the microtasks the upload's own `await`
 * chain resumes on are drained. React can commit a render in one of these; it
 * cannot run a passive effect, which is where the teardown that used to be the
 * only thing voiding the frame lives.
 */
async function resumeUploadBeforeRender(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

/**
 * What a case can change between renders.
 *
 * `nativePreview` is optional, and left out by every case that is not about
 * which preview is up: the room's own `<video>` is what they sample, which is
 * what leaving it out means.
 */
interface SightProps {
  cameraOpen: boolean;
  facing: "environment" | "user";
  nativePreview?: boolean;
}

/**
 * Mount the hook, in Live unless a case says otherwise.
 *
 * Live is the only mode that samples, so it is the premise of every case about
 * a kept frame rather than a variable in them: written out at each of those, it
 * would be forty repetitions of the same line. The cases where the mode itself
 * is what is under test pass it explicitly, in both directions.
 *
 * Live is turned on through the hook's own setter rather than an argument,
 * because the hook owns the flag and the room is not allowed to force it: what
 * a test can reach is what the shutter can.
 */
function renderSight(
  options: {
    cameraOpen?: boolean;
    assistantId?: string | null;
    facing?: "environment" | "user";
    live?: boolean;
    nativePreview?: boolean;
  } = {},
) {
  const video = document.createElement("video");
  const videoRef = { current: video };
  const view = renderHook<VoiceRoomSight, SightProps>(
    ({ cameraOpen, facing, nativePreview }) =>
      useVoiceRoomSight(
        options.assistantId === undefined ? ASSISTANT_ID : options.assistantId,
        videoRef,
        { cameraOpen, facing, nativePreview: nativePreview ?? false },
      ),
    {
      initialProps: {
        cameraOpen: options.cameraOpen ?? true,
        facing: options.facing ?? ("environment" as const),
        nativePreview: options.nativePreview ?? false,
      },
    },
  );
  if (options.live ?? true) {
    act(() => {
      view.result.current.setLive(true);
    });
  }
  return { view, video };
}

/** Offer one kept frame to the running sampler and settle the upload. */
async function keepFrame(): Promise<void> {
  act(() => {
    samplerOptions?.onDecision(KEEP, performance.now());
  });
  await flush();
}

/**
 * Replace the running gate's `reset` with a spy.
 *
 * The sampler is handed the very object the hook keeps, so overwriting the
 * method here is what the hook calls. Nothing else can observe a reset: the
 * sampler is faked, so no frame ever reaches the real gate.
 */
function watchGateReset() {
  const spy = mock((_nowMs: number) => {});
  samplerOptions!.gate.reset = spy;
  return spy;
}

/**
 * The same, for the one-shot arm, on whichever sampler is running.
 *
 * Both are handed the very gate the hook keeps, so replacing the method on the
 * object the source was given is what the hook calls.
 */
function watchGateArm() {
  const spy = mock((_nowMs: number) => {});
  (samplerOptions ?? nativeSourceOptions)!.gate.armForcedKeep = spy;
  return spy;
}

beforeEach(() => {
  samplerOptions = null;
  samplerStart.mockClear();
  samplerStop.mockClear();
  nativeSourceOptions = null;
  nativeStart.mockClear();
  nativeStop.mockClear();
  nativeInvalidate.mockClear();
  nativeSampleNow.mockClear();
  captureNativeVoiceCameraSample.mockClear();
  captureVideoFrame.mockClear();
  uploadChatAttachment.mockClear();
  deleteChatAttachment.mockClear();
  hapticLight.mockClear();
  pendingUploads = [];
  autoUploadId = 0;
  uploadsResolveImmediately = true;
  useLiveVoiceStore.getState().reset();
  // The reclaim queue is deliberately not session state, and a reset now feeds
  // it the sends nobody acknowledged, so it has to be drained between cases.
  useLiveVoiceStore
    .getState()
    .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);
  controls = makeControlsSpies();
  seedLiveVoiceSession("listening", {
    assistantId: ASSISTANT_ID,
    conversationId: "conv_sight",
    controls,
  });
  useAssistantIdentityStore
    .getState()
    .setIdentity("assistant", SUPPORTING_VERSION, ASSISTANT_ID);
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ visionMode: "on" }, null);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useVoiceRoomSight: when it samples", () => {
  test("samples the room's viewfinder while Live is running", () => {
    const { video } = renderSight({ live: true });

    expect(samplerStart).toHaveBeenCalledTimes(1);
    expect(samplerStart.mock.calls[0]?.[0]).toBe(video);
  });

  test("stops when the viewfinder closes", () => {
    const { view } = renderSight({ live: true });
    expect(samplerStart).toHaveBeenCalledTimes(1);

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    expect(samplerStop).toHaveBeenCalled();
  });

  test("samples nothing with the camera closed", () => {
    renderSight({ cameraOpen: false, live: true });

    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("samples nothing with the camera open and Live off", () => {
    // The viewfinder on its own is a camera the user is aiming, not one they
    // asked to stream. Nothing leaves the client until the shutter is held.
    const { view } = renderSight({ live: false });

    expect(view.result.current.live).toBe(false);
    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("starts sampling when Live goes on mid-session, and stops when it goes off", async () => {
    const { view } = renderSight({ live: false });

    act(() => {
      view.result.current.setLive(true);
    });
    expect(view.result.current.live).toBe(true);
    expect(samplerStart).toHaveBeenCalledTimes(1);

    await keepFrame();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");

    act(() => {
      view.result.current.setLive(false);
    });
    expect(samplerStop).toHaveBeenCalled();
    // The pulse says the call is being shown this, and once the stream is off
    // it is not being shown anything.
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("samples nothing while the vision-mode flag is off", () => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ visionMode: "off" }, null);

    const { view } = renderSight({ live: true });

    expect(view.result.current.liveAvailable).toBe(false);
    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("samples nothing against the release that predates the frame", () => {
    // 0.11.7 was cut before the handler existed, so every keep would come back
    // as the error the transport reads as a settings rejection.
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.11.7", ASSISTANT_ID);

    const { view } = renderSight({ live: true });

    expect(view.result.current.liveAvailable).toBe(false);
    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("samples nothing against a dev build from before the handler merged", () => {
    // Same base as a supported build, and only the timestamp tells them apart,
    // which is the whole reason the gate pins one.
    useAssistantIdentityStore
      .getState()
      .setIdentity(
        "assistant",
        "0.11.7-dev.202608311412.b432fb7",
        ASSISTANT_ID,
      );

    renderSight({ live: true });

    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("offers no Live without an assistant to upload against", () => {
    const { view } = renderSight({ assistantId: null, live: true });

    expect(view.result.current.liveAvailable).toBe(false);
    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("offers no Live once the session has latched the frame as unsupported", async () => {
    const { view } = renderSight({ live: true });
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });

    // The offer goes, not only the state. Left available, the room would keep
    // the hint and the hold on the shutter, and a second hold would raise a
    // pill saying Live over a camera whose every keep ends at the capture
    // guard.
    expect(view.result.current.liveAvailable).toBe(false);
    expect(view.result.current.live).toBe(false);

    act(() => {
      view.result.current.setLive(true);
    });
    expect(view.result.current.live).toBe(false);
  });

  test("offers Live behind the native preview", () => {
    const { view } = renderSight({ nativePreview: true, live: true });

    // The preview is up only because the camera plugin accepted a start, and
    // the sample call ships in that same plugin, so there is nothing further to
    // ask before offering the hold.
    expect(view.result.current.liveAvailable).toBe(true);
    expect(view.result.current.live).toBe(true);
    expect(nativeStart).toHaveBeenCalledTimes(1);
    // The native preview sits behind the web view, so the room's own element
    // is not on screen and never receives the stream.
    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("a preview that turns native mid-viewfinder swaps the source under Live", () => {
    const { view } = renderSight({ live: true });
    expect(view.result.current.live).toBe(true);
    expect(samplerStart).toHaveBeenCalledTimes(1);

    // A shell whose native start failed runs the browser fallback. A later flip
    // retries the native start, and the retry succeeding swaps the preview
    // under a mode that is already running.
    act(() => {
      view.rerender({
        cameraOpen: true,
        facing: "user",
        nativePreview: true,
      });
    });

    // Same camera, same hold, a different way of reading it. Ending Live here
    // would charge the user a hold for a swap they never asked for.
    expect(view.result.current.liveAvailable).toBe(true);
    expect(view.result.current.live).toBe(true);
    expect(samplerStop).toHaveBeenCalled();
    expect(nativeStart).toHaveBeenCalledTimes(1);
  });

  test("a setter held from an earlier render is refused against availability now", () => {
    const { view } = renderSight({ live: false });
    // What the room hands the shutter: a handler built around the setter of
    // the render that offered the hold. The shutter's own threshold fires it
    // half a second later, which is long enough for availability to go.
    const askFromBefore = view.result.current.setLive;

    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });
    act(() => {
      askFromBefore(true);
    });

    // The effect that holds the mode to availability has already run for the
    // change and does not re-run for this write, so a setter answering from
    // what it captured would leave Live raised for good.
    expect(view.result.current.liveAvailable).toBe(false);
    expect(view.result.current.live).toBe(false);
    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("a flip that stays on the room's own preview leaves Live running", () => {
    const { view } = renderSight({ live: true });

    act(() => {
      view.rerender({
        cameraOpen: true,
        facing: "user",
        nativePreview: false,
      });
    });

    // The ordinary flip, which is a camera change and not a preview change: the
    // gate is rebased for the new view (covered below) and the mode stands.
    expect(view.result.current.liveAvailable).toBe(true);
    expect(view.result.current.live).toBe(true);
    expect(samplerStop).not.toHaveBeenCalled();
  });

  test("backgrounding ends Live, and coming back does not resume it", async () => {
    const { view } = renderSight({ live: true });
    await keepFrame();
    expect(samplerStart).toHaveBeenCalledTimes(1);

    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });

    // The hold was given to a viewfinder the user was watching. The sampler
    // only pauses while the page is hidden, so a Live left standing would go
    // on sharing what the camera sees the moment the app is back.
    expect(view.result.current.live).toBe(false);
    expect(samplerStop).toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();

    act(() => {
      publish("app.resume", { signal: "visibility" });
    });

    expect(view.result.current.live).toBe(false);
    expect(samplerStart).toHaveBeenCalledTimes(1);

    // What it costs is one hold, which is the gesture the consent is carried
    // by rather than one the app remembers across being put away.
    act(() => {
      view.result.current.setLive(true);
    });
    expect(samplerStart).toHaveBeenCalledTimes(2);
  });
});

describe("useVoiceRoomSight: sharing a keep", () => {
  test("uploads a kept frame and shares it with the session at once", async () => {
    const { view } = renderSight();

    await keepFrame();

    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(controls.sightFrame).toHaveBeenCalledWith("att-1");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
    // The daemon owns a frame it was told about and reclaims it if the
    // persist fails, so nothing here may delete the row.
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("a keep the call was given is felt once", async () => {
    // The pulse is on a screen nobody is watching: Live is held at arm's
    // length, aimed at whatever is being talked about.
    const { view } = renderSight();

    await keepFrame();

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
  });

  test("a keep the session refused is felt not at all", async () => {
    // Same reason the thumbnail stays down for one: nothing was shared, so
    // there is nothing to report.
    controls.sightFrame.mockImplementation(() => false);
    renderSight();

    await keepFrame();

    expect(hapticLight).not.toHaveBeenCalled();
  });

  test("sends each keep exactly once", async () => {
    // The transcript carries one message per keep, so a second send would be a
    // duplicate frame in the conversation with no way for the user to tell
    // which was which.
    const { view } = renderSight();

    await keepFrame();
    await keepFrame();
    act(() => {
      view.rerender({ cameraOpen: true, facing: "environment" });
    });
    await flush();

    expect(controls.sightFrame.mock.calls).toEqual([["att-1"], ["att-2"]]);
  });

  test("ignores frames the gate skipped", async () => {
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(SKIP, performance.now());
    });
    await flush();

    expect(captureVideoFrame).not.toHaveBeenCalled();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("the newest keep replaces the one on screen, and gives its preview back", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();

    await keepFrame();
    const first = view.result.current.heldFrame;
    expect(first?.attachmentId).toBe("att-1");

    await keepFrame();

    expect(controls.sightFrame).toHaveBeenNthCalledWith(2, "att-2");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
    expect(revoke).toHaveBeenCalledWith(first!.previewUrl);
    revoke.mockRestore();
  });

  test("shows nothing it could not send", async () => {
    // A reconnect gap: the frame never reached the session, so the thumbnail
    // must not claim the call has been shown it.
    controls.sightFrame.mockImplementation(() => false);
    const { view } = renderSight();

    await keepFrame();

    expect(controls.sightFrame).toHaveBeenCalledWith("att-1");
    expect(view.result.current.heldFrame).toBeNull();
    // The daemon never saw this id, so nothing there will ever collect it.
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
  });

  test("sends overlapping keeps in capture order, not upload order", async () => {
    // The transcript is the record of what the call saw, and the model reads a
    // frame against the speech beside it. A scene persisted after a newer one
    // is read as the view the following words were about, and the camera can
    // close before any later keep corrects it.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    expect(pendingUploads).toHaveLength(2);

    // The newer capture's upload finishes first, which decides nothing.
    await act(async () => {
      pendingUploads[1]!({ ok: true, id: "att-newer" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(controls.sightFrame).not.toHaveBeenCalled();

    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-older" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame.mock.calls).toEqual([
      ["att-older"],
      ["att-newer"],
    ]);
    // The pulse follows the sends, so it settles on the newest scene.
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-newer");
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("the ordering the assistant sees is the ordering it is told about", async () => {
    // The latch and reclaim bookkeeping reads sends as they go out, so it has
    // to see capture order too, not the order the uploads happened to finish.
    uploadsResolveImmediately = false;
    renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    await act(async () => {
      pendingUploads[1]!({ ok: true, id: "att-newer" });
      pendingUploads[0]!({ ok: true, id: "att-older" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useLiveVoiceStore.getState().outstandingSightFrames).toEqual([
      "att-older",
      "att-newer",
    ]);
  });

  test("an earlier capture that fails releases the one behind it", async () => {
    // Nothing waits on a frame that will never come. An upload that fails
    // settles its place in the order just as a successful one does.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    await act(async () => {
      pendingUploads[1]!({ ok: true, id: "att-newer" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(controls.sightFrame).not.toHaveBeenCalled();

    await act(async () => {
      pendingUploads[0]!({ ok: false, status: 500, error: {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame.mock.calls).toEqual([["att-newer"]]);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-newer");
  });

  test("an earlier capture refused by the epoch releases the one behind it", async () => {
    // A flip invalidates everything captured before it, including the frame a
    // newer keep would otherwise be queued behind.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      view.rerender({ cameraOpen: true, facing: "user" });
    });
    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    await act(async () => {
      pendingUploads[1]!({ ok: true, id: "att-after-flip" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-before-flip" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The pre-flip frame is a view of somewhere the camera is not pointing.
    expect(controls.sightFrame.mock.calls).toEqual([["att-after-flip"]]);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-after-flip");
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-before-flip",
    );
  });

  test("a new session does not queue behind the call before it", async () => {
    // The order is per session. A capture left in flight by a call that ended
    // must never be the thing the next call's first keep is waiting on.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    act(() => {
      useLiveVoiceStore.getState().reset();
    });
    const successor = makeControlsSpies();
    act(() => {
      seedLiveVoiceSession("listening", {
        assistantId: ASSISTANT_ID,
        conversationId: "conv_next",
        controls: successor,
      });
    });
    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    await act(async () => {
      pendingUploads[1]!({ ok: true, id: "att-new-session" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(successor.sightFrame.mock.calls).toEqual([["att-new-session"]]);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-new-session");
  });

  test("a stalled capture does not hold the rest of the call hostage", async () => {
    // The cap. An upload that hangs rather than fails would otherwise park
    // every later keep behind it for as long as the camera is open.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    for (let i = 0; i < 6; i++) {
      act(() => {
        samplerOptions?.onDecision(KEEP, performance.now());
      });
      await flush();
    }
    expect(pendingUploads).toHaveLength(6);

    // Everything except the first resolves; the first never does.
    await act(async () => {
      for (let i = 1; i < 6; i++) {
        pendingUploads[i]!({ ok: true, id: `att-${i}` });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame.mock.calls).toEqual([
      ["att-1"],
      ["att-2"],
      ["att-3"],
      ["att-4"],
      ["att-5"],
    ]);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-5");

    // And when the stalled one finally lands, its place in the order is long
    // gone, so it is given back rather than sent after everything newer.
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-stalled" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame).toHaveBeenCalledTimes(5);
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-stalled",
    );
  });

  test("refuses a frame whose session ended under the upload", async () => {
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    // A terminal reset is what moves the generation; the frame belongs to the
    // call that is over, not to whichever one runs when the upload lands.
    act(() => {
      useLiveVoiceStore.getState().reset();
    });
    const successor = makeControlsSpies();
    act(() => {
      seedLiveVoiceSession("listening", {
        assistantId: ASSISTANT_ID,
        conversationId: "conv_next",
        controls: successor,
      });
    });
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-orphan" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(successor.sightFrame).not.toHaveBeenCalled();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-orphan",
    );
  });

  test("refuses a frame still uploading when the shutter stops Live", async () => {
    // The boundary the whole feature rests on. Stopping Live only schedules a
    // render, and the upload resolves inside the gap before it, so a frame
    // shared here is one the call is shown after the user said stop.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    // The tap, which is what the room's shutter runs on a press while live,
    // and the upload landing in the gap it opens. Outside `act` on purpose:
    // see `resumeUploadBeforeRender`.
    view.result.current.setLive(false);
    pendingUploads[0]!({ ok: true, id: "att-stopped" });
    await resumeUploadBeforeRender();

    expect(controls.sightFrame).not.toHaveBeenCalled();

    // Then let the render and its effects land, so the rest is read off a
    // settled surface rather than mid-commit.
    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    // Nothing else collects a row whose message was never written.
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-stopped",
    );
  });

  test("refuses a frame still uploading when the app is put away", async () => {
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    // The same boundary reached without a gesture. The bus delivers this
    // synchronously, and the frame in flight is on the far side of it.
    publish("app.hidden", { signal: "visibility" });
    pendingUploads[0]!({ ok: true, id: "att-hidden" });
    await resumeUploadBeforeRender();

    expect(controls.sightFrame).not.toHaveBeenCalled();

    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-hidden",
    );
  });

  test("refuses a frame still uploading when the camera control closes", async () => {
    // Closing the viewfinder ends Live without going through `setLive`, so the
    // mode only comes down on the render the tap schedules. The room revokes
    // in the handler instead, which is what this stands in for.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    view.result.current.revokeCaptureConsent();
    pendingUploads[0]!({ ok: true, id: "att-camera-closed" });
    await resumeUploadBeforeRender();

    expect(controls.sightFrame).not.toHaveBeenCalled();

    // The close itself, arriving as the render the tap scheduled.
    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });
    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-camera-closed",
    );
  });

  test("refuses a frame still uploading when the room is dismissed", async () => {
    // Minimizing does not unmount the room: the overlay plays an exit
    // animation first, so the teardown that would void this frame is an
    // animation away and the upload lands long before it.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    // The chevron, Escape, the sheet's drag and the assistant's own
    // `minimize_room` frame are all this one call.
    minimizeVoiceRoom();
    pendingUploads[0]!({ ok: true, id: "att-minimized" });
    await resumeUploadBeforeRender();

    expect(controls.sightFrame).not.toHaveBeenCalled();

    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.live).toBe(false);
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-minimized",
    );
  });

  test("a dismissal taken back leaves the room on photo, and its next hold samples", async () => {
    const { view } = renderSight();
    await keepFrame();
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);

    // Restoring inside the exit animation is the one case the room comes back
    // without ever unmounting. What it comes back to is photo: the consent the
    // dismissal spent is not handed back with the room.
    act(() => {
      minimizeVoiceRoom();
    });
    expect(view.result.current.live).toBe(false);
    act(() => {
      restoreVoiceRoom();
    });
    expect(view.result.current.live).toBe(false);

    // And a fresh hold is a fresh consent, which samples like any other.
    act(() => {
      view.result.current.setLive(true);
    });
    await keepFrame();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });

  test("dismissing a room that is only on photo costs the next Live nothing", async () => {
    const { view } = renderSight({ live: false });

    // Nothing is being sampled, so there is no run to withdraw and the flag's
    // early return makes the dismissal free.
    act(() => {
      minimizeVoiceRoom();
      restoreVoiceRoom();
    });
    act(() => {
      view.result.current.setLive(true);
    });
    await keepFrame();

    expect(controls.sightFrame).toHaveBeenCalledTimes(1);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
  });

  test("revoking with nothing being sampled costs the next Live nothing", async () => {
    const { view } = renderSight({ live: false });

    // The camera control closing a viewfinder that never left photo. There is
    // no run to withdraw, so the flag's early return makes this free: an epoch
    // churned here would void a capture nobody withdrew.
    act(() => {
      view.result.current.revokeCaptureConsent();
      view.result.current.revokeCaptureConsent();
    });
    act(() => {
      view.result.current.setLive(true);
    });
    await keepFrame();

    expect(controls.sightFrame).toHaveBeenCalledTimes(1);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
  });

  test("refuses a frame still uploading when Live stops being available", async () => {
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    // Availability going is the third way consent ends, and it ends it for the
    // same reason: an unavailable Live has nowhere honest to land a frame.
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });
    expect(view.result.current.liveAvailable).toBe(false);
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-unavailable",
    );
  });

  test("a frame that landed before the stop is shared, and the next Live sends its own", async () => {
    const { view } = renderSight();

    // Consent covered this one: it left while Live was running, and stopping
    // afterwards takes nothing back that the call has already been shown.
    await keepFrame();
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);

    act(() => {
      view.result.current.setLive(false);
    });
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);

    // And the boundary is per Live, not for the rest of the call: a fresh hold
    // is a fresh consent, and the frames it produces go.
    act(() => {
      view.result.current.setLive(true);
    });
    await keepFrame();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });

  test("refuses a frame whose camera closed under the upload", async () => {
    // The session is untouched, so only the capture epoch can tell that this
    // frame is a view of something nobody is looking at any more. Persisting
    // it would put it in the transcript as what the call is being shown.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-closed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-closed",
    );
  });

  test("refuses a frame whose camera flipped under the upload", async () => {
    // A flip keeps the same element and the same session, and points somewhere
    // else entirely: a rear-camera frame must not land in the transcript as
    // what the front camera is showing.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      view.rerender({ cameraOpen: true, facing: "user" });
    });
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-rear" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-rear");
  });
});

describe("useVoiceRoomSight: an assistant that cannot take the frame", () => {
  test("latches the session, so no further keep is sent or uploaded", async () => {
    // The runtime backstop for a mis-gated assistant. Without it every keep
    // uploads an attachment this assistant will never store and never
    // reclaim, one orphan per keep, while the room implies it is sharing.
    const { view } = renderSight();
    await keepFrame();
    expect(controls.sightFrame).toHaveBeenCalledWith("att-1");

    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });
    controls.sightFrame.mockClear();
    uploadChatAttachment.mockClear();
    await keepFrame();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    // Refused before the upload, not after, so there is nothing to give back.
    expect(uploadChatAttachment).not.toHaveBeenCalled();
    // Nothing was shared, so the pulse has no honest version to keep showing.
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("leaves the deleting to the session-lifetime reclaimer", async () => {
    // A minimized room is not mounted, so cleanup cannot be this component's
    // to perform. It queues on the store instead, naming the assistant.
    const { view } = renderSight();
    await keepFrame();

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().sightFramesToReclaim).toEqual([
      { assistantId: ASSISTANT_ID, attachmentId: "att-1" },
    ]);
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("the latch takes Live down, so nothing goes on being sampled", async () => {
    const { view } = renderSight();
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });

    // Every keep from here is dropped before it is uploaded, so a surface
    // still reading Live would be claiming the call can see the room while
    // nothing it captures leaves the client.
    expect(view.result.current.live).toBe(false);
    expect(samplerStop).toHaveBeenCalled();
  });

  test("a reconnect unlatches, so an upgraded assistant is tried again", async () => {
    const { view } = renderSight();
    await keepFrame();
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });

    act(() => {
      useLiveVoiceStore.getState().reset({ sessionContinues: true });
    });
    act(() => {
      seedLiveVoiceSession("listening", {
        assistantId: ASSISTANT_ID,
        conversationId: "conv_sight",
        controls,
      });
    });
    // The offer is back, and the mode is not: unlatching restores the hold on
    // the shutter, and the user asks for the stream again the same way they
    // asked the first time.
    expect(view.result.current.liveAvailable).toBe(true);
    expect(view.result.current.live).toBe(false);
    act(() => {
      view.result.current.setLive(true);
    });
    controls.sightFrame.mockClear();
    await keepFrame();

    expect(controls.sightFrame).toHaveBeenCalledTimes(1);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });
});

describe("useVoiceRoomSight: a keep the assistant could not persist", () => {
  test("retracts the pulse when the refusal can only be about it", async () => {
    // The lone final keep. Nothing newer is coming to correct the thumbnail,
    // so leaving it up would claim a view that never reached the transcript.
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();
    await keepFrame();
    const held = view.result.current.heldFrame;

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.result.current.heldFrame).toBeNull();
    expect(revoke).toHaveBeenCalledWith(held!.previewUrl);
    // This assistant reclaims what it could not persist; deleting here would
    // race it over a row this hook no longer owns.
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    revoke.mockRestore();
  });

  test("retracts the displayed keep the error named, past older sends", async () => {
    // What the positional fallback cannot reach: successful keeps are never
    // acknowledged, so after the first one the ledger holds more than one send
    // for the rest of the call and the fallback goes quiet.
    const { view } = renderSight();
    await keepFrame();
    await keepFrame();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false, "att-2");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.result.current.heldFrame).toBeNull();
  });

  test("a retraction queued after the render is applied, not cleared unread", async () => {
    // The window an atomic take closes. This render captured the retractions
    // as they stood, and a refusal can land before the effect body runs; a
    // consumer that cleared the whole list while checking only what it
    // captured would leave a frame the assistant refused sitting on screen as
    // one it was shown.
    const video = document.createElement("video");
    const videoRef = { current: video };
    let armed = false;
    let fired = false;
    const view = renderHook(() =>
      // Declared first, so its effect runs before the sight hook's in the same
      // commit: exactly between that hook's capture and its body.
      {
        useEffect(() => {
          if (!armed || fired) {
            return;
          }
          fired = true;
          useLiveVoiceStore.getState().noteSightFrameRefused(false, "att-1");
        });
        return useVoiceRoomSight(ASSISTANT_ID, videoRef, {
          cameraOpen: true,
          facing: "environment",
          nativePreview: false,
        });
      },
    );

    // This case mounts the hook itself, to seat an effect ahead of the sight
    // hook's, so it enters Live the way `renderSight` does.
    act(() => {
      view.result.current.setLive(true);
    });
    await keepFrame();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");

    armed = true;
    await act(async () => {
      // An unrelated retraction, which is what this render will capture.
      useLiveVoiceStore.getState().noteSightFrameRefused(false, "att-other");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.result.current.heldFrame).toBeNull();
    expect(useLiveVoiceStore.getState().sightFrameRetractions).toEqual([]);
  });

  test("leaves the pulse alone when the error named an older keep", async () => {
    const { view } = renderSight();
    await keepFrame();
    await keepFrame();

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false, "att-1");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });

  test("takes the pulse down when an unnamed refusal could mean it", async () => {
    // The fallback, with no id to go on: the refusal could be either keep,
    // the one on screen included, and a pulse left up would claim a share
    // that may never have happened. Nothing is deleted here; the reset-time
    // reclaim is what sorts the persisted keep from the lost one.
    const { view } = renderSight();
    await keepFrame();
    await keepFrame();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("does not latch, so keeps go on being sent", async () => {
    const { view } = renderSight();
    await keepFrame();
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false);
    });

    await keepFrame();

    expect(controls.sightFrame).toHaveBeenLastCalledWith("att-2");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });
});

describe("useVoiceRoomSight: what it is not coupled to", () => {
  test("a discarded utterance is a non-event", async () => {
    // There is no utterance coupling left to get wrong: keeps persist on their
    // own and nothing waits for speech to carry them. A cough that opens and
    // closes an utterance therefore neither sends a frame nor drops one.
    const { view } = renderSight();
    await keepFrame();
    controls.sightFrame.mockClear();

    act(() => {
      useLiveVoiceStore.getState().setState("transcribing");
    });
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
  });

  test("a turn running does not send or drop anything", async () => {
    const { view } = renderSight();
    await keepFrame();
    controls.sightFrame.mockClear();

    act(() => {
      useLiveVoiceStore.getState().setState("thinking");
    });
    act(() => {
      useLiveVoiceStore.getState().setState("speaking");
    });
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
  });
});

describe("useVoiceRoomSight: transport reconnect", () => {
  test("drops the pulse while no session is running", async () => {
    // A retryable close ends the server-side session while the logical call
    // survives the gap. The keep itself is in the transcript and stays there;
    // what comes off screen is the claim that a running session was just shown
    // this view.
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();
    await keepFrame();
    const held = view.result.current.heldFrame;
    const reset = watchGateReset();
    controls.sightFrame.mockClear();

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });

    expect(view.result.current.heldFrame).toBeNull();
    expect(revoke).toHaveBeenCalledWith(held!.previewUrl);
    // Nothing is said to a session that no longer exists, and the frame that
    // already landed is not this hook's to take back.
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    // Reset, so the reconnected session gets a frame as soon as the camera
    // settles rather than scoring against a baseline nobody can see.
    expect(reset).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });

  test("refuses a frame whose transport reconnected under the upload", async () => {
    // The generation survives a reconnect by design, so only the capture epoch
    // can refuse an upload that stalled across the gap and landed after the
    // fresh session was ready. Sending it would persist a view from seconds
    // before the drop as the current one.
    uploadsResolveImmediately = false;
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-gapped" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-gapped",
    );
  });

  test("shares the next keep with the reconnected session", async () => {
    const { view } = renderSight();
    await keepFrame();
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });

    await keepFrame();

    expect(controls.sightFrame).toHaveBeenLastCalledWith("att-2");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });

  test("coming back out of the gap clears nothing", async () => {
    // Only entering a reconnect means a session was replaced. The `ready` that
    // lowers the flag means the opposite, and a frame shared by then belongs
    // to the session that is now running.
    const { view } = renderSight();
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    await keepFrame();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });

    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
  });
});

describe("useVoiceRoomSight: closing and flipping", () => {
  test("clears the pulse when the viewfinder closes, and says nothing", async () => {
    // Closing has nothing to take back: every keep is already its own message
    // in the transcript, and the epoch is what stops the uploads still in
    // flight. All that comes down is the live pulse.
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();
    await keepFrame();
    const held = view.result.current.heldFrame;

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    expect(controls.sightFrame.mock.calls).toEqual([["att-1"]]);
    expect(view.result.current.heldFrame).toBeNull();
    expect(revoke).toHaveBeenCalledWith(held!.previewUrl);
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    revoke.mockRestore();
  });

  test("closing takes Live down, and reopening starts on photo", () => {
    const { view } = renderSight();
    expect(view.result.current.live).toBe(true);

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });
    expect(view.result.current.live).toBe(false);

    // The camera on screen is the consent, so the next time it comes up the
    // room asks again rather than resuming a stream nobody just asked for.
    act(() => {
      view.rerender({ cameraOpen: true, facing: "environment" });
    });
    expect(view.result.current.live).toBe(false);
  });

  test("says nothing when there was never anything shared", () => {
    const { view } = renderSight();

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("says nothing to the session when the room unmounts", async () => {
    const { view } = renderSight();
    await keepFrame();

    act(() => {
      view.unmount();
    });

    expect(controls.sightFrame.mock.calls).toEqual([["att-1"]]);
  });

  test("clears the pulse when the camera flips", async () => {
    // The frame on screen is the old camera's view, and the new camera's first
    // keep is an exposure warmup plus a rate floor away, so leaving it up would
    // show the user's own face as what the call is seeing of the room.
    const { view } = renderSight();
    await keepFrame();
    const reset = watchGateReset();

    act(() => {
      view.rerender({ cameraOpen: true, facing: "user" });
    });

    expect(controls.sightFrame.mock.calls).toEqual([["att-1"]]);
    expect(view.result.current.heldFrame).toBeNull();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("says nothing on the mount pass, where nothing is shared yet", () => {
    renderSight();

    expect(controls.sightFrame).not.toHaveBeenCalled();
  });

  test("says nothing about a session that is already over", async () => {
    // Ending a call unmounts the room, so this is the common path rather than
    // an edge. The successor must not be handed a frame from the call before
    // it, and nothing about the ended one is worth a warning.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { view } = renderSight();
    await keepFrame();

    act(() => {
      useLiveVoiceStore.getState().reset();
    });
    const successor = makeControlsSpies();
    act(() => {
      seedLiveVoiceSession("listening", {
        assistantId: ASSISTANT_ID,
        conversationId: "conv_next",
        controls: successor,
      });
    });
    act(() => {
      view.unmount();
    });

    expect(successor.sightFrame).not.toHaveBeenCalled();
    expect(controls.sightFrame.mock.calls).toEqual([["att-1"]]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("useVoiceRoomSight: the native preview", () => {
  /** Offer one kept frame to the running poll and settle the upload. */
  async function keepNativeFrame(bytes: number[]): Promise<Blob> {
    const sample = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
    await act(async () => {
      nativeSourceOptions?.onDecision(KEEP, performance.now(), sample);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return sample;
  }

  test("asks the bridge for a sample at the shared capture quality", async () => {
    renderSight({ nativePreview: true, live: true });

    await nativeSourceOptions!.captureSample();

    // Passed straight through from the camera module, so a Live keep and a
    // photo off the same camera are encoded alike.
    expect(captureNativeVoiceCameraSample).toHaveBeenCalledWith(
      NATIVE_CAPTURE_QUALITY,
    );
  });

  test("keeps the exact frame the gate judged", async () => {
    const createUrl = spyOn(URL, "createObjectURL");
    const { view } = renderSight({ nativePreview: true, live: true });

    await keepNativeFrame([9, 8, 7]);

    // One capture and not two: the bridge is asked once, and the frame the
    // transcript ends up with is the frame the decision was about.
    expect(captureVideoFrame).not.toHaveBeenCalled();
    const uploaded = uploadChatAttachment.mock.calls[0]?.[1];
    expect(uploaded?.type).toBe("image/jpeg");
    expect(new Uint8Array(await uploaded!.arrayBuffer())).toEqual(
      new Uint8Array([9, 8, 7]),
    );
    expect(controls.sightFrame.mock.calls).toEqual([["att-1"]]);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
    // The pulse is an object URL over those same bytes, given back by the same
    // `hold` the browser path uses.
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect((createUrl.mock.calls[0]?.[0] as File).size).toBe(3);
    createUrl.mockRestore();
  });

  test("shares nothing for a frame the gate skipped", async () => {
    renderSight({ nativePreview: true, live: true });

    await act(async () => {
      nativeSourceOptions?.onDecision(
        SKIP,
        performance.now(),
        new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The poll offers every frame it takes, kept or not, and only a keep costs
    // an upload.
    expect(uploadChatAttachment).not.toHaveBeenCalled();
    expect(controls.sightFrame).not.toHaveBeenCalled();
  });

  test("gives the pulse back when a newer keep replaces it", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight({ nativePreview: true, live: true });

    await keepNativeFrame([1, 2, 3]);
    const first = view.result.current.heldFrame!;
    await keepNativeFrame([4, 5, 6]);

    // Each preview holds a decoded frame alive, and a long call keeps one every
    // few seconds.
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
    expect(revoke).toHaveBeenCalledWith(first.previewUrl);
    revoke.mockRestore();
  });

  test("resets the gate when the native camera flips, and keeps polling", () => {
    const { view } = renderSight({ nativePreview: true, live: true });
    const reset = mock((_nowMs: number) => {});
    nativeSourceOptions!.gate.reset = reset;

    act(() => {
      view.rerender({
        cameraOpen: true,
        facing: "user",
        nativePreview: true,
      });
    });

    // The poll does not know which camera is behind the preview, so the reset
    // is the owner's to make. Nothing about the source itself changed.
    expect(reset).toHaveBeenCalledTimes(1);
    expect(nativeStop).not.toHaveBeenCalled();
  });

  test("backgrounding stops the poll, and coming back does not restart it", () => {
    const { view } = renderSight({ nativePreview: true, live: true });
    expect(nativeStart).toHaveBeenCalledTimes(1);

    act(() => {
      publish("app.hidden", { signal: "visibility" });
    });

    // The source watches no lifecycle of its own: the bus edge lowers the mode,
    // and lowering the mode is what stops it.
    expect(view.result.current.live).toBe(false);
    expect(nativeStop).toHaveBeenCalled();

    act(() => {
      publish("app.resume", { signal: "visibility" });
    });
    expect(nativeStart).toHaveBeenCalledTimes(1);
  });

  test("refuses a frame the poll offered after the app was put away", async () => {
    const { view } = renderSight({ nativePreview: true, live: true });

    // The bus edge and the stop are a commit apart, and a poll that is mid-tick
    // across that gap offers into it. The revocation is what closes it: it is
    // synchronous with the edge, and the capture path reads it first.
    publish("app.hidden", { signal: "visibility" });
    await keepNativeFrame([4]);

    expect(uploadChatAttachment).not.toHaveBeenCalled();
    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("stops the poll when the viewfinder closes", () => {
    const { view } = renderSight({ nativePreview: true, live: true });

    act(() => {
      view.rerender({
        cameraOpen: false,
        facing: "environment",
        nativePreview: true,
      });
    });

    expect(nativeStop).toHaveBeenCalled();
    expect(view.result.current.live).toBe(false);
  });
});

describe("useVoiceRoomSight: refusing the native sample a change caught in flight", () => {
  /**
   * The hook's half of the fix. The refusal itself is the source's, and its own
   * suite proves it: a sample invalidated mid-flight is never offered, and the
   * next tick still is. What can only be proved here is that the boundaries
   * reach the running poll at all, and that they reach nothing else.
   *
   * The seam exists because the epoch cannot cover this on its own. A capture
   * stamps itself when the gate KEEPS a frame, which on the native path is
   * after the bytes were taken, so a frame of the outgoing camera carries the
   * incoming camera's stamp and passes every guard on its way to the transcript.
   */
  test("tells the running poll when the camera flips", () => {
    const { view } = renderSight({ nativePreview: true, live: true });
    nativeInvalidate.mockClear();

    act(() => {
      view.rerender({
        cameraOpen: true,
        facing: "user",
        nativePreview: true,
      });
    });

    expect(nativeInvalidate).toHaveBeenCalledTimes(1);
    // Told, not restarted: the replacement camera is one tick away rather than
    // a whole interval, and the gate keeps the rate floor a rebuild would drop.
    expect(nativeStop).not.toHaveBeenCalled();
    expect(nativeStart).toHaveBeenCalledTimes(1);
  });

  test("tells the running poll when the transport reconnects", () => {
    renderSight({ nativePreview: true, live: true });
    nativeInvalidate.mockClear();

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });

    // The same hole, reached without a flip: the generation survives a
    // reconnect by design, so a sample from before the gap would be persisted
    // to the fresh session as the current view.
    expect(nativeInvalidate).toHaveBeenCalledTimes(1);
    expect(nativeStop).not.toHaveBeenCalled();
  });

  test("says nothing to a stopped poll", () => {
    const { view } = renderSight({ nativePreview: true, live: true });

    act(() => {
      view.result.current.setLive(false);
    });
    expect(nativeStop).toHaveBeenCalled();
    nativeInvalidate.mockClear();

    act(() => {
      view.rerender({
        cameraOpen: true,
        facing: "user",
        nativePreview: true,
      });
    });

    // A stopped source has already refused everything it held, and a reference
    // kept past the run would be one this hook could still reach into.
    expect(nativeInvalidate).not.toHaveBeenCalled();
  });

  test("says nothing on the browser path, which has nothing to refuse", () => {
    const { view } = renderSight({ live: true });
    nativeInvalidate.mockClear();

    act(() => {
      view.rerender({
        cameraOpen: true,
        facing: "user",
        nativePreview: false,
      });
    });

    // That sampler encodes its frame from the element at the moment of the
    // keep, so the picture and the decision are of the same camera.
    expect(nativeInvalidate).not.toHaveBeenCalled();
    expect(samplerStop).not.toHaveBeenCalled();
  });
});

/**
 * The frame for the question being asked.
 *
 * The gate keeps on its own schedule, and the daemon reads the conversation the
 * instant an utterance closes, so a question asked just after the camera moved
 * is answered about the scene before it. The moment the user starts speaking is
 * the only signal the client has for "this is the one", and these cover what it
 * is composed from, that it fires once per utterance, and that it reaches the
 * keep through the same path every other keep takes.
 */
describe("useVoiceRoomSight: a frame for the question being asked", () => {
  /** Put the session on the server VAD, which is where an utterance exists. */
  function goHandsFree(): void {
    act(() => {
      useLiveVoiceStore.getState().setHandsFree(true);
    });
  }

  function openUtterance(open: boolean): void {
    act(() => {
      useLiveVoiceStore.getState().setUtteranceOpen(open);
    });
  }

  test("arms the gate when a hands-free utterance opens", () => {
    goHandsFree();
    renderSight({ live: true });
    const armed = watchGateArm();

    openUtterance(true);

    expect(armed).toHaveBeenCalledTimes(1);
  });

  test("arms once per utterance, however the store is written to inside it", () => {
    goHandsFree();
    renderSight({ live: true });
    const armed = watchGateArm();

    openUtterance(true);
    // A mute and an unmute mid-sentence are two more writes this hook reads,
    // and neither is a new question.
    act(() => {
      useLiveVoiceStore.getState().setMuted(true);
    });
    act(() => {
      useLiveVoiceStore.getState().setMuted(false);
    });
    expect(armed).toHaveBeenCalledTimes(1);

    // The next utterance is a new question and gets its own frame.
    openUtterance(false);
    openUtterance(true);
    expect(armed).toHaveBeenCalledTimes(2);
  });

  test("arms when a manual session opens the user's turn", () => {
    // Push-to-talk has no VAD and no utterance: the session reaching
    // `listening` is where forwarding starts, which is the press.
    act(() => {
      useLiveVoiceStore.getState().setState("connecting");
    });
    renderSight({ live: true });
    const armed = watchGateArm();

    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    expect(armed).toHaveBeenCalledTimes(1);
  });

  test("arms nothing while the mic is muted", () => {
    goHandsFree();
    act(() => {
      useLiveVoiceStore.getState().setMuted(true);
    });
    renderSight({ live: true });
    const armed = watchGateArm();

    openUtterance(true);

    expect(armed).not.toHaveBeenCalled();
  });

  test("arms nothing once Live is off", () => {
    goHandsFree();
    const { view } = renderSight({ live: true });
    const armed = watchGateArm();

    act(() => {
      view.result.current.setLive(false);
    });
    openUtterance(true);

    // Nothing is sampling, so there is nothing for a keep to be made of and
    // no consent to make it under.
    expect(armed).not.toHaveBeenCalled();
  });

  test("asks the native poll for a sample instead of waiting for its tick", () => {
    goHandsFree();
    renderSight({ live: true, nativePreview: true });
    const armed = watchGateArm();

    openUtterance(true);

    expect(armed).toHaveBeenCalledTimes(1);
    expect(nativeSampleNow).toHaveBeenCalledTimes(1);
  });

  test("does not nudge a browser sampler, whose next frame is a moment away", () => {
    goHandsFree();
    renderSight({ live: true });

    openUtterance(true);

    expect(nativeSampleNow).not.toHaveBeenCalled();
  });

  test("does not arm for an utterance that was already open when Live began", () => {
    goHandsFree();
    openUtterance(true);

    renderSight({ live: true, nativePreview: true });

    // The ask happened before there was a camera streaming, and the fresh
    // gate's first keep covers that scene anyway.
    expect(nativeSampleNow).not.toHaveBeenCalled();
  });

  test("the forced keep travels the same path as every other one", async () => {
    goHandsFree();
    renderSight({ live: true });
    openUtterance(true);

    // The arm decides WHICH frame is kept; the keep itself is the sampler's
    // own decision callback, so consent, capture order, the upload and the
    // thumbnail are inherited rather than duplicated.
    await keepFrame();

    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);
  });
});
