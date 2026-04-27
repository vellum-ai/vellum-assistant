import * as Sentry from "@sentry/node";

import type { LLMCallSite } from "../config/schemas/llm.js";
import {
  estimatePromptTokensRaw,
  estimateToolsTokens,
  getCalibrationProviderKey,
} from "../context/token-estimator.js";
import { calculateMaxToolResultChars } from "../context/tool-result-truncation.js";
import { defaultEmptyResponseTerminal } from "../plugins/defaults/empty-response.js";
import { defaultToolErrorTerminal } from "../plugins/defaults/tool-error.js";
import { defaultToolResultTruncateTerminal } from "../plugins/defaults/tool-result-truncate.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import type {
  EmptyResponseArgs,
  EmptyResponseDecision,
  LLMCallArgs,
  LLMCallResult,
  ToolErrorArgs,
  ToolErrorDecision,
  ToolResultTruncateArgs,
  ToolResultTruncateResult,
  TurnContext,
} from "../plugins/types.js";
import { normalizeThinkingConfigForWire } from "../providers/thinking-config.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ToolDefinition,
  ToolResultContent,
} from "../providers/types.js";
import type { SensitiveOutputBinding } from "../tools/sensitive-output-placeholders.js";
import {
  applyStreamingSubstitution,
  applySubstitutions,
} from "../tools/sensitive-output-placeholders.js";
import { AssistantError, ErrorCode, ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { isRetryableNetworkError } from "../util/retry.js";

const log = getLogger("agent-loop");

export interface AgentLoopConfig {
  maxTokens: number;
  maxInputTokens?: number; // context window size for tool result truncation
  thinking?: { enabled: boolean };
  effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  speed?: "standard" | "fast";
  toolChoice?:
    | { type: "auto" }
    | { type: "any" }
    | { type: "tool"; name: string };
  /** Minimum interval (ms) between consecutive LLM calls to prevent spin when tools return instantly */
  minTurnIntervalMs?: number;
  /** Override the default prompt cache TTL sent to the provider (e.g. "5m" for short-lived subagents). */
  cacheTtl?: "5m" | "1h";
}

export interface CheckpointInfo {
  turnIndex: number;
  toolCount: number;
  hasToolUse: boolean;
  history: Message[]; // current history snapshot for token estimation
}

export type CheckpointDecision = "continue" | "yield";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "message_complete"; message: Message }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_output_chunk"; toolUseId: string; chunk: string }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      diff?: {
        filePath: string;
        oldContent: string;
        newContent: string;
        isNewFile: boolean;
      };
      status?: string;
      contentBlocks?: ContentBlock[];
      riskLevel?: string;
      riskReason?: string;
      isContainerized?: boolean;
      riskScopeOptions?: Array<{ pattern: string; label: string }>;
      riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
    }
  | { type: "tool_use_preview_start"; toolUseId: string; toolName: string }
  | {
      type: "input_json_delta";
      toolName: string;
      toolUseId: string;
      accumulatedJson: string;
    }
  | {
      type: "server_tool_start";
      name: string;
      toolUseId: string;
      input: Record<string, unknown>;
    }
  | {
      type: "server_tool_complete";
      toolUseId: string;
      isError: boolean;
      content?: unknown[];
    }
  | { type: "error"; error: Error }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      model: string;
      actualProvider?: string;
      providerDurationMs: number;
      rawRequest?: unknown;
      rawResponse?: unknown;
      /**
       * Pre-send token estimate for the same call. Used by the estimator
       * calibrator to learn how off the heuristic is versus provider
       * ground truth. Omitted only when estimation genuinely was not run
       * for this call (e.g. legacy/stubbed code paths).
       */
      estimatedInputTokens?: number;
    };

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTokens: 64000,
  effort: "high",
  minTurnIntervalMs: 150,
};

const MAX_CONSECUTIVE_ERROR_NUDGES = 3;
const MAX_EMPTY_RESPONSE_RETRIES = 1;

/**
 * Build a minimal {@link TurnContext} for pipeline invocations inside the
 * agent loop. Real production call sites thread a full `TurnContext` into
 * `AgentLoop.run()` (see the `turnContext` parameter on
 * {@link AgentLoop.run}); this helper is the fallback used only by unit
 * tests that construct `AgentLoop` directly without an orchestrator.
 *
 * When the orchestrator-supplied context is present, {@link resolveLoopTurnContext}
 * is used instead of this helper so the pipeline sees the real
 * `conversationId`, trust, and `contextWindowManager`. In the fallback path
 * the returned context is still useful for pipeline logging: `requestId`
 * surfaces in every structured record, and `turnIndex` reflects the
 * current tool-use iteration.
 */
function buildLoopTurnContext(
  requestId: string | undefined,
  turnIndex: number,
): TurnContext {
  return {
    requestId: requestId ?? "agent-loop",
    // Loop-scoped pipelines do not currently carry a conversation ID; the
    // outer orchestrator owns that dimension. Use a fixed sentinel so log
    // consumers can filter loop-origin records out of conversation queries.
    conversationId: "agent-loop",
    turnIndex,
    trust: {
      sourceChannel: "vellum",
      trustClass: "unknown",
    },
  };
}

/**
 * Produce a `TurnContext` for a pipeline call inside {@link AgentLoop.run}.
 *
 * When the orchestrator supplied a `turnContext`, clone it and overwrite
 * `requestId` + `turnIndex` with the loop-scoped values so plugin log
 * records correctly attribute the call to the current tool-use iteration
 * while preserving the real `conversationId`, trust context, and
 * `contextWindowManager` the orchestrator assembled for the turn. Without
 * an orchestrator context (unit tests that instantiate `AgentLoop` with no
 * `turnContext`), fall back to {@link buildLoopTurnContext}'s synthesized
 * placeholder.
 */
function resolveLoopTurnContext(
  base: TurnContext | undefined,
  requestId: string | undefined,
  turnIndex: number,
): TurnContext {
  if (base) {
    return { ...base, requestId: requestId ?? base.requestId, turnIndex };
  }
  return buildLoopTurnContext(requestId, turnIndex);
}

/**
 * User-config HTTP status codes that should never page the on-call: billing
 * exhaustion (402), invalid credentials (401), and forbidden/plan-gated (403).
 * The user-facing error path already surfaces an actionable message (e.g.
 * credits_exhausted); a Sentry issue adds noise without engineering signal.
 */
const USER_CONFIG_STATUS_CODES = new Set([401, 402, 403]);

/**
 * Whether an agent-loop error should be reported to Sentry. Suppresses:
 *
 *  - `ProviderError` carrying a user-config status code (401/402/403) — these
 *    are bad API keys, exhausted billing, or plan gates, not engineering bugs.
 *  - Retry-exhausted transient network errors (`retriesExhausted === true` +
 *    still categorized as retryable network) — the retry loop already tried
 *    its best; the user's network was flaky, not our code.
 *
 * Everything else (5xx with no retry-exhaustion tag, surprise errors, tool
 * failures, etc.) still pages.
 */
export function shouldCaptureAgentLoopError(err: Error): boolean {
  if (
    err instanceof ProviderError &&
    err.statusCode !== undefined &&
    USER_CONFIG_STATUS_CODES.has(err.statusCode)
  ) {
    return false;
  }
  const exhausted = (err as Error & { retriesExhausted?: boolean })
    .retriesExhausted;
  if (exhausted === true && isRetryableNetworkError(err)) {
    return false;
  }
  return true;
}

export interface ResolvedSystemPrompt {
  systemPrompt: string;
  maxTokens?: number;
  model?: string;
}

/**
 * Callback shape the loop uses to execute a tool invocation.
 *
 * The trailing `turnContext` is optional so in-process tests that wire the
 * callback without an orchestrator keep working. Production sites (the
 * `Conversation`'s `createToolExecutor`) forward the supplied context into
 * `ToolExecutor.execute` so the `toolExecute` pipeline sees the orchestrator's
 * real conversation identity/trust/contextWindowManager instead of the
 * synthesized placeholder `ToolExecutor` would otherwise build from the
 * `ToolContext` alone.
 */
export type LoopToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  onOutput?: (chunk: string) => void,
  toolUseId?: string,
  turnContext?: TurnContext,
) => Promise<{
  content: string;
  isError: boolean;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    isNewFile: boolean;
  };
  status?: string;
  contentBlocks?: ContentBlock[];
  sensitiveBindings?: SensitiveOutputBinding[];
  yieldToUser?: boolean;
  riskLevel?: string;
  riskReason?: string;
  isContainerized?: boolean;
  riskScopeOptions?: Array<{ pattern: string; label: string }>;
  riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
}>;

export class AgentLoop {
  private provider: Provider;
  private systemPrompt: string;
  private config: AgentLoopConfig;
  private tools: ToolDefinition[];
  private resolveTools: ((history: Message[]) => ToolDefinition[]) | null;
  private resolveSystemPrompt:
    | ((history: Message[]) => ResolvedSystemPrompt)
    | null;
  private toolExecutor: LoopToolExecutor | null;

  constructor(
    provider: Provider,
    systemPrompt: string,
    config?: Partial<AgentLoopConfig>,
    tools?: ToolDefinition[],
    toolExecutor?: LoopToolExecutor,
    resolveTools?: (history: Message[]) => ToolDefinition[],
    resolveSystemPrompt?: (history: Message[]) => ResolvedSystemPrompt,
  ) {
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tools = tools ?? [];
    this.resolveTools = resolveTools ?? null;
    this.resolveSystemPrompt = resolveSystemPrompt ?? null;
    this.toolExecutor = toolExecutor ?? null;
  }

  /**
   * Resolve the tool definitions sent to the provider for the given turn.
   *
   * Mirrors the logic of {@link getToolTokenBudget} but returns the tool
   * array itself — callers that need to thread the tool set into a plugin
   * pipeline (e.g. `tokenEstimate`, where the pipeline's args include
   * `tools`) use this rather than re-implementing the dynamic-vs-static
   * resolver fork.
   */
  getResolvedTools(history?: Message[]): ToolDefinition[] {
    return history && this.resolveTools
      ? this.resolveTools(history)
      : this.tools;
  }

  /**
   * Estimate token cost of the tool definitions sent to the provider.
   *
   * When `history` is provided and a dynamic `resolveTools` callback
   * exists, the budget is derived from the resolved tool list for that
   * turn — matching what `run()` actually sends. Without `history` (or
   * without a resolver), falls back to the static `this.tools`.
   */
  getToolTokenBudget(history?: Message[]): number {
    return estimateToolsTokens(this.getResolvedTools(history));
  }

  async run(
    messages: Message[],
    onEvent: (event: AgentEvent) => void | Promise<void>,
    signal?: AbortSignal,
    requestId?: string,
    onCheckpoint?: (
      checkpoint: CheckpointInfo,
    ) => CheckpointDecision | Promise<CheckpointDecision>,
    callSite?: LLMCallSite,
    /**
     * Optional per-turn context supplied by the orchestrator. Every pipeline
     * invocation inside the loop clones from this value (overwriting only
     * `turnIndex`/`requestId`) so middleware sees the real conversation
     * identity, trust class, and `contextWindowManager` rather than the
     * `"agent-loop"` sentinel used when the loop is instantiated standalone
     * in unit tests.
     */
    turnContext?: TurnContext,
    /**
     * Optional ad-hoc inference-profile override applied to every LLM call
     * the loop issues. When set, each `SendMessageOptions.config` carries
     * `overrideProfile = <name>` so the provider's resolver layers
     * `llm.profiles[<name>]` between the workspace `activeProfile` and any
     * call-site named profile. Missing profile names silently fall through.
     * Used by per-conversation pinned profiles to override the workspace
     * default for the lifetime of an agent loop run.
     */
    overrideProfile?: string,
  ): Promise<Message[]> {
    const history = [...messages];
    const initialHistoryLength = messages.length;
    let toolUseTurns = 0;
    let consecutiveErrorTurns = 0;
    let emptyResponseRetries = 0;
    let lastLlmCallTime = 0;
    const rlog = requestId ? log.child({ requestId }) : log;

    // Per-run substitution map for sensitive output placeholders.
    // Bindings are accumulated from tool results; placeholders are
    // resolved in streamed deltas and final assistant message text.
    const substitutionMap = new Map<string, string>();
    let streamingPending = "";

    while (true) {
      if (signal?.aborted) break;

      rlog.info(
        { turn: toolUseTurns, messageCount: history.length },
        "Agent loop iteration start",
      );

      let toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[] = [];

      try {
        // Resolve tools for this turn: use the dynamic resolver if provided,
        // otherwise fall back to the static tool list.
        const currentTools = this.resolveTools
          ? this.resolveTools(history)
          : this.tools;

        // Resolve system prompt, per-turn maxTokens, and model
        const resolved = this.resolveSystemPrompt
          ? this.resolveSystemPrompt(history)
          : null;
        const turnSystemPrompt = resolved?.systemPrompt ?? this.systemPrompt;
        const turnModel = resolved?.model;

        // Field precedence (highest wins):
        //   1. Per-turn explicit (`resolved.maxTokens` / `resolved.model`)
        //   2. Call-site resolved values (filled by
        //      `RetryProvider.normalizeSendMessageOptions` from
        //      `resolveCallSiteConfig(callSite, llm)`)
        //   3. Conversation defaults (`this.config.*`, sourced from
        //      `llm.default`)
        //
        // When `callSite` is present we deliberately leave
        // `max_tokens`/`thinking`/`effort`/`speed` *unset* in `providerConfig`
        // so the normalizer can fill them from the call-site resolution. The
        // normalizer only writes these fields when they're undefined; if we
        // pre-set them from `this.config` here, every per-call-site override
        // for these knobs is silently ignored.
        //
        // `toolChoice` and `cacheTtl` are not part of the call-site schema, so
        // they always come from `this.config` regardless of `callSite`.
        const providerConfig: Record<string, unknown> = {};

        if (resolved?.maxTokens !== undefined) {
          providerConfig.max_tokens = resolved.maxTokens;
        } else if (!callSite) {
          providerConfig.max_tokens = this.config.maxTokens;
        }

        if (turnModel) {
          providerConfig.model = turnModel;
        }

        if (!callSite) {
          const thinking = normalizeThinkingConfigForWire(this.config.thinking);
          if (thinking !== undefined) {
            providerConfig.thinking = thinking;
          }
          if (this.config.effort) {
            providerConfig.effort = this.config.effort;
          }
          if (this.config.speed && this.config.speed !== "standard") {
            providerConfig.speed = this.config.speed;
          }
        }

        if (this.config.toolChoice) {
          providerConfig.tool_choice = this.config.toolChoice;
        }

        if (this.config.cacheTtl) {
          providerConfig.cacheTtl = this.config.cacheTtl;
        }

        // Per-call LLM call-site identifier. Surfaces on the per-call
        // `config.callSite` so `RetryProvider.normalizeSendMessageOptions`
        // can route through `resolveCallSiteConfig` against
        // `llm.callSites.<id>` (falling back to `llm.default` when absent).
        // User-initiated conversation turns default to `mainAgent` in the
        // agent loop's caller; other invocation contexts (heartbeat, filing,
        // analyze, etc.) pass their own `callSite`.
        if (callSite) {
          providerConfig.callSite = callSite;
        }

        // Per-call inference-profile override. The resolver layers
        // `llm.profiles[overrideProfile]` between the workspace's
        // `activeProfile` and any call-site named profile. Threading it on
        // every send (rather than once at construction) keeps subagents that
        // share an `AgentLoop` instance but ought to inherit a different
        // profile correct — and matches how `callSite` is plumbed.
        if (overrideProfile) {
          providerConfig.overrideProfile = overrideProfile;
        }

        // Rate-limit consecutive LLM calls to prevent spin when tools return instantly
        const minInterval = this.config.minTurnIntervalMs ?? 0;
        if (minInterval > 0 && lastLlmCallTime > 0) {
          const elapsed = Date.now() - lastLlmCallTime;
          if (elapsed < minInterval) {
            await Bun.sleep(minInterval - elapsed);
          }
        }

        const providerStart = Date.now();
        lastLlmCallTime = providerStart;

        // Compute the pre-send estimate against the full in-memory
        // history — matching what upstream callers of
        // `estimatePromptTokens` (preflight, mid-loop checkpoints, the
        // window manager) see. We use the RAW estimate (before applying
        // the existing correction) so the calibrator learns the true
        // bias against provider ground truth instead of ratcheting a
        // feedback loop against its own corrected output.
        const toolTokenBudget =
          currentTools.length > 0 ? estimateToolsTokens(currentTools) : 0;
        const preSendEstimatedTokens = estimatePromptTokensRaw(
          history,
          turnSystemPrompt,
          {
            providerName: getCalibrationProviderKey(this.provider),
            toolTokenBudget,
          },
        );
        rlog.info({ turn: toolUseTurns }, "LLM call start");

        // Strip image contentBlocks from older tool results to prevent
        // screenshots from accumulating in the context window. The LLM
        // already saw each image on the turn it was captured; keeping
        // base64 blobs in history rapidly exhausts the context budget.
        // Also strip old AX tree snapshots to keep TTFT from growing
        // linearly with step count in computer-use sessions.
        const providerHistory = compactAxTreeHistory(
          stripOldImageBlocks(history),
        );

        // Wrap the provider call in the `llmCall` pipeline so middleware
        // contributed by plugins may observe, rewrite, short-circuit, or
        // post-process every LLM request. The terminal below is the real
        // `provider.sendMessage(...)` call; middleware reach it by calling
        // `next(args)`. The default `defaultLlmCallPlugin` contributes a
        // passthrough middleware that forwards to `next(args)` — it
        // registers at module load and sits at the outermost onion layer,
        // so it must yield to keep user-registered `llmCall` middleware
        // reachable. Timeout is `null` (`DEFAULT_TIMEOUTS.llmCall`) — the
        // provider layer already enforces its own HTTP-level budgets.
        //
        // The `onEvent` wrapping is kept inside `args.options` so substitution
        // and streaming behavior exactly match the pre-pipeline call site.
        const llmCallArgs: LLMCallArgs = {
          provider: this.provider,
          messages: providerHistory,
          tools: currentTools.length > 0 ? currentTools : undefined,
          systemPrompt: turnSystemPrompt,
          options: {
            config: providerConfig,
            onEvent: (event) => {
              if (event.type === "text_delta") {
                // Apply sensitive-output placeholder substitution (chunk-safe)
                if (substitutionMap.size > 0) {
                  const combined = streamingPending + event.text;
                  const { emit, pending } = applyStreamingSubstitution(
                    combined,
                    substitutionMap,
                  );
                  streamingPending = pending;
                  if (emit.length > 0) {
                    onEvent({ type: "text_delta", text: emit });
                  }
                } else {
                  onEvent({ type: "text_delta", text: event.text });
                }
              } else if (event.type === "thinking_delta") {
                onEvent({ type: "thinking_delta", thinking: event.thinking });
              } else if (event.type === "tool_use_preview_start") {
                onEvent({
                  type: "tool_use_preview_start",
                  toolUseId: event.toolUseId,
                  toolName: event.toolName,
                });
              } else if (event.type === "input_json_delta") {
                onEvent({
                  type: "input_json_delta",
                  toolName: event.toolName,
                  toolUseId: event.toolUseId,
                  accumulatedJson: event.accumulatedJson,
                });
              } else if (event.type === "server_tool_start") {
                onEvent({
                  type: "server_tool_start",
                  name: event.name,
                  toolUseId: event.toolUseId,
                  input: event.input,
                });
              } else if (event.type === "server_tool_complete") {
                onEvent({
                  type: "server_tool_complete",
                  toolUseId: event.toolUseId,
                  isError: event.isError,
                  ...(event.content ? { content: event.content } : {}),
                });
              }
            },
            signal,
          },
        };

        // Per-turn pipeline context. When the orchestrator threaded a full
        // `turnContext` into `run()`, use it (overwriting `turnIndex` with
        // the loop-scoped tool-use iteration) so middleware sees the real
        // conversation identity, trust, and `contextWindowManager`. The
        // synthesized fallback is only reached by standalone unit-test
        // instantiations that never plumb a context through.
        const turnCtx = resolveLoopTurnContext(
          turnContext,
          requestId,
          toolUseTurns,
        );

        const response: LLMCallResult = await runPipeline<
          LLMCallArgs,
          LLMCallResult
        >(
          "llmCall",
          getMiddlewaresFor("llmCall"),
          (args) =>
            args.provider.sendMessage(
              args.messages,
              args.tools,
              args.systemPrompt,
              args.options,
            ),
          llmCallArgs,
          turnCtx,
          DEFAULT_TIMEOUTS.llmCall,
        );

        const providerDurationMs = Date.now() - providerStart;

        onEvent({
          type: "usage",
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
          cacheReadInputTokens: response.usage.cacheReadInputTokens,
          model: response.model,
          actualProvider: response.actualProvider ?? this.provider.name,
          providerDurationMs,
          rawRequest: response.rawRequest,
          rawResponse: response.rawResponse,
          estimatedInputTokens: preSendEstimatedTokens,
        });

        // Flush any buffered streaming text from the substitution pipeline
        if (streamingPending.length > 0) {
          const flushed = applySubstitutions(streamingPending, substitutionMap);
          if (flushed.length > 0) {
            onEvent({ type: "text_delta", text: flushed });
          }
          streamingPending = "";
        }

        // Build the assistant message with placeholder-only text.
        // Both provider history and persisted conversation store must retain
        // placeholders so the model never sees real sensitive values — neither
        // on subsequent loop turns nor on session reload from the database.
        // Substitution to real values happens only in streamed text_delta events.
        const assistantMessage: Message = {
          role: "assistant",
          content: response.content,
        };

        // Check for tool use
        toolUseBlocks = response.content.filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use",
        );

        rlog.info(
          {
            turn: toolUseTurns,
            stopReason: response.stopReason,
            contentBlocks: response.content.length,
            toolUseCount: toolUseBlocks.length,
            durationMs: providerDurationMs,
          },
          "LLM call complete",
        );

        // Detect empty responses: no user-visible text and no tool calls.
        // This can happen when the model fails to produce output after
        // receiving a large tool result. Retry once with a nudge before
        // the message is persisted.
        //
        // Only nudge when the model hasn't already delivered text to the user
        // earlier in this tool-use chain. If a prior assistant turn in history
        // contained visible text (e.g. the model said its piece before calling
        // a side-effect tool like `remember`), an empty follow-up is the model
        // correctly ending its turn — nudging would mislead it into thinking
        // its earlier text didn't land and cause a verbatim re-send.
        //
        // Note: we check ANY prior assistant turn from this run()
        // invocation, not just the most recent one. In multi-step tool-use
        // chains (say-something → call-tool → call-another-tool → end),
        // the "say-something" text lives on an earlier assistant turn while
        // the most recent assistant turn is a pure tool_use with no text.
        // Restricting the check to the most recent assistant turn would
        // falsely nudge in that case and trigger a duplicate re-send of
        // text the user already saw.
        //
        // Scope the scan to messages appended during this run() call only.
        // Assistant text from prior conversation turns (earlier run()
        // invocations passed in via `messages`) must NOT suppress the
        // nudge — those turns completed long ago and have no bearing on
        // whether the current tool-use chain has delivered text yet.
        //
        // The actual decision (nudge vs. accept vs. error) is delegated to
        // the `emptyResponse` plugin pipeline. The pipeline returns a
        // decision; the loop carries out the side-effect (pushing the nudge
        // or surfacing the error). See `plugins/defaults/empty-response.ts`
        // for the default decision logic.
        const hasVisibleText = response.content.some(
          (block) => block.type === "text" && block.text.trim().length > 0,
        );
        const priorAssistantHadVisibleText = (() => {
          for (let i = history.length - 1; i >= initialHistoryLength; i--) {
            const msg = history[i];
            if (msg.role !== "assistant") continue;
            const hasText = msg.content.some(
              (block) =>
                block.type === "text" &&
                typeof (block as { text?: unknown }).text === "string" &&
                (block as { text: string }).text.trim().length > 0,
            );
            if (hasText) return true;
          }
          return false;
        })();

        const emptyResponseArgs: EmptyResponseArgs = {
          responseContent: response.content,
          toolUseBlocksLength: toolUseBlocks.length,
          toolUseTurns,
          emptyResponseRetries,
          maxEmptyResponseRetries: MAX_EMPTY_RESPONSE_RETRIES,
          priorAssistantHadVisibleText,
        };
        const emptyResponseCtx = resolveLoopTurnContext(
          turnContext,
          requestId,
          toolUseTurns,
        );
        const emptyResponseDecision: EmptyResponseDecision = await runPipeline(
          "emptyResponse",
          getMiddlewaresFor("emptyResponse"),
          async (args) => defaultEmptyResponseTerminal(args),
          emptyResponseArgs,
          emptyResponseCtx,
          DEFAULT_TIMEOUTS.emptyResponse,
        );

        if (emptyResponseDecision.action === "nudge") {
          // Fall back to the canonical nudge text if the plugin returned
          // `action: "nudge"` but forgot `nudgeText`. Keeps a misbehaving
          // plugin from silently breaking the loop invariant that the
          // model sees a coherent prompt.
          const nudgeText =
            emptyResponseDecision.nudgeText ??
            "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text.</system_notice>";
          emptyResponseRetries++;
          rlog.warn(
            { turn: toolUseTurns, retry: emptyResponseRetries },
            "Model returned empty response after tool results — retrying",
          );
          history.push({
            role: "user",
            content: [{ type: "text", text: nudgeText }],
          });
          continue;
        }

        if (emptyResponseDecision.action === "error") {
          rlog.error(
            { turn: toolUseTurns, retries: emptyResponseRetries },
            "emptyResponse pipeline requested error surface",
          );
          throw new AssistantError(
            "Model returned empty response after tool results",
            ErrorCode.INTERNAL_ERROR,
          );
        }

        // action === "accept" — fall through. Emit a dedicated log line for
        // the specific "empty turn after tool results, retries exhausted"
        // case so ops dashboards that grep on this line keep working.
        if (
          !hasVisibleText &&
          toolUseBlocks.length === 0 &&
          toolUseTurns > 0 &&
          !priorAssistantHadVisibleText
        ) {
          rlog.error(
            { turn: toolUseTurns, retries: emptyResponseRetries },
            "Model returned empty response after tool results — retries exhausted",
          );
        }

        history.push(assistantMessage);

        await onEvent({ type: "message_complete", message: assistantMessage });

        if (toolUseBlocks.length === 0 || !this.toolExecutor) {
          break;
        }

        // Emit all tool_use events upfront, then execute tools in parallel
        for (const toolUse of toolUseBlocks) {
          onEvent({
            type: "tool_use",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });
        }

        // If already cancelled, synthesize cancelled results and stop
        if (signal?.aborted) {
          const cancelledBlocks: ContentBlock[] = toolUseBlocks.map(
            (toolUse) => ({
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: "Cancelled by user",
              is_error: true,
            }),
          );
          history.push({ role: "user", content: cancelledBlocks });
          break;
        }

        // Execute all tools concurrently for reduced latency.
        // Race against the abort signal so cancellation isn't blocked by
        // stuck tools (e.g. a hung browser navigation).
        const toolExecStart = Date.now();
        rlog.info(
          {
            turn: toolUseTurns,
            toolNames: toolUseBlocks.map((t) => t.name),
          },
          "Tool execution start",
        );

        const toolExecutionPromise = Promise.all(
          toolUseBlocks.map(async (toolUse) => {
            const result = await this.toolExecutor!(
              toolUse.name,
              toolUse.input,
              (chunk) => {
                onEvent({
                  type: "tool_output_chunk",
                  toolUseId: toolUse.id,
                  chunk,
                });
              },
              toolUse.id,
              // Forward the loop's resolved `TurnContext` through the
              // executor callback so `ToolExecutor.execute` can thread the
              // real orchestrator context into the `toolExecute` pipeline.
              // Standalone tests that don't wire a `turnContext` into
              // `AgentLoop.run()` pass `undefined` here and the executor
              // falls back to the synthesized placeholder — preserving the
              // existing unit-test behavior.
              turnCtx,
            );

            return { toolUse, result };
          }),
        );

        let toolResults: Awaited<typeof toolExecutionPromise>;
        if (signal && !signal.aborted) {
          let abortHandler!: () => void;
          const abortPromise = new Promise<never>((_, reject) => {
            abortHandler = () =>
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              );
            signal.addEventListener("abort", abortHandler, { once: true });
          });
          try {
            toolResults = await Promise.race([
              toolExecutionPromise,
              abortPromise,
            ]);
          } finally {
            signal.removeEventListener("abort", abortHandler);
            // Suppress unhandled rejection from abandoned tool executions
            toolExecutionPromise.catch(() => {});
          }
        } else {
          toolResults = await toolExecutionPromise;
        }

        rlog.info(
          {
            turn: toolUseTurns,
            toolCount: toolResults.length,
            durationMs: Date.now() - toolExecStart,
          },
          "Tool execution complete",
        );

        // Merge sensitive output bindings from tool results into the
        // per-run substitution map. Bindings carry placeholder->value pairs
        // that are resolved in streamed text deltas and final message text.
        for (const { result } of toolResults) {
          if (result.sensitiveBindings) {
            for (const binding of result.sensitiveBindings) {
              substitutionMap.set(binding.placeholder, binding.value);
            }
          }
        }

        // Collect result blocks preserving tool_use order (Promise.all maintains order)
        const rawResultBlocks: ContentBlock[] = toolResults.map(
          ({ toolUse, result }) => ({
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.isError,
            ...(result.contentBlocks
              ? { contentBlocks: result.contentBlocks }
              : {}),
          }),
        );

        // Pre-emptively truncate oversized tool results to prevent context
        // overflow. The work is delegated to the `toolResultTruncate`
        // plugin pipeline so downstream plugins can swap in a smarter
        // truncation strategy (e.g. a summariser) while the default
        // middleware preserves the historical tail-drop behaviour.
        const contextWindowTokens = this.config.maxInputTokens ?? 180_000;
        const maxChars = calculateMaxToolResultChars(contextWindowTokens);
        const truncateMiddlewares = getMiddlewaresFor("toolResultTruncate");

        let truncatedCount = 0;
        const truncatedBlocks: ContentBlock[] = [];
        for (const block of rawResultBlocks) {
          if (block.type !== "tool_result") {
            truncatedBlocks.push(block);
            continue;
          }
          const toolBlock = block as ToolResultContent;
          if (
            typeof toolBlock.content !== "string" ||
            toolBlock.content.length <= maxChars
          ) {
            truncatedBlocks.push(block);
            continue;
          }
          const pipelineResult = await runPipeline<
            ToolResultTruncateArgs,
            ToolResultTruncateResult
          >(
            "toolResultTruncate",
            truncateMiddlewares,
            async (args) => defaultToolResultTruncateTerminal(args),
            { content: toolBlock.content, maxChars },
            turnCtx,
            DEFAULT_TIMEOUTS.toolResultTruncate,
          );
          if (pipelineResult.truncated) {
            truncatedCount++;
            truncatedBlocks.push({
              ...toolBlock,
              content: pipelineResult.content,
            });
          } else {
            truncatedBlocks.push(block);
          }
        }
        const resultBlocks = truncatedBlocks;
        if (truncatedCount > 0) {
          log.warn(
            `Truncated ${truncatedCount} oversized tool result(s) to prevent context overflow`,
          );
        }

        // Emit tool_result events AFTER truncation so downstream consumers
        // (e.g. session persistence) receive the truncated content.
        for (const { toolUse, result } of toolResults) {
          // Look up the (possibly truncated) content from resultBlocks
          const truncatedBlock = resultBlocks.find(
            (b) => b.type === "tool_result" && b.tool_use_id === toolUse.id,
          );
          const emitContent =
            truncatedBlock && truncatedBlock.type === "tool_result"
              ? truncatedBlock.content
              : result.content;
          onEvent({
            type: "tool_result",
            toolUseId: toolUse.id,
            content: emitContent,
            isError: result.isError,
            diff: result.diff,
            status: result.status,
            contentBlocks: result.contentBlocks,
            riskLevel: result.riskLevel,
            riskReason: result.riskReason,
            isContainerized: result.isContainerized,
            riskScopeOptions: result.riskScopeOptions,
            riskDirectoryScopeOptions: result.riskDirectoryScopeOptions,
          });
        }

        // If cancelled during execution, push completed results and stop
        if (signal?.aborted) {
          history.push({ role: "user", content: resultBlocks });
          break;
        }

        // If any tool result requests yielding to the user (e.g. interactive
        // surface awaiting a button click), push results and stop the loop.
        if (toolResults.some(({ result }) => result.yieldToUser)) {
          history.push({ role: "user", content: resultBlocks });
          break;
        }

        toolUseTurns++;

        // When any tool returned an error, nudge the LLM to retry with
        // corrected parameters instead of ending its turn. Skip the nudge
        // after MAX_CONSECUTIVE_ERROR_NUDGES consecutive error turns
        // (the error is likely unrecoverable at that point). The nudge
        // decision is delegated to the `toolError` plugin pipeline so user
        // plugins can change the text, observe the event, or suppress it.
        const hasToolError = toolResults.some(({ result }) => result.isError);
        if (hasToolError) {
          consecutiveErrorTurns++;
        } else {
          consecutiveErrorTurns = 0;
        }
        const toolErrorArgs: ToolErrorArgs = {
          hasToolError,
          consecutiveErrorTurns,
          maxConsecutiveErrorNudges: MAX_CONSECUTIVE_ERROR_NUDGES,
        };
        const toolErrorCtx: TurnContext = resolveLoopTurnContext(
          turnContext,
          requestId,
          toolUseTurns - 1,
        );
        const toolErrorDecision = await runPipeline<
          ToolErrorArgs,
          ToolErrorDecision
        >(
          "toolError",
          getMiddlewaresFor("toolError"),
          // Terminal: the canonical nudge decision. The default plugin's
          // middleware is a passthrough (so later-registered user plugins
          // aren't shadowed), so this terminal is what actually produces
          // the decision when no user plugin overrides it. Wiring the
          // decision here also ensures the nudge fires for direct
          // AgentLoop callers (tests, benchmarks) that skip
          // `bootstrapPlugins()` and therefore never register the default.
          async (args) => defaultToolErrorTerminal(args),
          toolErrorArgs,
          toolErrorCtx,
          DEFAULT_TIMEOUTS.toolError,
        );
        if (toolErrorDecision.action === "nudge") {
          resultBlocks.push({
            type: "text",
            text: toolErrorDecision.nudgeText,
          });
        }

        // Add tool results as a user message and continue the loop
        history.push({ role: "user", content: resultBlocks });

        // Invoke checkpoint callback after tool results are in history.
        // The callback may be async — the mid-loop budget check delegates
        // to the `tokenEstimate` plugin pipeline, which is asynchronous.
        if (onCheckpoint) {
          const decision = await onCheckpoint({
            turnIndex: toolUseTurns - 1, // 0-based (toolUseTurns was already incremented)
            toolCount: toolUseBlocks.length,
            hasToolUse: true,
            history,
          });
          if (decision === "yield") {
            break;
          }
        }
      } catch (error) {
        // Abort errors are expected when user cancels — synthesize
        // cancellation tool_results so the history stays valid for the
        // Anthropic API (every tool_use must have a matching tool_result).
        if (signal?.aborted) {
          if (toolUseBlocks.length > 0) {
            const cancelledBlocks: ContentBlock[] = toolUseBlocks.map(
              (toolUse) => ({
                type: "tool_result" as const,
                tool_use_id: toolUse.id,
                content: "Cancelled by user",
                is_error: true,
              }),
            );
            history.push({ role: "user", content: cancelledBlocks });
          }
          break;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        rlog.error(
          { err, turn: toolUseTurns, messageCount: history.length },
          "Agent loop error during turn processing",
        );
        if (shouldCaptureAgentLoopError(err)) {
          Sentry.captureException(err);
        }
        onEvent({ type: "error", error: err });
        break;
      }
    }

    rlog.info(
      {
        turns: toolUseTurns,
        finalMessageCount: history.length,
        aborted: signal?.aborted ?? false,
      },
      "Agent loop exited",
    );

    return history;
  }
}

/** Number of most-recent AX tree snapshots to keep in conversation history. */
const MAX_AX_TREES_IN_HISTORY = 2;

/** Regex that matches the `<ax-tree>...</ax-tree>` markers. */
const AX_TREE_PATTERN = /<ax-tree>[\s\S]*?<\/ax-tree>/g;
const AX_TREE_PLACEHOLDER = "<ax_tree_omitted />";

/**
 * Escapes any literal `</ax-tree>` occurrences inside AX tree content so
 * that the non-greedy compaction regex (`AX_TREE_PATTERN`) does not stop
 * prematurely when the user happens to be viewing XML/HTML source that
 * contains the closing tag.  The escaped content does not need to be
 * unescaped because compaction replaces the entire block with a placeholder.
 */
export function escapeAxTreeContent(content: string): string {
  return content.replace(/<\/ax-tree>/gi, "&lt;/ax-tree&gt;");
}

/**
 * Returns a shallow copy of `messages` where all but the most recent
 * `MAX_AX_TREES_IN_HISTORY` `<ax-tree>` blocks have been replaced with a
 * short placeholder.  This keeps the conversation context small so that
 * TTFT does not grow linearly with step count in computer-use sessions.
 *
 * Counting is per-block, not per-message — a single user message can
 * contain multiple tool_result blocks each with their own AX tree snapshot.
 */
export function compactAxTreeHistory(messages: Message[]): Message[] {
  // Collect (messageIndex, blockIndex) for every tool_result block with <ax-tree>
  const axBlocks: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (
        block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content.includes("<ax-tree>")
      ) {
        axBlocks.push({ msgIdx: i, blockIdx: j });
      }
    }
  }

  if (axBlocks.length <= MAX_AX_TREES_IN_HISTORY) {
    return messages;
  }

  // Build a set of "msgIdx:blockIdx" keys for blocks that should be stripped
  const toStrip = new Set(
    axBlocks
      .slice(0, -MAX_AX_TREES_IN_HISTORY)
      .map((b) => `${b.msgIdx}:${b.blockIdx}`),
  );

  return messages.map((msg, idx) => {
    // Quick check: does this message have any blocks to strip?
    const hasStripTarget = msg.content.some((_, j) =>
      toStrip.has(`${idx}:${j}`),
    );
    if (!hasStripTarget) return msg;

    return {
      ...msg,
      content: msg.content.map((block, j) => {
        if (
          toStrip.has(`${idx}:${j}`) &&
          block.type === "tool_result" &&
          typeof block.content === "string"
        ) {
          return {
            ...block,
            content: block.content.replace(
              AX_TREE_PATTERN,
              AX_TREE_PLACEHOLDER,
            ),
          };
        }
        return block;
      }),
    };
  });
}

/**
 * Strip image contentBlocks from all tool_result blocks except those in the
 * most recent user message that contains tool_result blocks. This prevents
 * screenshots from accumulating in the context window — each image is seen
 * once by the LLM on the turn it was captured, then replaced with a text
 * placeholder on subsequent turns.
 *
 * We target the last user message with tool_results (not just the last user
 * message) because a plain-text user message may follow the tool-result
 * turn. Using the last user message unconditionally would leave the most
 * recent tool screenshots unprotected from stripping.
 */
function stripOldImageBlocks(history: Message[]): Message[] {
  // Find the last user message that contains tool_result blocks.
  let lastToolResultUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].role === "user" &&
      history[i].content.some((b) => b.type === "tool_result")
    ) {
      lastToolResultUserIdx = i;
      break;
    }
  }

  return history.map((msg, idx) => {
    // Keep the most recent tool-result user message intact (current turn)
    if (idx === lastToolResultUserIdx || msg.role !== "user") return msg;

    // Check if any tool_result blocks have image contentBlocks
    const hasImages = msg.content.some(
      (b) =>
        b.type === "tool_result" &&
        (b as ToolResultContent).contentBlocks?.some(
          (cb) => cb.type === "image",
        ),
    );
    if (!hasImages) return msg;

    // Strip images from tool_result blocks, replacing with text marker
    return {
      ...msg,
      content: msg.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const tr = b as ToolResultContent;
        if (!tr.contentBlocks?.some((cb) => cb.type === "image")) return b;
        return {
          ...tr,
          contentBlocks: undefined,
          content:
            (tr.content || "") +
            "\n[Screenshot was captured and shown previously — image data removed to save context.]",
        };
      }),
    };
  });
}
