import type { VoiceShortcutConfirmationCopy } from "@vellumai/ipc-contract";

import { captureError } from "@/lib/sentry/capture-error";
import { ensureMainWindowVisible } from "@/runtime/main-window";

export async function confirmVoiceShortcutStart(
  copy: VoiceShortcutConfirmationCopy,
): Promise<boolean> {
  try {
    const confirm = window.vellum?.hotkeys?.confirmVoiceStart;
    if (confirm) {
      return await confirm(copy);
    }
    await ensureMainWindowVisible();
    return window.confirm(`${copy.title}\n\n${copy.detail}`);
  } catch (error) {
    captureError(error, { context: "voice_shortcut_confirmation" });
    return false;
  }
}
