import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-158");

/**
 * Remove a disabled `gateway.runtimeProxyRequireAuth` from `config.json`.
 *
 * A workspace carrying `false` here serves the catch-all runtime proxy without
 * client authentication. Only a disabled value is removed; an explicit `true`
 * matches the default and is left alone. `RUNTIME_PROXY_REQUIRE_AUTH` takes
 * precedence over config and is unaffected.
 */
export const clearRuntimeProxyRequireAuthMigration: WorkspaceMigration = {
  id: "158-clear-runtime-proxy-require-auth",
  description:
    "Remove a disabled gateway.runtimeProxyRequireAuth from config.json",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const gateway = config.gateway;
    if (
      gateway === null ||
      typeof gateway !== "object" ||
      Array.isArray(gateway)
    ) {
      return;
    }

    const gw = gateway as Record<string, unknown>;
    const value = gw.runtimeProxyRequireAuth;
    if (value !== false && value !== "false") {
      return;
    }

    delete gw.runtimeProxyRequireAuth;

    const tmpPath = `${configPath}.migration-158.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
    log.info(
      "Removed disabled gateway.runtimeProxyRequireAuth from config.json",
    );
  },
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: restoring a disabled value would reopen the unauthenticated
    // runtime proxy.
  },
};
