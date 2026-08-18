import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  configureLocalMode,
  getPairedGuardianAccessToken,
  installLocalMode,
} from "@vellumai/electron-desktop/local-mode";
import {
  resolveConfigDir,
  resolveEnvironmentName,
  resolveLockfilePaths,
  type CliInvocation,
} from "@vellumai/local-mode";

import {
  ensureCliInstalled,
  getBundledBunPath,
  getCliBinPath,
} from "./cli-installer";
import { handle } from "./ipc";
import { refreshLockfileNow } from "./lockfile-watcher.client";
import { getSessionToken } from "./session-token-store.client";

export const resolveCliInvocation = async (): Promise<CliInvocation> => {
  const envPath = process.env.VELLUM_CLI_PATH;
  if (envPath) {
    return { command: "bun", baseArgs: ["run", envPath] };
  }
  if (!app.isPackaged) {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
    if (existsSync(cliEntry)) {
      return { command: "bun", baseArgs: ["run", cliEntry] };
    }
  }
  await ensureCliInstalled();
  return { command: getBundledBunPath(), baseArgs: ["run", getCliBinPath()] };
};

configureLocalMode({
  cli: { resolveInvocation: resolveCliInvocation },
  handle,
  paths: {
    configDir: resolveConfigDir(process.env),
    environment: resolveEnvironmentName(process.env),
    lockfilePaths: resolveLockfilePaths(process.env),
  },
  refreshLockfile: refreshLockfileNow,
  session: { getToken: getSessionToken },
});

export { getPairedGuardianAccessToken, installLocalMode };
