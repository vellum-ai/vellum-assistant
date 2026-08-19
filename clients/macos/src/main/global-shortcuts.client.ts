import { installGlobalShortcuts as installSharedGlobalShortcuts } from "@vellumai/electron-desktop/global-shortcuts";
import { toggleQuickInput } from "@vellumai/electron-desktop/quick-input-window";

import { dispatchWithoutRaising } from "./companion-window";

import "./commands.client";
import log from "./logger";
import { ensureVisible } from "./main-window";

export const installGlobalShortcuts = (): void => {
  installSharedGlobalShortcuts({
    handlers: {
      globalHotkey: () => {
        void ensureVisible();
      },
      quickInput: toggleQuickInput,
      // Talk, from wherever the user is. Never raises the app: the whole
      // point of a global binding is that they are somewhere else, and the
      // companion surface is where the session shows itself.
      toggleVoice: () => {
        dispatchWithoutRaising({ kind: "toggleVoice" });
      },
    },
    logger: log,
  });
};
