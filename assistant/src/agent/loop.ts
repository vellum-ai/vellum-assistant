import * as Sentry from "@sentry/node";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { stripInjectionsForCompaction } from "../context/strip-injections.js";
import {
  estimatePromptTokensRaw,
  estimatePromptTokensWithTools,
  estimateToolsTokens,
  getCalibrationProviderKey,
} from "../context/token-estimator.js";
import type { InboundActorContext } from "../daemon/conversation-runtime-assembly.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { stripHistoricalWebSearchResults } from "../daemon/web-search-history.js";
import { HOOKS } from "../plugin-api/constants.js";
import type {
  PostModelCallContext,
  PostToolUseContext,
  PreModelCallContext,
  StopContext,
} from "../plugin-api/types.js";
import { defaultCompact } from "../plugins/defaults/compaction/compact.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import postCompact from "../plugins/defaults/memory-retrieval/hooks/post-compact.js";
import { runHook } from "../plugins/pipeline.js";
import type { CompactionCircuitEvent } from "../plugins/types.js";
import { normalizeThinkingConfigForWire } from "../providers/thinking-config.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
  ToolResultContent,
} from "../providers/types.js";
import type { SensitiveOutputBinding } from "../tools/sensitive-output-placeholders.js";
import {
  applyStreamingSubstitution,
  applySubstitutions,
} from "../tools/sensitive-output-placeholders.js";
import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { isRetryableNetworkError } from "../util/retry.js";
import { CompactionCircuit } from "./compaction-circuit.js";

const log = getLogger("agent-loop");

/** Fraction of the preflight budget at which a checkpoint triggers mid-loop compaction. */
const MID_LOOP_YIELD_THRESHOLD_RATIO = 0.85;

/** In-context message count above which the budget gate raises the safety-margin floor. */
const LONG_HISTORY_MESSAGE_THRESHOLD = 50;
const LONG_HISTORY_SAFETY_MARGIN_FLOOR = 0.15;

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

/**
 * Why a checkpoint paused the loop. Surfaced back to the caller via
 * {@link AgentLoopRunResult.exitReason} so the orchestrator reacts to
 * the loop's own signal (hand off to a queued message vs. compact and
 * re-enter) instead of the checkpoint callback mutating orchestrator state.
 */
export type ExitReason = "handoff" | "budget";

export type CheckpointDecision = "continue" | ExitReason;

/** Result of {@link AgentLoop.run}. */
export interface AgentLoopRunResult {
  /** Full conversation history after the run, including everything appended this run. */
  history: Message[];
  /**
   * Reason the loop paused at a checkpoint, or `null` on a terminal stop
   * (completion, error, abort, or a tool-requested yield-to-user).
   */
  exitReason: ExitReason | null;
  /**
   * Whether the loop produced at least one new assistant message this run —
   * the forward-progress signal for the ordering-error retry gate and the
   * overflow convergence fold (immune to in-loop compaction shrinking history
   * below a pre-run length).
   */
  appendedNewMessages: boolean;
  /**
   * Slice of `history` appended this run, measured from the loop's input or
   * from the compacted base when it compacts in place. The loop owns this
   * boundary, so it cannot desync the way an externally-held index can.
   */
  newMessages: Message[];
}

/**
 * Why an agent turn reached a terminal state.
 *
 * Emitted as part of an {@link AgentEvent} of type `agent_loop_exit`, then
 * persisted onto the **final** `llm_request_logs` row of the turn. Rows from
 * intermediate turns keep a NULL `agent_loop_exit_reason`, which is how
 * downstream tooling (and the LLM Context Inspector) distinguishes "loop kept
 * going" from "loop is done".
 *
 * Values are stable wire/DB strings — they are written to SQLite and
 * surfaced over the inspector wire format, so renaming any of them is a
 * breaking change.
 *
 * Keep in sync with `emitExit` call sites in {@link AgentLoop.run} and the
 * outer conversation orchestrator paths that terminate after a checkpoint
 * yield. A checkpoint yield used for budget compaction is intentionally not
 * a terminal reason — it is a control transfer before re-entering the loop.
 */
export type AgentLoopExitReason =
  /** `if (signal?.aborted) break;` at the top of the loop. */
  | "aborted_pre_call"
  /** Assistant message has no tool-use blocks (or no tool executor). */
  | "no_tool_calls"
  /** Signal aborted while building the user-side tool-results message. */
  | "aborted_post_response"
  /** Signal aborted mid-tool-execution; completed results were pushed. */
  | "aborted_during_tools"
  /** A tool result requested handing back to the user. */
  | "yield_to_user"
  /** The orchestrator yielded at checkpoint to process a queued message. */
  | "checkpoint_handoff"
  /** Context-window recovery exhausted and the turn ended with an error. */
  | "context_too_large"
  /**
   * Auto-compress rerun (post-emergency-compaction, post-tier reducer)
   * still yielded at the mid-loop budget checkpoint — the turn silently
   * terminated with no further recovery layer to re-enter. Pure
   * observability signal so the silent stall is attributable instead of
   * leaving `agent_loop_exit_reason` NULL.
   */
  | "budget_yield_unrecovered"
  /** Provider stopped because the configured output-token limit was reached. */
  | "max_tokens_reached"
  /** User cancellation landed after a non-terminal checkpoint yield. */
  | "aborted_after_checkpoint"
  /** Signal aborted while the catch handler was synthesizing an error turn. */
  | "aborted_via_error"
  /** Catch-block fallback: an unhandled error broke the loop. */
  | "error";

export type AgentEvent =
  /**
   * Emitted once per LLM call inside the loop, immediately before the
   * `provider.sendMessage` invocation. Carries the optional `callSite` tag so
   * downstream handlers (the daemon's persistence pipeline) can decide
   * whether to reserve a row for this call. One `llm_call_started` precedes
   * every `message_complete` for the same call; multi-call agent turns emit
   * one pair per call.
   */
  | { type: "llm_call_started"; callSite?: LLMCallSite }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "message_complete"; message: Message }
  | { type: "max_tokens_reached"; stopReason: string }
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
      matchedTrustRuleId?: string;
      isContainerized?: boolean;
      riskScopeOptions?: Array<{ pattern: string; label: string }>;
      riskAllowlistOptions?: Array<{
        label: string;
        description: string;
        pattern: string;
      }>;
      riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
      approvalMode?: string;
      approvalReason?: string;
      riskThreshold?: string;
      activityMetadata?: ToolActivityMetadata;
      /**
       * Set when the loop synthesizes this result for a tool_use that never
       * executed (a "Cancelled by user" block on abort). The daemon still
       * captures it into `pendingToolResults` and forwards it to the client,
       * but skips the side effects that assume the tool ran — marking the
       * workspace dirty and emitting a post-tool "thinking" activity state.
       */
      cancelled?: boolean;
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
      /**
       * Finalized input for the server tool (e.g. the actual web-search
       * query). Carried through so the daemon can populate accurate activity
       * metadata; Anthropic streams server-tool input via deltas that aren't
       * resolved at `server_tool_start` time.
       */
      resolvedInput?: Record<string, unknown>;
      /** Provider-specific error code (e.g. `max_uses_exceeded`). */
      errorCode?: string;
      /** Optional human-readable error message from the provider. */
      errorMessage?: string;
    }
  | { type: "error"; error: Error }
  | {
      /**
       * Emitted when the provider call throws — i.e. the provider
       * rejected the request before returning a usable response. Carries
       * the loop-level raw request we attempted to send (messages, tools,
       * system prompt, provider-agnostic config) plus the thrown error.
       * Consumers (`handleProviderError` in the daemon handlers, the
       * `onEvent` in `agent-wake`) persist these as `llm_request_logs`
       * rows so failed calls are queryable in the LLM inspector instead
       * of only surfacing in pino logs.
       *
       * `rawRequest` is the loop-level abstract shape rather than the
       * provider-specific payload (which the provider builds internally
       * and never returns when it throws). `actualProvider` echoes the
       * `ProviderError.provider` tag when available so the persisted row
       * has the same `provider` column value as a successful `usage` row.
       *
       * Re-thrown by the inner LLM-call try/catch after emission so the
       * outer agent-loop catch still handles abort, Sentry capture, the
       * existing `error` event, and the loop break.
       */
      type: "provider_error";
      rawRequest: unknown;
      error: Error;
      actualProvider?: string;
    }
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
    }
  | {
      /**
       * Emitted when the loop begins compacting the running history because
       * the mid-loop budget gate tripped. The daemon's event dispatcher
       * translates it into a "compacting context" activity state so clients
       * surface that the turn paused to summarize context.
       */
      type: "context_compacting";
    }
  | {
      /**
       * Emitted after the loop's inline mid-loop compaction pipeline runs,
       * immediately before re-injection — whether or not the pipeline actually
       * compacted. The daemon's event dispatcher always commits `basis` (the
       * stripped pre-compaction history) as the conversation's durable message
       * state, so re-injection ({@link postCompact}) re-applies
       * injections onto the stripped base rather than stacking on top of the
       * still-injected messages. When `result.compacted` is set it
       * additionally commits the durable compaction result (DB-record fields,
       * graph-memory side effects, SSE) and flips the per-turn re-injection
       * guards on the handler state.
       *
       * Treated as a critical event: a failed durable commit re-throws so the
       * turn aborts rather than re-injecting against half-applied state.
       *
       * `basis` is the stripped pre-compaction history the summary was built
       * from; the dispatcher uses it to project Slack provenance onto the
       * compacted result.
       */
      type: "compaction_completed";
      result: ContextWindowResult;
      basis: Message[];
    }
  | {
      /**
       * Emitted right after the loop strips runtime injections from the
       * running history, before the compaction pipeline runs. The daemon's
       * event dispatcher records the history-stripped marker — a Conversation
       * DB-record field read back at load time to strip embedded injection
       * prefixes from pre-strip messages. Best-effort: a transient marker
       * write must not abort the turn, so unlike `compaction_completed` this
       * event is not treated as critical.
       */
      type: "history_stripped";
    }
  /**
   * Circuit-breaker transitions emitted when auto-compaction is paused
   * (`compaction_circuit_open`, after three consecutive summary-LLM
   * failures) or resumed (`compaction_circuit_closed`). These are already
   * in wire-contract shape; the daemon's event dispatcher forwards them to
   * the client unchanged so the "auto-compaction paused" banner shows and
   * dismisses.
   */
  | CompactionCircuitEvent
  | {
      /**
       * Emitted when an agent turn reaches a terminal state. Checkpoint
       * yields used for orchestration (handoff or budget compaction) are not
       * emitted by {@link AgentLoop.run}; the outer orchestrator emits a
       * terminal reason only if that control transfer truly ends the turn.
       * Consumers persist `reason` onto the final `llm_request_logs` row;
       * intermediate rows keep `agent_loop_exit_reason = NULL`, which is the
       * canonical "loop kept going" signal.
       */
      type: "agent_loop_exit";
      reason: AgentLoopExitReason;
    };

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTokens: 64000,
  effort: "high",
  minTurnIntervalMs: 150,
};

const MAX_STOP_CONTINUE_RETRIES = 1;
const MAX_TOKENS_STOP_REASONS = new Set([
  "length",
  "max_output_tokens",
  "max_tokens",
]);

export function isMaxTokensStopReason(
  stopReason: string | null | undefined,
): boolean {
  if (!stopReason) return false;
  return MAX_TOKENS_STOP_REASONS.has(stopReason.trim().toLowerCase());
}

/**
 * Concatenate the text of an assistant message's `text` blocks (ignoring
 * `tool_use`, `thinking`, and other non-text blocks). Used to re-emit the
 * finalized text as a single `text_delta` when a turn's live output was
 * deferred by a `pre-model-call` hook.
 */
function assistantTextOf(content: ReadonlyArray<ContentBlock>): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
  }
  return text;
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

export interface AgentLoopRunOptions {
  /** Input history the run starts from; the loop appends its output onto a copy. */
  messages: Message[];
  /** Sink the loop streams its {@link AgentEvent}s through as the turn runs. */
  onEvent: (event: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
  requestId?: string;
  onCheckpoint?: (
    checkpoint: CheckpointInfo,
  ) => CheckpointDecision | Promise<CheckpointDecision>;
  callSite?: LLMCallSite;
  /**
   * Trust classification and channel identity for the turn's inbound actor,
   * supplied by the caller as the turn-start snapshot. Read only on the
   * mid-loop in-place compaction path — to scope the compactor's image
   * manifest (guardian-only attachments are excluded for untrusted actors) and
   * forwarded to {@link postCompact}. Callers without a meaningful actor (agent
   * wakes, standalone unit tests) pass an `unknown`-class snapshot so the
   * compactor fail-closes to excluding guardian-only attachments.
   */
  trust: TrustContext;
  /**
   * Ad-hoc inference-profile override applied to every LLM call the loop
   * issues. When set, each `SendMessageOptions.config` carries
   * `overrideProfile = <name>` so the provider's resolver layers
   * `llm.profiles[<name>]` between the workspace `activeProfile` and any
   * call-site named profile. Missing profile names silently fall through.
   */
  overrideProfile?: string;
  resolveOverrideProfile?: () => string | undefined;
  /**
   * Resolves the orchestrator's effective context window for this turn: the
   * provider max-input-token ceiling (read by tool-result truncation) plus the
   * `overflowRecovery` config that drives the mid-loop budget gate. Resolved
   * fresh per checkpoint so a mid-turn profile change is reflected. Absent →
   * truncation falls back to `this.config.maxInputTokens` and the budget gate
   * is skipped (agent wakes pass `overflowRecovery.enabled = false`).
   */
  resolveContextWindow?: () => {
    maxInputTokens: number;
    overflowRecovery: { enabled: boolean; safetyMarginRatio: number };
  };
  /**
   * When `true`, the loop owns turn-start and mid-loop compaction. The pre-call
   * budget gate runs before the very first provider call — subsuming the
   * proactive turn-start compaction the orchestrator would otherwise perform
   * inline before `run()` — as well as before each tool-use re-entry. When the
   * gate trips it compacts the running history in place, re-applying runtime
   * injections via the default post-compaction hook ({@link postCompact}), and
   * continues instead of yielding `exitReason = "budget"`.
   *
   * The first-call pass honors the compaction circuit breaker and proceeds with
   * the call whether or not it compacted (preflight-overflow recovery and the
   * convergence loop remain the escalation path), so it never yields on the
   * first call. Reruns without an inline compaction path (agent wakes,
   * convergence/auto-compress reruns) leave it `false`: they skip the
   * first-call gate and keep yielding for budget on mid-loop re-entries.
   * Defaults to `false` when omitted.
   */
  compactInPlace?: boolean;
  /**
   * Whether the in-flight turn has no human present to answer clarification
   * questions. Resolved once by the orchestrator at turn start and forwarded to
   * {@link postCompact} so post-compaction
   * re-injection uses the turn-start snapshot rather than re-reading mutable
   * client/headless state mid-turn. Defaults to `false` when omitted.
   */
  isNonInteractive?: boolean;
  /**
   * The `model_profile:` turn-context label resolved once by the orchestrator
   * at turn start, or `null` when the active inference profile is unchanged
   * since the last notified one. Forwarded to
   * {@link postCompact} so post-compaction re-injection
   * re-emits the turn-start value rather than re-deriving the change-detected
   * label (which flips once the notification is persisted mid-turn). Defaults to
   * `null` when omitted.
   */
  modelProfile?: string | null;
  /**
   * Inbound actor identity and trust fields for the unified `<turn_context>`
   * block, or `null` on guardian turns. Resolved once by the orchestrator at
   * turn start via the actor-trust resolver, whose contact/member registry
   * inputs can be mutated mid-turn by contact tools, and forwarded to
   * {@link postCompact} so post-compaction
   * re-injection re-emits the turn-start value rather than re-resolving it.
   * Defaults to `null` when omitted.
   */
  actorContext?: InboundActorContext | null;
}

/**
 * Callback shape the loop uses to execute a tool invocation.
 */
export type LoopToolExecutor = (
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
  riskLevel?: string;
  riskReason?: string;
  matchedTrustRuleId?: string;
  isContainerized?: boolean;
  riskScopeOptions?: Array<{ pattern: string; label: string }>;
  riskAllowlistOptions?: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
  approvalMode?: string;
  approvalReason?: string;
  riskThreshold?: string;
  activityMetadata?: ToolActivityMetadata;
}>;

export interface AgentLoopConstructorOptions {
  /** LLM provider the loop issues every call through. */
  provider: Provider;
  /** Base system prompt, before any per-turn dynamic resolution. */
  systemPrompt: string;
  config?: Partial<AgentLoopConfig>;
  tools?: ToolDefinition[];
  toolExecutor?: LoopToolExecutor;
  resolveTools?: (history: Message[]) => ToolDefinition[];
  resolveSystemPrompt?: (history: Message[]) => ResolvedSystemPrompt;
  /**
   * Conversation this loop drives. Scopes the loop-held compaction circuit
   * breaker and is the source of truth the loop's pipeline contexts and
   * post-compaction re-injection resolve the live conversation through.
   */
  conversationId: string;
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
  private toolExecutor: LoopToolExecutor | null;

  /**
   * Conversation this loop drives. Source of truth for the `conversationId`
   * the loop's pipeline contexts and post-compaction re-injection resolve the
   * live conversation through, so the loop knows its own identity without a
   * threaded-in turn context.
   */
  private readonly conversationId: string;

  /**
   * Loop-held compaction circuit breaker. The loop has a 1:1 lifetime with its
   * conversation, so it is the source of truth for the cross-turn failure
   * counter and cooldown deadline. Non-loop callers (the orchestrator's
   * compaction paths, `Conversation.forceCompact`, and the dev-only playground
   * routes) reach it via `agentLoop.compactionCircuit`.
   */
  readonly compactionCircuit: CompactionCircuit;

  constructor(options: AgentLoopConstructorOptions) {
    const {
      provider,
      systemPrompt,
      config,
      tools,
      toolExecutor,
      resolveTools,
      resolveSystemPrompt,
      conversationId,
    } = options;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tools = tools ?? [];
    this.resolveTools = resolveTools ?? null;
    this.resolveSystemPrompt = resolveSystemPrompt ?? null;
    this.toolExecutor = toolExecutor ?? null;
    this.conversationId = conversationId;
    this.compactionCircuit = new CompactionCircuit(this.conversationId);
  }

  /**
   * Resolve the tool definitions sent to the provider for the given turn.
   *
   * Mirrors the logic of {@link getToolTokenBudget} but returns the tool
   * array itself — callers that need to thread the tool set into the token
   * estimate (`estimatePromptTokensWithTools`, whose args include `tools`)
   * use this rather than re-implementing the dynamic-vs-static resolver fork.
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

  /**
   * Calibrated prompt-token estimate for `history`, including the
   * resolved-tool budget for the turn.
   */
  private estimateTokens(history: Message[]): number {
    return estimatePromptTokensWithTools(
      history,
      this.systemPrompt,
      this.getResolvedTools(history),
      getCalibrationProviderKey(this.provider),
    );
  }

  /**
   * Record a compaction outcome against the loop's circuit breaker. Three
   * consecutive failures trip a cooldown that suspends auto-compaction; a
   * success resets the counter. Any open/closed transition is emitted on the
   * loop's own event channel via `onEvent`.
   *
   * Bookkeeping is best-effort — a failure here must not turn a recoverable
   * compaction outcome into a user-visible turn failure.
   */
  private async recordCompactionOutcome(
    requestId: string | undefined,
    summaryFailed: boolean,
    onEvent: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    try {
      await this.compactionCircuit.recordOutcome(summaryFailed, onEvent);
    } catch (recordError) {
      log.error(
        { err: recordError, requestId },
        "Recording a compaction outcome against the circuit breaker failed; suppressing to keep the agent loop alive",
      );
    }
  }

  /**
   * Compact the running history in place when the mid-loop budget gate trips.
   *
   * Calls the default compaction plugin on the stripped history, then
   * re-applies injections via the supplied hooks. Returns the history to
   * continue from, or `null` when the compactor exhausted its retry budget so
   * the caller yields `exitReason = "budget"` and the orchestrator escalates.
   */
  private async compact(
    history: Message[],
    requestId: string | undefined,
    trust: TrustContext,
    signal: AbortSignal | undefined,
    onEvent: (event: AgentEvent) => void | Promise<void>,
    overrideProfile: string | null,
    isNonInteractive: boolean,
    modelProfile: string | null,
    actorContext: InboundActorContext | null,
  ): Promise<Message[] | null> {
    await onEvent({ type: "context_compacting" });
    // Strip runtime injections so the compactor summarizes the raw persistent
    // messages.
    const rawHistory = stripInjectionsForCompaction(history);
    // Record the history-stripped marker right after stripping, before the
    // pipeline runs.
    await onEvent({ type: "history_stripped" });
    // The compaction module owns the per-conversation manager; pass the
    // conversation id and let `defaultCompact` resolve it from the store.
    // The mid-loop budget gate is reached only when this turn decides to
    // compact in place, so `force` past the auto-threshold check.
    // `actorTrustClass` comes from the turn's trust snapshot (the actor whose
    // turn triggered compaction) so the compactor's image manifest excludes
    // guardian-only attachments for untrusted actors. `overrideProfile` is the
    // turn's resolved inference-profile override for the summary call.
    const compactResult = await defaultCompact({
      conversationId: this.conversationId,
      messages: rawHistory,
      signal,
      force: true,
      actorTrustClass: trust.trustClass,
      overrideProfile,
    });
    // `force: true` bypasses the auto-threshold gate, but early returns
    // for "no eligible messages" / "insufficient messages" still leave
    // `summaryFailed` undefined. Only record an outcome when the summary LLM
    // actually ran.
    if (compactResult.summaryFailed !== undefined) {
      await this.recordCompactionOutcome(
        requestId,
        compactResult.summaryFailed,
        onEvent,
      );
    }
    // Emit unconditionally: the dispatcher commits the stripped `basis` as the
    // durable message base whether or not the pipeline compacted (re-injection
    // reads it), and runs the durable compaction commit only when
    // `result.compacted`.
    await onEvent({
      type: "compaction_completed",
      result: compactResult,
      basis: rawHistory,
    });
    if (compactResult.exhausted ?? false) {
      return null;
    }
    // Re-inject onto the same base the `compaction_completed` dispatch commits:
    // the compacted messages when the pipeline compacted, the stripped
    // pre-compaction history otherwise.
    const injection = await postCompact({
      history: compactResult.compacted ? compactResult.messages : rawHistory,
      requestId,
      conversationId: this.conversationId,
      trust,
      isNonInteractive,
      // Mid-loop re-injection always runs at full injection volume.
      mode: "full",
      modelProfile,
      actorContext,
    });
    return injection.messages;
  }

  async run(options: AgentLoopRunOptions): Promise<AgentLoopRunResult> {
    const {
      messages,
      onEvent,
      signal,
      requestId,
      onCheckpoint,
      callSite,
      trust,
      overrideProfile,
      resolveOverrideProfile,
      resolveContextWindow,
      compactInPlace = false,
      isNonInteractive = false,
      modelProfile = null,
      actorContext = null,
    } = options;
    let history = [...messages];
    // Index into `history` where this run's appended output begins. It starts
    // after the input and resets to the compacted base whenever the loop
    // compacts in place, so `history.slice(newMessagesStart)` is always exactly
    // what the loop produced since the last (re-injected) base.
    let newMessagesStart = history.length;
    let producedVisibleTextThisRun = false;
    let toolUseTurns = 0;
    let stopContinueRetries = 0;
    let lastLlmCallTime = 0;
    let exitReason: ExitReason | null = null;
    let appendedNewMessages = false;
    // Armed at the end of a tool-use iteration so the budget gate runs at the
    // top of the NEXT iteration — before that iteration's provider call —
    // instead of after the current one. Stop-hook re-query continues re-enter
    // without arming, so the gate fires on exactly the same occasions as the
    // prior post-call placement, plus the first call when
    // `compactInPlace` is set (the primary run's turn-start compaction).
    let budgetGateArmed = compactInPlace;
    const rlog = requestId ? log.child({ requestId }) : log;

    // Resolve the inference-profile override that applies right now. The
    // optional resolver lets a turn observe a confirmed mid-turn profile switch
    // before the next model call; absent a resolver the turn-start value holds.
    const resolveEffectiveOverrideProfile = (): string | undefined =>
      resolveOverrideProfile ? resolveOverrideProfile() : overrideProfile;

    // Per-run substitution map for sensitive output placeholders.
    // Bindings are accumulated from tool results; placeholders are
    // resolved in streamed deltas and final assistant message text.
    const substitutionMap = new Map<string, string>();
    let streamingPending = "";

    // Idempotency guard for `emitExit`: the first reason stamped wins. A break
    // site that stamps a specific reason before unwinding into the catch
    // handler keeps that reason instead of the generic "error", and the guard
    // also defends against accidental double-emits if a new break site is
    // added without checking this.
    let exitReasonEmitted = false;
    const emitExit = async (reason: AgentLoopExitReason): Promise<void> => {
      if (exitReasonEmitted) return;
      exitReasonEmitted = true;
      await onEvent({ type: "agent_loop_exit", reason });
    };

    while (true) {
      if (signal?.aborted) {
        await emitExit("aborted_pre_call");
        break;
      }

      rlog.info(
        { turn: toolUseTurns, messageCount: history.length },
        "Agent loop iteration start",
      );

      let toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[] = [];

      try {
        // ── Pre-call budget gate ─────────────────────────────────────
        // When overflow recovery is enabled, estimate the running context
        // size as it approaches the preflight budget before issuing the
        // provider call. With `compactInPlace` the loop compacts in place and
        // proceeds with the call; otherwise it yields (`exitReason =
        // "budget"`) so the orchestrator can recover before the call risks a
        // hard context-too-large rejection. Keyed off the loop's own
        // `history.length` (the messages actually in context this turn,
        // including tool iterations) rather than the durable conversation
        // count.
        //
        // Armed after each tool-use iteration; stop-hook re-query continues
        // skip it. The first call runs it only when `compactInPlace` is set,
        // where it stands in for the orchestrator's turn-start compaction: it
        // honors the compaction circuit breaker and proceeds with the call
        // rather than yielding, since there is no prior turn output to
        // escalate.
        if (budgetGateArmed) {
          budgetGateArmed = false;
          // The gate only re-arms after a completed tool-use iteration
          // (`toolUseTurns` is incremented first), so reaching it with
          // `toolUseTurns === 0` uniquely identifies the first-call pass: it
          // compacts-or-proceeds (never yields) and honors the compaction
          // circuit breaker, matching the orchestrator's turn-start compaction.
          const isFirstCallGate = toolUseTurns === 0;
          const contextWindow = resolveContextWindow?.();
          if (contextWindow?.overflowRecovery.enabled) {
            const { maxInputTokens, overflowRecovery } = contextWindow;
            const safetyMargin =
              history.length > LONG_HISTORY_MESSAGE_THRESHOLD
                ? Math.max(
                    overflowRecovery.safetyMarginRatio,
                    LONG_HISTORY_SAFETY_MARGIN_FLOOR,
                  )
                : overflowRecovery.safetyMarginRatio;
            const preflightBudget = Math.floor(
              maxInputTokens * (1 - safetyMargin),
            );
            const midLoopThreshold =
              preflightBudget * MID_LOOP_YIELD_THRESHOLD_RATIO;
            const estimated = this.estimateTokens(history);
            if (estimated > midLoopThreshold) {
              let compactedInPlace = false;
              // The turn-start pass skips compaction while the circuit breaker
              // is open so a run of failed summaries doesn't keep hammering the
              // summary LLM; mid-loop compaction is force-driven and proceeds
              // regardless (it has already committed to compacting in place).
              const compactionAllowed =
                !isFirstCallGate || !(await this.compactionCircuit.isOpen());
              if (compactInPlace && compactionAllowed) {
                rlog.info(
                  {
                    turn: toolUseTurns,
                    estimated,
                    threshold: midLoopThreshold,
                  },
                  "Token estimate approaching budget — compacting in place",
                );
                const compacted = await this.compact(
                  history,
                  requestId,
                  trust,
                  signal,
                  onEvent,
                  resolveEffectiveOverrideProfile() ?? null,
                  isNonInteractive,
                  modelProfile,
                  actorContext,
                );
                if (compacted) {
                  history = compacted;
                  // The compacted, re-injected array is the new base; output
                  // produced after this point is what the orchestrator
                  // persists.
                  newMessagesStart = history.length;
                  compactedInPlace = true;
                }
              }
              // The turn-start gate proceeds with the call whether or not it
              // compacted (preflight-overflow recovery and the convergence loop
              // remain the escalation path); only mid-loop re-entries yield to
              // the orchestrator before the call.
              if (!compactedInPlace && !isFirstCallGate) {
                rlog.warn(
                  {
                    turn: toolUseTurns,
                    estimated,
                    threshold: midLoopThreshold,
                  },
                  "Token estimate approaching budget — yielding for compaction",
                );
                exitReason = "budget";
                break;
              }
            }
          }
        }

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

        // Cache-anchor signal for volatile latest-user-message turns: when
        // memory-v3 is live it injects a per-turn `<memory>` block into the
        // latest user message, so the provider must anchor its long-TTL cache
        // breakpoint on the most recent STABLE user message instead of the
        // volatile latest one. Read here alongside the rest of the provider
        // config; only set when true so the wire/config stays byte-identical
        // when off.
        if (isAssistantFeatureFlagEnabled("memory-v3-live", getConfig())) {
          providerConfig.mutableLatestUserMessage = true;
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
          providerConfig.usageTracking = "manual";
          // Per-conversation seed for deterministic `mix`-profile expansion.
          // Sourced from the loop's own conversation id so every LLM call in a
          // conversation resolves the same mix arm (stable across turns and
          // retries, and across daemon restarts since the seed is the durable
          // conversation id). Absent for standalone `AgentLoop` instances
          // (unit tests constructed without a conversation id) — those fall
          // back to per-call random mix selection.
          if (this.conversationId) {
            providerConfig.selectionSeed = this.conversationId;
          }
        }

        // Per-call inference-profile override. The resolver layers
        // `llm.profiles[overrideProfile]` between the workspace's
        // `activeProfile` and any call-site named profile. Threading it on
        // every send (rather than once at construction) keeps subagents that
        // share an `AgentLoop` instance but ought to inherit a different
        // profile correct — and matches how `callSite` is plumbed.
        const effectiveOverrideProfile = resolveEffectiveOverrideProfile();
        if (effectiveOverrideProfile) {
          providerConfig.overrideProfile = effectiveOverrideProfile;
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

        // Sanitize the outbound history right before sending: drop accumulated
        // media, collapse old AX-tree snapshots, and convert historical
        // web-search results to text. See {@link preModelCallSanitize}.
        const providerHistory = preModelCallSanitize(history);

        // A `pre-model-call` hook (below) can defer this turn's assistant
        // output; when set, the live text stream is held so an
        // `post-model-call` hook can emit the finalized (transformed) text
        // instead. Reset per model call.
        let deferAssistantOutput = false;

        // The `onEvent` wrapping below applies sensitive-output placeholder
        // substitution to streamed text while forwarding every other event
        // type through unchanged.
        const providerOptions: SendMessageOptions = {
          tools: currentTools.length > 0 ? currentTools : undefined,
          systemPrompt: turnSystemPrompt,
          config: providerConfig,
          onEvent: (event) => {
            if (event.type === "text_delta") {
              // Held when the turn's output is deferred — the final text is
              // emitted once, after the `post-model-call` hook runs.
              if (deferAssistantOutput) return;
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
                ...(event.resolvedInput
                  ? { resolvedInput: event.resolvedInput }
                  : {}),
                ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                ...(event.errorMessage
                  ? { errorMessage: event.errorMessage }
                  : {}),
              });
            }
          },
          signal,
        };

        // Let plugins edit the outbound request and opt this call into deferred
        // output streaming. Runs for every provider call; hooks self-gate on
        // call site / conversation. Fail-open: a throwing hook leaves the
        // request unchanged and streaming live.
        try {
          const preModelCtx: PreModelCallContext = {
            conversationId: this.conversationId,
            callSite,
            systemPrompt: providerOptions.systemPrompt,
            deferAssistantOutput: false,
            logger: rlog,
          };
          const finalPreModelCtx = await runHook(
            HOOKS.PRE_MODEL_CALL,
            preModelCtx,
          );
          providerOptions.systemPrompt = finalPreModelCtx.systemPrompt;
          // The hook owns the policy (it sees `callSite`/conversation and
          // self-gates); the loop honors whatever it decides.
          deferAssistantOutput = finalPreModelCtx.deferAssistantOutput;
        } catch (preModelCallError) {
          rlog.error(
            { err: preModelCallError },
            "pre-model-call hook failed — proceeding with the original request",
          );
        }

        // Announce the LLM-call boundary so downstream handlers (the
        // daemon's persistence pipeline) can reserve an empty assistant row
        // and stamp the resulting `messageId` onto every streaming event the
        // call emits. Emit as late as possible — after history stripping,
        // arg construction, and turn-context resolution — so the gap
        // between "we said the call started" and the actual provider HTTP
        // call is minimized. Awaited so the row is created and the
        // `assistant_turn_start` wire event reaches the client BEFORE the
        // provider starts streaming deltas — the deltas downstream will
        // carry the freshly-reserved id.
        await onEvent({ type: "llm_call_started", callSite });

        // Inner try/catch narrows error-recording scope to the provider
        // call itself. The outer agent-loop catch (below) wraps the entire
        // turn body (tool execution, plugin pipelines, checkpoints), so
        // recording there would risk mis-attributing tool/plugin throws as
        // provider rejections. On provider failure we emit `provider_error`
        // with the loop-level raw request so consumers can persist it as an
        // `llm_request_logs` row, then re-throw so the existing outer catch
        // continues to handle abort sync, Sentry capture, the `error` event,
        // and the loop break unchanged.
        let response: ProviderResponse;
        try {
          response = await this.provider.sendMessage(
            providerHistory,
            providerOptions,
          );
        } catch (llmCallError) {
          // Skip recording on abort — the user cancelled the request and
          // there's no provider rejection worth a log row. The outer catch
          // still synthesizes cancellation tool_results.
          if (!signal?.aborted) {
            const errInstance =
              llmCallError instanceof Error
                ? llmCallError
                : new Error(String(llmCallError));
            // Strip non-serializable / runtime-only fields from `options`
            // before snapshotting. `onEvent` is a closure with side effects
            // and `signal` is an AbortSignal — neither is meaningful in a
            // persisted log row, and `JSON.stringify` would silently drop or
            // misrepresent both.
            const rawRequest = {
              provider: this.provider.name,
              messages: providerHistory,
              tools: providerOptions.tools,
              systemPrompt: providerOptions.systemPrompt,
              config: providerOptions.config,
            };
            onEvent({
              type: "provider_error",
              rawRequest,
              error: errInstance,
              actualProvider:
                errInstance instanceof ProviderError
                  ? errInstance.provider
                  : this.provider.name,
            });
          }
          throw llmCallError;
        }

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

        // Run the `post-model-call` hook on a finalized message and, when
        // output was deferred, emit the finalized text once (with sensitive-output
        // substitution applied, matching the live stream). Fail-open: the hook
        // receives a clone, so a throw — even mid in-place mutation — leaves the
        // original message intact.
        const finalizeAssistantMessage = async (
          message: Message,
        ): Promise<Message> => {
          let finalized = message;
          try {
            const ctx: PostModelCallContext = {
              conversationId: this.conversationId,
              callSite,
              content: structuredClone(message.content),
              stopReason: response.stopReason,
              logger: rlog,
            };
            const result = await runHook(HOOKS.POST_MODEL_CALL, ctx);
            finalized = { role: "assistant", content: result.content };
          } catch (assistantMessageError) {
            rlog.error(
              { err: assistantMessageError },
              "post-model-call hook failed — keeping the original content",
            );
            finalized = message;
          }
          if (deferAssistantOutput) {
            // The persisted message keeps sensitive-output placeholders; the
            // stream shows real values — substitute before emitting.
            const finalText = applySubstitutions(
              assistantTextOf(finalized.content),
              substitutionMap,
            );
            if (finalText.length > 0) {
              onEvent({ type: "text_delta", text: finalText });
            }
          }
          return finalized;
        };

        // Build the assistant message with placeholder-only text.
        // Both provider history and persisted conversation store must retain
        // placeholders so the model never sees real sensitive values — neither
        // on subsequent loop turns nor on session reload from the database.
        // Substitution to real values happens only in streamed text_delta events.
        let assistantMessage: Message = {
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

        if (isMaxTokensStopReason(response.stopReason)) {
          const safeContent = response.content.filter(
            (block) =>
              block.type !== "tool_use" &&
              block.type !== "server_tool_use" &&
              block.type !== "web_search_tool_result",
          );
          rlog.warn(
            {
              turn: toolUseTurns,
              stopReason: response.stopReason,
              contentBlocks: response.content.length,
              safeContentBlocks: safeContent.length,
              toolUseCount: toolUseBlocks.length,
            },
            "LLM response reached output token limit",
          );
          // Run the hook on the truncated reply so output-filter plugins still
          // see it, and so a deferred turn gets its synthetic final emit (the
          // live stream was suppressed; without this the client would see nothing).
          const safeAssistantMessage = await finalizeAssistantMessage({
            role: "assistant",
            content: safeContent,
          });
          history.push(safeAssistantMessage);
          appendedNewMessages = true;
          await onEvent({
            type: "max_tokens_reached",
            stopReason: response.stopReason,
          });
          await onEvent({
            type: "message_complete",
            message: safeAssistantMessage,
          });
          await emitExit("max_tokens_reached");
          break;
        }

        // The model's "stop" moment: a response with no tool calls is about to
        // yield to the user. The `stop` hook (below) decides whether to accept
        // the turn or re-query with a follow-up; `priorAssistantHadVisibleText`
        // gates the ops log for the post-tool empty case.
        const hasVisibleText = response.content.some(
          (block) => block.type === "text" && block.text.trim().length > 0,
        );
        const priorAssistantHadVisibleText = producedVisibleTextThisRun;
        if (hasVisibleText) {
          producedVisibleTextThisRun = true;
        }

        if (toolUseBlocks.length === 0) {
          // The model stopped requesting tools — the run's stop boundary. The
          // `stop` hook decides whether to let the turn end or re-query with a
          // follow-up turn. It receives the full history and, when it asks to
          // continue, appends the follow-up turn itself.
          const stopCtx: StopContext = {
            conversationId: this.conversationId,
            messages: [...history],
            responseContent: response.content,
            stopReason: response.stopReason,
            decision: "stop",
            logger: rlog,
          };
          const finalStopCtx = await runHook(HOOKS.STOP, stopCtx);

          if (finalStopCtx.decision === "continue") {
            // The loop owns the retry budget: a hook always asks to continue
            // when a nudge is warranted, and the loop stops anyway once the
            // budget is spent. This bounds the hook-driven re-query loop.
            if (stopContinueRetries < MAX_STOP_CONTINUE_RETRIES) {
              stopContinueRetries++;
              rlog.warn(
                { turn: toolUseTurns, retry: stopContinueRetries },
                "Model returned empty response after tool results — retrying",
              );
              history = finalStopCtx.messages;
              continue;
            }

            // Budget spent — accept the empty turn. Emit a dedicated log line
            // for the post-tool empty case so ops dashboards that grep on it
            // keep working.
            if (
              !hasVisibleText &&
              toolUseTurns > 0 &&
              !priorAssistantHadVisibleText
            ) {
              rlog.error(
                { turn: toolUseTurns, retries: stopContinueRetries },
                "Model returned empty response after tool results — retries exhausted",
              );
            }
          }
        }

        // Run the `post-model-call` hook + emit any deferred final text.
        // On a no-tool turn this point is reached only after the `stop` hook
        // resolves to "stop" (a `continue` already re-queried above), so a
        // re-queried reply is never transformed-then-discarded.
        assistantMessage = await finalizeAssistantMessage(assistantMessage);

        history.push(assistantMessage);
        appendedNewMessages = true;

        await onEvent({ type: "message_complete", message: assistantMessage });

        if (toolUseBlocks.length === 0 || !this.toolExecutor) {
          await emitExit("no_tool_calls");
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
          for (const toolUse of toolUseBlocks) {
            await onEvent({
              type: "tool_result",
              toolUseId: toolUse.id,
              content: "Cancelled by user",
              isError: true,
              cancelled: true,
            });
          }
          await emitExit("aborted_post_response");
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

        // Run the `post-tool-use` hook once per tool result, after the tool
        // returns and before the result joins the provider-bound history.
        // The default tool-result-truncate plugin tail-drops oversized output
        // to fit the context window; user hooks can swap in a smarter strategy
        // (e.g. a summariser) or observe results for side effects.
        const contextWindowTokens =
          resolveContextWindow?.().maxInputTokens ??
          this.config.maxInputTokens ??
          180_000;

        const resultBlocks: ContentBlock[] = [];
        const additionalContextBlocks: ContentBlock[] = [];
        for (const block of rawResultBlocks) {
          if (block.type !== "tool_result") {
            resultBlocks.push(block);
            continue;
          }
          const postToolUseCtx: PostToolUseContext = {
            conversationId: this.conversationId,
            toolResponse: block as ToolResultContent,
            messages: history,
            maxInputTokens: contextWindowTokens,
            logger: rlog,
          };
          const finalCtx = await runHook(HOOKS.POST_TOOL_USE, postToolUseCtx);
          resultBlocks.push(finalCtx.toolResponse);
          if (finalCtx.additionalContext !== undefined) {
            additionalContextBlocks.push({
              type: "text",
              text: finalCtx.additionalContext,
            });
          }
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
            matchedTrustRuleId: result.matchedTrustRuleId,
            isContainerized: result.isContainerized,
            riskScopeOptions: result.riskScopeOptions,
            riskAllowlistOptions: result.riskAllowlistOptions,
            riskDirectoryScopeOptions: result.riskDirectoryScopeOptions,
            approvalMode: result.approvalMode,
            approvalReason: result.approvalReason,
            riskThreshold: result.riskThreshold,
            activityMetadata: result.activityMetadata,
          });
        }

        // If cancelled during execution, push completed results and stop
        if (signal?.aborted) {
          history.push({ role: "user", content: resultBlocks });
          await emitExit("aborted_during_tools");
          break;
        }

        // If any tool result requests yielding to the user (e.g. interactive
        // surface awaiting a button click), push results and stop the loop.
        if (toolResults.some(({ result }) => result.yieldToUser)) {
          history.push({ role: "user", content: resultBlocks });
          await emitExit("yield_to_user");
          break;
        }

        toolUseTurns++;

        // Append any guidance a post-tool-use hook surfaced via
        // `additionalContext` (e.g. tool-error retry coaching) as separate
        // blocks. They join the provider-bound history below but were not part
        // of the tool_result events emitted above, so the model sees the
        // guidance while the client-facing and persisted tool output stay the
        // tool's actual result.
        resultBlocks.push(...additionalContextBlocks);

        // Add tool results as a user message and continue the loop.
        history.push({ role: "user", content: resultBlocks });

        // Invoke checkpoint callback after tool results are in history.
        // Handoff takes precedence over the budget gate: a handoff decision
        // breaks here and leaves `budgetGateArmed` false, so a queued message
        // is processed before the next iteration's pre-call budget gate.
        if (onCheckpoint) {
          const decision = await onCheckpoint({
            turnIndex: toolUseTurns - 1, // 0-based (toolUseTurns was already incremented)
            toolCount: toolUseBlocks.length,
            hasToolUse: true,
            history,
          });
          if (decision !== "continue") {
            exitReason = decision;
            break;
          }
        }

        // Arm the pre-call budget gate for the next iteration. Placed after
        // the checkpoint so a handoff yield (which breaks above) leaves it
        // disarmed; the gate then runs at the top of the next iteration,
        // before that iteration's provider call.
        budgetGateArmed = true;
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
            for (const toolUse of toolUseBlocks) {
              await onEvent({
                type: "tool_result",
                toolUseId: toolUse.id,
                content: "Cancelled by user",
                isError: true,
                cancelled: true,
              });
            }
          }
          await emitExit("aborted_via_error");
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
        // Catch-block fallback. A break site that stamped a more specific
        // reason before unwinding here keeps it; the guard makes this a no-op.
        // Otherwise this is the genuine unhandled-error exit.
        await emitExit("error");
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

    return {
      history,
      exitReason,
      appendedNewMessages,
      newMessages: history.slice(newMessagesStart),
    };
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
function stripOldMediaBlocks(history: Message[]): Message[] {
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

    // Check if any tool_result blocks carry embedded media (image or audio).
    const isMedia = (cb: ContentBlock) =>
      cb.type === "image" || cb.type === "file";
    const hasMedia = msg.content.some(
      (b) =>
        b.type === "tool_result" &&
        (b as ToolResultContent).contentBlocks?.some(isMedia),
    );
    if (!hasMedia) return msg;

    // Strip media from tool_result blocks, replacing with a text marker. The
    // model already saw/heard the media in the turn it was captured; resending
    // the bytes every turn (a 12 MB audio clip isn't optimized like images)
    // bloats the request until compaction.
    return {
      ...msg,
      content: msg.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const tr = b as ToolResultContent;
        if (!tr.contentBlocks?.some(isMedia)) return b;
        return {
          ...tr,
          contentBlocks: undefined,
          content:
            (tr.content || "") +
            "\n[Media (image/audio) was captured and shown previously — binary data removed to save context.]",
        };
      }),
    };
  });
}

/**
 * Sanitize the outbound history immediately before a provider call, bundling
 * the pre-send transforms the loop applies to every request:
 * - {@link stripOldMediaBlocks} drops accumulated screenshot/audio bytes from
 *   older tool results — the model saw the media on the turn it was captured.
 * - {@link compactAxTreeHistory} collapses all but the most recent few
 *   `<ax-tree>` snapshots so TTFT does not grow linearly with step count.
 * - {@link stripHistoricalWebSearchResults} converts historical
 *   `web_search_tool_result` blocks to text summaries; Anthropic's opaque
 *   `encrypted_content` tokens expire / are route-scoped, and replaying a stale
 *   one is rejected with `Invalid encrypted_content in search_result block`.
 *
 * Transforms the outbound copy only — the durable history keeps the rich
 * originals and each send re-derives the sanitized projection (every transform
 * is idempotent). Because it runs unconditionally before every provider call,
 * it is the single place where oversized media and expired web-search tokens
 * are guaranteed to be removed from a request.
 *
 * This is outbound-request preparation and should eventually move to a default
 * `pre-model-call` plugin hook ({@link HOOKS.PRE_MODEL_CALL}) once that hook's
 * context carries the outbound message list; for now it lives inline next to
 * the provider call it guards.
 */
export function preModelCallSanitize(history: Message[]): Message[] {
  const mediaStripped = stripOldMediaBlocks(history);
  const axCompacted = compactAxTreeHistory(mediaStripped);
  return stripHistoricalWebSearchResults(axCompacted).messages;
}
