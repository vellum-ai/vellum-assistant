/**
 * The switch that turns the voice key's start confirmation back on after
 * "Always start". Drives the real device setting through `localStorage`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { VoiceStartConfirmationToggle } from "@/domains/settings/pages/voice-start-confirmation-toggle";
import { getDeviceBool, setDeviceBool } from "@/utils/device-settings";

const LABEL = "Ask before starting a voice chat";

function toggle() {
  return screen.getByRole("switch", { name: LABEL });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("VoiceStartConfirmationToggle", () => {
  test("is on while nothing has been stored", () => {
    render(<VoiceStartConfirmationToggle />);

    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText(
        "Double-tapping the voice key shows a confirmation first.",
      ),
    ).toBeTruthy();
  });

  test("is off once Always start was chosen", () => {
    setDeviceBool("voiceStartConfirmationSkipped", true);

    render(<VoiceStartConfirmationToggle />);

    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  test("turning it on clears the opt-out, and off stores it again", () => {
    setDeviceBool("voiceStartConfirmationSkipped", true);
    render(<VoiceStartConfirmationToggle />);

    fireEvent.click(toggle());
    expect(getDeviceBool("voiceStartConfirmationSkipped", true)).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle());
    expect(getDeviceBool("voiceStartConfirmationSkipped", false)).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  test("follows Always start chosen on the companion while it is open", () => {
    render(<VoiceStartConfirmationToggle />);
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    act(() => {
      setDeviceBool("voiceStartConfirmationSkipped", true);
    });

    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });
});
