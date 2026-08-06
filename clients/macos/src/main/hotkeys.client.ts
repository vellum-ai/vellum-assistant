import { installHotkeysIpc as installSharedHotkeysIpc } from "@vellumai/electron-desktop/hotkeys";

import "./commands.client";
import { handle } from "./ipc";

export const installHotkeysIpc = (): void => {
  installSharedHotkeysIpc({ handle });
};
