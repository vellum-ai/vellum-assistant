/**
 * A press on a pointed-at control becomes the user's turn on the running
 * call, cutting in on and kept past a reply in progress, and nothing at all
 * when there is no call to tell.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { reportCoachmarkPressed } from "@/domains/chat/voice/live-voice/coachmark-press-turn";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";

const sendText = mock((_text: string, _options?: unknown) => true);

function registerStarter(): void {
  useLiveVoiceStore.getState().setStarter({
    prewarm: () => {},
    cancelPrewarm: () => {},
    start: () => {},
    sendText,
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  sendText.mockClear();
  sendText.mockImplementation(() => true);
});

describe("reportCoachmarkPressed", () => {
  test("puts the press to a running session as a turn that cuts in and is kept", () => {
    registerStarter();
    useLiveVoiceStore.getState().setState("speaking");

    expect(reportCoachmarkPressed("Share")).toBe(true);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [text, options] = sendText.mock.calls[0]!;
    expect(text).toContain("Share");
    expect(options).toEqual({ bargeIn: true, retryWhenBusy: true });
  });

  test("resolves real copy, not a key path", () => {
    // A missing catalog entry makes `t` echo the key, which would ship
    // "chat:coachmarkPress.turn" to the assistant as the user's words.
    registerStarter();
    useLiveVoiceStore.getState().setState("listening");

    reportCoachmarkPressed("Share");

    const [text] = sendText.mock.calls[0]!;
    expect(text).not.toContain("coachmarkPress");
    expect(text).not.toContain("{label}");
  });

  test("says nothing when no session is up", () => {
    registerStarter();

    expect(reportCoachmarkPressed("Share")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  test("reports a turn the session would not take", () => {
    registerStarter();
    useLiveVoiceStore.getState().setState("listening");
    sendText.mockImplementation(() => false);

    expect(reportCoachmarkPressed("Share")).toBe(false);
  });
});
