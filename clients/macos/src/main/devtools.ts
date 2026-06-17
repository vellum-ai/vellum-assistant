import { app } from "electron";

declare const __VELLUM_ENABLE_CHROME_DEVTOOLS__: boolean | undefined;

const isChromeDevToolsBuild = (): boolean =>
  typeof __VELLUM_ENABLE_CHROME_DEVTOOLS__ === "boolean" &&
  __VELLUM_ENABLE_CHROME_DEVTOOLS__;

export const areChromeDevToolsEnabled = (): boolean =>
  !app.isPackaged || isChromeDevToolsBuild();
