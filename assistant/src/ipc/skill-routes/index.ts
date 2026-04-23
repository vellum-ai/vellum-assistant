import type { IpcRoute } from "../cli-server.js";
import { configRoutes } from "./config.js";
import { identityRoutes } from "./identity.js";
import { logRoutes } from "./log.js";
import { memorySkillRoutes } from "./memory.js";
import { platformRoutes } from "./platform.js";
import { providerSkillRoutes } from "./providers.js";
import { registriesRoutes } from "./registries.js";

/**
 * Skill IPC routes — host capabilities exposed to first-party skill processes
 * over the `assistant-skill.sock` socket.
 *
 * Populated incrementally by the skill-isolation plan PRs (host.log,
 * host.config.*, host.identity.*, host.platform.*, host.memory.*,
 * host.providers.*, host.events.*, host.registries.*).
 */
export const skillIpcRoutes: IpcRoute[] = [
  ...logRoutes,
  ...configRoutes,
  ...identityRoutes,
  ...platformRoutes,
  ...memorySkillRoutes,
  ...providerSkillRoutes,
  ...registriesRoutes,
];
