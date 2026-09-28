import { installHotkeysIpc as installSharedHotkeysIpc } from "@vellumai/electron-desktop/hotkeys";

import "./commands.client";
import { handle } from "./ipc";

export const installHotkeysIpc = (): void => {
  // Talk is the voice key's double tap on this shell, so the chord is not on
  // offer; `installGlobalShortcuts` passes no handler for it either.
  installSharedHotkeysIpc({ handle, exclude: ["toggleVoice"] });
};
