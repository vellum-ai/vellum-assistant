/**
 * The two failure cases pin the delegation: a helper owning its own
 * `navigator.clipboard.writeText` throws where the Clipboard API is absent
 * and reports nothing where the write is refused, and both reach the user as
 * a menu item that silently does nothing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const toastSuccess = mock(() => {});
const toastError = mock(() => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { copyIdToClipboard } = await import("./copy-id-to-clipboard");

let writeTextResult: Promise<void>;
const writeText = mock((_text: string) => writeTextResult);

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
  captureErrorMock.mockClear();
  writeText.mockClear();
  writeTextResult = Promise.resolve();
});

describe("copyIdToClipboard", () => {
  test("writes the id and names it in the success toast", async () => {
    copyIdToClipboard("conv_123", "Conversation ID");
    await flushMicrotasks();

    expect(writeText).toHaveBeenCalledWith("conv_123");
    expect(toastSuccess).toHaveBeenCalledWith(
      "Conversation ID copied to clipboard.",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  test("reports the failure as well as toasting when the write is refused", async () => {
    writeTextResult = Promise.reject(new Error("denied"));

    copyIdToClipboard("grp_456", "Group ID");
    await flushMicrotasks();

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Couldn't copy the group id.");
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("toasts and reports instead of throwing when the Clipboard API is absent", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    try {
      // A bare `navigator.clipboard.writeText` throws a TypeError here, and it
      // throws inside the menu's click handler, so nothing is toasted.
      expect(() =>
        copyIdToClipboard("conv_123", "Conversation ID"),
      ).not.toThrow();

      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't copy the conversation id.",
      );
      expect(captureErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    }
  });
});
