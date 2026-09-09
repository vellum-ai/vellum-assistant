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

import {
  MOBILE_CONTROL_CLASS,
  MOBILE_GLYPH_CLASS,
} from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import { LiveVoiceButton } from "@/domains/chat/components/live-voice-button";
import { HoverCapabilityOverride } from "@vellumai/design-library/utils/hover-capability";

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
    expect(button.className).toContain(MOBILE_CONTROL_CLASS);
    expect(button.querySelector("span")?.className).toContain(
      MOBILE_GLYPH_CLASS,
    );

    // WHILE the default leaves the primitive's sizing alone
    cleanup();
    const desktop = render(<LiveVoiceButton onStart={onStartSpy} />);
    const plain = desktop.getByLabelText("Start voice mode");
    expect(plain.className).not.toContain(MOBILE_CONTROL_CLASS);
    expect(plain.className).toContain("touch-mobile:h-10");
  });

  test("holdComposerFocus holds the composer's focus through the press", () => {
    // GIVEN the button in the focus-gated row, on a press that would not carry
    // focus to it
    const { getByLabelText } = render(
      <LiveVoiceButton onStart={onStartSpy} mobileRow holdComposerFocus />,
    );
    const button = getByLabelText("Start voice mode");

    // THEN `pointerdown` runs untouched: WebKit drops the rest of the tap's
    // sequence, `click` included, when it is cancelled
    expect(fireEvent.pointerDown(button)).toBe(true);

    // WHILE `mousedown` is cancelled, since that is the press that would blur
    // the textarea, collapse the focus-gated row and move this circle out from
    // under the finger before the click arrives
    expect(fireEvent.mouseDown(button)).toBe(false);

    // AND the click still starts the session
    fireEvent.click(button);
    expect(onStartSpy).toHaveBeenCalledTimes(1);
  });

  test("leaves the press alone by default, mobile row or not", () => {
    // GIVEN the desktop presentation, which gates no row on focus
    const { getByLabelText } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // THEN the press behaves as the platform intends
    expect(fireEvent.mouseDown(getByLabelText("Start voice mode"))).toBe(true);

    // AND the row's chrome alone does not cancel it: a window dragged narrow
    // takes the row with a pointing device still driving it, and that device
    // focuses the button it presses. Cancelling there would take the focus the
    // button is owed and buy nothing, since the row never drops.
    cleanup();
    const narrow = render(<LiveVoiceButton onStart={onStartSpy} mobileRow />);
    expect(fireEvent.mouseDown(narrow.getByLabelText("Start voice mode"))).toBe(
      true,
    );
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

/**
 * The hover label. The glyph alone does not separate a spoken conversation
 * from the dictation mic beside it, so the label carries the explanation
 * while the control keeps its own accessible name.
 */
describe("LiveVoiceButton hover label", () => {
  test("opens the tooltip on focus, where the device can hover", async () => {
    // GIVEN a hover-capable device
    const { getByLabelText, findAllByText } = render(
      <HoverCapabilityOverride hoverCapable>
        <LiveVoiceButton onStart={onStartSpy} />
      </HoverCapabilityOverride>,
    );

    // WHEN the control takes focus
    fireEvent.focus(getByLabelText("Start voice mode"));

    // THEN the label says what the mode is for, not what the button is called
    expect(
      (await findAllByText("Talk out loud with voice mode")).length,
    ).toBeGreaterThan(0);
  });

  test("carries no native title, so the OS tooltip cannot double it", () => {
    // WHEN the button renders
    const { getByLabelText } = render(<LiveVoiceButton onStart={onStartSpy} />);

    // THEN the only label is the design library's
    expect(getByLabelText("Start voice mode").hasAttribute("title")).toBe(
      false,
    );
  });

  test("stays out of the tree where the device cannot hover", () => {
    // GIVEN a device with no hover
    const { getByLabelText, queryByText } = render(
      <HoverCapabilityOverride hoverCapable={false}>
        <LiveVoiceButton onStart={onStartSpy} />
      </HoverCapabilityOverride>,
    );

    // WHEN the control takes focus, which a tap hands out on such a device
    fireEvent.focus(getByLabelText("Start voice mode"));

    // THEN nothing is stranded over the control
    expect(queryByText("Talk out loud with voice mode")).toBeNull();
  });
});
