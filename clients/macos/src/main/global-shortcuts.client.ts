import { installGlobalShortcuts as installSharedGlobalShortcuts } from "@vellumai/electron-desktop/global-shortcuts";

import "./commands.client";
import log from "./logger";
import { ensureVisible } from "./main-window";
import { toggleQuickInput } from "./quick-input-window";

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
