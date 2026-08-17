import { installGlobalShortcuts as installSharedGlobalShortcuts } from "@vellumai/electron-desktop/global-shortcuts";
import { toggleQuickInput } from "@vellumai/electron-desktop/quick-input-window";

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
    },
    logger: log,
  });
};
