/**
 * Linux host_bash adapter: runs the wire-contract command strings through
 * bash via the shared host shell executor.
 */

import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import {
  createHostShellExecutor,
  type HostShellSpec,
} from "@vellumai/electron-desktop/host-proxy/executors/host-shell-executor";
import { buildShellInvocation } from "@vellumai/environments/shell";

const createBashSpec = (): HostShellSpec => ({
  buildSpawn: (command) => {
    const invocation = buildShellInvocation(command, "linux");
    return { file: invocation.command, args: invocation.args };
  },
});

export const createLinuxHostBashExecutor = (): HostProxyExecutor =>
  createHostShellExecutor(createBashSpec());

export const hostBashExecutor = createLinuxHostBashExecutor();
