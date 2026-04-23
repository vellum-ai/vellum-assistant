/**
 * Skill IPC socket-path helper — resolves the path to `assistant-skill.sock`,
 * the Unix domain socket that first-party skill processes use to talk to the
 * daemon.
 *
 * Delegates to the shared `resolveIpcSocketPath` in `socket-path.ts` so the
 * same workspace → BASE_DATA_DIR → tmp fallback chain applies for platforms
 * with strict AF_UNIX path limits.
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
  return resolveIpcSocketPath(SKILL_IPC_SOCKET_FILE_NAME, workspaceDir);
}

export function getSkillSocketPath(): string {
  return resolveSkillIpcSocketPath().path;
}
