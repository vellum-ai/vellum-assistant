/**
 * The session's view of the shared screen: when a frame is taken, which of
 * them are worth sending, what a sent frame becomes, and what stops the share.
 *
 * The helper, the decode, the resize and the upload are replaced (happy-dom
 * has no helper, no daemon and no picture decoder, and each is covered by its
 * own suite), so what is under test is the cadence and the lifecycle: which
 * store changes ask for a frame, which of those the gate lets through, which
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
import {
  FRAME_GATE_FORCED_KEEP_TTL_MS,
  FRAME_GRID_CELLS,
  type FrameGrid,
} from "@/lib/camera/frame-gate";
import type {
  ScreenCaptureFrame,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

/**
 * A frame of a named view, as the helper would answer. The "JPEG" is the
 * view's name: the decode is replaced below by one that reads the name back,
 * so a test says what is on screen by naming it.
 */
function frameOf(view: string): ScreenCaptureFrame {
  return { jpegBase64: btoa(view), width: 16, height: 9 };
}

/**
 * What the gate reads off a frame, made from the view's name rather than
 * decoded from pixels.
 *
 * Three names are three views the gate scores as wholly different from each
 * other (past the ambient bar), and a name with a `+` on it is that view with
 * a small change in it: past the bar a question lowers the gate to, and short
 * of the ambient one. The same name is the same picture, byte for byte, which
 * is what a screen capture of an unchanged screen is.
 */
function gridFor(view: string): FrameGrid {
  const grid = new Uint8Array(FRAME_GRID_CELLS);
  const name = view.replace("+", "");
  for (let i = 0; i < FRAME_GRID_CELLS; i++) {
    const lit =
      name === "b"
        ? i % 4 < 2
        : name === "c"
          ? i < FRAME_GRID_CELLS / 2
          : i % 2 === 0;
    grid[i] = lit ? 220 : 40;
  }
  if (view.endsWith("+")) {
    for (let i = 0; i < 40; i++) {
      grid[i] = grid[i] === 220 ? 40 : 220;
    }
  }
  return grid;
}

/** What the helper answers, swapped per case for the refusal path. */
let answerFrame: () => Promise<ScreenCaptureFrame | null> = async () =>
  frameOf("a");
/** Put a view on the shared screen. */
function show(view: string): void {
  answerFrame = async () => frameOf(view);
}
const captureCompanionScreen = mock((_target: WatchCaptureTarget) =>
  answerFrame(),
);
/**
 * What the shell is told reached the call, recorded rather than sent. The
 * acknowledgement is what lets main admit the assistant's own marks against
 * a surface, so which targets arrive here, and whether one arrives at all
 * when a frame fails, is the part worth pinning.
 */
const sharedFrames: WatchCaptureTarget[] = [];
const reportCompanionSharedFrame = mock((target: WatchCaptureTarget) => {
  sharedFrames.push(target);
});
mock.module("@/runtime/companion-surface", () => ({
  captureCompanionScreen,
  reportCompanionSharedFrame,
}));

/**
 * The drawing, recorded rather than done: happy-dom decodes no JPEG and paints
 * no canvas, and what the marks look like on a frame is
 * `annotate-shared-frame.test.ts`'s subject. What matters here is which frames
 * carry marks at all.
 */
const annotated: number[] = [];
mock.module("@/domains/chat/voice/live-voice/annotate-shared-frame", () => ({
  annotateSharedFrame: async (file: File, strokes: readonly unknown[]) => {
    annotated.push(strokes.length);
    return file;
  },
}));

mock.module("@/lib/camera/still-frame-grid", () => ({
  stillFrameGrid: async (bytes: Uint8Array) =>
    gridFor(new TextDecoder().decode(bytes)),
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

const { useLiveVoiceScreenShare } =
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
/** The colour the frame's window drew the marks in. */
const INK = "#a78bfa";
/** A mark around the middle of whatever is shared. */
const CIRCLE = {
  points: [
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.4 },
    { x: 0.6, y: 0.6 },
    { x: 0.4, y: 0.6 },
  ],
};

let controls = makeControlsSpies();
let warn: ReturnType<typeof spyOn> | null = null;
/** The clock the gate is stamped from, advanced by hand. */
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
  act(() => {
    useLiveVoiceStore.getState().setUtteranceOpen(open);
  });
}

function renderShare() {
  return renderHook(() => useLiveVoiceScreenShare());
}

/**
 * Hold the next upload open, and hand back what finishes or fails it. For
 * the cases where something lands while a frame is on its way up.
 */
function holdNextUpload(): { finish: () => void; fail: () => void } {
  let resolveUpload!: (result: UploadAttachmentResult) => void;
  // Numbered when the upload starts, as the ordinary mock numbers its own,
  // so a held upload keeps its place among the ones that overtake it.
  let id = "";
  uploadChatAttachment.mockImplementationOnce(
    () =>
      new Promise<UploadAttachmentResult>((resolve) => {
        autoUploadId += 1;
        id = `att-${autoUploadId}`;
        resolveUpload = resolve;
      }),
  );
  return {
    finish: () => resolveUpload({ ok: true, id }),
    fail: () => resolveUpload({ ok: false, status: 500, error: {} }),
  };
}

beforeEach(() => {
  annotated.length = 0;
  sharedFrames.length = 0;
  captureCompanionScreen.mockClear();
  reportCompanionSharedFrame.mockClear();
  uploadChatAttachment.mockClear();
  deleteChatAttachment.mockClear();
  show("a");
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
    expect(await file?.text()).toBe("a");
    // The gate's own word for it, so the daemon's log reads the same for a
    // screen as for a camera.
    expect(controls.sightFrame).toHaveBeenCalledWith(
      "att-1",
      expect.objectContaining({ reason: "first" }),
    );
  });

  /**
   * The shell admits the assistant's own marks against a surface only once a
   * frame of it has reached the call, so the acknowledgement has to follow the
   * send rather than the capture.
   */
  test("tells the shell the surface reached the call, after it was sent", async () => {
    renderShare();
    share(WINDOW);
    await flush();

    expect(controls.sightFrame).toHaveBeenCalledWith(
      "att-1",
      expect.objectContaining({ reason: "first" }),
    );
    expect(sharedFrames).toEqual([WINDOW]);
  });

  /**
   * A frame the helper never produced was never shown, so nothing may be
   * acknowledged for it: the guard it opens would be admitting marks against
   * a picture the call does not have.
   */
  test("acknowledges nothing when no frame could be taken", async () => {
    answerFrame = async () => null;
    renderShare();
    share(WINDOW);
    await flush();

    expect(sharedFrames).toEqual([]);
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
  test("asks the helper as the user starts talking and again as they stop", async () => {
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
  });

  /**
   * The double frame: an utterance about an unchanged screen used to cost a
   * frame at each edge, two of one view a few seconds apart. Both edges are
   * still asked for, and the gate sends neither.
   */
  test("sends nothing for either edge of a question about an unchanged screen", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    speak(true);
    speak(false);
    await flush();

    expect(captureCompanionScreen).toHaveBeenCalledTimes(3);
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);
  });

  /**
   * The start edge is the frame the turn reads, and a question changes what
   * a frame is worth: a view that differs from the last keep by less than the
   * ambient bar is still the view the question is about.
   */
  test("sends the view a question starts on when it changed, at the question's bar", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    show("a+");
    speak(true);
    await flush();

    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-2",
      expect.objectContaining({ reason: "forced" }),
    );
  });

  /**
   * The same change, on an edge with no question behind it: the ask's window
   * has run out by the time the user stops, and a small change is not news at
   * the ambient bar. A whole new view is.
   */
  test("judges the stop edge at the ambient bar once the question's window has passed", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    speak(true);
    await flush();
    now += FRAME_GATE_FORCED_KEEP_TTL_MS + 1;

    show("a+");
    speak(false);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);

    show("b");
    speak(true);
    speak(false);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-2",
      expect.objectContaining({ reason: "forced" }),
    );
  });

  test("sends the view the user left behind for the turn after", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    speak(true);
    await flush();
    now += FRAME_GATE_FORCED_KEEP_TTL_MS + 1;
    show("c");
    speak(false);
    await flush();

    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-2",
      expect.objectContaining({ reason: "novel" }),
    );
  });

  /**
   * The picture the gate judges is the one the helper took for the edge, and
   * the picture it sends is the same bytes: a keep is not a second capture.
   */
  test("uploads the frame it judged, not a fresh one", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    show("b");
    speak(true);
    await flush();

    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);
    const file = uploadChatAttachment.mock.calls[1]?.[1];
    expect(await file?.text()).toBe("b");
  });

  /**
   * A frame the gate cannot read is not sent on faith: sending unjudged is
   * the second frame of one view this file exists to stop.
   */
  test("sends nothing it could not judge", async () => {
    answerFrame = async () => ({
      jpegBase64: "not base64!",
      width: 16,
      height: 9,
    });
    renderShare();
    share(WINDOW);
    await flush();

    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
    expect(uploadChatAttachment).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().screenShareTarget).toEqual(WINDOW);
  });

  test("takes nothing on an edge the store merely rewrote", async () => {
    renderShare();
    share(WINDOW);
    await flush();
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
    show("b");
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
  });
});

/**
 * A drawing is the one frame here the user asks for by hand, and the cadence
 * has to get out of its way in both directions: nothing while the mark is
 * being made, and one the instant it is finished.
 */
describe("useLiveVoiceScreenShare: a mark drawn on the shared surface", () => {
  const draw = (): void => {
    act(() => {
      useLiveVoiceStore.getState().setShareAnnotation("drawing", [], INK);
    });
  };
  const release = (): void => {
    act(() => {
      useLiveVoiceStore
        .getState()
        .setShareAnnotation("released", [CIRCLE], INK);
    });
  };
  /** The layer letting go on the user's behalf: the mode went off mid-stroke. */
  const abandon = (): void => {
    act(() => {
      useLiveVoiceStore.getState().setShareAnnotation("released", [], INK);
    });
  };

  test("holds every frame for as long as the hand is down", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    speak(true);
    speak(false);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  test("takes one the moment the hand comes off", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    release();
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);
    // And the frame says it was the mark's, so the daemon's log can tell a
    // drawn frame from the cadence's.
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-2",
      expect.objectContaining({ reason: "drawing" }),
    );
  });

  /**
   * The overlay the user drew on is never in the pixels, so the frame that
   * carries the mark is the one the marks were drawn onto here. A frame the
   * cadence took carries none, which is what makes this worth pinning: the
   * two paths share a capture and differ only in this.
   */
  test("draws the marks onto the frame that carries them, and only that one", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    // A frame the cadence took is never handed to the drawing at all: there
    // is nothing to draw, and decoding and re-encoding it to draw nothing
    // would cost a picture's worth of work per frame.
    expect(annotated).toEqual([]);
    draw();
    release();
    await flush();
    expect(annotated).toEqual([1]);
  });

  /**
   * The gate turns away a view the call already has. A mark is a deliberate
   * act the user has just watched themselves make, and refusing it because
   * the screen under it has not changed would drop the thing they pointed
   * at.
   */
  test("is not judged by the gate the cadence obeys", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    release();
    await flush();
    draw();
    release();
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(3);
    expect(controls.sightFrame).toHaveBeenCalledTimes(3);
  });

  /**
   * The call was given the drawn frame, so that is the view the next frame
   * is judged against. Without this a screen that changed under the mark
   * would be sent again, plain, on the next thing the user said.
   */
  test("is what the cadence's next frame is judged against", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    show("b");
    draw();
    release();
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);

    speak(true);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(3);
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
  });

  test("goes back to the ordinary cadence once the hand is off", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    release();
    await flush();
    speak(true);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(3);
  });

  /**
   * The marks are long since faded off the user's screen by the time a new
   * run mounts, so a frame taken for them would be of a surface with nothing
   * on it, arriving in the transcript as a second copy of a view already sent.
   */
  test("does not redraw a mark left in the store by an earlier run", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    release();
    await flush();
    captureCompanionScreen.mockClear();
    // The share moving to another target is what tears the run down and
    // starts a new one over the same store.
    share({ kind: "display", displayId: 2 });
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  /**
   * The layer sends a release carrying nothing when it goes away mid-stroke,
   * so the hold is lifted for a hand that is no longer down. It is not a
   * drawing: a frame taken for it would be of a surface with nothing on it,
   * for a mark the user never finished.
   */
  test("an abandoned stroke lifts the hold without costing a frame", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    abandon();
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
    expect(useLiveVoiceStore.getState().shareDrawing).toBe(false);

    speak(true);
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);
  });

  /**
   * The marks are counted rather than compared, and the count starts again
   * from one whenever the store clears it, so the first mark after a
   * reconnect wears the same id as the last one before it. What keeps that
   * from reading as a mark already sent is that a reconnect takes the session
   * to `idle` and this run down with it, so the run that meets the new mark
   * has never seen the old id. That is behaviour of `reset`, a floor above
   * this file, which is what makes it worth pinning here.
   */
  test("still sends the first mark drawn after a reconnect", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    release();
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(2);

    act(() => {
      useLiveVoiceStore.getState().reset({ sessionContinues: true });
    });
    seedLiveVoiceSession("listening", {
      assistantId: ASSISTANT_ID,
      conversationId: "conv_share",
      controls,
    });
    share(WINDOW);
    await flush();
    captureCompanionScreen.mockClear();

    draw();
    release();
    await flush();
    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
  });

  /** A share that ends takes the drawing on it with it. */
  test("a stop clears the hand as well as the target", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    draw();
    share(null);
    expect(useLiveVoiceStore.getState().shareDrawing).toBe(false);
    expect(useLiveVoiceStore.getState().shareAnnotation).toBeNull();
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
    const upload = holdNextUpload();
    renderShare();
    share(WINDOW);
    await flush();
    // The stop lands while the frame is still on its way up.
    share(null);
    upload.finish();
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
  });

  /**
   * Earlier on the same path: the helper has not answered yet. The picture is
   * of what the user has just stopped showing, so it is not judged, and a
   * frame the gate never saw is not one it thinks the call has.
   */
  test("a frame the helper is still taking when the share stops is never judged", async () => {
    let releaseFrame!: (frame: ScreenCaptureFrame) => void;
    answerFrame = () =>
      new Promise<ScreenCaptureFrame>((resolve) => {
        releaseFrame = resolve;
      });
    renderShare();
    share(WINDOW);
    await Promise.resolve();
    share(null);
    releaseFrame(frameOf("a"));
    await flush();

    expect(uploadChatAttachment).not.toHaveBeenCalled();
    expect(controls.sightFrame).not.toHaveBeenCalled();
  });

  /**
   * The edge was queued while the helper was still answering for the share
   * start. By the time its turn comes the share is off, and a frame of a
   * surface the user has stopped showing is not taken even to be thrown
   * away.
   */
  test("an edge queued behind a slow capture never asks the helper once the share is off", async () => {
    let releaseFrame!: (frame: ScreenCaptureFrame) => void;
    answerFrame = () =>
      new Promise<ScreenCaptureFrame>((resolve) => {
        releaseFrame = resolve;
      });
    renderShare();
    share(WINDOW);
    await Promise.resolve();
    speak(true);
    share(null);
    releaseFrame(frameOf("a"));
    await flush();

    expect(captureCompanionScreen).toHaveBeenCalledTimes(1);
    expect(uploadChatAttachment).not.toHaveBeenCalled();
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

/**
 * The gate moves its baseline when a frame is judged, and the upload behind
 * the frame can still fail. What the gate judges against has to be what the
 * call was given, or a view it never saw is turned away as one it has.
 */
describe("useLiveVoiceScreenShare: a keep that never arrives", () => {
  const failNextUpload = (): void => {
    uploadChatAttachment.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      error: {},
    }));
  };

  test("the first frame failing does not leave the call judged to have the view", async () => {
    failNextUpload();
    renderShare();
    share(WINDOW);
    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();

    // Same screen. With the lost frame still the baseline this would be
    // `answered` and the call would go without a picture until the heartbeat.
    speak(true);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-1",
      expect.objectContaining({ reason: "forced" }),
    );
  });

  test("a later frame failing puts the gate back to the last one delivered", async () => {
    renderShare();
    share(WINDOW);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);

    failNextUpload();
    show("b");
    speak(true);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(1);

    // The view the call has is still the first one, so the view it was not
    // given is news at the ambient bar, on an edge with no question behind
    // it.
    now += FRAME_GATE_FORCED_KEEP_TTL_MS + 1;
    speak(false);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-2",
      expect.objectContaining({ reason: "novel" }),
    );
  });

  /**
   * A send waits its turn behind older captures, and the capture resolves
   * before the turn comes. A frame that is merely waiting is not a frame
   * that was lost, and the gate must go on judging against it: put back to
   * the view before it, the same screen would be sent again as new.
   */
  test("a frame parked behind a slower upload is not taken for lost", async () => {
    const first = holdNextUpload();
    renderShare();
    share(WINDOW);
    await flush();
    // The question's frame uploads at once and waits behind the first.
    show("b");
    speak(true);
    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();

    first.finish();
    await flush();
    expect(controls.sightFrame.mock.calls.map(([id]) => id)).toEqual([
      "att-1",
      "att-2",
    ]);

    // The call has the second view, and nothing has changed since.
    now += FRAME_GATE_FORCED_KEEP_TTL_MS + 1;
    speak(false);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
  });

  /**
   * The gate was put back to the last delivered frame when a newer one was
   * lost, and a frame older than the lost one was still waiting its turn.
   * When that one lands it is the newest view the call has, and the gate
   * has to come up to it rather than stay on the older view.
   */
  test("a parked frame that lands after a newer one was lost becomes the baseline", async () => {
    const first = holdNextUpload();
    renderShare();
    share(WINDOW);
    await flush();
    show("b");
    speak(true);
    await flush();
    // A third view, lost, while the first two are still on their way.
    now += FRAME_GATE_FORCED_KEEP_TTL_MS + 1;
    const third = holdNextUpload();
    show("c");
    speak(false);
    await flush();
    third.fail();
    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();

    first.finish();
    await flush();
    expect(controls.sightFrame.mock.calls.map(([id]) => id)).toEqual([
      "att-1",
      "att-2",
    ]);

    // The second view is what the call has, so a question about it is
    // answered already, and one about the lost third view is not.
    show("b");
    speak(true);
    speak(false);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(2);
    show("c");
    speak(true);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledTimes(3);
    expect(controls.sightFrame).toHaveBeenLastCalledWith(
      "att-4",
      expect.objectContaining({ reason: "forced" }),
    );
  });
});

/**
 * Occasions are judged in the order they came, and an ask belongs to the
 * occasion it came with. A second question starting while the first's
 * picture still waits its turn must not take the first's ask off the gate.
 */
describe("useLiveVoiceScreenShare: two questions in the queue", () => {
  test("each question's frame is judged at its own ask", async () => {
    let releaseFirst!: (frame: ScreenCaptureFrame) => void;
    answerFrame = () =>
      new Promise<ScreenCaptureFrame>((resolve) => {
        releaseFirst = resolve;
      });
    renderShare();
    share(WINDOW);
    await Promise.resolve();
    // The pictures are taken in turn, so the helper answers each occasion
    // in order: the first question starts on a modest change, the user
    // stops on the same view, and a second question starts on a new one,
    // all while the share-start picture is still coming.
    const answers = ["a+", "a+", "b"];
    answerFrame = async () => frameOf(answers.shift() ?? "b");
    speak(true);
    speak(false);
    speak(true);
    await flush();
    expect(controls.sightFrame).not.toHaveBeenCalled();

    releaseFirst(frameOf("a"));
    await flush();
    // The first question's frame is kept at the question's bar, its stop
    // edge is the same view, and the second question's frame is new.
    const uploaded = await Promise.all(
      uploadChatAttachment.mock.calls.map(([, file]) => file.text()),
    );
    expect(uploaded).toEqual(["a", "a+", "b"]);
  });
});

describe("useLiveVoiceScreenShare: the boundary a frame in flight can cross", () => {
  /**
   * A reconnect keeps the share and the session generation on purpose, and
   * `connecting` still reads as a live session, so nothing tears this run
   * down. What must not survive is a frame of the view from before the drop.
   */
  test("a frame uploading across a reconnect is refused, and the share goes on", async () => {
    const upload = holdNextUpload();
    renderShare();
    share(WINDOW);
    await flush();

    act(() => {
      useLiveVoiceStore.getState().setReconnecting(true);
    });
    upload.finish();
    await flush();

    expect(controls.sightFrame).not.toHaveBeenCalled();
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    // The share itself is untouched: the socket came back, and the next thing
    // the user says is framed as usual. The refused frame never reached the
    // transcript, so the resumed session is given the view afresh: the
    // question's ask keeps it, where a view the call already had would have
    // been `answered` and gone nowhere.
    expect(useLiveVoiceStore.getState().screenShareTarget).toEqual(WINDOW);
    act(() => {
      useLiveVoiceStore.getState().setReconnecting(false);
    });
    speak(true);
    await flush();
    expect(controls.sightFrame).toHaveBeenCalledWith(
      "att-2",
      expect.objectContaining({ reason: "forced" }),
    );
  });

  test("a frame the helper is still taking at a reconnect is never judged", async () => {
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
    releaseFrame(frameOf("a"));
    await flush();

    expect(uploadChatAttachment).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().screenShareTarget).toEqual(WINDOW);
  });
});
