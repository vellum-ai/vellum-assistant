/**
 * Tests for `LiveVoiceButton`.
 *
 * The button is gated behind the `voice-mode` assistant flag and toggles a
 * {@link useLiveVoice} session. We mock both so the component renders in
 * isolation: the flag store via a mutable `mockVoiceMode`, and `useLiveVoice`
 * via spies for `start`/`stop` plus a mutable `mockState`/`mockInputAmplitude`.
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

let mockVoiceMode = false;
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => mockVoiceMode,
    },
  },
}));

const startSpy = mock(
  async (
    _assistantId: string,
    _conversationId?: string,
    _options?: { handsFree?: boolean },
  ) => {},
);
const stopSpy = mock(async () => {});
let mockState: LiveVoiceSessionState = "idle";
let mockInputAmplitude = 0;
mock.module("@/domains/chat/voice/live-voice/use-live-voice", () => ({
  useLiveVoice: () => ({
    state: mockState,
    partialTranscript: "",
    finalTranscript: "",
    assistantTranscript: "",
    inputAmplitude: mockInputAmplitude,
    error: null,
    start: startSpy,
    stop: stopSpy,
  }),
}));

// Imported after the mocks so the component picks up the mocked modules.
const { LiveVoiceButton } = await import(
  "@/domains/chat/components/live-voice-button"
);

beforeEach(() => {
  mockVoiceMode = false;
  mockState = "idle";
  mockInputAmplitude = 0;
  startSpy.mockClear();
  stopSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("LiveVoiceButton", () => {
  test("renders nothing when the voice-mode flag is off", () => {
    // GIVEN the voice-mode flag is disabled
    mockVoiceMode = false;

    // WHEN the button renders
    const { container } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN nothing is painted
    expect(container.firstChild).toBeNull();
  });

  test("renders a start control when the flag is on and idle", () => {
    // GIVEN the flag is enabled and no session is active
    mockVoiceMode = true;
    mockState = "idle";

    // WHEN the button renders
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN it offers to start voice mode and is not pressed
    const button = getByLabelText("Start voice mode");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("starts a hands-free session on click when idle", () => {
    // GIVEN an idle, flag-enabled button with a conversation
    mockVoiceMode = true;
    mockState = "idle";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" conversationId="c1" />,
    );

    // WHEN the user clicks it
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN it starts a hands-free live-voice session for the assistant +
    // conversation (manual mode survives only as the version-skew fallback)
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith("a1", "c1", { handsFree: true });
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("stops the session on click when active", () => {
    // GIVEN an active session (listening)
    mockVoiceMode = true;
    mockState = "listening";
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN the control reflects the live session
    const button = getByLabelText("Stop voice mode");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    // WHEN the user clicks it
    fireEvent.click(button);

    // THEN it stops the session
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("reflects connecting as a busy, non-toggling state", () => {
    // GIVEN a session that is still connecting
    mockVoiceMode = true;
    mockState = "connecting";
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN the control is busy and disabled
    const button = getByLabelText("Connecting live voice") as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    // WHEN the user clicks it, neither start nor stop fire
    fireEvent.click(button);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("stays stoppable when disabled while a session is active", () => {
    // GIVEN an active session and a parent that has raised `disabled`
    mockVoiceMode = true;
    mockState = "listening";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" disabled />,
    );

    // THEN the stop control remains enabled despite the external disabled prop
    const button = getByLabelText("Stop voice mode") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // WHEN the user clicks it, the session is stopped
    fireEvent.click(button);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("prevents starting a session when disabled while idle", () => {
    // GIVEN an idle, flag-enabled button that the parent has disabled
    mockVoiceMode = true;
    mockState = "idle";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" disabled />,
    );

    // THEN the start control is disabled
    const button = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // WHEN the user clicks it, no session is started
    fireEvent.click(button);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("scales the icon with live amplitude while active", () => {
    // GIVEN an active session with non-zero mic amplitude
    mockVoiceMode = true;
    mockState = "listening";
    mockInputAmplitude = 1;
    const { getByLabelText } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN the control carries an amplitude-driven transform
    const button = getByLabelText("Stop voice mode");
    expect(button.style.transform).toContain("scale(");
  });
});
