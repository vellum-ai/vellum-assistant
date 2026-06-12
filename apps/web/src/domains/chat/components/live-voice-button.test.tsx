/**
 * Tests for `LiveVoiceButton`.
 *
 * The button is gated behind the `voice-mode` assistant flag and drives the
 * {@link useVoiceMode} conversation loop. We mock both so the component
 * renders in isolation: the flag store via a mutable `mockVoiceModeFlag`, and
 * `useVoiceMode` via spies for `activate`/`deactivate`/`interrupt` plus a
 * mutable `mockState`/`mockInputAmplitude`. The session-level store supplies
 * the `connecting` busy phase.
 *
 * Uses happy-dom via the bun:test preload configured in `web/bunfig.toml`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { VoiceModeState } from "@/domains/chat/voice/live-voice/voice-mode-store";

let mockVoiceModeFlag = false;
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => mockVoiceModeFlag,
    },
  },
}));

const activateSpy = mock(async () => {});
const deactivateSpy = mock(async () => {});
const interruptSpy = mock(() => {});
let mockState: VoiceModeState = "off";
let mockInputAmplitude = 0;
let lastVoiceModeOptions: { assistantId: string; conversationId?: string } | null =
  null;
mock.module("@/domains/chat/voice/live-voice/use-voice-mode", () => ({
  useVoiceMode: (options: { assistantId: string; conversationId?: string }) => {
    lastVoiceModeOptions = options;
    return {
      state: mockState,
      error: null,
      autoDeactivated: false,
      inputAmplitude: mockInputAmplitude,
      activate: activateSpy,
      deactivate: deactivateSpy,
      interrupt: interruptSpy,
    };
  },
}));

let mockSessionState: LiveVoiceSessionState = "idle";
mock.module("@/domains/chat/voice/live-voice/live-voice-store", () => ({
  useLiveVoiceStore: {
    use: {
      state: () => mockSessionState,
    },
  },
}));

// Imported after the mocks so the component picks up the mocked modules.
const { LiveVoiceButton } = await import(
  "@/domains/chat/components/live-voice-button"
);

beforeEach(() => {
  mockVoiceModeFlag = false;
  mockState = "off";
  mockSessionState = "idle";
  mockInputAmplitude = 0;
  lastVoiceModeOptions = null;
  activateSpy.mockClear();
  deactivateSpy.mockClear();
  interruptSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("LiveVoiceButton", () => {
  test("renders nothing when the voice-mode flag is off", () => {
    mockVoiceModeFlag = false;

    const { container } = render(<LiveVoiceButton assistantId="a1" />);

    expect(container.firstChild).toBeNull();
  });

  test("renders a start control when the flag is on and the mode is off", () => {
    mockVoiceModeFlag = true;
    mockState = "off";

    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" conversationId="c1" />,
    );

    const button = getByLabelText("Start voice mode");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // The conversation loop is parameterized with the composer's identifiers.
    expect(lastVoiceModeOptions).toEqual({
      assistantId: "a1",
      conversationId: "c1",
    });
  });

  test("activates the mode on click when off", () => {
    mockVoiceModeFlag = true;
    mockState = "off";
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    fireEvent.click(getByLabelText("Start voice mode"));

    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(interruptSpy).not.toHaveBeenCalled();
  });

  test("deactivates on click while listening", () => {
    mockVoiceModeFlag = true;
    mockState = "listening";
    mockSessionState = "listening";
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    const button = getByLabelText("Stop voice mode");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).not.toHaveBeenCalled();
    expect(interruptSpy).not.toHaveBeenCalled();
  });

  test("interrupts (not stops) on click while speaking", () => {
    // The LUM-1969 acceptance path: pressing the mic button mid-playback
    // stops playback and the mode goes back to listening.
    mockVoiceModeFlag = true;
    mockState = "speaking";
    mockSessionState = "speaking";
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    fireEvent.click(getByLabelText("Interrupt and speak"));

    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(activateSpy).not.toHaveBeenCalled();
  });

  test("reflects connecting as a busy, non-toggling state", () => {
    mockVoiceModeFlag = true;
    mockState = "listening"; // mode already on…
    mockSessionState = "connecting"; // …but the socket is still opening
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    const button = getByLabelText("Connecting voice mode") as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(activateSpy).not.toHaveBeenCalled();
    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(interruptSpy).not.toHaveBeenCalled();
  });

  test("stays stoppable when disabled while the mode is on", () => {
    mockVoiceModeFlag = true;
    mockState = "listening";
    mockSessionState = "listening";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" disabled />,
    );

    const button = getByLabelText("Stop voice mode") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  test("prevents activating when disabled while off", () => {
    mockVoiceModeFlag = true;
    mockState = "off";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" disabled />,
    );

    const button = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(activateSpy).not.toHaveBeenCalled();
    expect(deactivateSpy).not.toHaveBeenCalled();
  });

  test("scales the icon with live amplitude while active", () => {
    mockVoiceModeFlag = true;
    mockState = "listening";
    mockSessionState = "listening";
    mockInputAmplitude = 1;
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    const button = getByLabelText("Stop voice mode");
    expect(button.style.transform).toContain("scale(");
  });

  test("flag turning off mid-conversation deactivates the mode", () => {
    // GIVEN an active conversation whose voice-mode flag has just dropped
    // (flag refresh / dev toggle) — the component renders nothing, so the
    // user has no stop control left
    mockVoiceModeFlag = false;
    mockState = "listening";
    mockSessionState = "listening";

    // WHEN the button renders in that state
    const { container } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN it ends the conversation rather than stranding the loop + mic
    expect(container.firstChild).toBeNull();
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
  });
});
