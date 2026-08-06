import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";

import { useCommandPalette } from "@/components/command-palette/use-command-palette";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

afterEach(() => {
  cleanup();
  useCommandPaletteStore.getState().close();
  for (const input of document.querySelectorAll("input, textarea")) {
    input.remove();
  }
});

describe("useCommandPalette", () => {
  test("leaves focus an action moved outside the palette alone", () => {
    // Mirrors item selection: `handleIndexSelect` runs the action and then
    // closes, and "New Conversation" focuses the composer on the way through.
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);

    const { result } = renderHook(() => useCommandPalette({ itemCount: 0 }));

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      composer.focus();
      result.current.close();
    });

    expect(document.activeElement).toBe(composer);
    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
  });
});
