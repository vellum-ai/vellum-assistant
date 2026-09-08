import { NativeSidecarClient } from "@vellumai/native-sidecar/supervisor";

import log from "./logger";

/**
 * Placeholder sidecar client for Linux. There is no native helper binary yet,
 * so every RPC fails closed and capability modules report unavailable.
 */
export const getLinuxHelperPath = (): string =>
  "/nonexistent/vellum-linux-helper";

let client: NativeSidecarClient | null = null;

export const getLinuxHelperClient = (): NativeSidecarClient =>
  (client ??= new NativeSidecarClient({
    name: "linux helper",
    resolveExecutablePath: getLinuxHelperPath,
    logger: log,
    platform: process.platform,
  }));
