import { configureLockfileWatcher } from "@vellumai/electron-desktop/lockfile-watcher";
import { resolveLockfilePaths } from "@vellumai/local-mode";

configureLockfileWatcher(() => resolveLockfilePaths(process.env));

export * from "@vellumai/electron-desktop/lockfile-watcher";
