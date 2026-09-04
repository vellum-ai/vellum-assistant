/**
 * The session's view of the shared screen: when a frame is taken, what it
 * becomes, and what stops the share.
 *
 * The helper, the resize and the upload are replaced (happy-dom has no helper
 * and no daemon, and each is covered by its own suite), so what is under test
 * is the cadence and the lifecycle: which store changes ask for a frame, which
 * frames reach the session, and every way the share is lowered.
 *
 * The store side is real, as in the room's sight suite: the ask is exercised
 * through the actual store, and a frame goes through the actual
 * `sendLiveVoiceSightFrame`.
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
import type {
  ScreenCaptureFrame,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

/** What the helper answers, swapped per case for the refusal path. */
let answerFrame: () => Promise<ScreenCaptureFrame | null> = async () => ({
  jpegBase64: btoa("jpeg"),
  width: 16,
  height: 9,
});
const captureCompanionScreen = mock((_target: WatchCaptureTarget) =>
  answerFrame(),
);
mock.module("@/runtime/companion-surface", () => ({
  captureCompanionScreen,
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

const { useLiveVoiceScreenShare, SCREEN_SHARE_MIN_FRAME_GAP_MS } =
  await import("./use-live-voice-screen-share");
const { useLiveVoiceStore } = await import("./live-voice-store");
const { makeControlsSpies, seedLiveVoiceSession } =
  await import("./live-voice-fakes.test-helper");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

const ASSISTANT_ID = "asst_share";
/** A dev build off `main` published after the `sight_frame` handler merged. */
const SUPPORTING_VERSION = "0.11.7-dev.202609010300.b432fb7";
const WINDOW: WatchCaptureTarget = { kind: "window", windowId: 7 };

let controls = makeControlsSpies();
let warn: ReturnType<typeof spyOn> | null = null;
/** The clock the frame floor is measured on, advanced by hand. */
let now = 0;
let clock: ReturnType<typeof spyOn> | null = null;

/** Let a capture, its upload and the send behind them settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function share(target: WatchCaptureTarget | null): void {
  act(() => {
    useLiveVoiceStore.getState().setScreenShareTarget(target);
  });
}

/** Open or close the user's turn, the way the server VAD does hands-free. */
function speak(open: boolean): void {
  now += SCREEN_SHARE_MIN_FRAME_GAP_MS + 1;
  act(() => {
    useLiveVoiceStore.getState().setUtteranceOpen(open);
  });
}

function renderShare() {
  return renderHook(() => useLiveVoiceScreenShare());
}

beforeEach(() => {
  captureCompanionScreen.mockClear();
  uploadChatAttachment.mockClear();
  deleteChatAttachment.mockClear();
  answerFrame = async () => ({
    jpegBase64: btoa("jpeg"),
    width: 16,
    height: 9,
  });
  autoUploadId = 0;
  now = 0;
  clock = spyOn(performance, "now").mockImplementation(() => now);
  warn = spyOn(console, "warn").mockImplementation(() => {});
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore
    .getState()
    .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);
  controls = makeControlsSpies();
  seedLiveVoiceSession("listening", {
    assistantId: ASSISTANT_ID,
    conversationId: "conv_share",
    controls,
  });
  useLiveVoiceStore.getState().setHandsFree(true);
  useAssistantIdentityStore
    .getState()
    .setIdentity("assistant", SUPPORTING_VERSION, ASSISTANT_ID);
});

afterEach(() => {
  cleanup();
  clock?.mockRestore();
  warn?.mockRestore();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useLiveVoiceScreenShare: starting", () => {
  test("takes no frame until something is shared", async () => {
    renderShare();
    await flush();
    expect(captureCompanionScreen).not.toHaveBeenCalled();
  });

  test("takes a frame of the target at once, uploads it against the session's assistant, and sends it", async () => {
    renderShare();
    share(WINDOW);
    await flush();

    expect(captureCompanionScreen).toHaveBeenCalledWith(WINDOW);
    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(uploadChatAttachment.mock.calls[0]?.[0]).toBe(ASSISTANT_ID);
    const file = uploadChatAttachment.mock.calls[0]?.[1];
    expect(file?.type).toBe("image/jpeg");
    expect(await file?.text()).toBe("jpeg");
    expect(controls.sightFrame).toHaveBeenCalledWith("att-1");
  });

  test("takes nothing for an assistant that predates the frame", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.11.6", ASSISTANT_ID);
    renderShare();
    share(WINDOW);
    await flush();
    expect(captureCompanionScreen).not.toHaveBeenCalled();
  });

  test("takes nothing with no session for the frames to land in", async () => {
    useLiveVoiceStore.getState().setState("idle");
    renderShare();
    share(WINDOW);
    await flush();
    expect(captureCompanionScreen).not.toHaveBeenCalled();
  });

  test("a new target is a new share, framed at once", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    share({ kind: "display", displayId: 2 });
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);
    expect(captureCompanionScreen.mock.calls[1]?.[0]).toEqual({
      kind: "display",
      displayId: 2,
    });
  });
});

describe("useLiveVoiceScreenShare: cadence", () => {
  test("takes a frame as the user starts talking and another as they stop", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);

    speak(true);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);

    speak(false);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(3);
    expect(controls.sightFrame.mock.calls.map(([id]) => id)).toEqual([
      "att-1",
      "att-2",
      "att-3",
    ]);
  });

  test("takes no second frame inside the floor", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    act(() => {
      useLiveVoiceStore.getState().setUtteranceOpen(true);
    });
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  test("takes nothing on an edge the store merely rewrote", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    now += SCREEN_SHARE_MIN_FRAME_GAP_MS + 1;
    act(() => {
      useLiveVoiceStore.getState().setInputAmplitude(0.3);
    });
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  test("takes nothing for an edge on a muted microphone", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    act(() => {
      useLiveVoiceStore.getState().setMuted(true);
    });
    speak(true);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  test("reads the turn off the session state in push-to-talk", async () => {
    useLiveVoiceStore.getState().setHandsFree(false);
    useLiveVoiceStore.getState().setState("thinking");
    renderShare();
    share(WINDOW);
    await flush();
    now += SCREEN_SHARE_MIN_FRAME_GAP_MS + 1;
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);
  });
});

describe("useLiveVoiceScreenShare: stopping", () => {
  test("a frame the helper could not take lowers the share", async () => {
    answerFrame = async () => null;
    renderShare();
    share(WINDOW);
    await flush();

    expect(uploadChatAttachment).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a frame in flight when the share stops is refused, and its upload given back", async () => {
    renderShare();
    share(WINDOW);
    // The stop lands while the frame is still on its way up.
    share(null);
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
  });

  test("takes nothing more once the share is off", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    share(null);
    speak(true);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  test("the session ending takes the share with it", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    act(() => {
      useLiveVoiceStore.getState().reset();
    });
    expect(useLiveVoiceStore.getState().screenShareTarget).toBeNull();
  });
});

describe("useLiveVoiceScreenShare: the boundary a frame in flight can cross", () => {
  /**
   * A reconnect keeps the share and the session generation on purpose, and
   * `connecting` still reads as a live session, so nothing tears this run
   * down. What must not survive is a frame of the view from before the drop.
   */
  test("a frame captured before a reconnect is refused, and the share goes on", async () => {
    let releaseFrame!: (frame: ScreenCaptureFrame) => void;
    answerFrame = () =>
      new Promise<ScreenCaptureFrame>((resolve) => {
        releaseFrame = resolve;
      });
    renderShare();
    share(WINDOW);
    await Promise.resolve();

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    releaseFrame({ jpegBase64: btoa("jpeg"), width: 16, height: 9 });
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    // The share itself is untouched: the socket came back, and the next thing
    // the user says is framed as usual.
    expect(useLiveVoiceStore.getState().screenShareTarget).toEqual(WINDOW);
    answerFrame = async () => ({
      jpegBase64: btoa("jpeg"),
      width: 16,
      height: 9,
    });
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });
    speak(true);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledWith("att-2");
  });
});
