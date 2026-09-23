import { createCuHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/cu-executor";
import {
  PointAtExecutor,
  type CoachmarkPainter,
} from "@vellumai/electron-desktop/host-proxy/point-at-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import log from "../logger";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";
export { POINT_AT_TOOL } from "@vellumai/electron-desktop/host-proxy/point-at-executor";
export type { CoachmarkPainter } from "@vellumai/electron-desktop/host-proxy/point-at-executor";

export interface HostCuExecutorDeps {
  helper?: CuHelperClient;
  /** What draws the marks. Absent means this client answers that it cannot. */
  showCoachmarks?: CoachmarkPainter;
}

export function createHostCuExecutor(
  deps: HostCuExecutorDeps = {},
): HostProxyExecutor {
  const { helper, showCoachmarks } = deps;
  return new PointAtExecutor(
    createCuHelperProxyExecutor({
      logger: log,
      supportsWindowCapture: true,
      supportsSequence: true,
      resolveHelper: helper ? () => helper : getSharedCuHelper,
    }),
    showCoachmarks,
    log,
  );
}
