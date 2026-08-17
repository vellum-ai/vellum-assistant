/**
 * macOS binding of the shared computer-use host-proxy executor: it resolves the
 * mac-helper sidecar as the `cu.perform` transport.
 */

import { createCuHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/cu-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";

import log from "../logger";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";

export interface HostCuExecutorDeps {
  helper?: CuHelperClient;
}

export function createHostCuExecutor(
  deps: HostCuExecutorDeps = {},
): HostProxyExecutor {
  const { helper } = deps;
  return createCuHelperProxyExecutor({
    logger: log,
    resolveHelper: helper ? () => helper : getSharedCuHelper,
  });
}

export const hostCuExecutor: HostProxyExecutor = createHostCuExecutor();
