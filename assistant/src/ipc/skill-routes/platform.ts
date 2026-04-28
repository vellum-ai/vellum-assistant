/**
 * Skill IPC routes: `host.platform.workspaceDir`, `host.platform.vellumRoot`,
 * and `host.platform.runtimeMode`.
 *
 * Surface the platform-path helpers and deployment mode so out-of-process
 * skills can compute workspace-relative paths and branch on docker vs
 * bare-metal behavior without reaching into assistant internals.
 */

import { getDaemonRuntimeMode } from "../../runtime/runtime-mode.js";
import { getWorkspaceDir, vellumRoot } from "../../util/platform.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

export const hostPlatformWorkspaceDirRoute: SkillIpcRoute = {
  method: "host.platform.workspaceDir",
  handler: () => {
    return getWorkspaceDir();
  },
};

export const hostPlatformVellumRootRoute: SkillIpcRoute = {
  method: "host.platform.vellumRoot",
  handler: () => {
    return vellumRoot();
  },
};

export const hostPlatformRuntimeModeRoute: SkillIpcRoute = {
  method: "host.platform.runtimeMode",
  handler: () => {
    return getDaemonRuntimeMode();
  },
};

export const platformRoutes: SkillIpcRoute[] = [
  hostPlatformWorkspaceDirRoute,
  hostPlatformVellumRootRoute,
  hostPlatformRuntimeModeRoute,
];
