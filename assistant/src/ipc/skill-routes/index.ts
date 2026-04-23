import type { IpcRoute } from "../cli-server.js";

/**
 * Skill IPC routes — host capabilities exposed to first-party skill processes
 * over the `assistant-skill.sock` socket.
 *
 * Populated by subsequent PRs in the skill-isolation plan (host.log,
 * host.config.*, host.identity.*, host.platform.*, host.memory.*,
 * host.providers.*, host.events.*, host.registries.*).
 */
export const skillIpcRoutes: IpcRoute[] = [];
