import { app } from "electron";
import path from "node:path";

import { NativeSidecarClient } from "@vellumai/native-sidecar/supervisor";

import log from "./logger";

const HELPER_ARCH = process.arch === "arm64" ? "arm64" : "x64";

export const getWindowsHelperPath = (): string =>
  app.isPackaged
    ? path.join(
        process.resourcesPath,
        "native-helper",
        HELPER_ARCH,
        "Vellum.WindowsHelper.exe",
      )
    : path.join(
        app.getAppPath(),
        "resources",
        "native-helper",
        HELPER_ARCH,
        "Vellum.WindowsHelper.exe",
      );

let client: NativeSidecarClient | null = null;

export const getWindowsHelperClient = (): NativeSidecarClient =>
  (client ??= new NativeSidecarClient({
    name: "windows helper",
    resolveExecutablePath: getWindowsHelperPath,
    logger: log,
    platform: process.platform,
  }));
