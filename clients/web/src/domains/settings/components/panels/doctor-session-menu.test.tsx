/**
 * Tests for the Doctor header's overflow menu.
 *
 * The presentation is resolved inside the design library from a media query, so
 * these tests drive `window.matchMedia` rather than stubbing a hook: a stubbed
 * hook would pass while the real primitive read something else. The menu is
 * rendered open, since what is under test is the command set each surface
 * produces, not the trigger.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const TOUCH_SURFACE_QUERY = "(width < 48rem) and (pointer: coarse)";

function stubMatchMedia(touchSurface: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query === TOUCH_SURFACE_QUERY ? touchSurface : !touchSurface,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const { DoctorSessionMenu } = await import(
  "@/domains/settings/components/panels/doctor-session-menu"
);

const MENU_NAME = "Session options";

afterEach(() => {
  cleanup();
});

describe("DoctorSessionMenu on a pointer surface", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  test("shows one labelled trigger and no commands until it is opened", () => {
    render(
      <DoctorSessionMenu
        onShareFeedback={() => {}}
        onCopySession={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: MENU_NAME })).toBeTruthy();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  test("holds both commands behind that trigger", () => {
    render(
      <DoctorSessionMenu
        defaultOpen
        onShareFeedback={() => {}}
        onCopySession={() => {}}
      />,
    );

    expect(screen.getByRole("menu", { name: MENU_NAME })).toBeTruthy();
    for (const name of ["Share Feedback", "Copy Session"]) {
      expect(screen.getAllByRole("menuitem", { name })).toHaveLength(1);
    }
  });

  test("selecting a command runs it", () => {
    const onShareFeedback = mock();
    const onCopySession = mock();
    render(
      <DoctorSessionMenu
        defaultOpen
        onShareFeedback={onShareFeedback}
        onCopySession={onCopySession}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Share Feedback" }));

    expect(onShareFeedback).toHaveBeenCalledTimes(1);
    expect(onCopySession).not.toHaveBeenCalled();
  });

  // A session that has produced no transcript has nothing to copy, and a
  // client with no platform behind it has nowhere to send feedback.
  test("omits the command the caller did not supply", () => {
    render(<DoctorSessionMenu defaultOpen onCopySession={() => {}} />);

    expect(screen.queryByRole("menuitem", { name: "Share Feedback" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Copy Session" })).toBeTruthy();
  });

  test("renders nothing when neither command is available", () => {
    const { container } = render(<DoctorSessionMenu />);

    expect(container.innerHTML).toBe("");
  });
});

describe("DoctorSessionMenu on a touch surface", () => {
  beforeEach(() => {
    stubMatchMedia(true);
  });

  // The iOS and Android shells render this header at phone width, which is the
  // case the menu exists for.
  test("presents the same commands as a sheet", () => {
    const onCopySession = mock();
    render(
      <DoctorSessionMenu
        defaultOpen
        onShareFeedback={() => {}}
        onCopySession={onCopySession}
      />,
    );

    expect(screen.getByRole("dialog", { name: MENU_NAME })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy Session" }));

    expect(onCopySession).toHaveBeenCalledTimes(1);
  });
});
