/**
 * Tests for `LiveVoiceButton`.
 *
 * The button is a purely presentational entry point: it self-gates on the
 * `voice-mode` assistant flag (mocked via a mutable `mockVoiceMode`) and
 * forwards clicks to the composer-bound `onStart`. Session lifecycle lives in
 * the composer's `useLiveVoice` controller, so there is nothing else to mock.
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

let mockVoiceMode = false;
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => mockVoiceMode,
    },
  },
}));

// Imported after the mocks so the component picks up the mocked modules.
const { LiveVoiceButton } = await import(
  "@/domains/chat/components/live-voice-button"
);

const onStartSpy = mock(() => {});

beforeEach(() => {
  mockVoiceMode = false;
  onStartSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("LiveVoiceButton", () => {
  test("renders nothing when the voice-mode flag is off", () => {
    // GIVEN the voice-mode flag is disabled
    mockVoiceMode = false;

    // WHEN the button renders
    const { container } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // THEN nothing is painted
    expect(container.firstChild).toBeNull();
  });

  test("renders a start control when the flag is on", () => {
    // GIVEN the flag is enabled
    mockVoiceMode = true;

    // WHEN the button renders
    const { getByLabelText } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // THEN it offers to start voice mode
    expect(getByLabelText("Start voice mode")).toBeTruthy();
  });

  test("fires onStart on click", () => {
    // GIVEN a flag-enabled button
    mockVoiceMode = true;
    const { getByLabelText } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // WHEN the user clicks it
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the composer-bound start callback fires once
    expect(onStartSpy).toHaveBeenCalledTimes(1);
  });

  test("prevents starting a session when disabled", () => {
    // GIVEN a flag-enabled button that the parent has disabled
    mockVoiceMode = true;
    const { getByLabelText } = render(
      <LiveVoiceButton onStart={onStartSpy} disabled />,
    );

    // THEN the start control is disabled
    const button = getByLabelText("Start voice mode") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // WHEN the user clicks it, no session is started
    fireEvent.click(button);
    expect(onStartSpy).not.toHaveBeenCalled();
  });
});
