/**
 * Sight in the voice room: when it samples, what it parks, and what it takes
 * back.
 *
 * The sampler, the encoder, the resize and the upload are all replaced. None of
 * them can do its real work here (happy-dom has no video decode, no canvas
 * readback and no daemon), and each is covered by its own suite, so what is
 * under test is the wiring between them: which conditions open the camera path,
 * which frame reaches the session's slot, and which are refused on the way.
 *
 * The store side is real. The generation rules are the whole reason a frame
 * cannot be sent from a callback, so they are exercised through the actual
 * `attachLiveVoiceFrame` rather than around it.
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
/** Any dev build after 0.11.7 stable clears the `attach_frame` gate. */
const SUPPORTING_VERSION = "0.11.7-dev.202608301412.b432fb7";

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

  test("samples nothing against an assistant that predates the frame", () => {
    // 0.11.7 stable has no `attach_frame` handler, so every parked frame would
    // come back as the error the transport reads as a settings rejection.
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.11.7", ASSISTANT_ID);

    renderSight();

    expect(samplerStart).not.toHaveBeenCalled();
  });
});

describe("useVoiceRoomSight: parking a keep", () => {
  test("uploads a kept frame and parks it on the session at once", async () => {
    const { view } = renderSight();

    await keepFrame();

    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(controls.attachFrame).toHaveBeenCalledWith("att-1");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-1");
    // The daemon owns a frame that reached its slot and reclaims it there.
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("ignores frames the gate skipped", async () => {
    const { view } = renderSight();

    act(() => {
      samplerOptions?.onDecision(SKIP, performance.now());
    });
    await flush();

    expect(captureVideoFrame).not.toHaveBeenCalled();
    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("the newest keep replaces the one before it, and gives its preview back", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();

    await keepFrame();
    const first = view.result.current.heldFrame;
    expect(first?.attachmentId).toBe("att-1");

    await keepFrame();

    expect(controls.attachFrame).toHaveBeenNthCalledWith(2, "att-2");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
    expect(revoke).toHaveBeenCalledWith(first!.previewUrl);
    revoke.mockRestore();
  });

  test("shows nothing it could not park", async () => {
    // A reconnect gap: the id never reached the session, so the thumbnail must
    // not claim the call can see it.
    controls.attachFrame.mockImplementation(() => false);
    const { view } = renderSight();

    await keepFrame();

    expect(controls.attachFrame).toHaveBeenCalledWith("att-1");
    expect(view.result.current.heldFrame).toBeNull();
    // The daemon never saw this id, so nothing there will ever collect it.
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
  });

  test("an upload that resolves late does not displace a newer frame", async () => {
    // Two keeps in flight is the case the capture-time comparison exists for:
    // resolve order is not capture order, and the slower upload is not the
    // newer view. Parking the older one would point the session's slot
    // backwards.
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

    expect(controls.attachFrame.mock.calls).toEqual([["att-newer"]]);
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-newer");
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-older",
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

    expect(successor.attachFrame).not.toHaveBeenCalled();
    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-orphan",
    );
  });

  test("refuses a frame whose camera closed under the upload", async () => {
    // The session is untouched, so only the capture epoch can tell that this
    // frame is a view of something nobody is looking at any more.
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

    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-closed",
    );
  });

  test("refuses a frame whose camera flipped under the upload", async () => {
    // A flip keeps the same element and the same session, and points somewhere
    // else entirely: a rear-camera frame must not be parked as the front
    // camera's view.
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

    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-rear");
  });
});

describe("useVoiceRoomSight: transport reconnect", () => {
  test("drops the held frame the dead session took with it", async () => {
    // A retryable close ends the server-side session, whose own close reclaims
    // the parked frame, while the logical call survives the gap. The fresh
    // session's slot is empty and the id being held is a row the daemon has
    // already deleted.
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();
    await keepFrame();
    const held = view.result.current.heldFrame;
    const reset = watchGateReset();
    controls.attachFrame.mockClear();

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });

    expect(view.result.current.heldFrame).toBeNull();
    expect(revoke).toHaveBeenCalledWith(held!.previewUrl);
    // Nothing to unpark on a session that no longer exists, and re-parking a
    // deleted id would earn the refusal it deserves.
    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    // Reset, so the reconnected session gets a frame as soon as the camera
    // settles rather than scoring against a baseline nobody can see.
    expect(reset).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });

  test("refuses a frame whose transport reconnected under the upload", async () => {
    // The generation survives a reconnect by design and nothing is held to
    // outrank a late resolve, so only the capture epoch can refuse an upload
    // that stalled across the gap and landed after the fresh session was
    // ready. Parking it would stage a view from seconds before the drop.
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

    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
    expect(deleteChatAttachment).toHaveBeenCalledWith(
      ASSISTANT_ID,
      "att-gapped",
    );
  });

  test("parks the next keep on the reconnected session", async () => {
    const { view } = renderSight();
    await keepFrame();
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });

    await keepFrame();

    expect(controls.attachFrame).toHaveBeenLastCalledWith("att-2");
    expect(view.result.current.heldFrame?.attachmentId).toBe("att-2");
  });

  test("coming back out of the gap clears nothing", async () => {
    // Only entering a reconnect means a session was replaced. The `ready` that
    // lowers the flag means the opposite, and a frame parked by then belongs
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

describe("useVoiceRoomSight: unparking", () => {
  test("clears the session's slot when the viewfinder closes", async () => {
    const revoke = spyOn(URL, "revokeObjectURL");
    const { view } = renderSight();
    await keepFrame();
    const held = view.result.current.heldFrame;

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    // Without this the frame from a camera the user put away would still ride
    // whatever they say next.
    expect(controls.attachFrame).toHaveBeenLastCalledWith(null);
    expect(view.result.current.heldFrame).toBeNull();
    expect(revoke).toHaveBeenCalledWith(held!.previewUrl);
    // The daemon reclaims what it unparks; deleting here would race it.
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    revoke.mockRestore();
  });

  test("says nothing when there was never anything parked", () => {
    const { view } = renderSight();

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    expect(controls.attachFrame).not.toHaveBeenCalled();
    expect(view.result.current.heldFrame).toBeNull();
  });

  test("clears the slot when the room unmounts", async () => {
    const { view } = renderSight();
    await keepFrame();

    act(() => {
      view.unmount();
    });

    expect(controls.attachFrame).toHaveBeenLastCalledWith(null);
  });

  test("clears the slot when the camera flips", async () => {
    // The parked frame is the old camera's view, and the new camera's first
    // keep is an exposure warmup plus a rate floor away, so leaving it staged
    // would let a turn carry the view the user just turned away from.
    const { view } = renderSight();
    await keepFrame();
    const reset = watchGateReset();

    act(() => {
      view.rerender({ cameraOpen: true, facing: "user" });
    });

    expect(controls.attachFrame).toHaveBeenLastCalledWith(null);
    expect(view.result.current.heldFrame).toBeNull();
    expect(reset).toHaveBeenCalledTimes(1);
    // The daemon reclaims what it unparks.
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("says nothing on the mount pass, where nothing is parked yet", () => {
    renderSight();

    expect(controls.attachFrame).not.toHaveBeenCalled();
  });

  test("says nothing about a session that is already over", async () => {
    // Ending a call unmounts the room, so this is the common path rather than
    // an edge. The successor must not be told to clear a slot it never filled,
    // and a session whose own close reclaims the frame is not a failed unpark
    // worth reporting.
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

    expect(successor.attachFrame).not.toHaveBeenCalled();
    expect(controls.attachFrame.mock.calls).toEqual([["att-1"]]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("reports an unpark the transport could not take", async () => {
    // The reconnect gap: the session is the one that parked the frame, so the
    // slot really is still full and the frame really will ride the next turn.
    // Nothing can be done about it here, but it is not silent.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    controls.attachFrame.mockImplementation(
      (attachmentId: string | null) => attachmentId !== null,
    );
    const { view } = renderSight();
    await keepFrame();

    act(() => {
      view.rerender({ cameraOpen: false, facing: "environment" });
    });

    expect(controls.attachFrame).toHaveBeenLastCalledWith(null);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
