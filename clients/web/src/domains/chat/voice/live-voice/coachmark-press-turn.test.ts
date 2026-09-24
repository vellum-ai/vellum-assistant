/**
 * A press on a pointed-at control becomes the user's turn on the running
 * call, cutting in on and kept past a reply in progress, and nothing at all
 * when there is no call to tell. On a share, the turn waits for a fresh frame
 * of the screen the press changed, taken a beat after it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  PRESS_FRAME_WAIT_MS,
  PRESS_SETTLE_MS,
  reportCoachmarkPressed,
} from "@/domains/chat/voice/live-voice/coachmark-press-turn";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst_press";
/** A dev build off `main` published after the `sight_frame` handler merged. */
const SUPPORTING_VERSION = "0.11.7-dev.202609010300.b432fb7";

const sendText = mock((_text: string, _options?: unknown) => true);

function registerStarter(): void {
  useLiveVoiceStore.getState().setStarter({
    prewarm: () => {},
    cancelPrewarm: () => {},
    start: () => {},
    sendText,
  });
}

/** A call on an assistant that takes frames, sharing a window. */
function startSharing(): void {
  registerStarter();
  const store = useLiveVoiceStore.getState();
  store.setSessionContext(ASSISTANT_ID, "conv_press");
  store.setState("speaking");
  useAssistantIdentityStore
    .getState()
    .setIdentity("assistant", SUPPORTING_VERSION, ASSISTANT_ID);
  store.setScreenShareTarget({ kind: "window", windowId: 7 });
}

/** Let real timers run for `ms`. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  sendText.mockClear();
  sendText.mockImplementation(() => true);
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("reportCoachmarkPressed", () => {
  test("puts the press to a running session as a turn that cuts in and is kept", async () => {
    registerStarter();
    useLiveVoiceStore.getState().setState("speaking");

    expect(await reportCoachmarkPressed("Share")).toBe(true);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [text, options] = sendText.mock.calls[0]!;
    expect(text).toContain("Share");
    expect(options).toEqual({ bargeIn: true, retryWhenBusy: true });
  });

  test("resolves real copy, not a key path", async () => {
    // A missing catalog entry makes `t` echo the key, which would ship
    // "chat:coachmarkPress.turn" to the assistant as the user's words.
    registerStarter();
    useLiveVoiceStore.getState().setState("listening");

    await reportCoachmarkPressed("Share");

    const [text] = sendText.mock.calls[0]!;
    expect(text).not.toContain("coachmarkPress");
    expect(text).not.toContain("{label}");
  });

  test("says nothing when no session is up", async () => {
    registerStarter();

    expect(await reportCoachmarkPressed("Share")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  test("reports a turn the session would not take", async () => {
    registerStarter();
    useLiveVoiceStore.getState().setState("listening");
    sendText.mockImplementation(() => false);

    expect(await reportCoachmarkPressed("Share")).toBe(false);
  });

  test("asks for no frame without a share", async () => {
    registerStarter();
    useLiveVoiceStore.getState().setState("speaking");
    const asked = useLiveVoiceStore.getState().screenFrameAsked;

    await reportCoachmarkPressed("Share");

    expect(useLiveVoiceStore.getState().screenFrameAsked).toBe(asked);
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

describe("reportCoachmarkPressed: on a share", () => {
  test("asks for the frame after the settle, and sends the turn only once it is in", async () => {
    startSharing();
    const asked = useLiveVoiceStore.getState().screenFrameAsked;

    const pressed = reportCoachmarkPressed("Share");

    // The click has not drawn yet: nothing is asked for, nothing is said.
    await wait(PRESS_SETTLE_MS / 2);
    expect(useLiveVoiceStore.getState().screenFrameAsked).toBe(asked);
    expect(sendText).not.toHaveBeenCalled();

    await wait(PRESS_SETTLE_MS / 2 + 50);
    const ask = useLiveVoiceStore.getState().screenFrameAsked;
    expect(ask).toBe(asked + 1);
    // Asked, not yet answered: the turn is still held.
    expect(sendText).not.toHaveBeenCalled();

    useLiveVoiceStore.getState().answerScreenFrame(ask);

    expect(await pressed).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![1]).toEqual({
      bargeIn: true,
      retryWhenBusy: true,
    });
  });

  test("goes without the frame once the share stops", async () => {
    startSharing();

    const pressed = reportCoachmarkPressed("Share");
    await wait(PRESS_SETTLE_MS + 50);
    expect(sendText).not.toHaveBeenCalled();

    useLiveVoiceStore.getState().setScreenShareTarget(null);

    expect(await pressed).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  test(
    "goes without the frame when it never comes",
    async () => {
      startSharing();

      const pressed = reportCoachmarkPressed("Share");

      expect(await pressed).toBe(true);
      expect(sendText).toHaveBeenCalledTimes(1);
    },
    PRESS_SETTLE_MS + PRESS_FRAME_WAIT_MS + 2000,
  );

  test("says nothing when the call ends while the frame is taken", async () => {
    startSharing();

    const pressed = reportCoachmarkPressed("Share");
    await wait(PRESS_SETTLE_MS + 50);
    useLiveVoiceStore.getState().reset();

    expect(await pressed).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  test("asks for no frame from an assistant that cannot take one", async () => {
    startSharing();
    useAssistantIdentityStore.getState().clearIdentity();
    const asked = useLiveVoiceStore.getState().screenFrameAsked;

    expect(await reportCoachmarkPressed("Share")).toBe(true);

    expect(useLiveVoiceStore.getState().screenFrameAsked).toBe(asked);
  });
});
