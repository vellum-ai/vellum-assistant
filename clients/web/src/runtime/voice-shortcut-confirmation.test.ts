import { afterEach, describe, expect, mock, test } from "bun:test";
import type * as MainWindow from "@/runtime/main-window";
import type * as CaptureError from "@/lib/sentry/capture-error";

const ensureVisible = mock(async () => {});
const captureError = mock(() => {});
mock.module("@/runtime/main-window", (): Partial<typeof MainWindow> => ({
  ensureMainWindowVisible: ensureVisible,
}));
mock.module("@/lib/sentry/capture-error", (): Partial<typeof CaptureError> => ({
  captureError,
}));
const { confirmVoiceShortcutStart } =
  await import("./voice-shortcut-confirmation");
const originalBridge = window.vellum;
const originalConfirm = window.confirm;
const COPY = {
  title: "Start a voice chat?",
  detail: "Your microphone stays on until the call ends.",
  confirm: "Start voice chat",
  cancel: "Cancel",
  dontShowAgain: "Don't show again",
};
afterEach(() => {
  window.vellum = originalBridge;
  window.confirm = originalConfirm;
  ensureVisible.mockClear();
  captureError.mockClear();
});
function setNativeConfirm(confirmVoiceStart: () => Promise<boolean>) {
  const bridge: Pick<NonNullable<Window["vellum"]>, "hotkeys"> = {
    hotkeys: {
      get: async () => [],
      set: async () => {},
      onChange: () => () => {},
      confirmVoiceStart,
    },
  };
  window.vellum = bridge as NonNullable<Window["vellum"]>;
}
describe("voice shortcut confirmation bridge", () => {
  test("returns the native answer and passes localized copy", async () => {
    const native = mock(async () => true);
    setNativeConfirm(native);
    expect(await confirmVoiceShortcutStart(COPY)).toBe(true);
    expect(native).toHaveBeenCalledWith(COPY);
    expect(ensureVisible).not.toHaveBeenCalled();
  });
  test("a native failure cannot start a call", async () => {
    setNativeConfirm(async () => {
      throw new Error("IPC unavailable");
    });
    expect(await confirmVoiceShortcutStart(COPY)).toBe(false);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
  test.each([false, true])(
    "older shells require an explicit browser answer: %s",
    async (answer) => {
      window.vellum = undefined;
      const confirm = mock(() => answer);
      window.confirm = confirm;
      expect(await confirmVoiceShortcutStart(COPY)).toBe(answer);
      expect(ensureVisible).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(`${COPY.title}\n\n${COPY.detail}`);
    },
  );
});
