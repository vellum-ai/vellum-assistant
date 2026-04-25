/**
 * Skill IPC socket-path helper — resolves the path to `assistant-skill.sock`,
 * the Unix domain socket that first-party skill processes use to talk to the
 * daemon.
 *
 * Delegates to the shared `resolveIpcSocketPath` in `socket-path.ts`.
 */

import { getWorkspaceDir } from "../util/platform.js";
import {
  type IpcSocketPathResolution,
  resolveIpcSocketPath,
} from "./socket-path.js";

export const SKILL_IPC_SOCKET_FILE_NAME = "assistant-skill.sock";

export function resolveSkillIpcSocketPath(
  workspaceDir: string = getWorkspaceDir(),
): IpcSocketPathResolution {
  return resolveIpcSocketPath(
    SKILL_IPC_SOCKET_FILE_NAME,
    "SKILL_IPC_SOCKET_DIR",
    workspaceDir,
  );
}

export function getSkillSocketPath(
  workspaceDir: string = getWorkspaceDir(),
): string {
  return resolveSkillIpcSocketPath(workspaceDir).path;
}
