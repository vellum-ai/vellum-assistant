import * as Sentry from "@sentry/node";

import { backgroundToolManager } from "../agent/background-tool-manager.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { estimateToolsTokens } from "../context/token-estimator.js";
import { truncateOversizedToolResults } from "../context/tool-result-truncation.js";
import { getHookManager } from "../hooks/manager.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ToolDefinition,
} from "../providers/types.js";
import type { ToolResultContent } from "../providers/types.js";
import type { SensitiveOutputBinding } from "../tools/sensitive-output-placeholders.js";
import {
  applyStreamingSubstitution,
  applySubstitutions,
} from "../tools/sensitive-output-placeholders.js";
import type { Tool, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-loop");

export interface AgentLoopConfig {
  maxTokens: number;
  maxInputTokens?: number; // context window size for tool result truncation
  thinking?: { enabled: boolean };
  effort: "low" | "medium" | "high" | "max";
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
  | { type: "server_tool_complete"; toolUseId: string; isError: boolean }
  | {
      type: "tool_deferred_to_background";
      executionId: string;
      toolName: string;
      toolUseId: string;
      elapsedMs: number;
    }
  | {
      type: "background_tool_completed";
      executionId: string;
      toolName: string;
      toolUseId: string;
      result: string;
      isError: boolean;
      durationMs: number;
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
    };

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTokens: 16000,
  effort: "high",
  minTurnIntervalMs: 150,
};

const MAX_CONSECUTIVE_ERROR_NUDGES = 3;

/**
 * Callback type for scheduling a background tool check-in.
 * Implemented by the conversation layer (PR 6). The agent loop
 * calls this when a tool result contains `scheduleCheckIn`.
 */
export type ScheduleCheckInCallback = (checkIn: {
  afterSeconds: number;
  executionId: string;
  conversationId: string;
}) => void;

export interface ResolvedSystemPrompt {
  systemPrompt: string;
  maxTokens?: number;
  model?: string;
}

export class AgentLoop {
  private provider: Provider;
  private systemPrompt: string;
  private config: AgentLoopConfig;
  private tools: ToolDefinition[];
  private resolveTools: ((history: Message[]) => ToolDefinition[]) | null;
  private resolveSystemPrompt:
    | ((history: Message[]) => ResolvedSystemPrompt)
    | null;
  private toolExecutor:
    | ((
        name: string,
        input: Record<string, unknown>,
        onOutput?: (chunk: string) => void,
        toolUseId?: string,
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
        scheduleCheckIn?: {
          afterSeconds: number;
          executionId: string;
          conversationId: string;
        };
      }>)
    | null;
  /** Optional lookup for Tool objects — used to check deferralExempt. */
  private getToolByName: ((name: string) => Tool | undefined) | null;

  constructor(
    provider: Provider,
    systemPrompt: string,
    config?: Partial<AgentLoopConfig>,
    tools?: ToolDefinition[],
    toolExecutor?: (
      name: string,
      input: Record<string, unknown>,
      onOutput?: (chunk: string) => void,
      toolUseId?: string,
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
      scheduleCheckIn?: {
        afterSeconds: number;
        executionId: string;
        conversationId: string;
      };
    }>,
    resolveTools?: (history: Message[]) => ToolDefinition[],
    resolveSystemPrompt?: (history: Message[]) => ResolvedSystemPrompt,
    getToolByName?: (name: string) => Tool | undefined,
  ) {
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tools = tools ?? [];
    this.resolveTools = resolveTools ?? null;
    this.resolveSystemPrompt = resolveSystemPrompt ?? null;
    this.toolExecutor = toolExecutor ?? null;
    this.getToolByName = getToolByName ?? null;
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
    const tools =
      history && this.resolveTools ? this.resolveTools(history) : this.tools;
    return estimateToolsTokens(tools);
  }

  async run(
    messages: Message[],
    onEvent: (event: AgentEvent) => void | Promise<void>,
    signal?: AbortSignal,
    requestId?: string,
    onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    conversationId?: string,
    scheduleCheckInCallback?: ScheduleCheckInCallback,
  ): Promise<Message[]> {
    const history = [...messages];
    let toolUseTurns = 0;
    let consecutiveErrorTurns = 0;
    let lastLlmCallTime = 0;
    const rlog = requestId ? log.child({ requestId }) : log;

    // Per-run substitution map for sensitive output placeholders.
    // Bindings are accumulated from tool results; placeholders are
    // resolved in streamed deltas and final assistant message text.
    const substitutionMap = new Map<string, string>();
    let streamingPending = "";

    // Check the tool-deferral feature flag once per run.
    const deferralEnabled = isAssistantFeatureFlagEnabled(
      "tool-deferral",
      getConfig(),
    );

    while (true) {
      if (signal?.aborted) break;

      // Auto-inject completed background results at the top of each
      // iteration (before sending to the provider). Only when deferral
      // is enabled and we have a conversationId.
      if (deferralEnabled && conversationId) {
        const completedBgExecs =
          backgroundToolManager.drainCompleted(conversationId);
        if (completedBgExecs.length > 0) {
          const injectionBlocks: ContentBlock[] = [];
          for (const exec of completedBgExecs) {
            const resultContent = exec.result?.content ?? "No result available";
            const isError = exec.result?.isError ?? false;
            const durationMs = Date.now() - exec.startedAt;
            injectionBlocks.push({
              type: "text",
              text: `<background_tool_result execution_id="${exec.executionId}" tool="${exec.toolName}" tool_use_id="${exec.toolUseId}" status="${isError ? "error" : "success"}" duration_ms="${durationMs}">\n${resultContent}\n</background_tool_result>`,
            });
            onEvent({
              type: "background_tool_completed",
              executionId: exec.executionId,
              toolName: exec.toolName,
              toolUseId: exec.toolUseId,
              result: resultContent,
              isError,
              durationMs,
            });
          }

          // Prepend to the last user message's content blocks if available,
          // otherwise add a new user message
          const lastMsg = history[history.length - 1];
          if (lastMsg?.role === "user") {
            lastMsg.content = [...injectionBlocks, ...lastMsg.content];
          } else {
            history.push({ role: "user", content: injectionBlocks });
          }
        }
      }

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
        const turnMaxTokens = resolved?.maxTokens ?? this.config.maxTokens;
        const turnModel = resolved?.model;

        const providerConfig: Record<string, unknown> = {
          max_tokens: turnMaxTokens,
        };
        if (turnModel) {
          providerConfig.model = turnModel;
        }
        if (this.config.thinking?.enabled) {
          providerConfig.thinking = { type: "adaptive" };
        }

        if (this.config.effort) {
          providerConfig.effort = this.config.effort;
        }

        if (this.config.speed && this.config.speed !== "standard") {
          providerConfig.speed = this.config.speed;
        }

        if (this.config.toolChoice) {
          providerConfig.tool_choice = this.config.toolChoice;
        }

        if (this.config.cacheTtl) {
          providerConfig.cacheTtl = this.config.cacheTtl;
        }

        const preLlmResult = await getHookManager().trigger("pre-llm-call", {
          systemPrompt: turnSystemPrompt,
          messages: history,
          toolCount: currentTools.length,
        });

        if (preLlmResult.blocked) {
          onEvent({
            type: "error",
            error: new Error(
              `LLM call blocked by hook "${preLlmResult.blockedBy}"`,
            ),
          });
          break;
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

        // Strip image contentBlocks from older tool results to prevent
        // screenshots from accumulating in the context window. The LLM
        // already saw each image on the turn it was captured; keeping
        // base64 blobs in history rapidly exhausts the context budget.
        // Also strip old AX tree snapshots to keep TTFT from growing
        // linearly with step count in computer-use sessions.
        const providerHistory = compactAxTreeHistory(
          stripOldImageBlocks(history),
        );

        const response = await this.provider.sendMessage(
          providerHistory,
          currentTools.length > 0 ? currentTools : undefined,
          turnSystemPrompt,
          {
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
                });
              }
            },
            signal,
          },
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
        });

        void getHookManager().trigger("post-llm-call", {
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          contentBlockCount: response.content.length,
          durationMs: providerDurationMs,
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
        history.push(assistantMessage);

        await onEvent({ type: "message_complete", message: assistantMessage });

        // Check for tool use
        toolUseBlocks = response.content.filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use",
        );

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
        type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
        type ToolResultPair = {
          toolUse: ToolUseBlock;
          result: ToolExecutionResult;
        };

        // Determine if all tools in this batch are deferral-exempt.
        // If so, skip the threshold race even when deferral is enabled.
        const allDeferralExempt =
          deferralEnabled &&
          this.getToolByName != null &&
          toolUseBlocks.every((toolUse) => {
            const toolObj = this.getToolByName!(toolUse.name);
            return toolObj?.deferralExempt === true;
          });

        // Should we apply deferral racing for this batch?
        const applyDeferral =
          deferralEnabled && conversationId != null && !allDeferralExempt;

        // Track which individual promises have settled (used for deferral)
        const settled = new Map<number, ToolResultPair>();
        const toolExecutions = toolUseBlocks.map(async (toolUse, idx) => {
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
          );
          settled.set(idx, { toolUse, result });
          return { toolUse, result };
        });
        const toolExecutionPromise = Promise.all(toolExecutions);

        let toolResults: ToolResultPair[];

        if (applyDeferral) {
          // Race the batch against the deferral threshold timer
          const thresholdMs =
            getConfig().timeouts.toolDeferralThresholdSec * 1000;
          let thresholdHandle: ReturnType<typeof setTimeout>;
          const thresholdTimer = new Promise<"threshold">((resolve) => {
            thresholdHandle = setTimeout(
              () => resolve("threshold"),
              thresholdMs,
            );
          });

          // Also race against abort if an abort signal is provided
          let abortHandler: (() => void) | undefined;
          const racers: Promise<
            | { type: "all_complete"; results: ToolResultPair[] }
            | { type: "threshold" }
            | { type: "aborted" }
          >[] = [
            toolExecutionPromise.then((results) => ({
              type: "all_complete" as const,
              results,
            })),
            thresholdTimer.then(() => ({ type: "threshold" as const })),
          ];
          if (signal && !signal.aborted) {
            const abortPromise = new Promise<{ type: "aborted" }>((resolve) => {
              abortHandler = () => resolve({ type: "aborted" as const });
              signal.addEventListener("abort", abortHandler, { once: true });
            });
            racers.push(abortPromise);
          }

          const raceResult = await Promise.race(racers);
          clearTimeout(thresholdHandle!);
          if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
          }

          if (raceResult.type === "aborted") {
            // Cancelled — suppress unhandled rejections and synthesize cancellation
            toolExecutionPromise.catch(() => {});
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

          if (raceResult.type === "all_complete") {
            // All tools completed before threshold — proceed as normal
            toolResults = raceResult.results;
          } else {
            // Threshold fired — partition into completed and still-running
            const completedResults: ToolResultPair[] = [];
            const resultBlocks: ContentBlock[] = [];

            for (let idx = 0; idx < toolUseBlocks.length; idx++) {
              const toolUse = toolUseBlocks[idx];
              const completedPair = settled.get(idx);
              if (completedPair) {
                completedResults.push(completedPair);
                // Build a real tool_result block
                resultBlocks.push({
                  type: "tool_result" as const,
                  tool_use_id: toolUse.id,
                  content: completedPair.result.content,
                  is_error: completedPair.result.isError,
                  ...(completedPair.result.contentBlocks
                    ? { contentBlocks: completedPair.result.contentBlocks }
                    : {}),
                });
                // Merge sensitive bindings from completed results
                if (completedPair.result.sensitiveBindings) {
                  for (const binding of completedPair.result
                    .sensitiveBindings) {
                    substitutionMap.set(binding.placeholder, binding.value);
                  }
                }
                // Emit tool_result event for the completed tool
                onEvent({
                  type: "tool_result",
                  toolUseId: toolUse.id,
                  content: completedPair.result.content,
                  isError: completedPair.result.isError,
                  diff: completedPair.result.diff,
                  status: completedPair.result.status,
                  contentBlocks: completedPair.result.contentBlocks,
                });
              } else {
                // Still running — register with background manager and build placeholder
                backgroundToolManager.register({
                  executionId: toolUse.id,
                  toolName: toolUse.name,
                  toolUseId: toolUse.id,
                  conversationId: conversationId!,
                  startedAt: Date.now() - thresholdMs,
                  promise: toolExecutions[idx].then((pair) => pair.result),
                });
                resultBlocks.push({
                  type: "tool_result" as const,
                  tool_use_id: toolUse.id,
                  content: `This tool is still running in the background (execution_id: ${toolUse.id}).\nElapsed: ${Math.round(thresholdMs / 1000)}s. Use background_tool_control to wait longer, check status, or cancel it.`,
                  is_error: false,
                });
                onEvent({
                  type: "tool_deferred_to_background",
                  executionId: toolUse.id,
                  toolName: toolUse.name,
                  toolUseId: toolUse.id,
                  elapsedMs: thresholdMs,
                });
              }
            }

            // Pre-emptively truncate oversized tool results in the deferral
            // path, matching the non-deferral path's truncation behavior.
            const { blocks: truncatedResultBlocks, truncatedCount } =
              truncateOversizedToolResults(
                resultBlocks,
                this.config.maxInputTokens ?? 180_000,
              );
            if (truncatedCount > 0) {
              log.warn(
                `Truncated ${truncatedCount} oversized tool result(s) in deferral path to prevent context overflow`,
              );
            }

            // Append system notice about deferred tools (after truncation so
            // the notice text block is not subject to truncation)
            truncatedResultBlocks.push({
              type: "text",
              text: `<system_notice>One or more tool executions exceeded the ${Math.round(thresholdMs / 1000)}s deferral threshold and are now running in the background. You have full agency — you can respond to the user, call other tools, or use background_tool_control to wait longer, check status, or cancel background executions. Each deferred tool's placeholder result above includes its execution_id.</system_notice>`,
            });

            // Suppress unhandled rejections from background promises
            toolExecutionPromise.catch(() => {});

            // Push combined result blocks into history
            history.push({ role: "user", content: truncatedResultBlocks });
            toolUseTurns++;

            // Handle scheduleCheckIn from completed results
            if (scheduleCheckInCallback) {
              for (const { result } of completedResults) {
                if (result.scheduleCheckIn) {
                  scheduleCheckInCallback(result.scheduleCheckIn);
                }
              }
            }

            // If any completed tool result requests yielding to the user,
            // push results and stop the loop (matching non-deferral path).
            if (completedResults.some(({ result }) => result.yieldToUser)) {
              break;
            }

            // Invoke checkpoint callback after tool results are in history
            if (onCheckpoint) {
              const decision = onCheckpoint({
                turnIndex: toolUseTurns - 1,
                toolCount: toolUseBlocks.length,
                hasToolUse: true,
                history,
              });
              if (decision === "yield") {
                break;
              }
            }

            continue;
          }
        } else {
          // Non-deferral path: original blocking Promise.all with abort racing
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
        }

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

        // Pre-emptively truncate oversized tool results to prevent context overflow
        const { blocks: resultBlocks, truncatedCount } =
          truncateOversizedToolResults(
            rawResultBlocks,
            this.config.maxInputTokens ?? 180_000,
          );
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

        // Handle scheduleCheckIn from tool results
        if (scheduleCheckInCallback) {
          for (const { result } of toolResults) {
            if (result.scheduleCheckIn) {
              scheduleCheckInCallback(result.scheduleCheckIn);
            }
          }
        }

        // When any tool returned an error, nudge the LLM to retry with
        // corrected parameters instead of ending its turn. Skip the nudge
        // after MAX_CONSECUTIVE_ERROR_NUDGES consecutive error turns
        // (the error is likely unrecoverable at that point).
        const hasToolError = toolResults.some(({ result }) => result.isError);
        if (hasToolError) {
          consecutiveErrorTurns++;
        } else {
          consecutiveErrorTurns = 0;
        }
        if (
          hasToolError &&
          consecutiveErrorTurns <= MAX_CONSECUTIVE_ERROR_NUDGES
        ) {
          resultBlocks.push({
            type: "text",
            text: "<system_notice>One or more tool calls returned an error. If the error looks recoverable (e.g. missing or invalid parameters), fix the parameters and retry. If the error is clearly unrecoverable (e.g. a service is down, a resource does not exist, or a permission is permanently denied), report it to the user.</system_notice>",
          });
        }

        // Add tool results as a user message and continue the loop
        history.push({ role: "user", content: resultBlocks });

        // Invoke checkpoint callback after tool results are in history
        if (onCheckpoint) {
          const decision = onCheckpoint({
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
        Sentry.captureException(err);
        onEvent({ type: "error", error: err });
        break;
      }
    }

    // Note: cleanup of background tool state is handled by the conversation
    // lifecycle teardown (conversation.ts abort path). We intentionally do NOT
    // cleanup here because running background executions must survive across
    // run() calls so drainCompleted() can pick them up on the next turn.

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
