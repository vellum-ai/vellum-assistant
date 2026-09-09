/**
 * Workspace git auto-commit heartbeat, driven from the resource monitor
 * process.
 *
 * Turn-boundary commits stay on the daemon (they must finish before the next
 * turn starts). The periodic safety net is different: a dirty tree of
 * thousands of files makes `git add` / `git commit` block for seconds, and
 * running that on the daemon event loop stalls every in-process handler.
 * The monitor already owns other periodic, non-turn work (plugin auto-update,
 * crash recovery, the resource sampler), so the heartbeat timer lives here.
 *
 * `getAllWorkspaceGitServices()` is process-local. The daemon's registry is
 * invisible here, so this process registers the default workspace before
 * starting the timer. Git `index.lock` (plus stale-lock cleanup) serializes
 * against the daemon's turn-boundary commits.
 */

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import {
  startWorkspaceHeartbeatService,
  stopWorkspaceHeartbeatService,
} from "../workspace/heartbeat-service.js";

const log = getLogger("workspace-git-heartbeat");

export interface WorkspaceGitHeartbeatHandle {
  stop(): Promise<void>;
}

/**
 * Register the default workspace in this process and start the heartbeat
 * timer. Idempotent: a second call reuses the singleton.
 */
export function startWorkspaceGitHeartbeat(): WorkspaceGitHeartbeatHandle {
  getWorkspaceGitService(getWorkspaceDir());
  startWorkspaceHeartbeatService();
  log.info("Workspace git heartbeat started in resource monitor");
  return {
    async stop() {
      await stopWorkspaceHeartbeatService();
    },
  };
}
