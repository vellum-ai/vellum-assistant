/**
 * Names of the first-party default plugins, as a leaf module.
 *
 * This deliberately imports ONLY each default plugin's `package.json` (pure
 * JSON data, no code) rather than the `./index.js` barrel. The barrel statically
 * pulls in every hook/injector implementation (the memory-v3 engine, caption
 * caches, persistence hooks, …) and reaches back into `daemon/` modules, so
 * importing it from `daemon/conversation-tool-setup.ts` forms a module-init
 * cycle. Sourcing the names from this leaf keeps that consumer cycle-free while
 * staying data-driven (names come from `package.json`, never hand-typed).
 *
 * The set is kept in lock-step with the canonical {@link getAllDefaultPlugins}
 * list by a unit assertion in `daemon/conversation-tool-setup.test.ts`.
 */

import channelPkg from "./channel/package.json" with { type: "json" };
import compactionPkg from "./compaction/package.json" with { type: "json" };
import documentsPkg from "./documents/package.json" with { type: "json" };
import emptyResponsePkg from "./empty-response/package.json" with { type: "json" };
import explorationDriftPkg from "./exploration-drift/package.json" with { type: "json" };
import historyRepairPkg from "./history-repair/package.json" with { type: "json" };
import imageFallbackPkg from "./image-fallback/package.json" with { type: "json" };
import imageRecoveryPkg from "./image-recovery/package.json" with { type: "json" };
import maxTokensContinuePkg from "./max-tokens-continue/package.json" with { type: "json" };
import memoryPkg from "./memory/package.json" with { type: "json" };
import sessionPkg from "./session/package.json" with { type: "json" };
import surfaceCompletionNudgePkg from "./surface-completion-nudge/package.json" with { type: "json" };
import taskProgressNudgePkg from "./task-progress-nudge/package.json" with { type: "json" };
import titleGeneratePkg from "./title-generate/package.json" with { type: "json" };
import toolErrorPkg from "./tool-error/package.json" with { type: "json" };
import toolResultTruncatePkg from "./tool-result-truncate/package.json" with { type: "json" };
import turnContextPkg from "./turn-context/package.json" with { type: "json" };
import workspacePkg from "./workspace/package.json" with { type: "json" };

/**
 * The set of first-party default plugin names — runtime infrastructure
 * (memory, turn-context, workspace, session, history repair, title generation,
 * …), not user-toggleable extensions. Used by per-chat plugin scoping to ensure
 * these are never filtered out (see `getEffectiveEnabledPluginSet`).
 */
export const DEFAULT_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  memoryPkg.name,
  turnContextPkg.name,
  workspacePkg.name,
  documentsPkg.name,
  channelPkg.name,
  sessionPkg.name,
  imageFallbackPkg.name,
  toolResultTruncatePkg.name,
  emptyResponsePkg.name,
  maxTokensContinuePkg.name,
  toolErrorPkg.name,
  explorationDriftPkg.name,
  taskProgressNudgePkg.name,
  surfaceCompletionNudgePkg.name,
  historyRepairPkg.name,
  imageRecoveryPkg.name,
  compactionPkg.name,
  titleGeneratePkg.name,
]);
