/**
 * Tests for `LiveVoiceButton`.
 *
 * The button is a purely presentational entry point: it forwards clicks to
 * the composer-bound `onStart`. Session lifecycle lives in the composer's
 * `useLiveVoice` controller, so there is nothing else to mock.
 *
 * Uses happy-dom via the bun:test preload configured in `web/bunfig.toml`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { LiveVoiceButton } from "@/domains/chat/components/live-voice-button";

const onStartSpy = mock(() => {});

beforeEach(() => {
  onStartSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("LiveVoiceButton", () => {
  test("renders a start control", () => {
    // WHEN the button renders
    const { getByLabelText } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // THEN it offers to start voice mode
    expect(getByLabelText("Start voice mode")).toBeTruthy();
  });

  test("fires onStart on click", () => {
    // GIVEN a rendered button
    const { getByLabelText } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // WHEN the user clicks it
    fireEvent.click(getByLabelText("Start voice mode"));

    // THEN the composer-bound start callback fires once
    expect(onStartSpy).toHaveBeenCalledTimes(1);
  });

  test("mobileRow renders the composer row's 40x40 circle with a 20px glyph", () => {
    // GIVEN the button in the mobile composer row
    const { getByLabelText } = render(
      <LiveVoiceButton onStart={onStartSpy} mobileRow />,
    );

    // THEN it is the design's filled circle, sized here rather than by the
    // primitive's own mobile growth, so every narrow window gets the same one
    const button = getByLabelText("Start voice mode");
    expect(button.className).toContain("h-10 w-10 rounded-full");
    expect(button.querySelector("span")?.className).toContain("[&_svg]:size-5");

    // WHILE the default leaves the primitive's sizing alone
    cleanup();
    const desktop = render(<LiveVoiceButton onStart={onStartSpy} />);
    const plain = desktop.getByLabelText("Start voice mode");
    expect(plain.className).not.toContain("h-10 w-10 rounded-full");
    expect(plain.className).toContain("touch-mobile:h-10");
  });

  test("prevents starting a session when disabled", () => {
    // GIVEN a button the parent has disabled
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
