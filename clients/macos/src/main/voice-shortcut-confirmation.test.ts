import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MessageBoxOptions } from "electron";
import type { VoiceShortcutConfirmationCopy } from "@vellumai/ipc-contract";
import type * as MainWindow from "./main-window";
import type * as Ipc from "./ipc";
import type * as Settings from "@vellumai/electron-desktop/settings";

const showMessageBox = mock(async (_options: MessageBoxOptions) => ({
  response: 0,
  checkboxChecked: false,
}));
const ensureVisible = mock(async () => {});
let skipped = false;
const writeSetting = mock((_key: string, value: boolean) => {
  skipped = value;
});
mock.module("electron", () => ({ dialog: { showMessageBox } }));
mock.module("./main-window", (): Partial<typeof MainWindow> => ({
  ensureVisible,
}));
mock.module("./ipc", (): Partial<typeof Ipc> => ({ handle: mock(() => {}) }));
mock.module(
  "@vellumai/electron-desktop/settings",
  (): Partial<typeof Settings> => ({
    readSetting: (() => skipped) as typeof Settings.readSetting,
    writeSetting: writeSetting as typeof Settings.writeSetting,
  }),
);
const { confirmVoiceShortcutStart } =
  await import("./voice-shortcut-confirmation");
const COPY: VoiceShortcutConfirmationCopy = {
  title: "Start a voice chat?",
  detail: "Your microphone stays on until you end the call.",
  confirm: "Start voice chat",
  cancel: "Cancel",
  dontShowAgain: "Don't show again",
};
beforeEach(() => {
  skipped = false;
  showMessageBox.mockReset();
  showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
  ensureVisible.mockReset();
  ensureVisible.mockResolvedValue(undefined);
  writeSetting.mockClear();
});
describe("voice shortcut confirmation", () => {
  test("raises the app and defaults to cancel before any microphone starts", async () => {
    expect(await confirmVoiceShortcutStart(COPY)).toBe(false);
    expect(ensureVisible).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: [COPY.cancel, COPY.confirm],
        defaultId: 0,
        cancelId: 0,
        checkboxChecked: false,
        checkboxLabel: COPY.dontShowAgain,
      }),
    );
  });
  test("cancel never remembers the checkbox", async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true });
    expect(await confirmVoiceShortcutStart(COPY)).toBe(false);
    expect(writeSetting).not.toHaveBeenCalled();
  });
  test("confirm without opting out asks again on the next call", async () => {
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(await confirmVoiceShortcutStart(COPY)).toBe(true);
    expect(await confirmVoiceShortcutStart(COPY)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(writeSetting).not.toHaveBeenCalled();
  });
  test("only an explicit start with the checkbox skips future prompts", async () => {
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });
    expect(await confirmVoiceShortcutStart(COPY)).toBe(true);
    expect(writeSetting).toHaveBeenCalledWith(
      "skipVoiceShortcutConfirmation",
      true,
    );
    expect(await confirmVoiceShortcutStart(COPY)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(ensureVisible).toHaveBeenCalledTimes(1);
  });
  test("repeated shortcuts cannot queue or share one approval", async () => {
    const pending = confirmVoiceShortcutStart(COPY);
    expect(await confirmVoiceShortcutStart(COPY)).toBe(false);
    expect(await pending).toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });
  test("a failed foreground request releases the pending guard", async () => {
    ensureVisible.mockRejectedValueOnce(new Error("unavailable"));
    await expect(confirmVoiceShortcutStart(COPY)).rejects.toThrow(
      "unavailable",
    );
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(await confirmVoiceShortcutStart(COPY)).toBe(false);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });
});
