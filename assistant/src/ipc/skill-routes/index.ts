import type { SkillIpcRoute } from "../skill-ipc-types.js";
import type { SkillIpcStreamingRoute } from "../skill-ipc-types.js";
import { configRoutes } from "./config.js";
import { embeddingsSkillRoutes } from "./embeddings.js";
import { eventsRoutes, eventsStreamingRoutes } from "./events.js";
import { historySkillRoutes } from "./history.js";
import { identityRoutes } from "./identity.js";
import { logRoutes } from "./log.js";
import { memorySkillRoutes } from "./memory.js";
import { platformRoutes } from "./platform.js";
import { providerSkillRoutes } from "./providers.js";
import { registriesRoutes } from "./registries.js";
import { vectorStoreSkillRoutes } from "./vectorStore.js";

/**
 * Skill IPC routes — host capabilities exposed to first-party skill processes
 * over the `assistant-skill.sock` socket.
 *
 * Populated incrementally by the skill-isolation plan PRs (host.log,
 * host.config.*, host.identity.*, host.platform.*, host.memory.*,
 * host.providers.*, host.events.*, host.registries.*, host.history.*,
 * host.embeddings.*, host.vectorStore.*).
 */
export const skillIpcRoutes: SkillIpcRoute[] = [
  ...logRoutes,
  ...configRoutes,
  ...identityRoutes,
  ...platformRoutes,
  ...memorySkillRoutes,
  ...providerSkillRoutes,
  ...registriesRoutes,
  ...eventsRoutes,
  ...historySkillRoutes,
  ...embeddingsSkillRoutes,
  ...vectorStoreSkillRoutes,
];

/**
 * Long-lived streaming skill IPC routes. Handlers return a dispose callback
 * invoked on client disconnect, explicit close, or daemon shutdown.
 */
export const skillIpcStreamingRoutes: SkillIpcStreamingRoute[] = [
  ...eventsStreamingRoutes,
];
