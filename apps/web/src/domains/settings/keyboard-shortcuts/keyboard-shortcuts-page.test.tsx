/**
 * Tests for the Keyboard Shortcuts settings page.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`). The
 * typed `hotkeys` bridge and the Electron platform check are mocked so the
 * page renders its catalog without a real desktop host; the accelerator/
 * conflict math is unit-tested separately in `electron-accelerator.test.ts`.
 * Here we assert the user-facing contract: rows render grouped by scope, the
 * recorder turns a keypress into a `setHotkey` write, a conflicting capture is
 * blocked, and reset/remove map to the documented `null` / `""` writes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ResolvedHotkey } from "@/runtime/hotkeys";

const hotkey = (
  key: string,
  label: string,
  scope: ResolvedHotkey["scope"],
  accelerator: string,
  override: string | null = null,
): ResolvedHotkey => ({
  key,
  label,
  scope,
  defaultAccelerator: scope === "global" ? "CmdOrCtrl+Shift+G" : "CmdOrCtrl+N",
  override,
  accelerator,
});

let catalog: ResolvedHotkey[] = [];
const getHotkeys = mock(() => Promise.resolve(catalog));
const setHotkey = mock(() => Promise.resolve());
const onHotkeysChange = mock(() => () => {});

mock.module("@/runtime/hotkeys", () => ({
  getHotkeys,
  setHotkey,
  onHotkeysChange,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

const { KeyboardShortcutsPage } = await import(
  "@/domains/settings/keyboard-shortcuts/keyboard-shortcuts-page"
);

beforeEach(() => {
  catalog = [
    hotkey("globalHotkey", "Open Vellum", "global", "CmdOrCtrl+Shift+G"),
    hotkey("newConversation", "New chat", "menu", "CmdOrCtrl+N"),
    hotkey("home", "Home", "menu", "CmdOrCtrl+Alt+H", "CmdOrCtrl+Alt+H"),
  ];
  getHotkeys.mockClear();
  setHotkey.mockClear();
  onHotkeysChange.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("KeyboardShortcutsPage", () => {
  test("renders each command grouped under its scope section", async () => {
    render(<KeyboardShortcutsPage />);

    expect(await screen.findByText("Open Vellum")).toBeDefined();
    expect(screen.getByText("New chat")).toBeDefined();
    expect(screen.getByText("Global shortcuts")).toBeDefined();
    expect(screen.getByText("App shortcuts")).toBeDefined();
  });

  test("records a keypress into a setHotkey write", async () => {
    render(<KeyboardShortcutsPage />);
    fireEvent.click(await screen.findByLabelText("Record shortcut for New chat"));

    fireEvent.keyDown(document.body, {
      code: "KeyT",
      metaKey: true,
      altKey: true,
    });

    expect(setHotkey).toHaveBeenCalledTimes(1);
    expect(setHotkey).toHaveBeenCalledWith("newConversation", "CmdOrCtrl+Alt+T");
  });

  test("blocks a conflicting capture and surfaces a warning", async () => {
    render(<KeyboardShortcutsPage />);
    fireEvent.click(await screen.findByLabelText("Record shortcut for Open Vellum"));

    // CmdOrCtrl+N is already bound to "New chat".
    fireEvent.keyDown(document.body, { code: "KeyN", metaKey: true });

    expect(setHotkey).not.toHaveBeenCalled();
    // Surfaced both in the page-level Notice and inline under the row.
    expect(screen.getAllByText(/already used by New chat/i).length).toBeGreaterThan(0);
  });

  test("Escape cancels recording without writing", async () => {
    render(<KeyboardShortcutsPage />);
    fireEvent.click(await screen.findByLabelText("Record shortcut for New chat"));

    fireEvent.keyDown(document.body, { code: "Escape" });
    fireEvent.keyDown(document.body, { code: "KeyT", metaKey: true });

    expect(setHotkey).not.toHaveBeenCalled();
  });

  test("Reset clears the override with null", async () => {
    render(<KeyboardShortcutsPage />);
    fireEvent.click(await screen.findByLabelText("Reset Home to default"));

    expect(setHotkey).toHaveBeenCalledWith("home", null);
  });

  test("Remove disables a binding with an empty string", async () => {
    render(<KeyboardShortcutsPage />);
    fireEvent.click(await screen.findByLabelText("Remove New chat binding"));

    expect(setHotkey).toHaveBeenCalledWith("newConversation", "");
  });
});
