import { app } from "electron";

import {
  configureAboutRuntime,
  getVersionInfo,
  installAbout as installSharedAbout,
  openAboutWindow,
} from "@vellumai/electron-desktop/about";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { getName, onNameChange } from "./identity";
import { handle } from "./ipc";

configureAboutRuntime({
  rendererBase: () =>
    app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase(),
  getAssistantName: getName,
  onAssistantNameChange: onNameChange,
});

export { getVersionInfo, openAboutWindow };

export const installAbout = (): void => {
  installSharedAbout({ handle });
};
