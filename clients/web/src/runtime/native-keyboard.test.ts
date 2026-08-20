/**
 * Unit tests for `initNativeKeyboard`, `hideNativeKeyboard` and
 * `subscribeNativeKeyboardHeight`.
 *
 * These pin the platform gates (including the Android half of `hide()`, which
 * the swipe-down dismiss gesture depends on), the backwards-compat contract
 * (shells without the linked `@capacitor/keyboard` plugin reject the call and
 * retain the accessory bar, and boot must not surface that as an error), and
 * the defensive height read that keeps a malformed payload from reaching
 * layout.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockIsNativeIOS = false;
let mockIsNativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
  isNativeMobile: () => mockIsNativeIOS || mockIsNativeAndroid,
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

const hide = mock(async () => {});

mock.module("@capacitor/keyboard", () => ({
  Keyboard: { setAccessoryBarVisible, addListener, hide },
}));

// Warm the module cache so the source's lazy `import("@capacitor/keyboard")`
// resolves within microtasks instead of a full loader turn.
await import("@capacitor/keyboard");

const {
  hideNativeKeyboard,
  initNativeKeyboard,
  subscribeNativeKeyboardHeight,
} = await import("@/runtime/native-keyboard");

// The dynamic plugin import and its `.then` chain each queue a microtask, so
// listener registration lags synchronous test code.
async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mockIsNativeIOS = false;
  mockIsNativeAndroid = false;
  showHandler = null;
  hideHandler = null;
  hide.mockClear();
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

describe("hideNativeKeyboard", () => {
  test("never touches the plugin outside a native shell", async () => {
    await hideNativeKeyboard();
    expect(hide).not.toHaveBeenCalled();
  });

  test("hides the keyboard inside the native iOS shell", async () => {
    mockIsNativeIOS = true;
    await hideNativeKeyboard();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("hides the keyboard inside the native Android shell", async () => {
    // The swipe-down dismiss gesture needs this: an Android WebView commonly
    // keeps the IME up after a DOM blur, so the plugin call is the way down.
    mockIsNativeAndroid = true;
    await hideNativeKeyboard();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("swallows the rejection Android returns with no focused view", async () => {
    mockIsNativeAndroid = true;
    hide.mockImplementationOnce(async () => {
      throw new Error("Can't close keyboard, not currently focused");
    });
    await hideNativeKeyboard();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeNativeKeyboardHeight", () => {
  beforeEach(() => {
    mockIsNativeIOS = true;
  });

  test("reports the height the plugin announces on keyboardWillShow", async () => {
    const onHeightChange = mock((_height: number, _visible?: boolean) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    showHandler!({ keyboardHeight: 336 });

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(336, true);
    unsubscribe();
  });

  test("reports 0 on keyboardWillHide", async () => {
    const onHeightChange = mock((_height: number, _visible?: boolean) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    hideHandler!();

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(0, false);
    unsubscribe();
  });

  test("falls back to 0 for a malformed payload", async () => {
    const onHeightChange = mock((_height: number, _visible?: boolean) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    showHandler!({ keyboardHeight: undefined });
    showHandler!({ keyboardHeight: "tall" });
    showHandler!({ keyboardHeight: -12 });

    expect(onHeightChange).toHaveBeenCalledTimes(3);
    for (const call of onHeightChange.mock.calls) {
      expect(call).toEqual([0, true]);
    }
    unsubscribe();
  });

  test("listens on the native Android shell too", async () => {
    // The Android web view frame resizes for the IME the same way, so the
    // announcement is what tells `use-visible-viewport` that shrink apart from
    // the window itself getting shorter.
    mockIsNativeIOS = false;
    mockIsNativeAndroid = true;
    const onHeightChange = mock((_height: number, _visible?: boolean) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    showHandler!({ keyboardHeight: 336 });

    expect(onHeightChange).toHaveBeenCalledWith(336, true);
    unsubscribe();
  });

  test("attaches nothing outside the native shells", async () => {
    mockIsNativeIOS = false;
    const onHeightChange = mock((_height: number, _visible?: boolean) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    expect(addListener).not.toHaveBeenCalled();
    expect(onHeightChange).not.toHaveBeenCalled();
    expect(() => {
      unsubscribe();
    }).not.toThrow();
  });

  test("reports the keyboard source once both listeners register", async () => {
    const onSourceReady = mock(() => {});
    const unsubscribe = subscribeNativeKeyboardHeight(() => {}, onSourceReady);

    // Registration is a lazy plugin import, so nothing is settled yet
    expect(onSourceReady).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(onSourceReady).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("suppresses readiness for a registration the caller already left", async () => {
    // Unsubscribing during the lazy import means the listeners are being
    // removed as they land. Reporting a source then restores the shared flag
    // after the teardown that cleared it.
    const onSourceReady = mock(() => {});
    const unsubscribe = subscribeNativeKeyboardHeight(() => {}, onSourceReady);

    unsubscribe();
    await flushMicrotasks();

    expect(onSourceReady).not.toHaveBeenCalled();
  });

  test("reports a show and a hide by which event fired, not by its height", async () => {
    // The height is sanitized at the bridge, so a malformed show arrives as
    // `0`. Visibility has to survive that, or the frame resize behind it reads
    // as the window getting shorter.
    const onHeightChange = mock((_height: number, _visible: boolean) => {});
    const unsubscribe = subscribeNativeKeyboardHeight(onHeightChange);
    await flushMicrotasks();

    showHandler!({ keyboardHeight: 336 });
    showHandler!({ keyboardHeight: "tall" });
    hideHandler!();

    expect(onHeightChange.mock.calls).toEqual([
      [336, true],
      [0, true],
      [0, false],
    ]);
    unsubscribe();
  });

  test("reports no keyboard source when registration rejects", async () => {
    // A shell built before the plugin, which the deployed web bundle still runs
    // in, rejects the import and must not look like a shell that announces.
    addListener.mockImplementationOnce(() =>
      Promise.reject(new Error("plugin missing")),
    );
    addListener.mockImplementationOnce(() =>
      Promise.reject(new Error("plugin missing")),
    );
    const onSourceReady = mock(() => {});
    const unsubscribe = subscribeNativeKeyboardHeight(() => {}, onSourceReady);
    await flushMicrotasks();

    expect(onSourceReady).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("reports the keyboard source straight away in a browser", async () => {
    // No frame for a keyboard to resize, so nothing has to announce one.
    mockIsNativeIOS = false;
    const onSourceReady = mock(() => {});
    const unsubscribe = subscribeNativeKeyboardHeight(() => {}, onSourceReady);

    expect(onSourceReady).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("unsubscribe removes both plugin listeners", async () => {
    const onHeightChange = mock((_height: number, _visible?: boolean) => {});
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
