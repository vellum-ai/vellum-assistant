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

const { copyToClipboard } = await import("./copy-to-clipboard");

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

describe("copyToClipboard", () => {
  test("shows the success toast and runs onCopied after a successful write", async () => {
    const onCopied = mock(() => {});
    copyToClipboard("some text", {
      successMessage: "Copied!",
      errorMessage: "Couldn't copy.",
      onCopied,
    });
    await flushMicrotasks();

    expect(writeText).toHaveBeenCalledWith("some text");
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Copied!");
    expect(toastError).not.toHaveBeenCalled();
  });

  test("stays silent on success when no successMessage is given", async () => {
    const onCopied = mock(() => {});
    copyToClipboard("some text", {
      errorMessage: "Couldn't copy.",
      onCopied,
    });
    await flushMicrotasks();

    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  test("shows the error toast and reports the failure when the write rejects", async () => {
    writeTextResult = Promise.reject(new Error("denied"));
    const onCopied = mock(() => {});
    copyToClipboard("some text", {
      successMessage: "Copied!",
      errorMessage: "Couldn't copy.",
      onCopied,
    });
    await flushMicrotasks();

    expect(onCopied).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Couldn't copy.");
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("shows the error toast and reports when the Clipboard API is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    try {
      const onCopied = mock(() => {});
      copyToClipboard("some text", {
        successMessage: "Copied!",
        errorMessage: "Couldn't copy.",
        onCopied,
      });

      expect(onCopied).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith("Couldn't copy.");
      expect(captureErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    }
  });
});
