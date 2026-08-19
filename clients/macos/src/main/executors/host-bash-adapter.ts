/**
 * macOS host_bash adapter: runs the wire-contract command strings through
 * Bash via the shared host shell executor.
 */

import { createHostShellExecutor } from "@vellumai/electron-desktop/host-proxy/executors/host-shell-executor";

export const hostBashExecutor = createHostShellExecutor({
  buildSpawn: (command) => ({ file: "/bin/bash", args: ["-c", "--", command] }),
});
