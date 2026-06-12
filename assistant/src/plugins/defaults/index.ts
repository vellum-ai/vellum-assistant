/**
 * First-party default plugins — definitions and centralized registration.
 *
 * Each default contributes the hooks for one of the assistant's built-in
 * behaviors (history repair, title generation, tool-error coaching, …) so the
 * lifecycle is always populated at boot and at test time, even when no
 * third-party plugins are loaded. A `Plugin` is the manifest (name/version,
 * sourced from the sibling `package.json`) plus its hook map; the hook
 * implementations live in each `defaults/<name>/hooks/` directory.
 *
 * Consumers:
 *
 * - `daemon/external-plugins-bootstrap.ts` — the daemon's `initializePlugins()`
 *   calls {@link registerDefaultPlugins} explicitly at startup, before
 *   `loadUserPlugins()` closes the registration window, so the defaults compose
 *   innermost (ahead of any user plugins). `bootstrapPlugins()` replays it;
 *   idempotent, so already-registered defaults are skipped.
 * - integration tests that reset the registry and then need a
 *   production-parity state (e.g. `conversation-agent-loop.test.ts`); those
 *   call {@link resetPluginRegistryAndRegisterDefaults}.
 *
 * The plugin definitions below are plain `const`s, so importing this module
 * does no registration work — registration is driven by
 * {@link registerDefaultPlugins} at call time.
 */

import { registerPlugin, resetPluginRegistryForTests } from "../registry.js";
import { type Plugin, PluginExecutionError } from "../types.js";
import compactionPkg from "./compaction/package.json" with { type: "json" };
import emptyResponsePostModelCall from "./empty-response/hooks/post-model-call.js";
import emptyResponseStop from "./empty-response/hooks/stop.js";
import { resetEmptyResponseNudgeStoreForTests } from "./empty-response/nudge-state-store.js";
import emptyResponsePkg from "./empty-response/package.json" with { type: "json" };
import explorationDriftPostToolUse, {
  resetExplorationDriftStateForTests,
} from "./exploration-drift/hooks/post-tool-use.js";
import explorationDriftPkg from "./exploration-drift/package.json" with { type: "json" };
import historyRepairPostModelCall from "./history-repair/hooks/post-model-call.js";
import historyRepairStop from "./history-repair/hooks/stop.js";
import historyRepairUserPromptSubmit from "./history-repair/hooks/user-prompt-submit.js";
import historyRepairPkg from "./history-repair/package.json" with { type: "json" };
import { resetRepairStateStoreForTests } from "./history-repair/repair-state-store.js";
import imageRecoveryPostModelCall from "./image-recovery/hooks/post-model-call.js";
import imageRecoveryStop from "./image-recovery/hooks/stop.js";
import { resetImageRecoveryStoreForTests } from "./image-recovery/image-recovery-state-store.js";
import imageRecoveryPkg from "./image-recovery/package.json" with { type: "json" };
import { resetMaxTokensContinueStoreForTests } from "./max-tokens-continue/continue-state-store.js";
import maxTokensContinuePostModelCall from "./max-tokens-continue/hooks/post-model-call.js";
import maxTokensContinueStop from "./max-tokens-continue/hooks/stop.js";
import maxTokensContinuePkg from "./max-tokens-continue/package.json" with { type: "json" };
import memoryRetrievalPostCompact from "./memory-retrieval/hooks/post-compact.js";
import memoryRetrievalUserPromptSubmit from "./memory-retrieval/hooks/user-prompt-submit.js";
import memoryRetrievalPkg from "./memory-retrieval/package.json" with { type: "json" };
import memoryV3PostCompact from "./memory-v3-shadow/hooks/post-compact.js";
import memoryV3UserPromptSubmit from "./memory-v3-shadow/hooks/user-prompt-submit.js";
import memoryV3Pkg from "./memory-v3-shadow/package.json" with { type: "json" };
import titleGenerateStop from "./title-generate/hooks/stop.js";
import titleGenerateUserPromptSubmit from "./title-generate/hooks/user-prompt-submit.js";
import titleGeneratePkg from "./title-generate/package.json" with { type: "json" };
import toolErrorPostToolUse from "./tool-error/hooks/post-tool-use.js";
import toolErrorPkg from "./tool-error/package.json" with { type: "json" };
import toolResultTruncatePostToolUse from "./tool-result-truncate/hooks/post-tool-use.js";
import toolResultTruncatePkg from "./tool-result-truncate/package.json" with { type: "json" };

/**
 * `compaction` — compaction is implemented in `compaction/compact.ts` as
 * `defaultCompact`, which the agent loop calls directly. The plugin stays
 * registered as a placeholder so it keeps a presence in the defaults list
 * while we decide how plugins should surface compaction; it contributes no
 * hooks today.
 */
export const defaultCompactionPlugin: Plugin = {
  manifest: {
    name: compactionPkg.name,
    version: compactionPkg.version,
  },
};

/**
 * `empty-response` — a `post-model-call` hook that re-queries the model when a
 * turn yields with no tool calls but came back empty (or as a provider
 * refusal); the `stop` hook clears the one-shot nudge bound on a terminal stop
 * so the next run nudges afresh.
 */
export const defaultEmptyResponsePlugin: Plugin = {
  manifest: {
    name: emptyResponsePkg.name,
    version: emptyResponsePkg.version,
  },
  hooks: {
    "post-model-call": emptyResponsePostModelCall,
    stop: emptyResponseStop,
  },
};

/**
 * `memory-retrieval` — assembles the turn's runtime injections (the unified
 * `<turn_context>` block, Slack chronological transcript, NOW.md / PKB /
 * memory-v2 / workspace blocks) via two hooks: `user-prompt-submit` runs
 * memory-graph retrieval and the initial injection, and `post-compact`
 * re-applies the injections onto the compacted history after a mid-turn
 * compaction. Registered first in the chain so later `user-prompt-submit`
 * hooks (history repair, title) see the fully memory-injected history.
 */
export const defaultMemoryRetrievalPlugin: Plugin = {
  manifest: {
    name: memoryRetrievalPkg.name,
    version: memoryRetrievalPkg.version,
  },
  hooks: {
    "user-prompt-submit": memoryRetrievalUserPromptSubmit,
    "post-compact": memoryRetrievalPostCompact,
  },
};

/**
 * `history-repair` — normalizes the working message history (tool-use/tool-result
 * pairing, role alternation). The `user-prompt-submit` hook normalizes the
 * history before each provider call; the `post-model-call` hook handles the
 * provider rejection where the call failed on an ordering violation,
 * deep-repairing the history and asking the loop to retry; the `stop` hook
 * clears the one-shot repair bound on a terminal stop so the next turn repairs
 * afresh.
 */
export const defaultHistoryRepairPlugin: Plugin = {
  manifest: {
    name: historyRepairPkg.name,
    version: historyRepairPkg.version,
  },
  hooks: {
    "user-prompt-submit": historyRepairUserPromptSubmit,
    "post-model-call": historyRepairPostModelCall,
    stop: historyRepairStop,
  },
};

/**
 * `image-recovery` — recovers from a provider image-too-large rejection. The
 * `post-model-call` hook handles the rejection, downscaling the oversized image
 * blocks in the working history and asking the loop to retry, and persisting
 * the same downgrade durably so the rejected image cannot rehydrate from the
 * stored row and re-reject on later turns; the `stop` hook clears the one-shot
 * recovery bound on a terminal stop so the next turn recovers afresh. Bounded
 * to one pass per turn.
 */
export const defaultImageRecoveryPlugin: Plugin = {
  manifest: {
    name: imageRecoveryPkg.name,
    version: imageRecoveryPkg.version,
  },
  hooks: {
    "post-model-call": imageRecoveryPostModelCall,
    stop: imageRecoveryStop,
  },
};

/**
 * `max-tokens-continue` — a `post-model-call` hook that auto-resumes a
 * user-facing turn the provider truncated at its output token limit, keeping
 * the partial output and re-querying with a continuation nudge so long
 * generations can finish without the user clicking the continuation card.
 * Bounded per run; the `stop` hook clears the budget on a terminal stop.
 */
export const defaultMaxTokensContinuePlugin: Plugin = {
  manifest: {
    name: maxTokensContinuePkg.name,
    version: maxTokensContinuePkg.version,
  },
  hooks: {
    "post-model-call": maxTokensContinuePostModelCall,
    stop: maxTokensContinueStop,
  },
};

/**
 * `memory-v3-shadow` — houses the memory-v3 shadow/live orchestration engine
 * (`memory-v3-shadow/`) and its injector. The `user-prompt-submit` /
 * `post-compact` hooks are no-op scaffolding for the eventual convergence,
 * when v3 injection moves off the loop-driven chain and into these hooks.
 */
export const memoryV3ShadowPlugin: Plugin = {
  manifest: {
    name: memoryV3Pkg.name,
    version: memoryV3Pkg.version,
  },
  hooks: {
    "user-prompt-submit": memoryV3UserPromptSubmit,
    "post-compact": memoryV3PostCompact,
  },
};

/**
 * `title-generate` — two pure-trigger hooks that delegate the title work to
 * the conversation-title service: `user-prompt-submit` (first-pass title) and
 * `stop` (second-pass regeneration once the topic is established).
 */
export const defaultTitleGeneratePlugin: Plugin = {
  manifest: {
    name: titleGeneratePkg.name,
    version: titleGeneratePkg.version,
  },
  hooks: {
    "user-prompt-submit": titleGenerateUserPromptSubmit,
    stop: titleGenerateStop,
  },
};

/**
 * `tool-error` — a `post-tool-use` hook that coaches the model to retry or
 * report a failed tool call, bounded per tool. The coaching is surfaced via
 * `additionalContext`, leaving the tool result's own content untouched.
 */
export const defaultToolErrorPlugin: Plugin = {
  manifest: {
    name: toolErrorPkg.name,
    version: toolErrorPkg.version,
  },
  hooks: {
    "post-tool-use": toolErrorPostToolUse,
  },
};

/**
 * `exploration-drift` — a `post-tool-use` hook that detects exploration
 * drift — a long unbroken run of exploration tool calls (bash, file_read,
 * file_list) with no user-facing text, or (on loop-prone models such as Kimi
 * K2.6 and MiniMax M3) the model re-issuing a byte-identical exploration call — and nudges
 * the model via `additionalContext` to summarize progress for the user and
 * delegate the remaining investigation to an `investigator` subagent rather
 * than continuing inline.
 */
export const defaultExplorationDriftPlugin: Plugin = {
  manifest: {
    name: explorationDriftPkg.name,
    version: explorationDriftPkg.version,
  },
  hooks: {
    "post-tool-use": explorationDriftPostToolUse,
  },
};

/**
 * `tool-result-truncate` — a `post-tool-use` hook that tail-drops an oversized
 * tool result down to a character budget derived from the model's context
 * window before the result is sent to the provider.
 */
export const defaultToolResultTruncatePlugin: Plugin = {
  manifest: {
    name: toolResultTruncatePkg.name,
    version: toolResultTruncatePkg.version,
  },
  hooks: {
    "post-tool-use": toolResultTruncatePostToolUse,
  },
};

/**
 * Full set of first-party default plugins. Used by
 * {@link registerDefaultPlugins} to drive the registration loop; the array
 * order is the registration order, which fixes hook-chain order (defaults run
 * ahead of any later-registered user plugins).
 */
function getAllDefaultPlugins(): readonly Plugin[] {
  return [
    defaultMemoryRetrievalPlugin,
    defaultToolResultTruncatePlugin,
    defaultEmptyResponsePlugin,
    defaultMaxTokensContinuePlugin,
    defaultToolErrorPlugin,
    defaultExplorationDriftPlugin,
    defaultHistoryRepairPlugin,
    defaultImageRecoveryPlugin,
    defaultCompactionPlugin,
    defaultTitleGeneratePlugin,
    memoryV3ShadowPlugin,
  ];
}

/**
 * Register every first-party default plugin. Idempotent — duplicate-name
 * registrations (which the registry surfaces as `PluginExecutionError` with
 * an "already registered" message) are swallowed so repeat bootstrap or test
 * setup calls do not throw. Every other error (shape failure, version
 * mismatch) re-throws.
 */
export function registerDefaultPlugins(): void {
  for (const plugin of getAllDefaultPlugins()) {
    try {
      registerPlugin(plugin);
    } catch (err) {
      if (
        err instanceof PluginExecutionError &&
        err.message.includes("already registered")
      ) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Test-only helper: clear the plugin registry and re-register every default
 * so integration tests that exercise the full agent loop have a
 * production-parity plugin stack. Use this in `beforeEach` of tests that
 * dispatch through pipelines with a terminal that assumes the default
 * plugin handles every op (e.g. compaction).
 *
 * Tests that specifically need an empty registry (pipeline-unit tests, the
 * plugin-registry tests themselves) should continue to call
 * {@link resetPluginRegistryForTests} directly.
 */
export function resetPluginRegistryAndRegisterDefaults(): void {
  resetPluginRegistryForTests();
  resetEmptyResponseNudgeStoreForTests();
  resetMaxTokensContinueStoreForTests();
  resetRepairStateStoreForTests();
  resetImageRecoveryStoreForTests();
  resetExplorationDriftStateForTests();
  registerDefaultPlugins();
}
