import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";

import { useCommandPalette } from "@/components/command-palette/use-command-palette";
import { useCommandPaletteStore } from "@/stores/command-palette-store";

afterEach(() => {
  cleanup();
  useCommandPaletteStore.getState().close();
  for (const input of document.querySelectorAll("input")) {
    input.remove();
  }
});

describe("useCommandPalette", () => {
  test("blurs the focused element when closing", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const { result } = renderHook(() => useCommandPalette({ itemCount: 0 }));

    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });

    expect(document.activeElement).not.toBe(input);
    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
  });
});
