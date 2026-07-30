/**
 * Unit tests for `subscribeNativeKeyboardHeight`.
 *
 * These pin the platform gate, the shape of the native payload, and the
 * defensive height read that keeps a malformed `detail` from reaching layout.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockIsNativeIOS = true;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
}));

const { subscribeNativeKeyboardHeight } = await import(
  "@/runtime/native-keyboard-events"
);

function dispatchWillShow(detail: unknown) {
  window.dispatchEvent(new CustomEvent("keyboardWillShow", { detail }));
}

beforeEach(() => {
  mockIsNativeIOS = true;
});

describe("subscribeNativeKeyboardHeight", () => {
  test("reports the height carried by keyboardWillShow", () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);

    dispatchWillShow({ keyboardHeight: 336 });

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(336);
    unsubscribe();
  });

  test("reports 0 on keyboardWillHide", () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);

    window.dispatchEvent(new Event("keyboardWillHide"));

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(0);
    unsubscribe();
  });

  test("falls back to 0 for a malformed payload", () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);

    dispatchWillShow(undefined);
    dispatchWillShow({});
    dispatchWillShow({ keyboardHeight: "tall" });
    dispatchWillShow({ keyboardHeight: -12 });

    expect(onHeightChange).toHaveBeenCalledTimes(4);
    for (const call of onHeightChange.mock.calls) {
      expect(call).toEqual([0]);
    }
    unsubscribe();
  });

  test("attaches nothing outside the native iOS shell", () => {
    mockIsNativeIOS = false;
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);

    dispatchWillShow({ keyboardHeight: 336 });
    window.dispatchEvent(new Event("keyboardWillHide"));

    expect(onHeightChange).not.toHaveBeenCalled();
    expect(() => {
      unsubscribe();
    }).not.toThrow();
  });

  test("unsubscribe detaches both listeners", () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);

    unsubscribe();
    dispatchWillShow({ keyboardHeight: 336 });
    window.dispatchEvent(new Event("keyboardWillHide"));

    expect(onHeightChange).not.toHaveBeenCalled();
  });
});
