/**
 * Skill IPC routes: `host.platform.workspaceDir`, `host.platform.vellumRoot`,
 * and `host.platform.runtimeMode`.
 *
 * Surface the platform-path helpers and deployment mode so out-of-process
 * skills can compute workspace-relative paths and branch on docker vs
 * bare-metal behavior without reaching into assistant internals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getDaemonRuntimeMode } from "../../runtime/runtime-mode.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { IpcRoute } from "../assistant-server.js";

export const hostPlatformWorkspaceDirRoute: IpcRoute = {
  method: "host.platform.workspaceDir",
  handler: () => {
    return getWorkspaceDir();
  },
};

export const hostPlatformVellumRootRoute: IpcRoute = {
  method: "host.platform.vellumRoot",
  handler: () => {
    return join(homedir(), ".vellum");
  },
};

export const hostPlatformRuntimeModeRoute: IpcRoute = {
  method: "host.platform.runtimeMode",
  handler: () => {
    return getDaemonRuntimeMode();
  },
};

export const platformRoutes: IpcRoute[] = [
  hostPlatformWorkspaceDirRoute,
  hostPlatformVellumRootRoute,
  hostPlatformRuntimeModeRoute,
];
