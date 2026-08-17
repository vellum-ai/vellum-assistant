import { hostname } from "node:os";

import {
  createHostProxyClientHeaders,
  type HostProxyRuntime,
} from "@vellumai/electron-desktop/host-proxy/router";

import type { ComputerUseActionExecutors } from "./features/computer-use-actions";

export type WindowsHostProxySources = Omit<
  HostProxyRuntime,
  "executors" | "teardownExecutors" | "posterClientHeaders" | "sseClientHeaders"
> & {
  getClientId: () => string;
  /**
   * Computer-use executors contributed by the `computer-use-actions` capability
   * module. Absent when the native helper feature is not installed, in which
   * case `host_cu` is reported as unavailable to the daemon.
   */
  computerUseExecutors?: ComputerUseActionExecutors;
};

export const createWindowsHostProxyRuntime = (
  sources: WindowsHostProxySources,
): HostProxyRuntime => {
  const { getClientId, computerUseExecutors, ...runtimeSources } = sources;
  return {
    ...runtimeSources,
    ...createHostProxyClientHeaders({
      getClientId,
      getMachineName: hostname,
      interfaceId: "windows",
    }),
    executors: computerUseExecutors
      ? { host_cu: computerUseExecutors.host_cu }
      : {},
    teardownExecutors: computerUseExecutors?.teardown,
  };
};
