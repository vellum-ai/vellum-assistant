import { hostname } from "node:os";

import {
  createHostProxyClientHeaders,
  type HostProxyRuntime,
} from "@vellumai/electron-desktop/host-proxy/router";

export type WindowsHostProxySources = Omit<
  HostProxyRuntime,
  "executors" | "posterClientHeaders" | "sseClientHeaders"
> & {
  getClientId: () => string;
};

export const createWindowsHostProxyRuntime = (
  sources: WindowsHostProxySources,
): HostProxyRuntime => {
  const { getClientId, ...runtimeSources } = sources;
  return {
    ...runtimeSources,
    ...createHostProxyClientHeaders({
      getClientId,
      getMachineName: hostname,
      interfaceId: "windows",
    }),
    executors: {},
  };
};
