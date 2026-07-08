import * as Sentry from "@sentry/node";

import { getConfig } from "../config/loader.js";
import { isMemoryV3Live } from "../config/memory-v3-gate.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { recordEstimate } from "../context/estimator-calibration.js";
import { preModelCallSanitize } from "../context/outbound-sanitize.js";
import {
  estimatePromptTokensRaw,
  estimatePromptTokensWithTools,
  estimateToolsTokens,
  getCalibrationProviderKey,
} from "../context/token-estimator.js";
import { spoolAndStubOversizedToolResults } from "../context/tool-result-spool.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";
import { parseActualTokensFromError } from "../daemon/parse-actual-tokens-from-error.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type {
  AgentLoopExitReason,
  PostCompactInputContext,
  PostModelCallDecision,
  PostModelCallInputContext,
  PostToolUseInputContext,
  PreModelCallInputContext,
  StopInputContext,
} from "../hooks/types.js";
import {
  timeSyncSection,
  traceAsyncSection,
} from "../persistence/slow-sync-log.js";
import { HOOKS } from "../plugin-api/constants.js";
import { defaultCompact } from "../plugins/defaults/compaction/compact.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import { runHook } from "../plugins/pipeline.js";
import type { CompactionCircuitEvent } from "../plugins/types.js";
import { isMaxTokensStopReason } from "../providers/stop-reasons.js";
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
import { isContextOverflowError } from "../providers/types.js";
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

/**
 * Minimum token regrowth, measured from the post-compaction watermark, before
 * the budget gate will compact again. A compaction pass that just ran already
 * proved how far the history can shrink; if the estimate has not climbed at
 * least this far past that watermark, another pass cannot free more than it
 * already did and would only thrash (the production failure mode: each pass
 * lands a hair under the trigger, one tick pushes it back over, repeat).
 *
 * Sized as `max(2048, 2% of maxInputTokens)` so it scales with the window but
 * never collapses to a trivial value on small budgets. Overflow-driven
 * compaction bypasses this guard entirely — a provider-confirmed overflow must
 * always be allowed to compact.
 */
const MIN_REGROWTH_FLOOR_TOKENS = 2048;
const MIN_REGROWTH_WINDOW_RATIO = 0.02;
function minRegrowthTokens(maxInputTokens: number): number {
  return Math.max(
    MIN_REGROWTH_FLOOR_TOKENS,
    Math.floor(maxInputTokens * MIN_REGROWTH_WINDOW_RATIO),
  );
}

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
  /**
   * Give every LLM call provider-native (server-side) web search, gated on the
   * native-search capability of the (provider, model) the call routes to —
   * {@link Provider.supportsNativeWebSearchFor} when the provider exposes it,
   * else the static {@link Provider.supportsNativeWebSearch} flag.
   * When both are true, the loop appends a `web_search`-named tool to the
   * outbound request — which Anthropic/OpenAI substitute for their server-side
   * search tool, running the search inline and returning results without a
   * client tool round-trip — and forces `tool_choice: auto` so the model may
   * call it. Non-native providers get nothing.
   *
   * This is a SERVER tool the provider runs itself, distinct from the client
   * tool list (`tools` / `resolveTools`): it is never executed by
   * {@link AgentLoopConstructorOptions.toolExecutor} and does not require any
   * client-tool allowlist entry. Used by the tool-less advisor consult to
   * ground its guidance with live web access while staying one-shot for client
   * tools. Defaults to false — existing behavior.
   */
  enableNativeWebSearch?: boolean;
}

/**
 * The `web_search`-named tool the loop appends when
 * {@link AgentLoopConfig.enableNativeWebSearch} is set on a native provider.
 * Anthropic/OpenAI intercept a tool with this name and substitute their own
 * server-side web search (run inline, no client execution), so the exact
 * `input_schema` is informational — the provider supplies the real schema.
 */
const NATIVE_WEB_SEARCH_TOOL: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web for current information to ground your response.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },
};

/**
 * Build the minimal `SendMessageOptions` a routing-aware provider needs to
 * report the native web-search capability of the (provider, model) THIS turn
 * routes to. Mirrors the call-site fields the loop plumbs onto the actual send
 * (`callSite` + `overrideProfile`/`forceOverrideProfile` + per-conversation
 * `selectionSeed`) so the capability probe and the dispatch resolve the same
 * arm. Returns `undefined` when there is no `callSite` (the legacy
 * default-provider path); `selectionSeed` is omitted for standalone loops with
 * no conversation id, matching the dispatch path's own guard.
 */
function buildNativeWebSearchProbeOptions(
  callSite: LLMCallSite | undefined,
  overrideProfile: string | undefined,
  forceOverrideProfile: boolean,
  conversationId: string | undefined,
): SendMessageOptions | undefined {
  if (!callSite) {
    return undefined;
  }
  return {
    config: {
      callSite,
      ...(overrideProfile ? { overrideProfile } : {}),
      ...(overrideProfile && forceOverrideProfile
        ? { forceOverrideProfile: true }
        : {}),
      ...(conversationId ? { selectionSeed: conversationId } : {}),
    },
  };
}

export interface CheckpointInfo {
  turnIndex: number;
  toolCount: number;
  hasToolUse: boolean;
  history: Message[]; // current history snapshot for token estimation
}

/**
 * Why a checkpoint paused the loop. Surfaced back to the caller via
 * {@link AgentLoopRunResult.exitReason} so the wrapper reacts to the loop's
 * own signal (hand off to a queued message) instead of the checkpoint callback
 * mutating wrapper state.
 */
export type ExitReason = "handoff";

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
   * Slice of `history` appended this run, measured from the loop's input or
   * from the compacted base when it compacts in place. The loop owns this
   * boundary, so it cannot desync the way an externally-held index can.
   */
  newMessages: Message[];
}

/**
 * Outcome of an in-loop {@link AgentLoop.compact} call.
 */
interface CompactionAttempt {
  /**
   * Re-injected history to continue from, or `null` when an ordinary forced
   * compaction exhausted with nothing reduced worth continuing from. The
   * overflow-recovery path always returns the reduction rung's history.
   */
  history: Message[] | null;
  /** Whether the overflow reduction ladder reported it is spent. */
  exhausted: boolean;
  /** Whether the ladder applied its terminal auto-compress-latest-turn rung. */
  autoCompressApplied: boolean;
}

export type { AgentLoopExitReason };

/**
 * Why a mid-loop compaction ran: `"budget"` for the proactive estimate gate,
 * `"overflow"` for recovery from a provider context-overflow rejection.
 */
export type CompactionTrigger = "budget" | "overflow";

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
       *
       * Carries the start-side half of the compaction record: everything the
       * loop knows before handing the history to the compaction pipeline.
       * The pipeline between this event and `compaction_completed` is
       * plugin-owned, so consumers must treat the start/end pair (correlated
       * by `compactionId`) as the complete picture of an attempt. A start
       * event with no matching end means the pipeline threw or the turn
       * aborted mid-compaction.
       */
      type: "context_compacting";
      /** Correlates this start event with its `compaction_completed` pair. */
      compactionId: string;
      /** The turn's request id, linking the attempt to the triggering turn. */
      requestId: string;
      /**
       * Why the loop compacted: `"budget"` when the proactive mid-loop
       * estimate gate tripped, `"overflow"` when recovering from a provider
       * context-overflow rejection via the reduction ladder.
       */
      trigger: CompactionTrigger;
      /** Epoch ms when the loop began the compaction ceremony. */
      startedAt: number;
      /** The running history before injection stripping and compaction. */
      messages: Message[];
    }
  | ({
      /**
       * Emitted after the loop's inline mid-loop compaction pipeline runs,
       * immediately before re-injection — whether or not the pipeline actually
       * compacted. Carries the pipeline's `ContextWindowResult` unnested into
       * the event, so `messages` here is the pipeline's output history. The
       * pre-compaction history lives on the paired `context_compacting` start
       * event (correlated by `compactionId`); consumers that need the
       * stripped pre-compaction base re-derive it from the start event via
       * `stripInjectionsForCompaction`.
       *
       * The daemon's event dispatcher commits the stripped pre-compaction
       * base as the conversation's durable message state. Re-injection (the
       * post-compaction hook) strips runtime injections before re-applying
       * them, so it is idempotent whether the loop continues from the
       * stripped compaction result or from the unchanged injected history.
       * When `compacted` is set the dispatcher additionally commits the
       * durable compaction result (DB-record fields, graph-memory side
       * effects, SSE) and projects Slack provenance from the pre-compaction
       * base.
       *
       * Treated as a critical event: a failed durable commit re-throws so the
       * turn aborts rather than re-injecting against half-applied state.
       */
      type: "compaction_completed";
      /** Correlates this end event with its `context_compacting` pair. */
      compactionId: string;
      /** The turn's request id, linking the attempt to the triggering turn. */
      requestId: string;
      /** Same trigger as the paired start event, duplicated so the end
       * event is self-sufficient for consumers that only buffer ends. */
      trigger: CompactionTrigger;
      /** Epoch ms when the loop began the compaction ceremony. */
      startedAt: number;
      /** Epoch ms when the compaction pipeline returned. */
      finishedAt: number;
    } & ContextWindowResult)
  | {
      /**
       * Emitted during the loop's compaction ceremony, before the pipeline
       * runs. The daemon's event dispatcher commits the stripped
       * pre-compaction base as the durable history and records the
       * history-stripped marker — a Conversation DB-record field read back at
       * load time to strip embedded injection prefixes from pre-strip
       * messages. Best-effort: a transient marker write must not abort the
       * turn, so unlike `compaction_completed` this event is not treated as
       * critical.
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
    }
  | {
      /**
       * Emitted when the `pre-model-call` hook chain mutates the system
       * prompt for the current call — i.e. `finalPreModelCtx.systemPrompt`
       * differs from the value the loop handed the hook. Carries the
       * post-hook string so consumers can observe exactly what the provider
       * received.
       */
      type: "system_prompt_changed";
      systemPrompt: string;
    };

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTokens: 64000,
  effort: "high",
  minTurnIntervalMs: 150,
};

/**
 * Per-run backstop on `post-model-call`-driven retries. A recovery hook that
 * sets `decision: "continue"` re-issues the provider call; this bounds the
 * total such re-issues across a run so a misbehaving hook can't spin forever.
 *
 * It is a backstop, not the primary guard: each recovery class owns a
 * one-shot per-conversation bound that stops it repeating within a turn, so
 * the legitimate ceiling is one continue per class (empty-response nudge,
 * ordering repair, image downscale). This sits above that sum to leave
 * headroom while still catching pathological alternation between classes.
 */
const MAX_POST_MODEL_CALL_CONTINUES = 5;

/**
 * Concatenate the text of an assistant message's `text` blocks (ignoring
 * `tool_use`, `thinking`, and other non-text blocks). Used to re-emit the
 * finalized text as a single `text_delta` when a turn's live output was
 * deferred by a `pre-model-call` hook.
 */
function assistantTextOf(content: ReadonlyArray<ContentBlock>): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

/** Whether `content` carries at least one non-empty `text` block. */
function hasVisibleText(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
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

type AgentLoopContextWindowResolver = () => {
  maxInputTokens: number;
  overflowRecovery: { enabled: boolean; safetyMarginRatio: number };
};

interface AgentLoopRunOptionsBase {
  /** Input history the run starts from; the loop appends its output onto a copy. */
  messages: Message[];
  /** Sink the loop streams its {@link AgentEvent}s through as the turn runs. */
  onEvent: (event: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
  requestId: string;
  /**
   * Explicit model override (provider/model string) for every LLM call in
   * this run. When omitted, the model is resolved through the normal
   * call-site / profile resolution path.
   */
  model?: string;
  onCheckpoint?: (
    checkpoint: CheckpointInfo,
  ) => CheckpointDecision | Promise<CheckpointDecision>;
  callSite?: LLMCallSite;
  /**
   * Whether the connected client can render dynamic UI surfaces this turn,
   * surfaced to post-tool-use hooks via {@link PostToolUseContext}. Defaults to
   * `true`; the daemon run paths derive it from the conversation's channel.
   */
  supportsDynamicUi?: boolean;
  /**
   * Trust classification and channel identity for the turn's inbound actor,
   * supplied by the caller as the turn-start snapshot. Read only on the
   * mid-loop in-place compaction path — to scope the compactor's image
   * manifest (guardian-only attachments are excluded for untrusted actors).
   * Callers without a meaningful actor (agent
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
  /**
   * Float the override profile above the call-site layers (named site
   * profile + call-site override) for non-main-agent call sites — the
   * resolver's `forceOverrideProfile` escape hatch. Threaded onto each
   * send's `SendMessageOptions.config` alongside `overrideProfile`. Used by
   * wakes that must run a background call site under a specific
   * conversation's inference profile (e.g. fork-based memory
   * retrospectives).
   */
  forceOverrideProfile?: boolean;
  resolveOverrideProfile?: () => string | undefined;
  /**
   * When `true`, the loop owns turn-start and mid-loop compaction. The pre-call
   * budget gate runs before the very first provider call — subsuming the
   * proactive turn-start compaction the wrapper would otherwise perform inline
   * before `run()` — as well as before each tool-use re-entry. When the gate
   * trips it compacts the running history in place, re-applying runtime
   * injections via the default post-compaction hook ({@link HOOKS.POST_COMPACT}),
   * and continues with the call.
   *
   * The first-call pass honors the compaction circuit breaker and proceeds with
   * the call whether or not it compacted, so it never yields on the first call;
   * a provider context-too-large rejection then drives the reactive recovery
   * ladder from the catch. Reruns that carry no inline compaction path (the
   * deep-repair and image-recovery retries) leave it `false` and skip the
   * first-call gate. Defaults to `false` when omitted.
   */
  compactInPlace?: boolean;
  /**
   * Whether the in-flight turn has no human present to answer clarification
   * questions. Resolved once by the orchestrator at turn start and forwarded to
   * the post-compaction hook so post-compaction
   * re-injection uses the turn-start snapshot rather than re-reading mutable
   * client/headless state mid-turn. Defaults to `false` when omitted.
   */
  isNonInteractive?: boolean;
  /**
   * First-token latency instrumentation. Created per turn by the
   * orchestrator (which stamps the turn-level marks) and threaded here so
   * the loop can stamp the per-call marks (`tools_resolved`, `request_sent`,
   * `first_token`, `call_complete`). Structurally typed to keep the loop
   * decoupled from the daemon's `TurnLatencyTracker`. Absent for callers
   * that don't instrument (tests, workflows).
   */
  latencyTracker?: {
    mark(name: string): void;
    markFirstToken(kind: "thinking" | "text"): void;
  };
}

interface AgentLoopRunOptionsWithContextWindow extends AgentLoopRunOptionsBase {
  /**
   * Resolves the orchestrator's effective context window for this turn: the
   * provider max-input-token ceiling (read by tool-result truncation) plus the
   * `overflowRecovery` config that drives the mid-loop budget gate. Resolved
   * fresh per checkpoint so a mid-turn profile change is reflected.
   */
  resolveContextWindow: AgentLoopContextWindowResolver;
  /**
   * Effective inference-profile key for this run. The conversation
   * orchestrator supplies it so post-compaction hooks keep using the same
   * profile context after history is reassembled.
   */
  modelProfileKey: string;
}

interface AgentLoopRunOptionsWithoutContextWindow extends AgentLoopRunOptionsBase {
  /**
   * Absent when the run does not need provider-window-aware tool-result
   * truncation or in-loop compaction/recovery.
   */
  resolveContextWindow?: undefined;
  /**
   * Optional for raw loop runs that never compact/re-inject. Conversation
   * orchestrator runs pass this through the context-window variant above.
   */
  modelProfileKey?: string;
}

export type AgentLoopRunOptions =
  | AgentLoopRunOptionsWithContextWindow
  | AgentLoopRunOptionsWithoutContextWindow;

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

/**
 * The benign result returned for a sibling tool call that was deferred because
 * an exclusive tool ran in the same turn. Phrased so the model treats it as a
 * "not run yet" signal — read the exclusive tool's output, then re-issue this
 * call if it is still the right next step.
 */
function deferredForExclusiveMessage(exclusiveToolName: string): string {
  return (
    `(not run: \`${exclusiveToolName}\` was called this turn and runs first, on its own, ` +
    `so the rest of your tool calls were held back. Read its output, then call this tool ` +
    `again if it is still the right next step.)`
  );
}

export interface AgentLoopConstructorOptions {
  /** LLM provider the loop issues every call through. */
  provider: Provider;
  /** Base system prompt, before any per-turn dynamic resolution. */
  systemPrompt: string;
  config?: Partial<AgentLoopConfig>;
  tools?: ToolDefinition[];
  toolExecutor?: LoopToolExecutor;
  resolveTools?: (history: Message[]) => ToolDefinition[];
  /**
   * Decide whether a tool runs exclusively in its turn (see
   * {@link ToolDefinition.exclusive}). When it returns true for a tool present
   * in a multi-call turn, the loop runs only that tool and defers the siblings
   * un-run. Injected by the conversation wiring, which can read the tool
   * registry; lightweight loops that omit it never defer.
   */
  isExclusiveTool?: (toolName: string) => boolean;
  /**
   * Conversation this loop drives. Scopes the loop-held compaction circuit
   * breaker and is the source of truth the loop's pipeline contexts and
   * post-compaction re-injection resolve the live conversation through.
   */
  conversationId: string;
  /**
   * Resolve the conversation's on-disk directory, used to spool oversized
   * tool results to `.tool-results/` and swap the inline copy for the
   * post-turn pass's stub at result time — before the result joins history,
   * so the provider-bound prefix stays append-only for prompt caching.
   * Returns `null` while the directory cannot be resolved (e.g. the
   * conversation row is not yet persisted); the loop then skips the
   * result-time pass and the post-turn truncation covers the turn instead.
   */
  resolveConversationDir?: () => string | null;
}

export class AgentLoop {
  private provider: Provider;
  private systemPrompt: string;
  private config: AgentLoopConfig;
  private tools: ToolDefinition[];
  private resolveTools: ((history: Message[]) => ToolDefinition[]) | null;
  private toolExecutor: LoopToolExecutor | null;
  private isExclusiveTool: ((toolName: string) => boolean) | null;

  /**
   * Conversation this loop drives. Source of truth for the `conversationId`
   * the loop's pipeline contexts and post-compaction re-injection resolve the
   * live conversation through, so the loop knows its own identity without a
   * threaded-in turn context.
   */
  private readonly conversationId: string;

  /** See {@link AgentLoopConstructorOptions.resolveConversationDir}. */
  private readonly resolveConversationDir: (() => string | null) | null;

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
      isExclusiveTool,
      conversationId,
      resolveConversationDir,
    } = options;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tools = tools ?? [];
    this.resolveTools = resolveTools ?? null;
    this.toolExecutor = toolExecutor ?? null;
    this.isExclusiveTool = isExclusiveTool ?? null;
    this.conversationId = conversationId;
    this.resolveConversationDir = resolveConversationDir ?? null;
    this.compactionCircuit = new CompactionCircuit(this.conversationId);
  }

  /**
   * Replace the system prompt used by subsequent runs. The conversation pushes
   * a freshly resolved prompt here between turns when its persona context
   * (trust, channel, persona override) changed, so a conversation that binds
   * that context after construction (e.g. a voice call resolving the caller's
   * identity after the loop is built) does not stay pinned to the
   * construction-time persona. An in-flight `run()` keeps its own snapshot
   * (`runSystemPrompt`), so this never changes the prompt mid-run.
   */
  setSystemPrompt(systemPrompt: string): void {
    this.systemPrompt = systemPrompt;
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
    requestId: string,
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
   * Compact the running history in place when the budget gate trips.
   *
   * Calls the default compaction plugin, then re-applies injections via the
   * supplied hooks. Both the budget and overflow paths hand the full injected
   * `history` to the plugin (so the summary call reuses the agent's warm prefix
   * cache); the POST_COMPACT hook owns re-injection idempotency so continuing
   * from injected history does not double-stack blocks. When `overflowSignal`
   * is supplied the plugin routes through the manager's reduction ladder (which
   * advances one rung per call and reports `exhausted` / `autoCompressApplied`
   * / `injectionMode`); otherwise it runs ordinary forced compaction. Returns
   * the re-injected history to continue from alongside the ladder's terminal
   * state. On the ordinary path an exhausted compactor yields a `null` history
   * (nothing reduced worth continuing from, so the caller proceeds with the
   * call); the overflow path always returns the rung's reduced history so the
   * call is retried once at maximum reduction before the turn ends.
   */
  private async compact(
    history: Message[],
    requestId: string,
    trust: TrustContext,
    signal: AbortSignal | undefined,
    onEvent: (event: AgentEvent) => void | Promise<void>,
    overrideProfile: string | null,
    isNonInteractive: boolean,
    modelProfileKey: string,
    overflowSignal?: { actualTokens: number | null; isInteractive: boolean },
  ): Promise<CompactionAttempt> {
    const compactionId = crypto.randomUUID();
    const startedAt = Date.now();
    const trigger: CompactionTrigger =
      overflowSignal != null ? "overflow" : "budget";
    await onEvent({
      type: "context_compacting",
      compactionId,
      requestId,
      trigger,
      startedAt,
      messages: history,
    });
    // The durable pre-compaction base is stripped by the event dispatcher
    // (re-derived from the start event), so record the history-stripped
    // marker for this compaction before the pipeline runs.
    await onEvent({ type: "history_stripped" });
    // The compaction module owns the per-conversation manager; pass the
    // conversation id and let `defaultCompact` resolve it from the store.
    // The budget gate is reached only when this turn decides to compact in
    // place, so `force` past the auto-threshold check. `actorTrustClass` comes
    // from the turn's trust snapshot (the actor whose turn triggered
    // compaction) so the compactor's image manifest excludes guardian-only
    // attachments for untrusted actors. `overrideProfile` is the turn's
    // resolved inference-profile override for the summary call. `overflowSignal`
    // routes the request through the reduction ladder when present.
    const compactResult = await defaultCompact({
      conversationId: this.conversationId,
      messages: history,
      signal,
      force: true,
      actorTrustClass: trust.trustClass,
      overrideProfile,
      overflowSignal,
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
    // Emit unconditionally: the dispatcher commits the stripped pre-compaction
    // base (re-derived from the start event) as the durable message base
    // whether or not the pipeline compacted (re-injection reads it), and runs
    // the durable compaction commit only when `compacted`.
    await onEvent({
      type: "compaction_completed",
      compactionId,
      requestId,
      trigger,
      startedAt,
      finishedAt: Date.now(),
      ...compactResult,
    });
    const exhausted = compactResult.exhausted ?? false;
    const autoCompressApplied = compactResult.autoCompressApplied ?? false;
    if (overflowSignal == null && exhausted) {
      return { history: null, exhausted, autoCompressApplied };
    }
    // The POST_COMPACT hook strips runtime injections from this base and
    // re-applies them, so continuing from injected history is safe. The
    // overflow ladder transforms the history on every rung (truncation /
    // media stubbing / injection downgrade) regardless of whether the summary
    // ran, so continue from its reduced messages; the ordinary path continues
    // from the compacted messages when the pipeline compacted, otherwise from
    // the unchanged injected history.
    const base =
      overflowSignal != null || compactResult.compacted
        ? compactResult.messages
        : history;
    const postCompactCtx: PostCompactInputContext = {
      history: base,
      requestId,
      conversationId: this.conversationId,
      isNonInteractive,
      modelProfileKey,
      injectionMode: compactResult.injectionMode,
    };
    // The hook chain writes the re-injected history back onto the context;
    // read it from there once the chain settles.
    const finalPostCompactCtx = await runHook(
      HOOKS.POST_COMPACT,
      postCompactCtx,
    );
    return {
      history: finalPostCompactCtx.history,
      exhausted,
      autoCompressApplied,
    };
  }

  async run(options: AgentLoopRunOptions): Promise<AgentLoopRunResult> {
    const {
      messages,
      onEvent,
      signal,
      requestId,
      onCheckpoint,
      callSite,
      supportsDynamicUi = true,
      trust,
      overrideProfile,
      forceOverrideProfile = false,
      resolveOverrideProfile,
      compactInPlace = false,
      isNonInteractive = false,
      model: runModel,
      latencyTracker,
    } = options;
    // Snapshot the system prompt once per run. The instance field is mutable
    // (the conversation may update it between turns), but a single run must
    // use one consistent prompt — an aborted run left detached after the
    // watchdog rejects must not pick up a later turn's prompt on its next
    // provider call.
    const runSystemPrompt = this.systemPrompt;
    let history = [...messages];
    // Index into `history` where this run's appended output begins. It starts
    // after the input and resets to the new base whenever the loop rewrites the
    // history in place (compaction re-injection, ordering deep-repair), so
    // `history.slice(newMessagesStart)` is always exactly what the loop produced
    // since the last base.
    let newMessagesStart = history.length;
    let toolUseTurns = 0;
    let postModelCallContinues = 0;
    let lastLlmCallTime = 0;
    let exitReason: ExitReason | null = null;
    // Armed at the end of a tool-use iteration so the budget gate runs at the
    // top of the NEXT iteration — before that iteration's provider call —
    // instead of after the current one. Stop-hook re-query continues re-enter
    // without arming, so the gate fires on exactly the same occasions as the
    // prior post-call placement, plus the first call when
    // `compactInPlace` is set (the primary run's turn-start compaction).
    let budgetGateArmed = compactInPlace;
    // Raw pre-send estimate for the most recent provider call, captured so the
    // overflow catch can calibrate the estimator against the provider's actual
    // token count. Reset to the success path's value on every call.
    let lastPreSendEstimatedTokens = 0;
    // Overflow signal stashed by the reactive catch when the provider rejects a
    // call as context-too-large. The next budget gate forwards it into
    // `compact()`, which routes through the manager's reduction ladder, then
    // clears it (one rung consumed per recovery pass).
    let pendingOverflowSignal: {
      actualTokens: number | null;
      isInteractive: boolean;
    } | null = null;
    // Mirror of the reduction ladder's terminal state from the most recent
    // overflow-recovery compaction. When the ladder is spent and the provider
    // still rejects, the catch ends the turn with the reason the final rung
    // implies (auto-compress applied → `budget_yield_unrecovered`, otherwise
    // `context_too_large`) instead of looping.
    let overflowLadderExhausted = false;
    let overflowAutoCompressApplied = false;
    // Per-turn suppression for floor-dominated proactive-compaction thrash.
    // Set when a proactive (non-overflow) pass completes WITHOUT clearing the
    // mid-loop gate (the manager returned `exhausted` — it could not get below
    // its success threshold). During a tool-heavy turn each tool round grows the
    // PROTECTED in-flight region past the regrowth guard's re-arm delta, but
    // that region is exactly what compaction cannot touch, so every subsequent
    // gate check would fire another futile full-context pass. Once set, the
    // budget gate skips proactive compaction for the rest of THIS turn; it
    // clears when a later proactive pass succeeds (non-exhausted). Overflow-
    // driven compaction always bypasses it — a provider-confirmed overflow must
    // always compact.
    //
    // Lifetime is exactly one turn: this is a `run()`-local (like
    // `budgetGateArmed` / `pendingOverflowSignal` / `overflowLadderExhausted`),
    // not an instance field. The AgentLoop instance is constructed once per
    // Conversation and `run()` is invoked once per turn (a checkpoint handoff
    // breaks out of the loop and the queued message resumes in a fresh `run()`),
    // so a `run()`-local resets implicitly at every turn start — no manual reset
    // point is needed, and suppression can never leak across turns the way an
    // instance field would. (The regrowth watermark, by contrast, lives on the
    // cross-turn `compactionCircuit` precisely because it must persist.)
    let proactiveCompactionFutileThisTurn = false;
    const rlog = log.child({ requestId });

    // Conversation directory for the result-time tool-result spool/stub pass.
    // Resolved once per run; `null` disables the pass for this run and the
    // post-turn truncation covers the turn instead.
    let conversationDir: string | null = null;
    try {
      conversationDir = this.resolveConversationDir?.() ?? null;
    } catch (err) {
      rlog.warn(
        { err },
        "Resolving conversation dir for tool-result spooling failed (non-fatal)",
      );
    }

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

    // Single chokepoint for ending the turn. Runs the definitive terminal
    // `stop` hook chain exactly once — by the time it fires the loop has
    // committed to ending, so teardown hooks can clear per-turn state with the
    // guarantee that nothing will re-enter the loop this turn. The first reason
    // stamped wins: a break site that stamps a specific reason before unwinding
    // into the catch handler keeps that reason instead of the generic "error",
    // and the guard also defends against accidental double-invocation if a new
    // terminal break site is added.
    //
    // `emitExit` controls whether the matching `agent_loop_exit` observability
    // event fires. Real terminal exits emit it; a `checkpoint_handoff` runs the
    // teardown chain (so per-turn state like recovery bounds is cleared before
    // the queued message drains) but does not emit, because the orchestrator
    // owns the handoff signal and the conversation resumes in a fresh run.
    //
    // A throwing `stop` hook must not suppress the terminal exit: the chain is
    // isolated so a failing teardown hook (e.g. a third-party plugin) is logged
    // but `agent_loop_exit` still fires with the real exit reason. Otherwise the
    // throw would unwind into the outer catch, which re-enters here as a no-op
    // (the guard is already set) and the turn's terminal observability event
    // would be dropped.
    let turnStopped = false;
    const runTerminalStop = async (
      reason: AgentLoopExitReason,
      { emitExit, error }: { emitExit: boolean; error?: Error },
    ): Promise<void> => {
      if (turnStopped) {
        return;
      }
      turnStopped = true;
      const stopCtx: StopInputContext = {
        conversationId: this.conversationId,
        messages: [...history],
        error,
        exitReason: reason,
      };
      try {
        await runHook(HOOKS.STOP, stopCtx);
      } catch (stopHookError) {
        rlog.error(
          { err: stopHookError, exitReason: reason },
          "stop hook threw during terminal teardown; continuing",
        );
      }
      if (emitExit) {
        await onEvent({ type: "agent_loop_exit", reason });
      }
    };
    const stopTurn = (
      reason: AgentLoopExitReason,
      error?: Error,
    ): Promise<void> => runTerminalStop(reason, { emitExit: true, error });

    while (true) {
      if (signal?.aborted) {
        await stopTurn("aborted_pre_call");
        break;
      }

      rlog.info(
        { turn: toolUseTurns, messageCount: history.length },
        "Agent loop iteration start",
      );

      let toolUseBlocks: Extract<ContentBlock, { type: "tool_use" }>[] = [];
      // The provider rejection thrown by this iteration's call, if any. Set in
      // the inner provider catch and read by the outer catch to confine
      // error-stop recovery to genuine provider rejections — a throw from
      // elsewhere in the turn body (tool execution, the success-path stop
      // chain, post-model-call hooks) must not re-enter the stop chain.
      let providerCallError: unknown;

      try {
        // ── Pre-call budget gate ─────────────────────────────────────
        // Compact the running history before issuing the provider call when
        // either the running estimate approaches the preflight budget
        // (proactive) or a prior call was rejected as context-too-large
        // (reactive, signalled via `pendingOverflowSignal`). The reactive case
        // forwards the overflow signal into `compact()`, which routes through
        // the manager's reduction ladder; the proactive case runs ordinary
        // forced compaction. Either way the loop proceeds with the call —
        // recovery is driven by compaction, never by yielding out of the loop.
        //
        // Keyed off the loop's own `history.length` (the messages actually in
        // context this turn, including tool iterations) rather than the durable
        // conversation count. Armed after each tool-use iteration and by the
        // reactive catch; stop-hook re-query continues skip it. The first call
        // runs it only when `compactInPlace` is set (standing in for turn-start
        // compaction) or when recovering an overflow.
        if (budgetGateArmed) {
          budgetGateArmed = false;
          const overflowSignal = pendingOverflowSignal;
          pendingOverflowSignal = null;
          // The gate only re-arms after a completed tool-use iteration
          // (`toolUseTurns` is incremented first), so reaching it with
          // `toolUseTurns === 0` and no overflow signal uniquely identifies the
          // first-call turn-start pass, which honors the compaction circuit
          // breaker. Overflow recovery ignores the breaker — the provider has
          // already rejected the call, so it must reduce regardless.
          const isFirstCallGate = toolUseTurns === 0;
          if (options.resolveContextWindow != null) {
            const contextWindow = options.resolveContextWindow();
            if (contextWindow.overflowRecovery.enabled) {
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
              const overflowDriven = overflowSignal !== null;
              // Proactive compaction fires when the primary run's turn-start
              // signal (`compactInPlace`) crosses the estimate threshold;
              // overflow recovery always compacts.
              const shouldCompact =
                overflowDriven ||
                (compactInPlace && estimated > midLoopThreshold);
              const compactionAllowed =
                overflowDriven ||
                !isFirstCallGate ||
                !(await this.compactionCircuit.isOpen());
              // Regrowth hysteresis: a proactive pass that just ran proved how
              // far this history can shrink. If the estimate has not climbed at
              // least `minRegrowth` past that watermark, another pass cannot free
              // more and would only thrash — skip it and let the provider call
              // proceed (overflow recovery remains the safety net). Overflow-
              // driven compaction always bypasses the guard.
              const watermark =
                this.compactionCircuit.lastPostCompactionEstimate;
              const minRegrowth = minRegrowthTokens(maxInputTokens);
              const regrowthGuardSkip =
                !overflowDriven &&
                watermark !== null &&
                estimated - watermark < minRegrowth;
              // Floor-dominated thrash guard: a proactive pass earlier this turn
              // already exhausted the compactor (couldn't clear the gate because
              // the over-budget region is the protected in-flight turn). The
              // regrowth guard cannot catch this — each tool round's growth lands
              // in that protected region and re-arms the regrowth delta — so this
              // per-turn latch is what stops the repeated futile passes. Overflow-
              // driven compaction bypasses it.
              const proactiveFutileSkip =
                !overflowDriven && proactiveCompactionFutileThisTurn;
              if (
                shouldCompact &&
                compactionAllowed &&
                (regrowthGuardSkip || proactiveFutileSkip)
              ) {
                rlog.info(
                  {
                    turn: toolUseTurns,
                    estimated,
                    postCompactionWatermark: watermark,
                    minRegrowth,
                    reason: proactiveFutileSkip
                      ? "proactive_compaction_exhausted_this_turn"
                      : "history_not_regrown",
                  },
                  proactiveFutileSkip
                    ? "Skipping compaction: a proactive pass already exhausted the compactor this turn — the over-budget region is the protected in-flight turn, so re-compacting would free nothing"
                    : "Skipping compaction: history has not regrown past the post-compaction watermark — re-compacting would not free more",
                );
              } else if (shouldCompact && compactionAllowed) {
                rlog.info(
                  {
                    turn: toolUseTurns,
                    estimated,
                    threshold: midLoopThreshold,
                    overflowDriven,
                  },
                  "Compacting in place before provider call",
                );
                const attempt = await this.compact(
                  history,
                  requestId,
                  trust,
                  signal,
                  onEvent,
                  resolveEffectiveOverrideProfile() ?? null,
                  isNonInteractive,
                  options.modelProfileKey,
                  overflowSignal ?? undefined,
                );
                if (attempt.history) {
                  history = attempt.history;
                  // The compacted, re-injected array is the new base; output
                  // produced after this point is what the wrapper persists.
                  newMessagesStart = history.length;
                  // Record the post-compaction estimate so the regrowth guard can
                  // tell, on a later gate crossing, whether the history has grown
                  // enough to be worth compacting again.
                  this.compactionCircuit.lastPostCompactionEstimate =
                    this.estimateTokens(history);
                }
                if (overflowDriven) {
                  // Carry the ladder's terminal state to the catch: if the
                  // provider rejects again after the ladder is spent, the turn
                  // ends instead of looping.
                  overflowLadderExhausted = attempt.exhausted;
                  overflowAutoCompressApplied = attempt.autoCompressApplied;
                } else {
                  // Proactive (non-overflow) pass. If it exhausted the compactor
                  // without clearing the gate, latch suppression so later gate
                  // checks this turn skip the futile re-pass; a pass that DID
                  // clear the gate (non-exhausted) releases the latch.
                  proactiveCompactionFutileThisTurn = attempt.exhausted;
                }
              }
            }
          }
        }

        // Resolve tools for this turn: use the dynamic resolver if provided,
        // otherwise fall back to the static tool list.
        const resolvedTools = this.resolveTools
          ? this.resolveTools(history)
          : this.tools;
        // Latency: the budget gate (above) and tool resolution are done; what
        // follows is per-call request prep before the wire.
        latencyTracker?.mark("tools_resolved");

        // Provider-native web search: append a `web_search`-named tool that the
        // provider substitutes for its server-side search (run inline, no client
        // execution), gated STRICTLY on the capability of the provider/model
        // this call ACTUALLY routes to so a non-native provider never sees an
        // unexecutable client tool. The advisor consult's `advisorProfile` can
        // route `subagentSpawn` to a provider/model whose native-search support
        // differs from the construction-time default, so the gate resolves the
        // routed target (callSite + overrideProfile) via
        // `supportsNativeWebSearchFor` rather than the static
        // `this.provider.supportsNativeWebSearch` snapshot; providers without
        // the routing-aware probe fall back to the static flag. This is a SERVER
        // tool — it bypasses the client allowlist and the tool executor — so the
        // tool-less advisor consult can ground its guidance with live web access
        // while staying one-shot for client tools. Skip when a `web_search` tool
        // is already present so we never duplicate the name.
        const supportsRoutedNativeWebSearch = this.provider
          .supportsNativeWebSearchFor
          ? this.provider.supportsNativeWebSearchFor(
              buildNativeWebSearchProbeOptions(
                callSite,
                resolveEffectiveOverrideProfile(),
                forceOverrideProfile,
                this.conversationId,
              ),
            )
          : this.provider.supportsNativeWebSearch === true;
        const attachNativeWebSearch =
          this.config.enableNativeWebSearch === true &&
          supportsRoutedNativeWebSearch &&
          !resolvedTools.some((t) => t.name === NATIVE_WEB_SEARCH_TOOL.name);
        const currentTools = attachNativeWebSearch
          ? [...resolvedTools, NATIVE_WEB_SEARCH_TOOL]
          : resolvedTools;

        // Field precedence (highest wins):
        //   1. Per-run explicit (`runModel`)
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

        if (!callSite) {
          providerConfig.max_tokens = this.config.maxTokens;
        }

        if (runModel) {
          providerConfig.model = runModel;
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
        } else if (attachNativeWebSearch) {
          // The native web-search tool is the only tool on this turn (the
          // advisor consult is otherwise tool-less). Let the model decide
          // whether to search rather than forcing it.
          providerConfig.tool_choice = { type: "auto" };
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
        if (isMemoryV3Live(getConfig())) {
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
          if (forceOverrideProfile) {
            providerConfig.forceOverrideProfile = true;
          }
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
        const preSendEstimatedTokens = timeSyncSection(
          "agent-loop:estimate-prompt-tokens",
          () => {
            const toolTokenBudget =
              currentTools.length > 0 ? estimateToolsTokens(currentTools) : 0;
            return estimatePromptTokensRaw(history, runSystemPrompt, {
              providerName: getCalibrationProviderKey(this.provider),
              toolTokenBudget,
            });
          },
          (estimatedTokens) => ({
            estimatedTokens,
            messageCount: history.length,
          }),
        );
        lastPreSendEstimatedTokens = preSendEstimatedTokens;
        rlog.info({ turn: toolUseTurns }, "LLM call start");

        // Sanitize the outbound history right before sending: drop accumulated
        // media, collapse old AX-tree snapshots, and convert historical
        // web-search results to text. See {@link preModelCallSanitize}.
        const providerHistory = timeSyncSection(
          "agent-loop:pre-model-call-sanitize",
          () => preModelCallSanitize(history),
          (sanitized) => ({ messageCount: sanitized.length }),
        );

        // A `pre-model-call` hook (below) can defer this turn's assistant
        // output; when set, the live text stream is held so an
        // `post-model-call` hook can emit the finalized (transformed) text
        // instead. Reset per model call.
        let deferAssistantOutput = false;

        // Set once any visible assistant text reaches the client live this
        // model call. A deferred turn holds the live stream and a turn the
        // model leaves visibly empty streams nothing, so this stays false for
        // both — letting the loop surface the finalized text exactly once when
        // the client would otherwise see nothing.
        let streamedVisibleText = false;

        // Latency instrumentation: stamp the first streamed token (thinking or
        // text) of THIS call exactly once, so each per-call segment carries its
        // own time-to-first-token. Reset per provider call.
        let firstTokenMarked = false;

        // The `onEvent` wrapping below applies sensitive-output placeholder
        // substitution to streamed text while forwarding every other event
        // type through unchanged.
        const providerOptions: SendMessageOptions = {
          tools: currentTools.length > 0 ? currentTools : undefined,
          systemPrompt: runSystemPrompt,
          config: providerConfig,
          onEvent: (event) => {
            if (
              !firstTokenMarked &&
              (event.type === "thinking_delta" || event.type === "text_delta")
            ) {
              firstTokenMarked = true;
              latencyTracker?.markFirstToken(
                event.type === "thinking_delta" ? "thinking" : "text",
              );
            }
            if (event.type === "text_delta") {
              // Held when the turn's output is deferred — the final text is
              // emitted once, after the `post-model-call` hook runs.
              if (deferAssistantOutput) {
                return;
              }
              // Apply sensitive-output placeholder substitution (chunk-safe)
              if (substitutionMap.size > 0) {
                const combined = streamingPending + event.text;
                const { emit, pending } = applyStreamingSubstitution(
                  combined,
                  substitutionMap,
                );
                streamingPending = pending;
                if (emit.length > 0) {
                  streamedVisibleText = true;
                  onEvent({ type: "text_delta", text: emit });
                }
              } else {
                if (event.text.length > 0) {
                  streamedVisibleText = true;
                }
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
          const preModelCtx: PreModelCallInputContext = {
            conversationId: this.conversationId,
            callSite: callSite ?? null,
            systemPrompt: providerOptions.systemPrompt ?? null,
            modelProfile: effectiveOverrideProfile ?? null,
            deferAssistantOutput: false,
          };
          const finalPreModelCtx = await traceAsyncSection(
            "agent-loop:pre-model-call-hook",
            () => runHook(HOOKS.PRE_MODEL_CALL, preModelCtx),
          );
          // Emit a changed event when the hook mutated the prompt. Compare
          // against the pre-hook value from providerOptions, not
          // preModelCtx — the hook may mutate the context object in place,
          // which would make preModelCtx.systemPrompt already reflect the
          // change and hide the diff.
          const preHookSystemPrompt = providerOptions.systemPrompt ?? null;
          if (
            typeof finalPreModelCtx.systemPrompt === "string" &&
            finalPreModelCtx.systemPrompt !== preHookSystemPrompt
          ) {
            await onEvent({
              type: "system_prompt_changed",
              systemPrompt: finalPreModelCtx.systemPrompt,
            });
          }
          providerOptions.systemPrompt =
            finalPreModelCtx.systemPrompt ?? undefined;
          // Route this call to the hook's chosen inference profile. The
          // resolver layers `llm.profiles[overrideProfile]` at the top of
          // precedence for the user-facing call, so a model router can pick
          // the profile per message; clearing it drops any seeded override.
          const hookModelProfile = finalPreModelCtx.modelProfile?.trim();
          if (hookModelProfile) {
            providerConfig.overrideProfile = hookModelProfile;
            if (forceOverrideProfile) {
              providerConfig.forceOverrideProfile = true;
            }
          } else {
            delete providerConfig.overrideProfile;
            delete providerConfig.forceOverrideProfile;
          }
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
        // Latency: the request is about to leave for the provider. The span
        // from here to the first streamed token is time-to-first-token.
        latencyTracker?.mark("request_sent");
        let response: ProviderResponse;
        try {
          response = await traceAsyncSection("agent-loop:provider-send", () =>
            this.provider.sendMessage(providerHistory, providerOptions),
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
          providerCallError = llmCallError;
          throw llmCallError;
        }

        const providerDurationMs = Date.now() - providerStart;
        // Latency: provider call returned; the span from first token to here is
        // generation time. Stamped before the `usage` event so the breakdown
        // serialized in `handleUsage` already sees it.
        latencyTracker?.mark("call_complete");

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
            streamedVisibleText = true;
            onEvent({ type: "text_delta", text: flushed });
          }
          streamingPending = "";
        }

        // Run the `post-model-call` hook on a finalized message. Fail-open: the
        // hook receives a clone, so a throw — even mid in-place mutation —
        // leaves the original message intact and the outcome resolves to
        // `"stop"`.
        //
        // Returns the finalized message alongside the chain's retry `decision`
        // and resulting `messages`. The caller honors `decision` only at an
        // actionable outcome (a no-tool stop boundary); other call sites take
        // the finalized message and ignore the decision. Final output is not
        // emitted here — the caller emits it via `emitFinalAssistantText`
        // once it has decided to keep the turn, so a re-queried reply isn't
        // streamed-then-discarded.
        const finalizeAssistantMessage = async (
          message: Message,
        ): Promise<{
          finalized: Message;
          decision: PostModelCallDecision;
          messages: Message[];
        }> => {
          try {
            const ctx: PostModelCallInputContext = {
              conversationId: this.conversationId,
              callSite: callSite ?? null,
              content: structuredClone(message.content),
              messages: [...history],
              stopReason: response.stopReason,
              decision: "stop",
            };
            const result = await traceAsyncSection(
              "agent-loop:post-model-call-hook",
              () => runHook(HOOKS.POST_MODEL_CALL, ctx),
            );
            return {
              finalized: { role: "assistant", content: result.content },
              decision: result.decision,
              messages: result.messages,
            };
          } catch (assistantMessageError) {
            rlog.error(
              { err: assistantMessageError },
              "post-model-call hook failed — keeping the original content",
            );
            return { finalized: message, decision: "stop", messages: history };
          }
        };

        // Surface the finalized assistant text when the client saw nothing live
        // this turn: a deferred turn held its live stream, and a turn the model
        // left visibly empty that a `post-model-call` hook rewrote into visible
        // text (e.g. a refusal turned into an apology) streamed nothing either.
        // Sensitive-output substitution is applied to match what the live stream
        // would have shown. A no-op when text already streamed live — that
        // stream stands. Call only for a turn being kept.
        const emitFinalAssistantText = (content: ContentBlock[]): void => {
          if (streamedVisibleText) {
            return;
          }
          const finalText = applySubstitutions(
            assistantTextOf(content),
            substitutionMap,
          );
          if (finalText.length > 0) {
            onEvent({ type: "text_delta", text: finalText });
          }
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

        // The model's own tool calls. The executable set is finalized after
        // the `post-model-call` hook below, which may add or drop tool calls;
        // this raw set drives only the completion log and the max-tokens branch.
        const modelToolUseBlocks = response.content.filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use",
        );

        rlog.info(
          {
            turn: toolUseTurns,
            stopReason: response.stopReason,
            contentBlocks: response.content.length,
            toolUseCount: modelToolUseBlocks.length,
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
              toolUseCount: modelToolUseBlocks.length,
            },
            "LLM response reached output token limit",
          );
          // Run the hook on the truncated reply so output-filter plugins still
          // see it, and so a turn that streamed nothing live gets its final
          // emit (without this the client would see nothing). A recovery hook
          // (max-tokens-continue) may set `decision: "continue"` to resume the
          // truncated turn: it leaves `messages` as the next history (the
          // truncated turn followed by a continuation nudge), so unlike the
          // no-tool retry below the partial output is kept, not discarded.
          // Otherwise the stop is terminal and the continuation card surfaces.
          const {
            finalized: rawSafeAssistantMessage,
            decision: maxTokensDecision,
            messages: maxTokensMessages,
          } = await finalizeAssistantMessage({
            role: "assistant",
            content: safeContent,
          });
          // A truncated turn never executes tools — the model's own tool calls
          // were stripped into `safeContent` above. The hook can still append a
          // `tool_use` block while transforming the reply, but this branch
          // short-circuits without an executor pass, so honoring it would
          // persist a tool call with no matching `tool_result`. Drop hook-added
          // tool calls here too: tool injection is supported only on the
          // non-truncated path below, which runs the executor.
          const safeAssistantMessage: Message = {
            ...rawSafeAssistantMessage,
            content: rawSafeAssistantMessage.content.filter(
              (block) =>
                block.type !== "tool_use" &&
                block.type !== "server_tool_use" &&
                block.type !== "web_search_tool_result",
            ),
          };
          emitFinalAssistantText(safeAssistantMessage.content);
          if (
            maxTokensDecision === "continue" &&
            postModelCallContinues < MAX_POST_MODEL_CALL_CONTINUES
          ) {
            postModelCallContinues++;
            rlog.warn(
              { turn: toolUseTurns, retry: postModelCallContinues },
              "max-tokens stop — auto-continuing the truncated turn",
            );
            await onEvent({
              type: "message_complete",
              message: safeAssistantMessage,
            });
            history = maxTokensMessages;
            continue;
          }
          history.push(safeAssistantMessage);
          await onEvent({
            type: "max_tokens_reached",
            stopReason: response.stopReason,
          });
          await onEvent({
            type: "message_complete",
            message: safeAssistantMessage,
          });
          await stopTurn("max_tokens_reached");
          break;
        }

        // A response with no tool calls is the run's stop boundary. The
        // `post-model-call` hook (below) sees the finalized reply and decides
        // whether to accept the turn or re-query with a follow-up.
        const responseHasVisibleText = hasVisibleText(response.content);

        // Run the `post-model-call` hook: transform the finalized reply and
        // surface its retry decision.
        const {
          finalized: finalizedAssistantMessage,
          decision: postModelCallDecision,
          messages: postModelCallMessages,
        } = await finalizeAssistantMessage(assistantMessage);
        assistantMessage = finalizedAssistantMessage;

        // Execution follows the FINALIZED content, not the raw reply. A
        // `post-model-call` hook may append a `tool_use` block to run a tool as
        // if the model had called it (the supported way for a plugin to surface
        // a card or take a follow-up action), or drop one the model emitted, so
        // the loop runs whatever the assistant message ends up carrying.
        // Normalize ids so the executor and tool_result correlation stay 1:1 —
        // a hook-added block may carry an empty or duplicate id.
        toolUseBlocks = assistantMessage.content.filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
            block.type === "tool_use",
        );
        const seenToolUseIds = new Set<string>();
        for (const block of toolUseBlocks) {
          if (block.id.length === 0 || seenToolUseIds.has(block.id)) {
            block.id = crypto.randomUUID();
          }
          seenToolUseIds.add(block.id);
        }

        // At the no-tool stop boundary the retry decision is actionable: a
        // recovery hook may repair history and ask to re-query (a tool-bearing
        // turn already continues, so its decision is ignored). A re-query
        // adopts the hook's `messages` and discards this turn rather than
        // persisting it; the per-run backstop keeps a misbehaving hook from
        // spinning forever.
        if (
          toolUseBlocks.length === 0 &&
          postModelCallDecision === "continue"
        ) {
          // A retry discards this reply and re-queries. That is only safe when
          // the reply was not already streamed to the client live: a deferred
          // turn suppressed its live stream, and a reply with no visible text
          // streamed nothing. Honoring a retry on an already-streamed visible
          // reply would leave the user looking at an answer the transcript
          // then silently replaces, with no retraction — so accept the turn
          // instead of discarding visible output.
          const replyWasStreamedLive =
            responseHasVisibleText && !deferAssistantOutput;
          if (replyWasStreamedLive) {
            rlog.warn(
              { turn: toolUseTurns },
              "post-model-call requested a retry on an already-streamed reply — keeping the turn to avoid discarding visible output",
            );
          } else if (postModelCallContinues < MAX_POST_MODEL_CALL_CONTINUES) {
            postModelCallContinues++;
            rlog.warn(
              { turn: toolUseTurns, retry: postModelCallContinues },
              "post-model-call requested a retry — re-querying the model",
            );
            history = postModelCallMessages;
            continue;
          } else {
            rlog.warn(
              { turn: toolUseTurns, retries: postModelCallContinues },
              "post-model-call retry backstop reached — accepting the turn",
            );
          }
        }

        // The turn is being kept: surface the finalized text if the client saw
        // nothing live (a deferred stream, or a hook-rewritten empty turn).
        emitFinalAssistantText(assistantMessage.content);

        history.push(assistantMessage);

        await onEvent({ type: "message_complete", message: assistantMessage });

        if (toolUseBlocks.length === 0 || !this.toolExecutor) {
          // The model stopped requesting tools and `post-model-call` settled on
          // ending the turn: the terminal `stop` chain fires via `stopTurn`.
          await stopTurn("no_tool_calls");
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
          await stopTurn("aborted_post_response");
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

        // When an exclusive tool (e.g. the advisor) is among this turn's calls,
        // it must run alone: the model should incorporate its output before
        // acting on anything else. Run only the first exclusive call and defer
        // the siblings with a benign, un-run result so the model re-issues them
        // next turn if still needed. Every tool_use still gets a matching
        // tool_result, so history stays well-formed.
        const exclusiveBlock = this.isExclusiveTool
          ? toolUseBlocks.find((block) => this.isExclusiveTool!(block.name))
          : undefined;
        const deferSiblings =
          exclusiveBlock !== undefined && toolUseBlocks.length > 1;
        if (deferSiblings) {
          rlog.info(
            {
              turn: toolUseTurns,
              exclusiveTool: exclusiveBlock!.name,
              deferred: toolUseBlocks
                .filter((block) => block !== exclusiveBlock)
                .map((block) => block.name),
            },
            "Exclusive tool present — running it alone and deferring sibling tool calls this turn",
          );
        }

        const toolExecutionPromise = Promise.all(
          toolUseBlocks.map(async (toolUse) => {
            if (deferSiblings && toolUse !== exclusiveBlock) {
              const result: Awaited<ReturnType<LoopToolExecutor>> = {
                content: deferredForExclusiveMessage(exclusiveBlock!.name),
                isError: false,
              };
              return { toolUse, result };
            }
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

        // Spool oversized results to `.tool-results/` and swap the inline
        // copy for the post-turn pass's stub now — on the raw blocks, before
        // the post-tool-use hooks, event emission, and history append. Running
        // ahead of the hooks means the spooled file holds the tool's full
        // output rather than the truncate plugin's tail-dropped copy, and the
        // hooks then see the stub. Stubbing before the first send keeps the
        // provider-bound history strictly append-only (rewriting an earlier
        // message between calls would invalidate the prompt-cache prefix on
        // every iteration).
        if (conversationDir) {
          const toolNameByUseId = new Map(
            toolUseBlocks.map((tu) => [tu.id, tu.name]),
          );
          try {
            spoolAndStubOversizedToolResults(rawResultBlocks, {
              conversationDir,
              toolNameById: (id) => toolNameByUseId.get(id),
            });
          } catch (err) {
            rlog.warn(
              { err, turn: toolUseTurns },
              "Spooling oversized tool results to disk failed (non-fatal)",
            );
          }
        }

        // Run the `post-tool-use` hook once per tool result, after the tool
        // returns and before the result joins the provider-bound history.
        // The default tool-result-truncate plugin tail-drops oversized output
        // to fit the context window (spool-stubbed results are already tiny;
        // spool-exempt ones still rely on it); user hooks can swap in a
        // smarter strategy (e.g. a summariser) or observe results for side
        // effects.
        const contextWindowTokens =
          options.resolveContextWindow?.().maxInputTokens ??
          this.config.maxInputTokens ??
          180_000;

        const resultBlocks: ContentBlock[] = [];
        const additionalContextBlocks: ContentBlock[] = [];
        for (const block of rawResultBlocks) {
          if (block.type !== "tool_result") {
            resultBlocks.push(block);
            continue;
          }
          const postToolUseCtx: PostToolUseInputContext = {
            conversationId: this.conversationId,
            toolResponse: block as ToolResultContent,
            messages: history,
            additionalContext: null,
            model: response.model,
            maxInputTokens: contextWindowTokens,
            callSite: callSite ?? null,
            supportsDynamicUi,
          };
          const finalCtx = await runHook(HOOKS.POST_TOOL_USE, postToolUseCtx);
          resultBlocks.push(finalCtx.toolResponse);
          if (finalCtx.additionalContext !== null) {
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
          await stopTurn("aborted_during_tools");
          break;
        }

        // If any tool result requests yielding to the user (e.g. interactive
        // surface awaiting a button click), push results and stop the loop.
        if (toolResults.some(({ result }) => result.yieldToUser)) {
          history.push({ role: "user", content: resultBlocks });
          await stopTurn("yield_to_user");
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
            // A handoff pauses this run so the orchestrator can drain a queued
            // message, then re-enters with a fresh run. It still ends *this*
            // turn, so fire the terminal `stop` chain to run teardown (clearing
            // per-turn state such as recovery bounds before the queued message
            // is processed) — but without emitting `agent_loop_exit`, since the
            // orchestrator owns the handoff signal and the conversation resumes.
            await runTerminalStop("checkpoint_handoff", { emitExit: false });
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
          await stopTurn("aborted_via_error");
          break;
        }

        const err = error instanceof Error ? error : new Error(String(error));

        // Reactive context-overflow recovery. The provider rejected the call
        // because the prompt exceeded its window. Fold the provider's actual
        // token count into the per-provider calibration (ground truth the
        // estimator under-counted) and stash the overflow signal so the next
        // iteration's budget gate forwards it into the compaction plugin's
        // reduction ladder, which advances one rung before re-issuing the call.
        // When the ladder is already spent and the provider still rejects, end
        // the turn with the terminal reason the final rung implies instead of
        // looping forever. Recovery requires the budget gate to be active; when
        // it is disabled (e.g. agent wakes) there is no ladder to drive, so the
        // overflow falls through to the generic error path below.
        if (
          isContextOverflowError(error) &&
          (options.resolveContextWindow?.().overflowRecovery.enabled ?? false)
        ) {
          if (overflowLadderExhausted) {
            await stopTurn(
              overflowAutoCompressApplied
                ? "budget_yield_unrecovered"
                : "context_too_large",
              err,
            );
            break;
          }
          const actualTokens = parseActualTokensFromError(error);
          if (actualTokens !== null) {
            recordEstimate(
              getCalibrationProviderKey(this.provider),
              "",
              lastPreSendEstimatedTokens,
              actualTokens,
            );
          }
          pendingOverflowSignal = {
            actualTokens,
            isInteractive: !isNonInteractive,
          };
          budgetGateArmed = true;
          rlog.warn(
            {
              turn: toolUseTurns,
              estimated: lastPreSendEstimatedTokens,
              actualTokens,
            },
            "Context too large — recovering via the compaction reduction ladder",
          );
          continue;
        }

        // A provider rejection is a model-call outcome: the loop has nothing
        // more to produce this turn unless a recovery hook repairs the history
        // and asks to retry. Run the `post-model-call` hook with the rejection
        // attached — a recovery hook (e.g. history-repair on an ordering
        // violation) can re-normalize the history and set `decision` to
        // `"continue"` to re-issue the call; hooks that only act on a real
        // reply ignore the rejection. The same per-run backstop bounds these
        // error-driven retries as the success-path ones. The chain is run
        // fail-open: a hook throw surfaces the original rejection.
        //
        // Confined to genuine provider rejections: a throw from elsewhere in
        // the turn body (tool execution, the success-path stop/post-model-call
        // hooks) is not a provider stop, so it falls straight through to the
        // error path below.
        if (error === providerCallError) {
          const errorOutcomeCtx: PostModelCallInputContext = {
            conversationId: this.conversationId,
            callSite: callSite ?? null,
            content: [],
            messages: [...history],
            stopReason: null,
            error: err,
            decision: "stop",
          };
          let errorOutcome: PostModelCallInputContext = errorOutcomeCtx;
          try {
            errorOutcome = await runHook(
              HOOKS.POST_MODEL_CALL,
              errorOutcomeCtx,
            );
          } catch (postModelCallError) {
            rlog.error(
              { err: postModelCallError },
              "post-model-call hook failed on a provider rejection — surfacing the original error",
            );
          }
          if (
            errorOutcome.decision === "continue" &&
            postModelCallContinues < MAX_POST_MODEL_CALL_CONTINUES
          ) {
            postModelCallContinues++;
            history = errorOutcome.messages;
            // A recovery hook rewrites the history anywhere (deep repair merges
            // and drops messages), so the prior input boundary no longer maps
            // onto the new array; the repaired history is the base the retry's
            // output appends after.
            newMessagesStart = history.length;
            continue;
          }
        }

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
        await stopTurn("error", err);
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
      newMessages: history.slice(newMessagesStart),
    };
  }
}
