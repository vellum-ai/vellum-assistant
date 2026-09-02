import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { WEB_ACCELERATORS } from "@/hooks/use-command-shortcut";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

import { useChatLayoutShortcuts } from "./use-chat-layout-shortcuts";

/**
 * The web build advertises its own chords through `WEB_ACCELERATORS`, and this
 * hook answers them. Nothing in the types connects the two, so a chord that one
 * side carries and the other does not is a hint naming a key nothing answers.
 *
 * These drive themselves from the table rather than repeating the chords: an
 * entry the handler ignores fails here, and the final case fails when the table
 * carries an entry no assertion covers.
 */

/** The keydown a given accelerator should produce, as a browser would send it. */
function keydownFor(accelerator: string): KeyboardEvent {
  const tokens = accelerator.split("+");
  const key = tokens[tokens.length - 1]!;
  return new KeyboardEvent("keydown", {
    // The handler accepts either modifier; a mac sends the command key.
    metaKey: tokens.includes("CmdOrCtrl"),
    shiftKey: tokens.includes("Shift"),
    // A browser reports the character, lowercased for an unshifted letter.
    key: key.length === 1 ? key.toLowerCase() : key,
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Wait for a condition the palette reaches asynchronously: opening tries the
 * Electron window first and falls back to the store only once that resolves,
 * so the flip is a few microtasks away rather than immediate.
 */
async function eventually(condition: () => boolean): Promise<boolean> {
  for (let i = 0; i < 20 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return condition();
}

describe("useChatLayoutShortcuts answers every chord the web build advertises", () => {
  const handlers = {
    toggleSidebar: mock(() => {}),
    onGoBack: mock(() => {}),
    onGoForward: mock(() => {}),
    onNewConversation: mock(() => {}),
  };

  beforeEach(() => {
    for (const fn of Object.values(handlers)) {
      fn.mockClear();
    }
    if (useCommandPaletteStore.getState().isOpen) {
      useCommandPaletteStore.getState().toggle();
    }
    renderHook(() => useChatLayoutShortcuts(handlers));
  });

  afterEach(() => {
    cleanup();
  });

  /** What proves the app answered a given command, per command. */
  const answered: Record<string, () => boolean | Promise<boolean>> = {
    newConversation: () => handlers.onNewConversation.mock.calls.length === 1,
    sidebarToggle: () => handlers.toggleSidebar.mock.calls.length === 1,
    navigateBack: () => handlers.onGoBack.mock.calls.length === 1,
    navigateForward: () => handlers.onGoForward.mock.calls.length === 1,
    // Off Electron the window open resolves false and the store is the fallback.
    commandPalette: () =>
      eventually(() => useCommandPaletteStore.getState().isOpen),
  };

  for (const [command, accelerator] of Object.entries(WEB_ACCELERATORS)) {
    test(`${command} (${accelerator})`, async () => {
      const check = answered[command];
      expect(check).toBeDefined();

      window.dispatchEvent(keydownFor(accelerator!));

      expect(await check!()).toBe(true);
    });
  }

  test("every advertised chord has a case above", () => {
    // A chord the table carries and this file does not cover is a hint no
    // assertion protects.
    expect(Object.keys(WEB_ACCELERATORS).sort()).toEqual(
      Object.keys(answered).sort(),
    );
  });
});
