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
import { act, cleanup, renderHook } from "@testing-library/react";

import type { UploadAttachmentResult } from "@/domains/chat/api/messages";
import type { FrameSamplerOptions } from "@/lib/camera/frame-sampler";

let samplerOptions: FrameSamplerOptions | null = null;
const samplerStart = mock((_video: HTMLVideoElement) => {});
const samplerStop = mock(() => {});
mock.module("@/lib/camera/frame-sampler", () => ({
  createFrameSampler: (options: FrameSamplerOptions) => {
    samplerOptions = options;
    return { start: samplerStart, stop: samplerStop };
  },
}));

const captureVideoFrame = mock(
  async (_video: HTMLVideoElement, filename: string) =>
    new File([new Uint8Array([1, 2, 3])], filename, { type: "image/jpeg" }),
);
mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  captureVideoFrame,
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

const { useVoiceRoomSight } = await import("./use-voice-room-sight");
const { useLiveVoiceStore } =
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

function renderSight(
  options: {
    cameraOpen?: boolean;
    assistantId?: string | null;
    facing?: "environment" | "user";
  } = {},
) {
  const video = document.createElement("video");
  const videoRef = { current: video };
  const view = renderHook(
    ({
      cameraOpen,
      facing,
    }: {
      cameraOpen: boolean;
      facing: "environment" | "user";
    }) =>
      useVoiceRoomSight(
        options.assistantId === undefined ? ASSISTANT_ID : options.assistantId,
        videoRef,
        { cameraOpen, facing },
      ),
    {
      initialProps: {
        cameraOpen: options.cameraOpen ?? true,
        facing: options.facing ?? ("environment" as const),
      },
    },
  );
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

beforeEach(() => {
  samplerOptions = null;
  samplerStart.mockClear();
  samplerStop.mockClear();
  captureVideoFrame.mockClear();
  uploadChatAttachment.mockClear();
  deleteChatAttachment.mockClear();
  pendingUploads = [];
  autoUploadId = 0;
  uploadsResolveImmediately = true;
  useLiveVoiceStore.getState().reset();
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
  test("samples the room's viewfinder while the camera is open", () => {
    const { video } = renderSight();

    expect(samplerStart).toHaveBeenCalledTimes(1);
    expect(samplerStart.mock.calls[0]?.[0]).toBe(video);
  });

  test("stops when the viewfinder closes", () => {
    const { view } = renderSight();
    expect(samplerStart).toHaveBeenCalledTimes(1);

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    expect(samplerStop).toHaveBeenCalled();
  });

  test("samples nothing with the camera closed", () => {
    renderSight({ cameraOpen: false });

    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("samples nothing while the vision-mode flag is off", () => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ visionMode: "off" }, null);

    renderSight();

    expect(samplerStart).not.toHaveBeenCalled();
  });

  test("samples nothing against the release that predates the frame", () => {
    // 0.11.7 was cut before the handler existed, so every keep would come back
    // as the error the transport reads as a settings rejection.
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.11.7", ASSISTANT_ID);

    renderSight();

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

    renderSight();

    expect(samplerStart).not.toHaveBeenCalled();
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

  test("shares both keeps when their uploads resolve out of order", async () => {
    // Nothing is staged and nothing is latest-wins, so the slower upload is
    // not a loser to be dropped: it is a frame the call saw, and the
    // transcript's order is the order the frames landed in.
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

    await act(async () => {
      pendingUploads[1]!({ ok: true, id: "att-newer" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      pendingUploads[0]!({ ok: true, id: "att-older" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controls.sightFrame.mock.calls).toEqual([
      ["att-newer"],
      ["att-older"],
    ]);
    // The pulse follows resolve order too, so it can briefly show the older of
    // two frames that overlapped. Accepted: the gate's rate floor puts keeps
    // seconds apart, and the correction is the next keep.
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-older");
    expect(deleteChatAttachment).not.toHaveBeenCalled();
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
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("gives back the upload the refusal stranded", async () => {
    const { view } = renderSight();
    await keepFrame();

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    // Nothing was shared, so the pulse has no honest version to keep showing.
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("the sampler keeps running while the session is latched", async () => {
    renderSight();
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });

    expect(samplerStop).not.toHaveBeenCalled();
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

  test("leaves the pulse alone while a newer keep is outstanding", async () => {
    // The error names no attachment, so this could be either keep, and the
    // ordinary reading is the older one. The surface already shows the newer.
    const { view } = renderSight();
    await keepFrame();
    await keepFrame();
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
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
