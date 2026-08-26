/**
 * Host app-control executor: the shared `appControl.perform` proxy bound to
 * the mac-helper computer-use client.
 */

import { createAppControlHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/app-control-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import log from "../logger";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";

export interface HostAppControlExecutorDeps {
  helper?: CuHelperClient;
}

export function createHostAppControlExecutor(
  deps: HostAppControlExecutorDeps = {},
): HostProxyExecutor {
  return createAppControlHelperProxyExecutor({
    logger: log,
    resolveHelper: deps.helper
      ? () => deps.helper as CuHelperClient
      : getSharedCuHelper,
  });
}

export const hostAppControlExecutor: HostProxyExecutor =
  createHostAppControlExecutor();
