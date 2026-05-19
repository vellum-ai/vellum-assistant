/**
 * Tests for `ConversationActionsMenu`.
 *
 * The component swaps surfaces based on `useIsMobile()`:
 *   - Desktop → Radix dropdown menu (`Menu.Root`)
 *   - Mobile  → `BottomSheet` (Radix Dialog) with `PanelItem` rows
 *
 * We mock `@/lib/hooks/useIsMobile` per-test to drive each branch and assert
 * that:
 *   - The right surface mounts (role=menu vs role=dialog).
 *   - Clicking an action fires its handler on both surfaces.
 *   - On mobile, selecting an action dismisses the sheet via `onOpenChange`.
 *
 * Behaviors that come from Radix (focus trap, Escape, arrow-key roving) are
 * owned upstream and exercised in the primitives' own test files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  userEvent,
} from "@/test-utils.js";

// Mock the mobile hook *before* importing the component so the module reads
// our spy at call time. The spy is mutable so each test can flip it without
// re-importing the module.
const useIsMobileMock = mock(() => false);
mock.module("@/lib/hooks/useIsMobile.js", () => ({
  useIsMobile: useIsMobileMock,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

import { ConversationActionsMenu } from "@/components/app/assistant/ConversationActionsMenu/ConversationActionsMenu.js";

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
  useIsMobileMock.mockReset();
  useIsMobileMock.mockImplementation(() => false);
});

afterEach(cleanup);

describe("ConversationActionsMenu — desktop branch", () => {
  test("renders inside a Radix dropdown menu (role=menu) when isMobile is false", async () => {
    useIsMobileMock.mockImplementation(() => false);
    render(
      <ConversationActionsMenu
        onPinToggle={() => undefined}
        onRename={() => undefined}
      />,
    );

    // Open the dropdown via the default ellipsis trigger.
    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );

    // Radix portals the menu content; the role surface is `menu`.
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // The Pin and Rename items should be present as menuitems (not <button>s).
    expect(
      screen.getByRole("menuitem", { name: "Pin" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Rename" }),
    ).toBeInTheDocument();
    // No bottom-sheet dialog is mounted on desktop.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("clicking a menu item invokes its handler on desktop", async () => {
    useIsMobileMock.mockImplementation(() => false);
    const onPinToggle = mock(() => {});
    render(<ConversationActionsMenu onPinToggle={onPinToggle} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Pin" }));

    expect(onPinToggle).toHaveBeenCalledTimes(1);
  });
});

describe("ConversationActionsMenu — mobile branch", () => {
  test("renders inside a BottomSheet (role=dialog) when isMobile is true", async () => {
    useIsMobileMock.mockImplementation(() => true);
    render(
      <ConversationActionsMenu
        onPinToggle={() => undefined}
        onRename={() => undefined}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );

    // The bottom sheet is a Radix Dialog (role=dialog, data-state=open).
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    // Bottom-sheet positioning: anchored to viewport bottom, full width.
    // The class string lives on the same node Radix gives the role=dialog.
    const dialogClass = dialog.getAttribute("class") ?? "";
    expect(dialogClass).toContain("inset-x-0");
    expect(dialogClass).toContain("bottom-0");
    expect(dialogClass).toContain("w-full");

    // No anchored Radix dropdown menu is mounted on mobile.
    expect(screen.queryByRole("menu")).toBeNull();

    // Items render as PanelItem buttons inside the sheet body.
    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rename" }),
    ).toBeInTheDocument();
  });

  test("selecting a sheet item fires the handler and dismisses the sheet", async () => {
    useIsMobileMock.mockImplementation(() => true);
    const onRename = mock(() => {});
    render(<ConversationActionsMenu onRename={onRename} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    // Handler fired exactly once.
    expect(onRename).toHaveBeenCalledTimes(1);
    // Sheet dismissed — Radix unmounts the dialog content on close.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Escape closes the bottom sheet", async () => {
    useIsMobileMock.mockImplementation(() => true);
    render(<ConversationActionsMenu onPinToggle={() => undefined} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConversationActionsMenu — read-only conversations", () => {
  // Read-only conversations (channel-bound: Slack, Telegram, voice) hide
  // write-affording items like Mark-as-read/unread and Analyze, but
  // Archive/Unarchive stay available — archive is an organizational
  // action that doesn't write to the source channel, and channel
  // threads accumulate faster than native ones so users need a tidy-up
  // affordance.

  test("desktop: Archive item renders when the conversation is read-only", async () => {
    useIsMobileMock.mockImplementation(() => false);
    const onArchive = mock(() => {});
    const onAnalyze = mock(() => {});
    const onMarkUnread = mock(() => {});
    render(
      <ConversationActionsMenu
        isReadonly
        onArchive={onArchive}
        onAnalyze={onAnalyze}
        onMarkUnread={onMarkUnread}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );

    // Archive stays — organizational, not a source-channel write.
    expect(
      screen.getByRole("menuitem", { name: "Archive" }),
    ).toBeInTheDocument();
    // Mark-as-unread and Analyze remain gated on the read-only flag.
    expect(
      screen.queryByRole("menuitem", { name: "Mark as unread" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Analyze" }),
    ).toBeNull();
  });

  test("desktop: Unarchive item renders when an archived read-only conversation is selected", async () => {
    useIsMobileMock.mockImplementation(() => false);
    const onUnarchive = mock(() => {});
    render(
      <ConversationActionsMenu
        isReadonly
        isArchived
        onUnarchive={onUnarchive}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );

    expect(
      screen.getByRole("menuitem", { name: "Unarchive" }),
    ).toBeInTheDocument();
  });

  test("mobile: Archive row renders in the bottom sheet when the conversation is read-only", async () => {
    useIsMobileMock.mockImplementation(() => true);
    const onArchive = mock(() => {});
    render(<ConversationActionsMenu isReadonly onArchive={onArchive} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );

    expect(
      screen.getByRole("button", { name: "Archive" }),
    ).toBeInTheDocument();
  });

  test("clicking Archive on a read-only conversation fires the handler", async () => {
    useIsMobileMock.mockImplementation(() => false);
    const onArchive = mock(() => {});
    render(<ConversationActionsMenu isReadonly onArchive={onArchive} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Conversation actions" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});
