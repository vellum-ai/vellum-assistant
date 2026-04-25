import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Resolve the path to an IPC socket file.
 *
 * Resolution order:
 *   1. `GATEWAY_IPC_SOCKET_DIR` env var — used in containerized deployments
 *      (emptyDir volume) and by hatch on macOS when the workspace path
 *      would exceed the platform's AF_UNIX limit.
 *   2. `{workspaceDir}/{socketFileName}` — default for local dev.
 */
export function resolveIpcSocketPath(
  socketFileName: string,
  workspaceDir: string = getWorkspaceDir(),
): string {
  const envSocketDir = process.env.GATEWAY_IPC_SOCKET_DIR?.trim();
  if (envSocketDir) {
    return join(envSocketDir, socketFileName);
  }
  return join(workspaceDir, socketFileName);
}
