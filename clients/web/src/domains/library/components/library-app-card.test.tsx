/**
 * Tests for `LibraryAppCardActionsMenu`, whose commands are declared once and
 * presented as the surface the current input deserves.
 *
 * The presentation is resolved inside the design library from a media query, so
 * these tests drive `window.matchMedia` rather than stubbing a hook: a stubbed
 * hook would pass while the real primitive read something else. The menu is
 * rendered open, since what is under test is the item set each surface produces,
 * not the trigger.
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

const { LibraryAppCardActionsMenu } = await import(
  "@/domains/library/components/library-app-card"
);

const APP_NAME = "Notes";
const MENU_NAME = `Options for ${APP_NAME}`;

function renderMenu(
  overrides: Partial<
    Parameters<typeof LibraryAppCardActionsMenu>[0]
  > = {},
): { onDelete: ReturnType<typeof mock>; onOpenChange: ReturnType<typeof mock> } {
  const onDelete = mock();
  const onOpenChange = mock();
  render(
    <LibraryAppCardActionsMenu
      appName={APP_NAME}
      isPinned={false}
      open
      onOpenChange={onOpenChange}
      onPin={() => {}}
      onDelete={onDelete}
      onShare={() => {}}
      onDeploy={() => {}}
      {...overrides}
    />,
  );
  return { onDelete, onOpenChange };
}

afterEach(() => {
  cleanup();
});

describe("LibraryAppCardActionsMenu on a pointer surface", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  test("renders the commands as one anchored menu", () => {
    renderMenu();

    expect(screen.getByRole("menu", { name: MENU_NAME })).toBeTruthy();
    for (const name of ["Pin", "Share", "Deploy to Vercel", "Delete"]) {
      expect(screen.getAllByRole("menuitem", { name })).toHaveLength(1);
    }
  });

  test("selecting a command runs it and closes the menu", () => {
    const { onDelete, onOpenChange } = renderMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("a deployed app offers the link and a redeploy instead of a deploy", () => {
    renderMenu({
      deployedUrl: "https://notes.example.com",
      onCopyDeployedLink: () => {},
    });

    expect(
      screen.queryByRole("menuitem", { name: "Deploy to Vercel" }),
    ).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: /Deployed to Vercel/ }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Redeploy" })).toBeTruthy();
  });
});

describe("LibraryAppCardActionsMenu on a touch surface", () => {
  beforeEach(() => {
    stubMatchMedia(true);
  });

  test("renders the same commands as sheet rows", () => {
    renderMenu();

    expect(screen.getByRole("dialog", { name: MENU_NAME })).toBeTruthy();
    for (const name of ["Pin", "Share", "Deploy to Vercel", "Delete"]) {
      expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    }
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  test("selecting a row runs it and closes the sheet", () => {
    const { onDelete, onOpenChange } = renderMenu();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("omitting a callback omits its row rather than disabling it", () => {
    renderMenu({ onDelete: undefined, onShare: undefined });

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
