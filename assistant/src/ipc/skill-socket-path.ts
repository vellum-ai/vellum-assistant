/**
 * Skill IPC socket-path helper — resolves the path to `assistant-skill.sock`,
 * the Unix domain socket that first-party skill processes use to talk to the
 * daemon.
 *
 * Delegates to the shared `resolveIpcSocketPath` in `socket-path.ts`.
 */

import {
  type IpcSocketPathResolution,
  resolveIpcSocketPath,
} from "./socket-path.js";

export function resolveSkillIpcSocketPath(): IpcSocketPathResolution {
  return resolveIpcSocketPath("assistant-skill");
}

export function getSkillSocketPath(): string {
  return resolveSkillIpcSocketPath().path;
}
