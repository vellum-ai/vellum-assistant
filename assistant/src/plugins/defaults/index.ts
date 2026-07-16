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

import {
  clearInjectorRegistry,
  registerPluginInjectors,
} from "../injector-registry.js";
import { registerPlugin, resetPluginRegistryForTests } from "../registry.js";
import { type Plugin, PluginExecutionError } from "../types.js";
import { channelInjectors } from "./channel/injectors.js";
import channelPkg from "./channel/package.json" with { type: "json" };
import compactionPkg from "./compaction/package.json" with { type: "json" };
import { documentsInjectors } from "./documents/injectors.js";
import documentsPkg from "./documents/package.json" with { type: "json" };
import emptyResponsePostModelCall from "./empty-response/hooks/post-model-call.js";
import emptyResponseStop from "./empty-response/hooks/stop.js";
import emptyResponseUserPromptSubmit from "./empty-response/hooks/user-prompt-submit.js";
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
import imageFallbackConversationDeleted from "./image-fallback/hooks/conversation-deleted.js";
import imageFallbackInit from "./image-fallback/hooks/init.js";
import imageFallbackPostCompact from "./image-fallback/hooks/post-compact.js";
import imageFallbackPostModelCall from "./image-fallback/hooks/post-model-call.js";
import imageFallbackPostToolUse from "./image-fallback/hooks/post-tool-use.js";
import imageFallbackShutdown from "./image-fallback/hooks/shutdown.js";
import imageFallbackStop from "./image-fallback/hooks/stop.js";
import imageFallbackUserPromptSubmit from "./image-fallback/hooks/user-prompt-submit.js";
import imageFallbackPkg from "./image-fallback/package.json" with { type: "json" };
import { resetCaptionCacheForTests } from "./image-fallback/src/caption-cache.js";
import imageRecoveryPostModelCall from "./image-recovery/hooks/post-model-call.js";
import imageRecoveryStop from "./image-recovery/hooks/stop.js";
import { resetImageRecoveryStoreForTests } from "./image-recovery/image-recovery-state-store.js";
import imageRecoveryPkg from "./image-recovery/package.json" with { type: "json" };
import { resetMaxTokensContinueStoreForTests } from "./max-tokens-continue/continue-state-store.js";
import maxTokensContinuePostModelCall from "./max-tokens-continue/hooks/post-model-call.js";
import maxTokensContinueStop from "./max-tokens-continue/hooks/stop.js";
import maxTokensContinuePkg from "./max-tokens-continue/package.json" with { type: "json" };
import memoryConversationDeleted from "./memory/hooks/conversation-deleted.js";
import memoryInit from "./memory/hooks/init.js";
import memoryPostCompact from "./memory/hooks/post-compact.js";
import memoryShutdown from "./memory/hooks/shutdown.js";
import memoryUserPromptSubmit from "./memory/hooks/user-prompt-submit.js";
import { memoryInjectors } from "./memory/injectors.js";
import memoryPkg from "./memory/package.json" with { type: "json" };
import {
  memoryV3Injector,
  memoryV3SpotlightInjector,
} from "./memory/v3/injector.js";
import { sessionInjectors } from "./session/injectors.js";
import sessionPkg from "./session/package.json" with { type: "json" };
import surfaceCompletionNudgePostModelCall from "./surface-completion-nudge/hooks/post-model-call.js";
import surfaceCompletionNudgeStop from "./surface-completion-nudge/hooks/stop.js";
import { resetSurfaceCompletionNudgeStoreForTests } from "./surface-completion-nudge/nudge-state-store.js";
import surfaceCompletionNudgePkg from "./surface-completion-nudge/package.json" with { type: "json" };
import taskProgressNudgePostToolUse, {
  resetTaskProgressNudgeStateForTests,
} from "./task-progress-nudge/hooks/post-tool-use.js";
import taskProgressNudgePkg from "./task-progress-nudge/package.json" with { type: "json" };
import titleGenerateStop from "./title-generate/hooks/stop.js";
import titleGenerateUserPromptSubmit from "./title-generate/hooks/user-prompt-submit.js";
import titleGeneratePkg from "./title-generate/package.json" with { type: "json" };
import toolErrorPostToolUse from "./tool-error/hooks/post-tool-use.js";
import toolErrorPkg from "./tool-error/package.json" with { type: "json" };
import toolResultTruncatePostToolUse from "./tool-result-truncate/hooks/post-tool-use.js";
import toolResultTruncatePkg from "./tool-result-truncate/package.json" with { type: "json" };
import { turnContextInjectors } from "./turn-context/injectors.js";
import turnContextPkg from "./turn-context/package.json" with { type: "json" };
import { workspaceInjectors } from "./workspace/injectors.js";
import workspacePkg from "./workspace/package.json" with { type: "json" };

/**
 * `image-fallback` — captions image blocks via a vision-capable profile when
 * the active model is text-only, substituting the caption as an `[Image …]`
 * text block so the model can still reason about the image's content. The
 * `user-prompt-submit` hook deep-sweeps the turn's history at turn start; the
 * `post-tool-use` hook handles images a tool returns (e.g. a browser
 * screenshot) nested in the tool result's `contentBlocks`; the `post-compact`
 * hook re-sweeps the rebuilt history after a mid-turn compaction, whose
 * retained images and persistence-restored tool results land after the
 * turn-start sweep. The `post-model-call` hook backstops raw images that
 * reach the provider anyway (messages joining an in-flight turn, catalog
 * entries that call a model vision-capable when its serving endpoint rejects
 * images): on a vision-not-supported rejection it captions the working
 * history and retries, bounded to one pass per turn, with the `stop` hook
 * clearing the recovery bound on a terminal stop. Fail-open with a
 * placeholder when no vision profile is configured or captioning fails. A
 * read-through content-hash cache (in-memory LRU over a plugin-owned SQLite
 * file, opened by `init` in the plugin's storage dir and closed by
 * `shutdown`) avoids re-captioning the same image across turns, compactions,
 * and restarts; `conversation-deleted` removes the deleted conversation's
 * cache rows.
 */
export const defaultImageFallbackPlugin: Plugin = {
  manifest: {
    name: imageFallbackPkg.name,
    version: imageFallbackPkg.version,
  },
  hooks: {
    init: imageFallbackInit,
    shutdown: imageFallbackShutdown,
    "user-prompt-submit": imageFallbackUserPromptSubmit,
    "post-tool-use": imageFallbackPostToolUse,
    "post-compact": imageFallbackPostCompact,
    "post-model-call": imageFallbackPostModelCall,
    stop: imageFallbackStop,
    "conversation-deleted": imageFallbackConversationDeleted,
  },
};

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
 * so the next run nudges afresh. The `user-prompt-submit` hook runs a turn-start
 * sweep that drops previously-refused exchanges (marked by the persisted
 * `REFUSAL_FALLBACK_TEXT`) from the working history, so a single refusal doesn't
 * poison the conversation by re-sending the flagged prompt every turn. It is
 * registered before `history-repair`, which normalizes any role-alternation
 * artifact a dropped run leaves behind.
 */
export const defaultEmptyResponsePlugin: Plugin = {
  manifest: {
    name: emptyResponsePkg.name,
    version: emptyResponsePkg.version,
  },
  hooks: {
    "user-prompt-submit": emptyResponseUserPromptSubmit,
    "post-model-call": emptyResponsePostModelCall,
    stop: emptyResponseStop,
  },
};

/**
 * `memory` — the assistant's combined memory plugin. Assembles the turn's
 * runtime injections (the unified `<turn_context>` block, Slack chronological
 * transcript, NOW.md / PKB / memory-v2 / workspace blocks) and houses the
 * memory-v3 orchestration engine (`memory/v3/`) and its injectors. Two hooks
 * drive its turn work: `user-prompt-submit` runs memory-graph retrieval and
 * the initial injection, and `post-compact` re-applies the injections onto
 * the compacted history after a mid-turn compaction; a `conversation-deleted`
 * hook fails the plugin's pending background jobs when a conversation is
 * deleted. It contributes its personal-memory
 * runtime injectors (PKB context/reminder and the memory-v2 static block, plus
 * the two memory-v3 injectors) to the global injector registry via the
 * `injectors` field; the registry unions them with the domain plugins'
 * injectors and sorts by `order` into the per-turn chain, and the v3 injectors
 * self-gate on `memory.v3.live`. Registered first among the default plugins so
 * later `user-prompt-submit` hooks (history repair, title) see the fully
 * memory-injected history.
 */
export const defaultMemoryPlugin: Plugin = {
  manifest: {
    name: memoryPkg.name,
    version: memoryPkg.version,
  },
  hooks: {
    init: memoryInit,
    shutdown: memoryShutdown,
    "user-prompt-submit": memoryUserPromptSubmit,
    "post-compact": memoryPostCompact,
    "conversation-deleted": memoryConversationDeleted,
  },
  injectors: [...memoryInjectors, memoryV3Injector, memoryV3SpotlightInjector],
};

/**
 * `turn-context` — contributes the unified `<turn_context>` runtime injector
 * (temporal, actor, channel, and interface grounding). Injector-only; it
 * contributes no hooks.
 */
export const defaultTurnContextPlugin: Plugin = {
  manifest: {
    name: turnContextPkg.name,
    version: turnContextPkg.version,
  },
  injectors: turnContextInjectors,
};

/**
 * `workspace` — contributes the workspace-grounding runtime injectors
 * (disk-pressure warning, `<workspace>` top-level context, config-quarantine
 * notice, NOW.md scratchpad). Injector-only; it contributes no hooks.
 */
export const defaultWorkspacePlugin: Plugin = {
  manifest: {
    name: workspacePkg.name,
    version: workspacePkg.version,
  },
  injectors: workspaceInjectors,
};

/**
 * `documents` — contributes the open-document runtime injectors
 * (`<active_documents>` and `<document_comments>`). Injector-only; it
 * contributes no hooks.
 */
export const defaultDocumentsPlugin: Plugin = {
  manifest: {
    name: documentsPkg.name,
    version: documentsPkg.version,
  },
  injectors: documentsInjectors,
};

/**
 * `channel` — contributes the Slack channel runtime injectors (chronological
 * transcript replacement and `<active_thread>` focus). Injector-only; it
 * contributes no hooks.
 */
export const defaultChannelPlugin: Plugin = {
  manifest: {
    name: channelPkg.name,
    version: channelPkg.version,
  },
  injectors: channelInjectors,
};

/**
 * `session` — contributes the session-state runtime injectors
 * (`<background_turn>` framing and `<active_subagents>` status).
 * Injector-only; it contributes no hooks.
 */
export const defaultSessionPlugin: Plugin = {
  manifest: {
    name: sessionPkg.name,
    version: sessionPkg.version,
  },
  injectors: sessionInjectors,
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
 * `task-progress-nudge` — a `post-tool-use` hook that nudges the model to show
 * a `task_progress` card once an interactive turn has accumulated several
 * tool-call rounds without one. Best-effort and once-per-turn; capable models
 * that already show a card are never nudged.
 */
export const defaultTaskProgressNudgePlugin: Plugin = {
  manifest: {
    name: taskProgressNudgePkg.name,
    version: taskProgressNudgePkg.version,
  },
  hooks: {
    "post-tool-use": taskProgressNudgePostToolUse,
  },
};

/**
 * `surface-completion-nudge` — a `post-model-call` hook that, when a user-facing
 * turn is about to end with a progress surface (a `task_progress` card or
 * `work_result`) the model showed but never advanced to a terminal status or
 * dismissed, nudges the model once to close it and re-queries so it can act; the
 * `stop` hook clears the one-shot bound on a terminal stop so the next run
 * nudges afresh.
 */
export const defaultSurfaceCompletionNudgePlugin: Plugin = {
  manifest: {
    name: surfaceCompletionNudgePkg.name,
    version: surfaceCompletionNudgePkg.version,
  },
  hooks: {
    "post-model-call": surfaceCompletionNudgePostModelCall,
    stop: surfaceCompletionNudgeStop,
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
 * ahead of any later-registered user plugins). Also used by
 * `bootstrapPlugins` to iterate defaults directly.
 */
export function getAllDefaultPlugins(): readonly Plugin[] {
  return [
    defaultMemoryPlugin,
    defaultTurnContextPlugin,
    defaultWorkspacePlugin,
    defaultDocumentsPlugin,
    defaultChannelPlugin,
    defaultSessionPlugin,
    defaultImageFallbackPlugin,
    defaultToolResultTruncatePlugin,
    defaultEmptyResponsePlugin,
    defaultMaxTokensContinuePlugin,
    defaultToolErrorPlugin,
    defaultExplorationDriftPlugin,
    defaultTaskProgressNudgePlugin,
    defaultSurfaceCompletionNudgePlugin,
    defaultHistoryRepairPlugin,
    defaultImageRecoveryPlugin,
    defaultCompactionPlugin,
    defaultTitleGeneratePlugin,
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
 * Register every default plugin's runtime injectors into the global injector
 * registry, up front and independent of disabled-state — the injector analog of
 * what {@link registerDefaultPlugins} does for hooks. `bootstrapPlugins` calls
 * this before the per-plugin init loop so an injector-only default that is
 * disabled at boot (and therefore skipped by the loop) still has its injectors
 * registered; the per-turn walker filters them by `isPluginDisabled` at read
 * time, so enabling it later takes effect on the next turn without a restart.
 * Tests that drive a real turn — or call `applyRuntimeInjections` directly —
 * use it the same way. Idempotent: `registerPluginInjectors` replaces a
 * plugin's prior set, so the per-plugin re-registration in `initializePlugin`
 * (for enabled defaults, and for future injector-contributing user plugins) is
 * a harmless no-op replace.
 */
export function registerDefaultPluginInjectors(): void {
  for (const plugin of getAllDefaultPlugins()) {
    if (plugin.injectors && plugin.injectors.length > 0) {
      registerPluginInjectors(plugin.manifest.name, plugin.injectors);
    }
  }
}

/**
 * Test-only helper: clear the hook registry and re-register every default
 * so integration tests that exercise the full agent loop have a
 * production-parity plugin stack. Use this in `beforeEach` of tests that
 * dispatch through pipelines with a terminal that assumes the default
 * plugin handles every op (e.g. compaction).
 *
 * Tests that specifically need an empty hook registry (pipeline-unit tests)
 * should continue to call {@link resetHookRegistryForTests} directly.
 */
export function resetPluginRegistryAndRegisterDefaults(): void {
  resetPluginRegistryForTests();
  resetEmptyResponseNudgeStoreForTests();
  resetMaxTokensContinueStoreForTests();
  resetRepairStateStoreForTests();
  resetImageRecoveryStoreForTests();
  resetExplorationDriftStateForTests();
  resetTaskProgressNudgeStateForTests();
  resetSurfaceCompletionNudgeStoreForTests();
  resetCaptionCacheForTests();
  registerDefaultPlugins();
  clearInjectorRegistry();
  registerDefaultPluginInjectors();
}
