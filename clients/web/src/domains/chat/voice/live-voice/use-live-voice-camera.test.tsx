/**
 * The session's own camera: when it opens, what it samples, and what closes it.
 *
 * The stream, the sampler, the encoder, the resize and the upload are all
 * replaced. None of them can do its real work here (happy-dom has no camera,
 * no video decode, no canvas readback and no daemon), and each is covered by
 * its own suite, so what is under test is the lifecycle: which conditions open
 * the camera, what the control is told, which frames reach the session, and
 * every way the camera is released.
 *
 * The store side is real, as in the room's sight suite: the ask and the fact
 * are exercised through the actual store, and a kept frame goes through the
 * actual `sendLiveVoiceSightFrame`.
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

/** The camera the browser hands back, with a track whose stop can be seen. */
const trackStop = mock(() => {});
/** A real `EventTarget` so a test can fire `ended` the way a track would. */
type FakeVideoTrack = EventTarget & { stop: () => void };
/** The track behind the most recently created stream, for firing `ended`. */
let lastTrack: FakeVideoTrack | null = null;
function cameraStream(): MediaStream {
  const track = Object.assign(new EventTarget(), {
    stop: trackStop,
  }) as FakeVideoTrack;
  lastTrack = track;
  const stream = new MediaStream();
  Object.defineProperties(stream, {
    getTracks: { value: () => [track] },
    getVideoTracks: { value: () => [track] },
  });
  return stream;
}

/** What `getUserMedia` answers. Swapped per case for the refusal paths. */
let answerStream: () => Promise<MediaStream> = async () => cameraStream();
const requestVideoStream = mock((_facing: "user" | "environment") =>
  answerStream(),
);
const captureVideoFrame = mock(
  async (_video: HTMLVideoElement, filename: string) =>
    new File([new Uint8Array([1, 2, 3])], filename, { type: "image/jpeg" }),
);
mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  requestVideoStream,
  captureVideoFrame,
  classifyVoiceCameraError: (cause: unknown) =>
    cause instanceof DOMException && cause.name === "NotAllowedError"
      ? "permission-denied"
      : "unknown",
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

let autoUploadId = 0;
const uploadChatAttachment = mock(
  (_assistantId: string, _file: File): Promise<UploadAttachmentResult> => {
    autoUploadId += 1;
    return Promise.resolve({ ok: true, id: `att-${autoUploadId}` });
  },
);
const deleteChatAttachment = mock(
  async (_assistantId: string, _attachmentId: string) => true,
);
mock.module("@/domains/chat/api/messages", () => ({
  uploadChatAttachment,
  deleteChatAttachment,
}));

const { useLiveVoiceCamera } = await import("./use-live-voice-camera");
const { useLiveVoiceStore } = await import("./live-voice-store");
const { makeControlsSpies, seedLiveVoiceSession } =
  await import("./live-voice-fakes.test-helper");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

const ASSISTANT_ID = "asst_camera";
/** A dev build off `main` published after the `sight_frame` handler merged. */
const SUPPORTING_VERSION = "0.11.7-dev.202609010300.b432fb7";

const KEEP = {
  keep: true,
  reason: "novel" as const,
  motion: null,
  novelty: 0.9,
  detail: 40,
};

let controls = makeControlsSpies();
let warn: ReturnType<typeof spyOn> | null = null;

/** Let the camera request, the play, and any capture behind them settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function ask(requested: boolean): void {
  act(() => {
    useLiveVoiceStore.getState().setCameraRequested(requested);
  });
}

/** Mount the hook, with a session and an assistant that understands the frame. */
function renderCamera() {
  return renderHook(() => useLiveVoiceCamera());
}

const realPlay = HTMLMediaElement.prototype.play;

beforeEach(() => {
  samplerOptions = null;
  samplerStart.mockClear();
  samplerStop.mockClear();
  trackStop.mockClear();
  lastTrack = null;
  requestVideoStream.mockClear();
  captureVideoFrame.mockClear();
  uploadChatAttachment.mockClear();
  deleteChatAttachment.mockClear();
  answerStream = async () => cameraStream();
  autoUploadId = 0;
  // happy-dom's element has no playback to speak of, and the hook awaits the
  // play before it samples.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  warn = spyOn(console, "warn").mockImplementation(() => {});
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore
    .getState()
    .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);
  controls = makeControlsSpies();
  seedLiveVoiceSession("listening", {
    assistantId: ASSISTANT_ID,
    conversationId: "conv_camera",
    controls,
  });
  useAssistantIdentityStore
    .getState()
    .setIdentity("assistant", SUPPORTING_VERSION, ASSISTANT_ID);
});

afterEach(() => {
  cleanup();
  HTMLMediaElement.prototype.play = realPlay;
  warn?.mockRestore();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useLiveVoiceCamera: opening", () => {
  test("opens nothing until asked", async () => {
    renderCamera();
    await flush();

    expect(requestVideoStream).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
  });

  test("opens the front camera on the ask and samples it by the display", async () => {
    renderCamera();
    ask(true);
    await flush();

    expect(requestVideoStream).toHaveBeenCalledWith("user");
    expect(samplerStart).toHaveBeenCalledTimes(1);
    expect(samplerOptions?.pacing).toBe("display");
    // The element the sampler reads is the stream's, and nobody's child: no
    // viewfinder is on screen.
    const video = samplerStart.mock.calls[0]?.[0];
    expect(video?.srcObject).toBeInstanceOf(MediaStream);
    expect(video?.isConnected).toBe(false);
  });

  test("reads as on only once frames flow", async () => {
    renderCamera();
    ask(true);
    // The ask alone is not the fact: the stream is still being requested.
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
    await flush();

    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(true);
  });

  test("opens nothing for an assistant that predates the frame", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.11.6", ASSISTANT_ID);
    renderCamera();
    ask(true);
    await flush();

    expect(requestVideoStream).not.toHaveBeenCalled();
  });

  test("opens nothing with no session for the frames to land in", async () => {
    useLiveVoiceStore.getState().setState("idle");
    renderCamera();
    ask(true);
    await flush();

    expect(requestVideoStream).not.toHaveBeenCalled();
  });

  test("a refused camera lowers the ask, so the control reads as off", async () => {
    answerStream = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
    renderCamera();
    ask(true);
    await flush();

    expect(samplerStart).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().cameraRequested).toBe(false);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a camera that never plays lowers the ask instead of reading as on", async () => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException("no decoder", "NotSupportedError"));
    renderCamera();
    ask(true);
    await flush();

    expect(samplerStart).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().cameraRequested).toBe(false);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
    expect(trackStop).toHaveBeenCalledTimes(1);
  });
});

describe("useLiveVoiceCamera: a kept frame", () => {
  test("is uploaded against the session's assistant and sent as a sight frame", async () => {
    renderCamera();
    ask(true);
    await flush();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
    expect(uploadChatAttachment.mock.calls[0]?.[0]).toBe(ASSISTANT_ID);
    expect(controls.sightFrame).toHaveBeenCalledWith("att-1");
  });

  test("is refused, and its upload given back, when the camera closed under it", async () => {
    renderCamera();
    ask(true);
    await flush();

    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    // The stop lands while the frame is still encoding.
    ask(false);
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
  });
});

describe("useLiveVoiceCamera: releasing", () => {
  async function opened() {
    const view = renderCamera();
    ask(true);
    await flush();
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(true);
    return view;
  }

  test("closes when the ask is taken back", async () => {
    await opened();
    ask(false);
    await flush();

    expect(samplerStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
  });

  test("closes when the session ends, and the ask goes with it", async () => {
    await opened();
    act(() => {
      useLiveVoiceStore.getState().reset();
    });
    await flush();

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().cameraRequested).toBe(false);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
  });

  test("closes when the assistant refuses the frame for the session", async () => {
    await opened();
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
    });
    await flush();

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
  });

  test("closes on unmount, which is the chat layout going away", async () => {
    const view = await opened();
    view.unmount();

    expect(samplerStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
  });

  test("closes when the track ends externally (unplugged, permission revoked)", async () => {
    await opened();
    act(() => {
      lastTrack?.dispatchEvent(new Event("ended"));
    });
    await flush();

    expect(useLiveVoiceStore.getState().cameraRequested).toBe(false);
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  test("closes a stream that arrives after the ask was taken back", async () => {
    let handBack: (stream: MediaStream) => void = () => undefined;
    answerStream = () =>
      new Promise((resolve) => {
        handBack = resolve;
      });
    renderCamera();
    ask(true);
    await flush();
    ask(false);
    await act(async () => {
      handBack(cameraStream());
    });
    await flush();

    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(samplerStart).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().cameraStreaming).toBe(false);
  });
});
