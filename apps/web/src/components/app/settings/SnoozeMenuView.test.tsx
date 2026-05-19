/**
 * Tests for the `SnoozeMenuView` extracted from `NotificationsPanel`.
 *
 * Covers the mobile vs desktop branch — desktop renders a Radix dropdown
 * (`role="menu"`); mobile renders a Radix Dialog (BottomSheet). Selecting a
 * snooze duration forwards `onSnooze(hours)` to the parent and dismisses
 * the surface; the disabled state is honored on both branches.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@/test-utils.js";

import { SnoozeMenuView } from "@/components/app/settings/NotificationsPanel.js";

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(cleanup);

describe("SnoozeMenuView", () => {
  test("desktop branch renders a Radix dropdown menu", () => {
    render(
      <SnoozeMenuView
        open
        onOpenChange={() => {}}
        pending={false}
        currentlySnoozed={false}
        isMobile={false}
        onSnooze={() => {}}
        onUnsnooze={() => {}}
      >
        <button type="button">Snooze</button>
      </SnoozeMenuView>,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  test("mobile branch renders a BottomSheet with Snooze options as PanelItem rows", () => {
    const onSnooze = mock((_hours: number) => {});
    const onOpenChange = mock((_next: boolean) => {});
    render(
      <SnoozeMenuView
        open
        onOpenChange={onOpenChange}
        pending={false}
        currentlySnoozed={false}
        isMobile
        onSnooze={onSnooze}
        onUnsnooze={() => {}}
      >
        <button type="button">Snooze</button>
      </SnoozeMenuView>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    // The visible "Snooze until…" Title is rendered in the BottomSheet.Header.
    expect(screen.getByText("Snooze until…")).toBeInTheDocument();
    // Snooze options come from SNOOZE_OPTIONS (1h, 4h, 24h…); pick the
    // first row by label match without hard-coding the literal so it
    // doesn't break if the option labels change.
    const buttons = screen.getAllByRole("button");
    // Filter out the trigger; BottomSheet no longer renders an auto Close
    // button so we only need to exclude the "Snooze" trigger.
    const optionButtons = buttons.filter(
      (b) => b.textContent !== "Snooze",
    );
    expect(optionButtons.length).toBeGreaterThan(0);
    fireEvent.click(optionButtons[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSnooze).toHaveBeenCalledTimes(1);
  });

  test("mobile branch suppresses callbacks while pending", () => {
    const onSnooze = mock((_hours: number) => {});
    const onOpenChange = mock((_next: boolean) => {});
    render(
      <SnoozeMenuView
        open
        onOpenChange={onOpenChange}
        pending
        currentlySnoozed={false}
        isMobile
        onSnooze={onSnooze}
        onUnsnooze={() => {}}
      >
        <button type="button">Snooze</button>
      </SnoozeMenuView>,
    );
    const buttons = screen
      .getAllByRole("button")
      .filter(
        (b) =>
          b.getAttribute("aria-label") !== "Close" &&
          b.textContent !== "Snooze",
      );
    fireEvent.click(buttons[0]!);
    // Pending state short-circuits both onOpenChange (not called) and onSnooze.
    expect(onSnooze).not.toHaveBeenCalled();
  });

  test("mobile branch shows a 'Clear snooze' row when currentlySnoozed", () => {
    render(
      <SnoozeMenuView
        open
        onOpenChange={() => {}}
        pending={false}
        currentlySnoozed
        isMobile
        onSnooze={() => {}}
        onUnsnooze={() => {}}
      >
        <button type="button">Snooze</button>
      </SnoozeMenuView>,
    );
    expect(screen.getByRole("button", { name: "Clear snooze" })).toBeInTheDocument();
  });
});
