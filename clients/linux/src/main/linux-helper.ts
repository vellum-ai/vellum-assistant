import { existsSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import { NativeSidecarClient } from "@vellumai/native-sidecar/supervisor";

import log from "./logger";

const HELPER_EXECUTABLE = "vellum-linux-helper";

// Kept as the resolved path when no helper is installed: the supervisor throws
// on a missing executable, so every RPC fails closed with a readable message.
const MISSING_HELPER_PATH = `/nonexistent/${HELPER_EXECUTABLE}`;

/**
 * Locates the packaged helper binary, or null when none is installed.
 * The env override wins, then the packaged resources dir, then the dev
 * publish dir that `scripts/build-native-helper.ts` writes.
 */
export const resolveLinuxHelperPath = (): string | null => {
  const override = process.env["VELLUM_LINUX_HELPER_PATH"];
  // `resourcesPath` is only set under an Electron runtime.
  const resourcesPath: string | undefined = process.resourcesPath;
  const tail = ["native-helper", process.arch, HELPER_EXECUTABLE];
  const candidates = [
    ...(override ? [override] : []),
    ...(resourcesPath ? [path.join(resourcesPath, ...tail)] : []),
    path.join(app.getAppPath(), "resources", ...tail),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

export const getLinuxHelperPath = (): string =>
  resolveLinuxHelperPath() ?? MISSING_HELPER_PATH;

let client: NativeSidecarClient | null = null;

export const getLinuxHelperClient = (): NativeSidecarClient =>
  (client ??= new NativeSidecarClient({
    name: "linux helper",
    resolveExecutablePath: getLinuxHelperPath,
    logger: log,
    platform: process.platform,
  }));
