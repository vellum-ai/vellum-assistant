/**
 * Host app-control executor — proxies a single `host_app_control_request`
 * (start / observe / press / combo / sequence / type / click / drag / stop) to
 * the native mac-helper's `appControl.perform` JSON-RPC method, then posts the
 * result (window state, PNG screenshot, window bounds) back to the daemon.
 *
 * App-control input is a discriminated union keyed by a `tool` field that the
 * daemon injects into `input`; the helper decodes it natively. This executor
 * only forwards the request and translates the result.
 */

import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import { createAppControlHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/app-control-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
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

export const hostAppControlExecutor: HostProxyExecutor = createHostAppControlExecutor();
