/**
 * Tests for `useOptionHotkeys`.
 *
 * Coverage:
 *   1. With `optionCount=3`, digits 1..3 route to `onSelect` with a
 *      zero-based index; digit 4 routes to `onFreeText`; digit 5 is a
 *      no-op (outside the configured range).
 *   2. With `optionCount=4`, digits 1..4 select options; digit 5 reveals
 *      free text; digit 6 is a no-op.
 *   3. Modifier keys (meta / ctrl / alt) suppress the hotkey entirely.
 *   4. When a `<textarea>` or `<input>` is the active element, even the
 *      free-text hotkey is ignored — the form field owns the keystroke.
 *   5. Disabling the hook tears the listener down (flipping enabled to
 *      false stops further dispatches).
 *   6. Unmounting removes the listener (no stray callbacks).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useOptionHotkeys } from "@/lib/hooks/use-option-hotkeys.js";

interface KeyEventInit {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

function pressKey(init: KeyEventInit): void {
  act(() => {
    const event = new KeyboardEvent("keydown", {
      key: init.key,
      metaKey: init.metaKey ?? false,
      ctrlKey: init.ctrlKey ?? false,
      altKey: init.altKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
  });
}

beforeEach(() => {
  // Ensure no element is focused at the start of each test — happy-dom
  // can carry focus across tests if a previous case focused something.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
});

afterEach(() => {
  cleanup();
});

describe("useOptionHotkeys", () => {
  test("optionCount=3: digit 1 -> onSelect(0), digit 3 -> onSelect(2), digit 4 -> onFreeText(), digit 5 -> no-op", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    renderHook(() => useOptionHotkeys(3, onSelect, onFreeText, true));

    pressKey({ key: "1" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(0);

    pressKey({ key: "3" });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(2);

    pressKey({ key: "4" });
    expect(onFreeText).toHaveBeenCalledTimes(1);

    pressKey({ key: "5" });
    // No additional calls — digit 5 is outside the 1..(optionCount + 1)
    // range for a 3-option question, so nothing should fire.
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onFreeText).toHaveBeenCalledTimes(1);
  });

  test("optionCount=4: digits 1..4 -> onSelect, digit 5 -> onFreeText, digit 6 -> no-op", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    renderHook(() => useOptionHotkeys(4, onSelect, onFreeText, true));

    pressKey({ key: "1" });
    pressKey({ key: "2" });
    pressKey({ key: "3" });
    pressKey({ key: "4" });
    expect(onSelect).toHaveBeenCalledTimes(4);
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([0, 1, 2, 3]);

    pressKey({ key: "5" });
    expect(onFreeText).toHaveBeenCalledTimes(1);

    pressKey({ key: "6" });
    expect(onSelect).toHaveBeenCalledTimes(4);
    expect(onFreeText).toHaveBeenCalledTimes(1);
  });

  test("ignores keys when meta/ctrl/alt is held (do not shadow browser shortcuts)", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    renderHook(() => useOptionHotkeys(3, onSelect, onFreeText, true));

    pressKey({ key: "1", metaKey: true });
    pressKey({ key: "2", ctrlKey: true });
    pressKey({ key: "3", altKey: true });
    pressKey({ key: "4", metaKey: true }); // would-be free-text trigger

    expect(onSelect).not.toHaveBeenCalled();
    expect(onFreeText).not.toHaveBeenCalled();
  });

  test("bails out when a textarea is the active element (free-text hotkey included)", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    renderHook(() => useOptionHotkeys(3, onSelect, onFreeText, true));

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    pressKey({ key: "1" });
    pressKey({ key: "4" }); // would normally fire onFreeText
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFreeText).not.toHaveBeenCalled();

    textarea.remove();
  });

  test("bails out when an <input> is the active element", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    renderHook(() => useOptionHotkeys(3, onSelect, onFreeText, true));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    pressKey({ key: "1" });
    pressKey({ key: "4" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFreeText).not.toHaveBeenCalled();

    input.remove();
  });

  test("no-op while disabled, and stops dispatching when flipped to false", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useOptionHotkeys(3, onSelect, onFreeText, enabled),
      { initialProps: { enabled: false } },
    );

    pressKey({ key: "1" });
    expect(onSelect).not.toHaveBeenCalled();

    rerender({ enabled: true });
    pressKey({ key: "1" });
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    pressKey({ key: "1" });
    pressKey({ key: "4" });
    // Still just the single call from the brief enabled window.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onFreeText).not.toHaveBeenCalled();
  });

  test("removes the listener on unmount", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    const { unmount } = renderHook(() =>
      useOptionHotkeys(3, onSelect, onFreeText, true),
    );

    pressKey({ key: "1" });
    expect(onSelect).toHaveBeenCalledTimes(1);

    unmount();
    pressKey({ key: "2" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("extras: ArrowLeft → onPrev, ArrowRight → onNext, `s` → onSkip, Escape → onClose", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    const onPrev = mock(() => {});
    const onNext = mock(() => {});
    const onSkip = mock(() => {});
    const onClose = mock(() => {});

    renderHook(() =>
      useOptionHotkeys(3, onSelect, onFreeText, true, {
        onPrev,
        onNext,
        onSkip,
        onClose,
      }),
    );

    pressKey({ key: "ArrowLeft" });
    pressKey({ key: "ArrowRight" });
    pressKey({ key: "s" });
    pressKey({ key: "Escape" });

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFreeText).not.toHaveBeenCalled();
  });

  test("extras: bail-out applies when an input is focused (no paginate/skip/close)", () => {
    const onSelect = mock((_index: number) => {});
    const onFreeText = mock(() => {});
    const onPrev = mock(() => {});
    const onNext = mock(() => {});
    const onSkip = mock(() => {});
    const onClose = mock(() => {});

    renderHook(() =>
      useOptionHotkeys(3, onSelect, onFreeText, true, {
        onPrev,
        onNext,
        onSkip,
        onClose,
      }),
    );

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    pressKey({ key: "ArrowLeft" });
    pressKey({ key: "ArrowRight" });
    pressKey({ key: "s" });
    pressKey({ key: "Escape" });

    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    input.remove();
  });
});
