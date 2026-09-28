import { dialog } from "electron";
import { z } from "zod";

import { readSetting, writeSetting } from "@vellumai/electron-desktop/settings";
import {
  HOTKEYS_CONFIRM_VOICE_START,
  voiceShortcutConfirmationCopySchema,
  type VoiceShortcutConfirmationCopy,
} from "@vellumai/ipc-contract";

import { handle } from "./ipc";
import { ensureVisible } from "./main-window";

let confirming = false;

export async function confirmVoiceShortcutStart(
  copy: VoiceShortcutConfirmationCopy,
): Promise<boolean> {
  if (confirming) {
    return false;
  }
  if (readSetting("skipVoiceShortcutConfirmation") === true) {
    return true;
  }
  confirming = true;
  try {
    await ensureVisible();
    const result = await dialog.showMessageBox({
      type: "question",
      title: copy.title,
      message: copy.title,
      detail: copy.detail,
      buttons: [copy.cancel, copy.confirm],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: copy.dontShowAgain,
      checkboxChecked: false,
    });
    if (result.response !== 1) {
      return false;
    }
    if (result.checkboxChecked) {
      writeSetting("skipVoiceShortcutConfirmation", true);
    }
    return true;
  } finally {
    confirming = false;
  }
}

export function installVoiceShortcutConfirmation(): void {
  handle(
    HOTKEYS_CONFIRM_VOICE_START,
    z.tuple([voiceShortcutConfirmationCopySchema]),
    ([copy]) => confirmVoiceShortcutStart(copy),
  );
}
