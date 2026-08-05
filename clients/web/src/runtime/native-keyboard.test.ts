/**
 * Unit tests for `initNativeKeyboard` and `subscribeNativeKeyboardHeight`.
 *
 * These pin the platform gate, the backwards-compat contract (shells without
 * the linked `@capacitor/keyboard` plugin reject the call and retain the
 * accessory bar, and boot must not surface that as an error), and the
 * defensive height read that keeps a malformed payload from reaching layout.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockIsNativeIOS = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

type ShowHandler = (info: { keyboardHeight: unknown }) => void;
type HideHandler = () => void;

let showHandler: ShowHandler | null = null;
let hideHandler: HideHandler | null = null;
const removeShow = mock(async () => {});
const removeHide = mock(async () => {});

const setAccessoryBarVisible = mock(
  async (_options: { isVisible: boolean }) => {},
);
const addListener = mock((eventName: string, handler: unknown) => {
  if (eventName === "keyboardWillShow") {
    showHandler = handler as ShowHandler;
    return Promise.resolve({ remove: removeShow });
  }
  hideHandler = handler as HideHandler;
  return Promise.resolve({ remove: removeHide });
});

mock.module("@capacitor/keyboard", () => ({
  Keyboard: { setAccessoryBarVisible, addListener },
}));

// Warm the module cache so the source's lazy `import("@capacitor/keyboard")`
// resolves within microtasks instead of a full loader turn.
await import("@capacitor/keyboard");

const { initNativeKeyboard, subscribeNativeKeyboardHeight } =
  await import("@/runtime/native-keyboard");

// The dynamic plugin import and its `.then` chain each queue a microtask, so
// listener registration lags synchronous test code.
async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mockIsNativeIOS = false;
  showHandler = null;
  hideHandler = null;
  setAccessoryBarVisible.mockClear();
  addListener.mockClear();
  removeShow.mockClear();
  removeHide.mockClear();
  captureErrorMock.mockClear();
});

describe("initNativeKeyboard", () => {
  test("never touches the plugin outside the native iOS shell", async () => {
    await initNativeKeyboard();
    expect(setAccessoryBarVisible).not.toHaveBeenCalled();
  });

  test("declares the accessory bar hidden inside the native iOS shell", async () => {
    mockIsNativeIOS = true;
    await initNativeKeyboard();
    expect(setAccessoryBarVisible).toHaveBeenCalledTimes(1);
    expect(setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: false });
  });

  test("swallows a rejection from a shell without the plugin", async () => {
    mockIsNativeIOS = true;
    setAccessoryBarVisible.mockImplementationOnce(async () => {
      throw new Error("not implemented");
    });
    await initNativeKeyboard();
    expect(setAccessoryBarVisible).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeNativeKeyboardHeight", () => {
  beforeEach(() => {
    mockIsNativeIOS = true;
  });

  test("reports the height the plugin announces on keyboardWillShow", async () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    showHandler!({ keyboardHeight: 336 });

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(336);
    unsubscribe();
  });

  test("reports 0 on keyboardWillHide", async () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    hideHandler!();

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(0);
    unsubscribe();
  });

  test("falls back to 0 for a malformed payload", async () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    showHandler!({ keyboardHeight: undefined });
    showHandler!({ keyboardHeight: "tall" });
    showHandler!({ keyboardHeight: -12 });

    expect(onHeightChange).toHaveBeenCalledTimes(3);
    for (const call of onHeightChange.mock.calls) {
      expect(call).toEqual([0]);
    }
    unsubscribe();
  });

  test("attaches nothing outside the native iOS shell", async () => {
    mockIsNativeIOS = false;
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    expect(addListener).not.toHaveBeenCalled();
    expect(onHeightChange).not.toHaveBeenCalled();
    expect(() => {
      unsubscribe();
    }).not.toThrow();
  });

  test("unsubscribe removes both plugin listeners", async () => {
    const onHeightChange = mock((_height: number) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    unsubscribe();

    expect(removeShow).toHaveBeenCalledTimes(1);
    expect(removeHide).toHaveBeenCalledTimes(1);
  });

  test("reports a missing plugin once, not once per listener", async () => {
    const err = new Error("plugin missing");
    addListener.mockImplementationOnce(() => Promise.reject(err));
    addListener.mockImplementationOnce(() => Promise.reject(err));

    const unsubscribe = subscribeNativeKeyboardHeight(() => {});
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(err, {
      context: "native_keyboard_height",
      level: "warning",
    });
    unsubscribe();
  });
});
