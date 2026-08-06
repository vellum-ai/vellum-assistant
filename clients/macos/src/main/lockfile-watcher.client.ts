import {
  configureLockfileWatcher,
  getWatchedLockfile,
  getWatchedLockfileSnapshot,
  installLockfileWatcher,
  onLockfileChange,
  refreshLockfileNow,
} from "@vellumai/electron-desktop/lockfile-watcher";
import { resolveLockfilePaths } from "@vellumai/local-mode";

configureLockfileWatcher(() => resolveLockfilePaths(process.env));

export {
  getWatchedLockfile,
  getWatchedLockfileSnapshot,
  installLockfileWatcher,
  onLockfileChange,
  refreshLockfileNow,
};
