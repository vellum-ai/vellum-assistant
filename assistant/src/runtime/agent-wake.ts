/**
 * Generic agent-loop wake mechanism for internal opportunities.
 *
 * Provides `wakeAgentForOpportunity()` — a callable used by subsystems
 * (e.g. meet chat-opportunity detector, scheduled tasks, memory-reducer
 * inferences) that want to invoke the agent loop without a user message.
 *
 * Semantics:
 *   - Resolves the conversation context exactly as a normal user turn.
 *   - Runs the conversation's auto-threshold compaction gate
 *     (`conversation.maybeCompact()`) before snapshotting the history —
 *     the wake bypasses the orchestrator's in-loop compaction, so this is
 *     its turn-start equivalent. Callers can pass
 *     `suppressAutoCompaction: true` to skip it; a suppressed wake whose
 *     input exceeds the effective context window fails deterministically
 *     with `reason: "context_overflow"` instead of compacting.
 *   - Hint delivery has two modes:
 *     - Default (ephemeral): appends `hint` as a non-persisted assistant
 *       message sandwiched between two static user bookends — never shows up
 *       in the transcript or SSE feed. The assistant role defangs prompt
 *       injection (LLMs don't follow instructions in their own prior output)
 *       and the bookends are hardcoded strings with no dynamic content. Suited
 *       to wakes carrying arbitrary/untrusted hint text (meet chat
 *       opportunities, the explicit wake route).
 *     - `persistTriggerAsEvent`: appends the trigger as a SINGLE PERSISTED,
 *       transcript-visible user message wrapped in `<background_event>` (any
 *       untrusted command output fenced in `<external_content>`). Keeping the
 *       trigger in durable, append-only history lets the provider prompt-cache
 *       treat repeated wakes like normal user turns instead of re-creating the
 *       whole prefix each wake. Used by background-command and scheduled wakes
 *       whose `hint` is trusted framing; wakes carrying arbitrary caller hint
 *       text stay on the ephemeral trio above.
 *   - Invokes the agent loop with all conversation tools available unless
 *     the caller provides an explicit `allowedTools` scope.
 *   - No tool calls AND no assistant text → silent no-op (nothing persisted,
 *     nothing emitted). Returns `{ invoked: true, producedToolCalls: false }`.
 *   - Tool calls produced → normal tool execution runs (the conversation's
 *     `AgentLoop` has its tool executor already wired). Returns
 *     `{ invoked: true, producedToolCalls: true }`.
 *   - Loop threw before ANY output went live or was persisted → the wake did
 *     no work. Returns `{ invoked: false, reason: "run_error" }` so callers
 *     that advance state on success (memory retrospective watermark,
 *     scheduler feed events) can retry instead of recording a phantom pass.
 *     A throw after output went live still returns `invoked: true`.
 *
 * Concurrency:
 *   - If a user turn (or another wake) is currently in flight on the same
 *     conversation, the wake is queued behind it (single-flight per
 *     `conversationId`).
 *   - While the wake's agent loop is running, the conversation is marked
 *     as processing (via the conversation's processing marker) so a user send
 *     that arrives mid-wake is queued by `enqueueMessage` instead of
 *     launching a concurrent `agentLoop.run()` on the same conversation.
 *
 * Logging:
 *   - Emits one structured log line per wake:
 *     `{ source, conversationId, durationMs, producedToolCalls, toolNamesCalled }`.
 *
 * Skill isolation:
 *   - This file lives in `assistant/src/runtime/` and is intentionally
 *     generic. It does not reference Meet or any specific skill. The Meet
 *     integration is wired up by `MeetSessionManager` (see PR 7).
 */

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { InterfaceId } from "../channels/types.js";
import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import {
  resolveProfilelessModelKey,
  selectWinningProfile,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { conversationSupportsDynamicUi } from "../daemon/channel-ui-capability.js";
import type { Conversation } from "../daemon/conversation.js";
import { recordUsage } from "../daemon/conversation-usage.js";
import { getDiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import {
  classifyDiskPressureTurnPolicy,
  type DiskPressureTurnPolicyDecision,
} from "../daemon/disk-pressure-policy.js";
import { looksLikeContextOverflowError } from "../daemon/parse-actual-tokens-from-error.js";
import type {
  SubagentToolGateMode,
  WakeToolContextPin,
} from "../daemon/tool-setup-types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { resolveTurnCallSite } from "../daemon/turn-call-site.js";
import {
  broadcastWakeSurface,
  emitWakeAgentEvent,
  persistWakeTailMessage,
  persistWakeTriggerMessage,
  scopeWakeAllowedTools,
} from "../daemon/wake-conversation-ops.js";
import {
  recordCompactionEndBestEffort,
  recordCompactionStartBestEffort,
} from "../persistence/compaction-log-store-clickhouse.js";
import { getConversationOverrideProfile } from "../persistence/conversation-crud.js";
import {
  buildProviderErrorResponsePayload,
  recordRequestLog,
  setAgentLoopExitReasonOnLatestLog,
} from "../persistence/llm-request-log-store.js";
import type { SystemPromptPersonaOverride } from "../prompts/system-prompt.js";
import type { Message } from "../providers/types.js";
import {
  type UntrustedContentSource,
  wrapUntrustedContent,
} from "../security/untrusted-content.js";
import type { CompletedBackgroundTool } from "../tools/background-tool-registry.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-wake");

/** Static preamble user message — no dynamic content, injection-safe. */
const WAKE_PREAMBLE =
  "[system] The following assistant message comes from an external system.";

/** Static postamble user message — ends conversation on a user turn. */
const WAKE_POSTAMBLE =
  "[system] End of message from external system, continue the conversation.";

/** Sanitize a value for use as an XML attribute (no quotes/brackets/newlines). */
function sanitizeEventAttr(value: string): string {
  return value.replace(/[<>"&\r\n]/g, "").slice(0, 200);
}

/**
 * Untrusted third-party output to fence inside a persisted wake trigger via
 * {@link wrapUntrustedContent}. `maxChars` overrides the per-source character
 * budget — used for preformatted shell output that `formatShellOutput` already
 * bounded (to `MAX_OUTPUT_LENGTH`) and appended an `<output_truncated file=…/>`
 * recovery marker to, so the wrapper does not re-truncate that marker off.
 */
interface WakeUntrustedOutput {
  content: string;
  source: UntrustedContentSource;
  maxChars?: number;
}

/**
 * Build the text for a persisted wake-trigger message: a `<background_event>`
 * wrapper carrying the trusted framing, with any untrusted command output
 * fenced in an `<external_content>` block the model is instructed never to
 * obey. The wrapper signals "a system event woke you" (replacing the legacy
 * `[system] external system` / `[opportunity:…]` bookends); `source` lives in
 * the tag attribute and the message metadata.
 */
function buildBackgroundEventText(
  source: string,
  framing: string,
  untrustedOutput?: WakeUntrustedOutput,
): string {
  const body = untrustedOutput
    ? `${framing}\n${wrapUntrustedContent(untrustedOutput.content, {
        source: untrustedOutput.source,
        maxChars: untrustedOutput.maxChars,
      })}`
    : framing;
  return `<background_event source="${sanitizeEventAttr(source)}">\n${body}\n</background_event>`;
}

/**
 * Warn line shared by the two reactive over-window failure sites (provider
 * rejection escaped as a throw / swallowed into a no-output stop). The
 * pre-flight estimate site logs its own distinct message.
 */
const OVER_WINDOW_REJECTION_LOG_MESSAGE =
  "agent-wake: provider rejected the input as over-window with auto-compaction suppressed; failing the wake";

export interface WakeOptions {
  conversationId: string;
  hint: string;
  source: string;
  /**
   * Optional trust context to apply to the conversation before the agent
   * loop runs. Required for internal background jobs that need elevated
   * trust to invoke side-effect tools — without it the loop falls back to
   * `trustClass: "unknown"` and side-effect tools are blocked. Caller
   * should pass `{ sourceChannel: "vellum", trustClass: "guardian" }` for
   * assistant-self-maintenance jobs.
   */
  trustContext?: TrustContext;
  /**
   * Explicit local-owner metadata for rare direct wakes that are allowed to run
   * in cleanup mode. Omit for background jobs; they are paused under disk
   * pressure even when they otherwise carry internal guardian trust.
   */
  sourceChannel?: TrustContext["sourceChannel"];
  sourceInterface?: InterfaceId | "vellum";
  /**
   * LLM call site to route this wake through. Defaults to `"mainAgent"` so
   * conversation wakes share the user's chat-model selection. Background jobs
   * (e.g. memory consolidation) pass their own call site so operators can
   * tune the model/profile and observability bucket independently.
   */
  callSite?: LLMCallSite;
  /**
   * Run the wake's LLM calls under this inference profile, floated ABOVE the
   * call site's named profile and call-site overrides (the resolver's
   * `forceOverrideProfile` escape hatch). When set, it replaces the
   * conversation's own pinned-profile lookup. Used by fork-based memory
   * retrospectives to resolve the SAME model/thinking/effort as the source
   * conversation's turns so the provider prompt-cache prefix can be reused.
   * A profile name that no longer exists in `llm.profiles` silently falls
   * back to normal call-site resolution (the resolver's standard
   * missing-reference semantics). Logging/attribution still bucket under
   * `callSite`.
   */
  forceOverrideProfile?: string;
  /**
   * Role to use for the injected hint message. Defaults to `"assistant"` so
   * the hint is sandwiched between two static user bookends — the canonical
   * anti-injection pattern for hints that may carry text from an external
   * source. Trusted internal callers (e.g. fork-based memory retrospectives)
   * can pass `"user"` to inject a single user-role message containing the
   * hint directly, which reads more naturally as an instruction from the
   * user/system rather than a self-directed assistant note.
   */
  hintRole?: "assistant" | "user";
  /**
   * Skip the wake's pre-run auto-threshold compaction gate and refuse to
   * run over-window instead of compacting.
   *
   * By default the wake runs `conversation.maybeCompact()` before
   * snapshotting the history — the wake invokes `conversation.agentLoop.run()`
   * directly with the loop's in-loop budget gate disabled, so this pre-run
   * gate is the wake path's equivalent of the turn-start compaction the
   * daemon orchestrator (`conversation-agent-loop.ts`) performs for user
   * turns. Passing `true` skips the gate entirely; if the wake input would
   * then exceed the effective context window, the wake fails fast with
   * `reason: "context_overflow"` instead of compacting, and a provider
   * context-overflow rejection mid-run is mapped to the same failure.
   *
   * Used by fork-based memory retrospectives: the wake operates on a
   * freshly-forked throwaway conversation that may already be near (or
   * past) the source's auto-threshold, but the goal is to operate on that
   * exact context — running a compaction LLM call before the wake's own
   * first call would waste tokens, defeat prompt-cache reuse, and fire
   * compaction side-effects on a fork that is deleted afterwards.
   */
  suppressAutoCompaction?: boolean;
  /**
   * Skip injection of the hint sandwich entirely. Used when the caller has
   * already persisted the instruction as a real message in the conversation
   * (e.g. fork-based memory retrospectives that append a user message to the
   * forked conversation before waking). When `true`, `hint` is ignored.
   */
  skipHintInjection?: boolean;
  /**
   * Skip injection of the "Conversation Woke" `ui_surface` card into the
   * first assistant tail message and the corresponding live
   * `onWakeProducedOutput` broadcast. Default false (existing behavior).
   * Used by callers whose conversation context already makes it obvious
   * that the agent's output came from a wake (e.g. fork-based memory
   * retrospectives whose conversation title already says "(Retrospective)").
   */
  suppressWakeSurface?: boolean;
  /**
   * Optional exact tool allowlist for this wake. Used by internal maintenance
   * jobs that need the assistant's judgment but must not execute arbitrary
   * side-effect tools. Enforcement depends on `toolGateMode`: in `"wire"`
   * mode (default) the tool definitions sent to the provider are filtered to
   * the allowlist; in `"execution"` mode the full tool surface stays on the
   * wire and non-allowlisted calls are rejected with an error tool_result
   * before their executor runs. Either way, only allowlisted tools can
   * execute during the wake.
   */
  allowedTools?: readonly string[];
  /**
   * How `allowedTools` is enforced — see {@link SubagentToolGateMode} for the
   * wire-vs-execution semantics and cache-parity rationale. Defaults to
   * `"wire"` (the historical behavior, byte-identical when absent). Ignored
   * when `allowedTools` is absent.
   */
  toolGateMode?: SubagentToolGateMode;
  /**
   * Client-context pin applied (and restored) alongside `allowedTools` for
   * the duration of the wake — see {@link WakeToolContextPin}. Pass only
   * with `toolGateMode: "execution"`: it exists purely so the wire tool
   * definitions resolve under the SOURCE conversation's client context
   * (provider prompt-cache parity) and is pointless when the wire is
   * allowlist-filtered anyway. Definition resolution only — pinned-in tools
   * remain execution-rejected by the gate. Ignored when `allowedTools` is
   * absent.
   */
  toolContextPin?: WakeToolContextPin;
  /**
   * Explicit persona/channel slugs for the wake's system-prompt build,
   * applied to the conversation for the duration of the run and restored
   * afterwards. Wakes bypass the orchestrator's turn-start persona snapshot,
   * so their prompt is otherwise built from whatever snapshot the
   * conversation already holds — for a freshly hydrated conversation (the
   * fork-retrospective case) that is the no-trust-context derivation
   * (guardian persona + "vellum" channel) regardless of which actor/channel
   * the conversation belongs to. Used by fork-based memory retrospectives to
   * render the SOURCE conversation's persona sections — both for review
   * quality and for byte-parity with the source's cached system-prompt
   * prefix. May also pin `hasNoClient` for the prompt build (see
   * {@link SystemPromptPersonaOverride}). Prompt-build selection only; trust
   * class and approval semantics are governed solely by `trustContext`.
   */
  personaOverride?: SystemPromptPersonaOverride;
  /**
   * Inject the wake's trigger as a SINGLE PERSISTED, transcript-visible user
   * message (wrapped in `<background_event>`) appended to the conversation
   * BEFORE the run, instead of the default ephemeral hint trio. This keeps the
   * message array append-only so the provider prompt-cache behaves like a
   * normal user turn — repeated wakes stop re-creating the whole prefix. The
   * trigger is persisted unconditionally (like a normal user turn's message),
   * even if the wake then produces no reply.
   *
   * `hint` is the trusted framing line; `untrustedOutput`, when given, is
   * appended fenced in `<external_content>` so the model treats command output
   * as data, never instructions. Mutually exclusive with the legacy
   * `hintRole` / `skipHintInjection` injection.
   */
  persistTriggerAsEvent?: boolean;
  /**
   * Untrusted third-party output (e.g. background-command stdout) to fence
   * inside the persisted trigger via {@link wrapUntrustedContent}. Only
   * consulted when `persistTriggerAsEvent` is set; `hint` stays the trusted
   * framing outside the fence.
   */
  untrustedOutput?: WakeUntrustedOutput;
  /**
   * Structured terminal record for a backgrounded bash/host_bash run, stamped
   * onto the persisted background-event wake so the web can rebuild the inline
   * card from history after a daemon restart.
   */
  backgroundToolCompletion?: CompletedBackgroundTool;
  /**
   * Schedule-run id to stamp on the usage rows this wake records. Set when the
   * wake is triggered by a script-mode schedule (the firing's run id), so the
   * woken turn's cost is attributed to that firing.
   */
  cronRunId?: string;
  /**
   * Run the woken turn clientless: pin `hasNoClient = true` for the duration of
   * the agent-loop run (restored after). Wakes bypass the orchestrator's
   * turn-start interactivity setup, so a wake on a conversation with no client
   * attached otherwise derives `isInteractive: true` (the default
   * `hasNoClient = false`). Pinning it makes `conversation-tool-setup` derive
   * `isInteractive: false`, which `policy-context` maps to `background`
   * (guardian) / `headless` (unknown) — so a side-effecting tool that would
   * prompt is denied instead of stalling on a client that isn't there.
   */
  clientless?: boolean;
}

/**
 * Reason a wake returned `invoked: false`. Callers (e.g. the CLI) need to
 * distinguish "conversation doesn't exist" from "conversation exists but
 * stayed busy past the wait-until-idle timeout" — the former is a
 * user-visible error, the latter is an expected transient condition.
 */
export type WakeSkipReason =
  | "not_found"
  | "archived"
  | "timeout"
  | "no_resolver"
  | "disk_pressure"
  /**
   * The wake input exceeds the effective context window and the caller
   * suppressed auto-compaction (`suppressAutoCompaction: true`), so the
   * run cannot proceed without the compaction it was told not to perform.
   * Only possible on suppressed wakes.
   */
  | "context_overflow"
  /**
   * The agent loop threw before producing ANY output — no checkpoint fired
   * and no tail message was emitted or persisted (typically a provider
   * failure on the run's first LLM call). The wake did no work, so callers
   * that treat `invoked: true` as "the pass ran" (e.g. the memory
   * retrospective, which advances its processed-message watermark and
   * finalizes on success) must see a retryable failure rather than a
   * silent no-op. A throw AFTER output went live keeps `invoked: true` —
   * side effects have already landed and the run must not read as skipped.
   */
  | "run_error";

export interface WakeResult {
  invoked: boolean;
  producedToolCalls: boolean;
  /** Present only when `invoked: false`; identifies why the wake was skipped. */
  reason?: WakeSkipReason;
}

/**
 * Dependencies injected for testing. Production callers can omit this
 * argument entirely and rely on the built-in default resolver.
 */
export interface WakeDeps {
  /**
   * Resolve the live {@link Conversation} for a wake invocation.
   * Returns `null` if the conversation doesn't exist, `"archived"` if it
   * exists but is archived, or the `Conversation` to proceed with the wake.
   *
   * Receives the full {@link WakeOptions} so the default resolver can
   * thread `trustContext` into `getOrCreateConversation`. Without that
   * threading, the conversation hydrates with `trustContext === undefined`
   * and `loadFromDb` fail-closes to `trustClass: "unknown"`, which filters
   * out every guardian-provenance message — fatal for fork-based memory
   * retrospectives.
   */
  resolveTarget: (
    opts: WakeOptions,
  ) => Promise<Conversation | null | "archived">;
  /** Timestamp source (for deterministic tests). */
  now?: () => number;
}

// ── Default resolution ────────────────────────────────────────────────
//
// When `wakeAgentForOpportunity()` is called without explicit `deps`,
// it resolves the live conversation directly via `getConversation` and
// `getOrCreateConversation`.

async function defaultResolveTarget(
  opts: WakeOptions,
): Promise<Conversation | null | "archived"> {
  const { conversationId } = opts;
  // Lazy-import daemon modules to avoid pulling heavyweight transitive
  // deps (conversation store → config/loader → provider catalogs) at
  // module-evaluation time.  Callers that only import agent-wake for
  // the types or for explicit-deps usage (tests, shell tools) never
  // trigger these imports.
  const { getConversation } =
    await import("../persistence/conversation-crud.js");
  const { getOrCreateConversation } =
    await import("../daemon/conversation-store.js");
  try {
    const existing = getConversation(conversationId);
    if (!existing) {
      return null;
    }
    if (existing.archivedAt != null) {
      log.info(
        { conversationId },
        "agent-wake: conversation is archived; rejecting wake",
      );
      return "archived";
    }
    // Thread trustContext through to getOrCreateConversation so the
    // hydration path applies setTrustContext + ensureActorScopedHistory
    // (conversation-store.ts:281-289) BEFORE the agent loop's per-turn
    // snapshot reads. Without this, fork-based memory retrospectives see
    // an empty history because loadFromDb ran with trustClass="unknown"
    // and filtered out every guardian-provenance message.
    const conversation = await getOrCreateConversation(conversationId, {
      trustContext: opts.trustContext,
    });
    return conversation;
  } catch (err) {
    log.warn(
      { err, conversationId },
      "agent-wake: failed to hydrate conversation",
    );
    return null;
  }
}

// ── Per-conversation single-flight lock ───────────────────────────────
//
// Simple promise-chain map. When a wake arrives and another run is in
// flight, we chain onto its tail so the wake runs *after* the current
// work completes. Using the tail promise avoids awaiting every prior
// completion in the chain (only the last one matters) and keeps memory
// bounded — the map entry is cleared once the chain completes.

const wakeChain = new Map<string, Promise<void>>();

async function runSingleFlight<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = wakeChain.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Install our tail *before* awaiting so later callers chain behind us.
  wakeChain.set(conversationId, next);
  try {
    await prior;
    return await fn();
  } finally {
    // Only clear the map entry if nothing chained behind us in the meantime.
    if (wakeChain.get(conversationId) === next) {
      wakeChain.delete(conversationId);
    }
    release();
  }
}

/**
 * How long a wake waits for an in-flight turn to release the conversation's
 * processing lock before skipping with reason "timeout". We rely primarily
 * on the single-flight chain above to serialize *wakes*; the pre-run
 * `waitForIdle` gate catches the case where a user turn started
 * independently while our wake was queued.
 */
const WAKE_IDLE_TIMEOUT_MS = 30_000;

function classifyWakeDiskPressurePolicy(opts: WakeOptions): {
  decision: DiskPressureTurnPolicyDecision;
  status: ReturnType<typeof getDiskPressureStatus>;
} {
  const status = getDiskPressureStatus();
  const decision = classifyDiskPressureTurnPolicy(status, {
    conversationSource: opts.source,
    callSite: opts.callSite ?? "mainAgent",
    isDirectWake: true,
    sourceChannel: opts.sourceChannel ?? opts.trustContext?.sourceChannel,
    sourceInterface: opts.sourceInterface,
    trustContext: opts.trustContext
      ? {
          sourceChannel: opts.trustContext.sourceChannel,
          trustClass: opts.trustContext.trustClass,
        }
      : null,
  });
  return { decision, status };
}

/**
 * Trust snapshot the wake hands to the agent loop. The wake's loop run has
 * no in-loop compaction path (it runs with overflow recovery disabled; the
 * wake compacts via the pre-run gate instead, which resolves trust from the
 * conversation's own trust context), so this snapshot is unread except on
 * the disk-pressure cleanup-mode path, whose guardian value scopes the
 * compactor's image manifest if cleanup ever compacts. Other wakes pass an
 * `unknown`-class snapshot so a missing actor cannot grant elevated trust.
 */
function buildWakeTrust(
  opts: WakeOptions,
  decision: DiskPressureTurnPolicyDecision,
): TrustContext {
  if (decision.action !== "allow-cleanup-mode") {
    return {
      sourceChannel: opts.sourceChannel ?? "vellum",
      trustClass: "unknown",
    };
  }
  return (
    opts.trustContext ??
    ({
      sourceChannel: opts.sourceChannel ?? "vellum",
      trustClass: "guardian",
    } satisfies TrustContext)
  );
}

/**
 * Inspect the post-run history slice to decide whether the wake produced
 * output worth persisting/emitting, and collect any tool-use names from
 * the *first* assistant reply (used only for logging).
 */
function inspectWakeOutput(
  baselineLength: number,
  hintMessageCount: number,
  updatedHistory: Message[],
): {
  tailMessages: Message[];
  hasVisibleText: boolean;
  toolUseNames: string[];
} {
  // The agent loop appends messages onto the history it was given. We
  // injected `hintMessageCount` hint messages (0, 1, or 3 depending on
  // hint mode), so anything at index >= baselineLength + hintMessageCount
  // came from the run.
  const firstAssistantIndex = baselineLength + hintMessageCount;
  if (updatedHistory.length <= firstAssistantIndex) {
    return { tailMessages: [], hasVisibleText: false, toolUseNames: [] };
  }
  const tailMessages = updatedHistory.slice(firstAssistantIndex);

  // Scan every tail message for visible text or tool_use blocks. A
  // multi-step run (assistant → tool_result → assistant) still counts as
  // "produced output" when the final assistant message is just a summary
  // — we must persist the entire tail so the DB mirrors in-memory
  // history.
  let hasVisibleText = false;
  const toolUseNames: string[] = [];
  for (const msg of tailMessages) {
    if (msg.role !== "assistant") {
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim().length > 0) {
          hasVisibleText = true;
        }
      } else if (block.type === "tool_use") {
        toolUseNames.push(block.name);
      }
    }
  }
  return { tailMessages, hasVisibleText, toolUseNames };
}

/**
 * Wake the agent loop on a conversation without a user message.
 *
 * See module-level doc for semantics. Safe to call concurrently; wakes
 * are serialized per `conversationId`.
 *
 * The `deps` argument is optional in production — when omitted, the
 * default resolver imports `getConversation` and
 * `getOrCreateConversation` directly to return the live conversation.
 * Tests that want tight control over resolution continue to pass
 * explicit deps.
 */
export async function wakeAgentForOpportunity(
  opts: WakeOptions,
  deps?: WakeDeps,
): Promise<WakeResult> {
  const { conversationId, hint, source } = opts;
  const suppressAutoCompaction = opts.suppressAutoCompaction === true;
  const resolveTarget = deps?.resolveTarget ?? defaultResolveTarget;
  const nowFn = deps?.now ?? Date.now;
  const startedAt = nowFn();

  return runSingleFlight(conversationId, async () => {
    // Snapshot the conversation's resting trust before the resolver runs, so
    // it can be restored after. The resolver leaves the wake's trust on the
    // conversation, and a following no-trust wake would otherwise read it via
    // tool setup's `currentTurnTrustContext ?? trustContext` fallback. Null
    // when the conversation isn't resident yet (a fresh hydrate or a fork).
    let priorPersistentTrust: TrustContext | null = null;
    if (opts.trustContext) {
      const { findConversation } =
        await import("../daemon/conversation-registry.js");
      priorPersistentTrust =
        findConversation(conversationId)?.trustContext ?? null;
    }
    const resolved = await resolveTarget(opts);
    if (resolved === "archived") {
      log.info(
        { conversationId, source },
        "agent-wake: conversation is archived; skipping",
      );
      return {
        invoked: false,
        producedToolCalls: false,
        reason: "archived" as const,
      };
    }
    if (!resolved) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation not found; skipping",
      );
      return { invoked: false, producedToolCalls: false, reason: "not_found" };
    }
    const conversation = resolved;

    // Put the resting trust back on exit. The guard restores only our own
    // elevation, so a trust re-set by another turn is left alone; it's also
    // idempotent, so the several call sites below are safe.
    const restorePersistentWakeTrust = (): void => {
      if (
        opts.trustContext &&
        conversation.trustContext === opts.trustContext
      ) {
        conversation.setTrustContext(priorPersistentTrust);
      }
    };

    const { decision: diskPressureDecision, status: diskPressureStatus } =
      classifyWakeDiskPressurePolicy(opts);
    if (diskPressureDecision.action === "block") {
      log.warn(
        {
          conversationId,
          source,
          reason: "disk_pressure",
          diskPressureReason: diskPressureDecision.reason,
          thresholdPercent: diskPressureStatus.thresholdPercent,
          usagePercent: diskPressureStatus.usagePercent,
          blockedCapability: "background-work",
          lockId: diskPressureStatus.lockId,
          path: diskPressureStatus.path,
        },
        "agent-wake: blocked by disk pressure cleanup mode",
      );
      restorePersistentWakeTrust();
      return {
        invoked: false,
        producedToolCalls: false,
        reason: "disk_pressure" as const,
      };
    }

    // Wait for any independently started user turn to release the processing
    // lock so we don't run a second agent loop concurrently. With no abort
    // signal, waitForIdle never rejects — `false` means the budget elapsed
    // with the lock still held. Idle waiters are notified FIFO from the same
    // `setProcessing(false)` transition, so a competing waiter registered
    // earlier (e.g. a voice turn) can re-take the lock before this
    // continuation runs — re-check `isProcessing()` after every wakeup and
    // re-wait on the remaining budget until the lock is observed free.
    const idleDeadline = nowFn() + WAKE_IDLE_TIMEOUT_MS;
    let idle = await conversation.waitForIdle({
      timeoutMs: WAKE_IDLE_TIMEOUT_MS,
    });
    while (idle && conversation.isProcessing()) {
      const remainingMs = idleDeadline - nowFn();
      idle =
        remainingMs > 0 &&
        (await conversation.waitForIdle({ timeoutMs: remainingMs }));
    }
    if (!idle) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation still processing after timeout; skipping",
      );
      restorePersistentWakeTrust();
      return { invoked: false, producedToolCalls: false, reason: "timeout" };
    }

    // Trust elevation is applied per-turn via `currentTurnTrustContext` right
    // before the run (see below) — not on the persistent conversation trust.

    // Honor the conversation's pinned inference-profile override (if any).
    // Without this, scheduled-task wakes and other opportunity wakes bypass
    // `runAgentLoopImpl` entirely and execute under workspace defaults,
    // silently violating the user's pinned preference. A caller-supplied
    // `forceOverrideProfile` replaces that lookup and additionally floats the
    // profile above the call-site layers (see the option's doc). Resolve the
    // effective context budget here as well because wakes bypass the normal
    // user-turn path that computes it for tool-result truncation. Read before
    // `setProcessing(true)` so a thrown DB/config read can't strand the
    // processing flag.
    const forceOverrideProfile = opts.forceOverrideProfile !== undefined;
    const overrideProfile =
      opts.forceOverrideProfile ??
      getConversationOverrideProfile(conversationId);
    const callSite = resolveTurnCallSite(opts.callSite, conversation);
    const config = getConfig();
    const effectiveContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite,
      overrideProfile,
      forceOverrideProfile,
    });
    // Same winner-selection sourcing as the agent loop's key: a hand-mirrored
    // chain would disagree with dispatch (a non-forced override wins on every
    // call site).
    const modelProfileKey =
      selectWinningProfile(callSite, config.llm, {
        ...(overrideProfile != null ? { overrideProfile } : {}),
        selectionSeed: conversationId,
      }).profileName ??
      resolveProfilelessModelKey(callSite, config.llm, {
        ...(overrideProfile != null ? { overrideProfile } : {}),
        ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
        selectionSeed: conversationId,
      });

    // Apply the caller's persona override for the duration of the run. The
    // prompt is built once before `agentLoop.run()` (via
    // `conversation.buildCurrentSystemPrompt()`), which reads this field;
    // cleared (below, before drainQueue) so a queued user turn never builds
    // its prompt under the wake's override. Assigned only AFTER the
    // profile/config reads above — those can throw, and they run before the
    // try/finally that clears the override, so an earlier assignment would
    // strand the override on the cached Conversation and corrupt every later
    // prompt build on it.
    if (opts.personaOverride) {
      conversation.wakePersonaOverride = opts.personaOverride;
    }
    const clearWakePersonaOverride = (): void => {
      if (opts.personaOverride) {
        conversation.wakePersonaOverride = undefined;
      }
    };

    // Mark processing for the duration of the wake — including the pre-run
    // compaction gate below, whose summary LLM call must not race a user
    // send into a concurrent agent loop on the same conversation. A user
    // message arriving while the flag is set is queued by `enqueueMessage()`
    // and drained after the wake's tail is pushed + persisted. This happens
    // before applying a wake-scoped tool allowlist so a concurrent user turn
    // cannot start under the wake's restricted tool set. The idle gate above
    // observed the lock free, and nothing between its final `isProcessing()`
    // check and this acquisition awaits — keep that stretch await-free so
    // the lock cannot change hands in between.
    conversation.setProcessing(true);

    // ── Pre-run auto-compaction gate ──────────────────────────────────
    // The wake invokes `conversation.agentLoop.run()` with the loop's
    // in-loop budget gate disabled (see `resolveContextWindow` below), so
    // the orchestrator's turn-start compaction never fires for wakes.
    // Mirror it here: run the conversation's auto-threshold compaction
    // before snapshotting the baseline — a successful compaction replaces
    // `conversation.messages`, so it must precede the snapshot. Callers
    // like fork-based memory retrospectives suppress this gate: the fork
    // is throwaway and a summarization LLM call on it is wasted spend.
    // Failure is non-fatal — the wake proceeds on the uncompacted history
    // exactly as it would have before the gate existed. The gate's window
    // sizing is threaded from the wake's own call-site resolution above —
    // without it, `maybeCompact` sizes the threshold against `mainAgent`,
    // which can pass un-compacted a wake whose call site resolves a smaller
    // window (and then overflow at the provider).
    if (!suppressAutoCompaction) {
      try {
        await conversation.maybeCompact({
          callSite,
          overrideProfile,
          forceOverrideProfile,
        });
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: pre-run auto-compaction failed; continuing with the uncompacted history",
        );
      }
    }

    // ── Persisted-trigger injection (append-only wake) ─────────────────
    // Append the trigger as a single VISIBLE user message to the in-memory
    // history AND the DB BEFORE snapshotting the baseline, so the message
    // array stays append-only (prompt-cache parity with a normal user turn)
    // and `baseline` already contains it. Runs after `maybeCompact` (a
    // successful compaction replaces `conversation.messages`) and inside the
    // single-flight lock + processing flag, so no concurrent turn interleaves.
    // Push first, then persist (matching the wake-tail flush idiom); a persist
    // failure is non-fatal — the in-memory push keeps this run's prompt
    // consistent. The trigger is part of `baseline`, so `flushPendingTail`
    // never re-persists it.
    if (opts.persistTriggerAsEvent) {
      const triggerMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: buildBackgroundEventText(source, hint, opts.untrustedOutput),
          },
        ],
      };
      conversation.messages.push(triggerMessage);
      try {
        await persistWakeTriggerMessage(
          conversation,
          triggerMessage,
          source,
          opts.backgroundToolCompletion,
        );
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: failed to persist wake trigger message; continuing",
        );
      }
    }

    const baseline = conversation.getMessages();
    // Snapshot the baseline length BEFORE the run starts. Incremental
    // persistence pushes onto `conversation.messages` mid-run, which grows the
    // live history array `baseline` aliases. Reading `baseline.length`
    // post-run would therefore include the tail we just pushed and the
    // tail-slice math would skip every message.
    const baselineLength = baseline.length;
    const wakeTrust = buildWakeTrust(opts, diskPressureDecision);
    // Build the ephemeral hint injection. `persistTriggerAsEvent` and
    // `skipHintInjection` produce no injection here — the former already
    // appended the trigger as a persisted message above; the latter relies on
    // the caller having persisted an instruction (fork retrospectives). The
    // remaining modes inject a non-persisted hint:
    //   - `hintRole === "user"`: single user-role message containing the hint
    //     directly. Used by trusted internal callers where the hint reads
    //     naturally as an instruction.
    //   - default (`hintRole === "assistant"`): sandwich the hint as an
    //     assistant message between two hardcoded user bookends. The assistant
    //     role defangs prompt injection (LLMs don't follow instructions in
    //     their own prior output) and the trailing user message satisfies
    //     providers that reject assistant prefill.
    const hintRole = opts.hintRole ?? "assistant";
    const wakeMessages: Message[] =
      opts.persistTriggerAsEvent || opts.skipHintInjection
        ? []
        : hintRole === "user"
          ? [
              {
                role: "user",
                content: [{ type: "text", text: hint }],
              },
            ]
          : [
              {
                role: "user",
                content: [{ type: "text", text: WAKE_PREAMBLE }],
              },
              {
                role: "assistant",
                content: [
                  { type: "text", text: `[opportunity:${source}] ${hint}` },
                ],
              },
              {
                role: "user",
                content: [{ type: "text", text: WAKE_POSTAMBLE }],
              },
            ];
    const wakeHintMessageCount = wakeMessages.length;
    const runInput: Message[] = [...baseline, ...wakeMessages];

    // Event handling runs in two modes. While `mode === "buffering"`,
    // events accumulate in `buffered` so that a wake which ultimately
    // produces nothing leaves no trace. As soon as we have evidence the
    // wake is producing output (first `onCheckpoint` after a tool turn,
    // or — for tool-free wakes — post-run inspection finds visible text),
    // we transition to `"live"`: flush the buffer, inject the ui_surface
    // card, and from that point forward emit each event directly so a
    // long-running wake (e.g. memory consolidation, often 5-30 minutes
    // and many turns) is observable in real time instead of materializing
    // only after `agentLoop.run()` returns.
    let mode: "buffering" | "live" = "buffering";
    const buffered: AgentEvent[] = [];
    // LLM request logs accumulated while buffering. Persisted only if the
    // wake transitions to live (i.e. produced output). A silent no-op wake
    // drops them — otherwise the next user-turn's `backfillMessageIdOnLogs`
    // sweep would misattach these NULL-messageId rows to an unrelated
    // future assistant message, contaminating inspector context.
    type PendingLog = {
      rawRequest: unknown;
      rawResponse: unknown;
      provider?: string;
    };
    const pendingLogs: PendingLog[] = [];
    // Exit reason deferred alongside pendingLogs. Same drop-on-silent-
    // wake guarantee: if the wake never goes live, this stays null and
    // no DB row is touched. Applied after pendingLogs flush in goLive
    // so the latest-row lookup in `setAgentLoopExitReasonOnLatestLog`
    // can see the freshly-persisted final usage row.
    let pendingExitReason: string | null = null;
    // Set when the provider rejects a call as context-too-large while
    // auto-compaction is suppressed. The loop has no recovery ladder to
    // drive (overflow recovery is disabled for wakes), so it swallows the
    // rejection into a graceful no-output stop — which would read as a
    // *successful* silent no-op to callers like the memory-retrospective
    // job. Capture the signal here so the wake can fail deterministically
    // instead (`reason: "context_overflow"`).
    let suppressedContextOverflow = false;
    const persistLog = (record: PendingLog): void => {
      try {
        recordRequestLog(
          conversationId,
          JSON.stringify(record.rawRequest),
          JSON.stringify(record.rawResponse),
          undefined,
          record.provider,
          callSite,
        );
      } catch (err) {
        log.warn(
          { err, conversationId, source },
          "agent-wake: failed to persist LLM request log (non-fatal)",
        );
      }
    };
    const persistExitReason = (reason: string): void => {
      try {
        setAgentLoopExitReasonOnLatestLog(conversationId, reason);
      } catch (err) {
        log.warn(
          { err, conversationId, source, reason },
          "agent-wake: failed to persist agent_loop_exit_reason (non-fatal)",
        );
      }
    };
    const safeEmit = (event: AgentEvent): void => {
      try {
        emitWakeAgentEvent(conversation, event);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: client emitter threw; continuing",
        );
      }
    };
    const onEvent = (event: AgentEvent): void => {
      // Compaction logging is observability, not turn state, so it writes
      // immediately even while buffering — a compaction during a silent
      // (never-goes-live) wake still happened and should be recorded.
      if (event.type === "context_compacting") {
        recordCompactionStartBestEffort(conversationId, event);
      }
      if (event.type === "compaction_completed") {
        recordCompactionEndBestEffort(conversationId, event);
      }
      // Normal user turns record usage via the `dispatchAgentEvent` event handler)
      // Wakes run their own onEvent and bypass it, so record here.
      if (event.type === "usage") {
        try {
          recordUsage(
            {
              conversationId,
              providerName: event.actualProvider ?? conversation.provider.name,
              usageStats: conversation.usageStats,
            },
            event.inputTokens,
            event.outputTokens,
            event.model,
            () => {},
            "main_agent",
            `wake:${source}`,
            event.cacheCreationInputTokens ?? 0,
            event.cacheReadInputTokens ?? 0,
            event.rawResponse,
            1,
            undefined,
            // Mirror the profile state the request actually ran under:
            // `forceOverrideProfile` floats the override above the call-site
            // profile (fork retrospectives with matchConversationProfile), and
            // the conversation-id seed resolves the same mix arm the dispatch
            // path chose. Without these, attribution credits the call-site
            // profile/arm instead of the one that ran.
            {
              callSite,
              overrideProfile: overrideProfile ?? null,
              forceOverrideProfile,
              selectionSeed: conversationId,
            },
            opts.cronRunId ?? null,
          );
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: usage recording failed (non-fatal)",
          );
        }
      }
      // Replicates the recordRequestLog side-effect in `handleUsage` because
      // wakes own their own onEvent and never reach `dispatchAgentEvent`.
      // Defer persistence while buffering — see `pendingLogs` above.
      if (event.type === "usage" && event.rawRequest && event.rawResponse) {
        const record = {
          rawRequest: event.rawRequest,
          rawResponse: event.rawResponse,
          provider: event.actualProvider,
        };
        if (mode === "buffering") {
          pendingLogs.push(record);
        } else {
          persistLog(record);
        }
      }
      // Mirror the same recording side-effect for provider-rejected calls.
      // `handleProviderError` in the daemon dispatcher persists these on the
      // normal turn path; the wake path owns its own onEvent and bypasses
      // that dispatcher entirely, so we replicate here. Buffering rules
      // match the success path: if the wake never goes live (silent no-op),
      // the rows are dropped so a stale `messageId IS NULL` row doesn't get
      // mis-backfilled onto an unrelated future assistant message.
      if (event.type === "provider_error") {
        const record: PendingLog = {
          rawRequest: event.rawRequest,
          rawResponse: buildProviderErrorResponsePayload(event.error),
          provider: event.actualProvider,
        };
        if (mode === "buffering") {
          pendingLogs.push(record);
        } else {
          persistLog(record);
        }
      }
      // Replicates the setAgentLoopExitReasonOnLatestLog side-effect that
      // `dispatchAgentEvent` does for the normal path. In live mode the
      // final usage event of the run has already landed its row, so the
      // latest-row lookup hits the right target. In buffering mode the
      // reason is stashed and applied in `goLive` after pendingLogs are
      // persisted, preserving the same ordering guarantee.
      if (event.type === "agent_loop_exit") {
        if (mode === "buffering") {
          pendingExitReason = event.reason;
        } else {
          persistExitReason(event.reason);
        }
      }
      // Detect an over-window rejection on a compaction-suppressed wake.
      // `provider_error` fires at the provider-call site; `error` fires from
      // the loop's generic catch — check both so a rewrapping retry layer
      // can't hide the signal. The heuristic check also catches adapter
      // paths (e.g. managed-proxy rewrappers) that surface the overflow as
      // an untyped error the typed `instanceof` check would miss.
      if (
        suppressAutoCompaction &&
        (event.type === "provider_error" || event.type === "error") &&
        looksLikeContextOverflowError(event.error)
      ) {
        suppressedContextOverflow = true;
      }
      if (mode === "buffering") {
        buffered.push(event);
        return;
      }
      safeEmit(event);
    };

    const wakeSurfaceId = `wake-${conversationId}-${nowFn()}`;
    let surfaceInjected = false;
    let persistedTailIndex = 0;

    // Transition from buffered to live emission. Idempotent — only the
    // first call has an effect. Mutates the first assistant message in
    // the tail to prepend the ui_surface block, emits the live
    // ui_surface event, then drains the buffered events through
    // `emitWakeAgentEvent`. The translator is what stamps `conversationId`
    // and renames `text_delta` → `assistant_text_delta`; bypassing it
    // would ship malformed wire frames.
    const goLive = (currentHistory: Message[]): void => {
      if (mode === "live") {
        return;
      }
      if (!surfaceInjected) {
        if (!opts.suppressWakeSurface) {
          const tailStart = baselineLength + wakeHintMessageCount;
          const tail = currentHistory.slice(tailStart);
          const firstAssistant = tail.find((m) => m.role === "assistant");
          if (firstAssistant && Array.isArray(firstAssistant.content)) {
            firstAssistant.content.unshift({
              type: "ui_surface",
              surfaceId: wakeSurfaceId,
              surfaceType: "card",
              title: "Conversation Woke",
              data: {
                title: "Conversation Woke",
                body: hint,
                metadata: [{ label: "Source", value: source }],
              },
              display: "inline",
            } as never);
          }
        }
        surfaceInjected = true;
      }
      if (!opts.suppressWakeSurface) {
        try {
          broadcastWakeSurface(conversation, source, hint, wakeSurfaceId);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: broadcastWakeSurface threw; continuing",
          );
        }
      }
      for (const event of buffered) {
        safeEmit(event);
      }
      buffered.length = 0;
      for (const record of pendingLogs) {
        persistLog(record);
      }
      pendingLogs.length = 0;
      // Apply the deferred exit reason after pendingLogs are persisted —
      // the latest-row lookup in `setAgentLoopExitReasonOnLatestLog`
      // needs the final usage row to already exist. Cleared after use so
      // an extremely unlikely double-goLive can't double-stamp.
      if (pendingExitReason !== null) {
        persistExitReason(pendingExitReason);
        pendingExitReason = null;
      }
      mode = "live";
    };

    // Push + persist any tail messages produced since the last call.
    // Pushes precede persists across the whole batch (matching the
    // canonical post-run ordering) so a queued user message draining
    // mid-flush still sees a consistent in-memory history before any DB
    // row lands. The persist guard mirrors the original post-run loop —
    // a single message persistence failure logs and continues so we
    // don't strand the rest of the tail.
    const flushPendingTail = async (
      currentHistory: Message[],
    ): Promise<void> => {
      const start = baselineLength + wakeHintMessageCount + persistedTailIndex;
      if (start >= currentHistory.length) {
        return;
      }
      const newMessages = currentHistory.slice(start);
      for (const msg of newMessages) {
        conversation.messages.push(msg);
      }
      for (const msg of newMessages) {
        try {
          await persistWakeTailMessage(conversation, msg);
        } catch (err) {
          log.warn(
            { conversationId, source, err, role: msg.role },
            "agent-wake: failed to persist wake-tail message",
          );
        }
      }
      persistedTailIndex += newMessages.length;
    };

    let wakeToolScopeRestored = false;
    let restoreWakeToolScope: (() => void) | null = null;
    const restoreWakeAllowedTools = (): void => {
      if (wakeToolScopeRestored) {
        return;
      }
      wakeToolScopeRestored = true;
      if (!restoreWakeToolScope) {
        return;
      }
      try {
        restoreWakeToolScope();
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: failed to restore tool allowlist; continuing",
        );
      }
    };
    const applyWakeAllowedTools = (): boolean => {
      if (!opts.allowedTools) {
        return true;
      }
      try {
        restoreWakeToolScope = scopeWakeAllowedTools(
          conversation,
          new Set(opts.allowedTools),
          opts.toolGateMode,
          opts.toolContextPin,
        );
        return true;
      } catch (err) {
        log.warn(
          { conversationId, source, allowedTools: opts.allowedTools, err },
          "agent-wake: failed to apply requested tool allowlist; skipping",
        );
        return false;
      }
    };

    // Fires after each tool-execution turn finalizes (assistant message
    // + matching tool_result user message both in history). A single
    // tool turn is unambiguous evidence of output — promote to live
    // mode and persist what's been produced so far so a client opening
    // the conversation mid-run can fetchHistory and see real content
    // instead of the empty-state welcome view.
    const onCheckpoint = async (
      checkpoint: CheckpointInfo,
    ): Promise<CheckpointDecision> => {
      goLive(checkpoint.history);
      await flushPendingTail(checkpoint.history);
      return "continue";
    };

    let runError: Error | null = null;
    let producedToolCalls = false;
    let toolUseNames: string[] = [];
    let tailMessageCount = 0;
    let drainedInTry = false;
    // Set when the wake fails with `reason: "context_overflow"`. The finally
    // block skips its generic outcome log for this path — the failure
    // already logged its own dedicated warn line.
    let failedContextOverflow = false;
    // Set when a mid-run throw was reported as `invoked: false` (reason
    // "run_error") because nothing had gone live or been persisted. The
    // finally's error log names the reported outcome so the line matches
    // what the caller actually saw.
    let reportedRunErrorAsFailure = false;
    // Shared failure path for an over-window condition on a
    // compaction-suppressed wake (reached from the pre-flight estimate, from
    // the run's catch when the rejection escaped as a throw, or post-run when
    // the loop swallowed it into a graceful no-output stop and only the event
    // capture saw it). `extraLogFields` is spread into the warn line so each
    // site can attach its own context (err, token estimates).
    const failSuppressedContextOverflow = (
      logMessage: string,
      extraLogFields: Record<string, unknown> = {},
    ): WakeResult => {
      failedContextOverflow = true;
      log.warn({ conversationId, source, ...extraLogFields }, logMessage);
      return {
        invoked: false,
        producedToolCalls: false,
        reason: "context_overflow" as const,
      };
    };
    try {
      // ── Over-window policy under suppressed auto-compaction ─────────
      // The pre-run gate above is the wake's only compaction path (the
      // loop's in-loop budget gate stays disabled), so when the caller
      // suppressed it an over-window input has no recovery. Fail fast and
      // deterministically — before spending any LLM call — instead of
      // letting the provider reject the run into a silent no-op. Estimated
      // with the same estimator the auto-compaction pre-check uses; an
      // estimator failure proceeds fail-open (the reactive
      // `suppressedContextOverflow` capture below still maps a provider
      // rejection to the same failure).
      if (suppressAutoCompaction) {
        let estimatedInputTokens: number | null = null;
        try {
          estimatedInputTokens =
            conversation.contextWindowManager.estimateInputTokens(runInput);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: over-window pre-flight estimate failed; proceeding without it",
          );
        }
        if (
          estimatedInputTokens !== null &&
          estimatedInputTokens > effectiveContextWindow.maxInputTokens
        ) {
          return failSuppressedContextOverflow(
            "agent-wake: input exceeds the effective context window and auto-compaction is suppressed; failing fast",
            {
              estimatedInputTokens,
              maxInputTokens: effectiveContextWindow.maxInputTokens,
            },
          );
        }
      }

      if (!applyWakeAllowedTools()) {
        return {
          invoked: false,
          producedToolCalls: false,
          reason: "no_resolver" as const,
        };
      }

      // Wakes bypass `runAgentLoopImpl`, which is what stamps the live turn's
      // call site and override profile onto the conversation for the tool
      // executor to read. Without stamping them here, `subagent_spawn` (and
      // usage attribution) see an unstamped context and resolve children under
      // workspace defaults instead of the profile this wake actually runs
      // under — so a wake on a conversation pinned to another profile spawns
      // children under the wrong one. Restored in the `finally` so a queued
      // user turn or a later background read never inherits the wake's stamps.
      const priorCallSite = conversation.currentCallSite;
      const priorTurnOverrideProfile = conversation.currentTurnOverrideProfile;
      const priorHasNoClient = conversation.hasNoClient;
      const priorTurnTrust = conversation.currentTurnTrustContext;
      conversation.currentCallSite = callSite;
      conversation.currentTurnOverrideProfile = overrideProfile;
      if (opts.clientless) {
        conversation.hasNoClient = true;
      }
      // Per-turn guardian elevation for the wake's tools, set after the pre-run
      // reads so a pre-run failure can't leak it; restored in the finally.
      if (opts.trustContext) {
        conversation.currentTurnTrustContext = opts.trustContext;
      }

      let updatedHistory: Message[];
      try {
        ({ history: updatedHistory } = await conversation.agentLoop.run({
          messages: runInput,
          onEvent,
          requestId: `wake:${source}`,
          onCheckpoint,
          // Route through the caller-supplied call site (defaults to
          // `mainAgent` so a normal user-turn wake shares the user's chat
          // selection). Without an explicit callSite, the resolver in
          // `RetryProvider` and the routing in `CallSiteRoutingProvider`
          // short-circuit and silently drop both per-callsite config and the
          // pinned `overrideProfile` below.
          callSite,
          supportsDynamicUi: conversationSupportsDynamicUi(conversation),
          trust: wakeTrust,
          overrideProfile,
          forceOverrideProfile,
          // The wake's compaction lives in the pre-run gate above
          // (`conversation.maybeCompact()`), never in the loop: the in-loop
          // budget gate and overflow-recovery ladder stay disabled because
          // the wake's tail accounting holds external indexes into the
          // returned history (`baselineLength` + hint count), which an
          // in-loop compaction rebase would invalidate. `maxInputTokens` is
          // still supplied for tool-result truncation.
          resolveContextWindow: () => ({
            maxInputTokens: effectiveContextWindow.maxInputTokens,
            overflowRecovery: { enabled: false, safetyMarginRatio: 0 },
          }),
          modelProfileKey,
          ...(conversation.modelOverride
            ? { model: conversation.modelOverride }
            : {}),
        }));
      } catch (err) {
        // An over-window throw on a compaction-suppressed wake is the
        // suppression contract's failure mode, not a generic loop error —
        // surface it as a deterministic failed result. The heuristic check
        // also catches rewrapped (untyped) provider overflow errors.
        if (
          suppressedContextOverflow ||
          (suppressAutoCompaction && looksLikeContextOverflowError(err))
        ) {
          return failSuppressedContextOverflow(
            OVER_WINDOW_REJECTION_LOG_MESSAGE,
            { err },
          );
        }
        // Capture the error for post-finally logging, then short-circuit
        // the rest of the try body — no tail to push/persist when the
        // run threw mid-flight. The outer finally still runs to release
        // `processing` and drain the queue.
        runError = err instanceof Error ? err : new Error(String(err));
        // Nothing went live and nothing was persisted: no checkpoint fired
        // (mode never left "buffering") and no tail message was flushed.
        // The run died before doing any work — typically a provider error
        // on the first LLM call — so report a failure instead of a silent
        // no-op. Callers gate real state transitions on `invoked` (the
        // memory retrospective advances its processed-message watermark
        // and finalizes on success; the scheduler emits a success feed
        // event), and a no-op result here permanently consumes their
        // trigger without a run ever happening. A throw after output went
        // live keeps `invoked: true`: side effects have already landed,
        // and the run must not read as skipped.
        if (mode === "buffering" && persistedTailIndex === 0) {
          reportedRunErrorAsFailure = true;
          return {
            invoked: false,
            producedToolCalls: false,
            reason: "run_error" as const,
          };
        }
        return { invoked: true, producedToolCalls: false };
      } finally {
        // Restore the pre-wake values so a queued user turn or background read
        // never observes the wake's stamps. (`runAgentLoopImpl` re-stamps both
        // at the start of the next normal turn regardless.)
        conversation.currentCallSite = priorCallSite;
        conversation.currentTurnOverrideProfile = priorTurnOverrideProfile;
        conversation.hasNoClient = priorHasNoClient;
        conversation.currentTurnTrustContext = priorTurnTrust;
      }

      // The loop swallows provider rejections into a graceful no-output
      // stop, so an over-window rejection on a compaction-suppressed wake
      // surfaces only through the event stream (captured into
      // `suppressedContextOverflow` by `onEvent`). Map it to a deterministic
      // failure instead of the silent no-op it would otherwise read as.
      if (suppressedContextOverflow) {
        return failSuppressedContextOverflow(OVER_WINDOW_REJECTION_LOG_MESSAGE);
      }

      // Run completed cleanly. The canonical user-turn pattern
      // (conversation-agent-loop.ts:1860, 2106-2126) updates
      // `ctx.messages` first, then clears the flag via `ctx.setProcessing(false)`, then
      // calls `ctx.drainQueue(...)`. We mirror that order so a message
      // queued during the wake dequeues against an already-updated
      // history — otherwise `drainSingleMessage` reads `ctx.messages`
      // mid-tail and writes a DB row that lands out of chronological
      // order (queued user msg before the wake's just-produced assistant
      // outputs).
      const {
        tailMessages,
        hasVisibleText,
        toolUseNames: names,
      } = inspectWakeOutput(
        baselineLength,
        wakeHintMessageCount,
        updatedHistory,
      );
      toolUseNames = names;
      producedToolCalls = names.length > 0;
      const producedOutput = producedToolCalls || hasVisibleText;

      if (!producedOutput || tailMessages.length === 0) {
        // Silent no-op: drop buffered events, push nothing, persist
        // nothing, emit nothing. (No checkpoint fired during the run
        // since checkpoints only fire after tool turns and there were
        // none.) The finally still runs drainQueue so a racy queued
        // message isn't stranded.
        return { invoked: true, producedToolCalls: false };
      }

      tailMessageCount = tailMessages.length;

      // Tool-free wakes (assistant text only, no tool calls) don't fire
      // any checkpoint, so we still need a one-shot transition here.
      // For checkpoint-driven wakes, goLive() / flushPendingTail() are
      // both idempotent — the post-run call picks up only the final
      // assistant message that came after the last checkpoint.
      goLive(updatedHistory);
      await flushPendingTail(updatedHistory);

      // Drain queued messages AFTER tail is pushed + persisted so the
      // next dequeued user message sees the complete, up-to-date
      // history. setProcessing(false) must come first (the queue only
      // accepts entries while processing === true, and drain expects
      // processing to already be false). The finally block handles the
      // error/early-return paths where no tail was produced.
      restoreWakeAllowedTools();
      clearWakePersonaOverride();
      try {
        conversation.setProcessing(false);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: setProcessing(false) threw; continuing",
        );
      }
      try {
        await conversation.drainQueue();
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: drainQueue threw; continuing",
        );
      }
      drainedInTry = true;

      return { invoked: true, producedToolCalls };
    } finally {
      // Put the conversation's resting trust back on every exit path.
      restorePersistentWakeTrust();
      // The success path (above) already called setProcessing(false)
      // + drainQueue after tail persist. This catch-all handles the
      // error and early-return paths where no tail was produced — those
      // exit the try body before reaching the drain block, so
      // `drainedInTry` is still false.
      if (!drainedInTry) {
        restoreWakeAllowedTools();
        clearWakePersonaOverride();
        try {
          conversation.setProcessing(false);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: setProcessing(false) threw; continuing",
          );
        }
        try {
          await conversation.drainQueue();
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: drainQueue threw; continuing",
          );
        }
      }

      const durationMs = nowFn() - startedAt;
      const suppressWakeSurface = opts.suppressWakeSurface === true;
      if (failedContextOverflow) {
        // Already logged its own dedicated warn line at the failure site;
        // a generic "silent no-op" line here would misclassify a failed
        // wake as a successful empty one.
      } else if (runError) {
        log.error(
          {
            conversationId,
            source,
            durationMs,
            suppressAutoCompaction,
            suppressWakeSurface,
            hintRole,
            err: runError,
          },
          reportedRunErrorAsFailure
            ? "agent-wake: agent loop threw before producing output; reported as run_error"
            : "agent-wake: agent loop threw after output went live; treating as no-op",
        );
      } else if (tailMessageCount === 0) {
        log.info(
          {
            source,
            conversationId,
            durationMs,
            suppressAutoCompaction,
            suppressWakeSurface,
            hintRole,
            producedToolCalls: false,
            toolNamesCalled: [],
          },
          "agent-wake: no output; silent no-op",
        );
      } else {
        log.info(
          {
            source,
            conversationId,
            durationMs,
            suppressAutoCompaction,
            suppressWakeSurface,
            hintRole,
            producedToolCalls,
            toolNamesCalled: toolUseNames,
            tailMessageCount,
          },
          "agent-wake: produced output",
        );
      }
    }
  });
}

// ── Test-only helpers ────────────────────────────────────────────────

/**
 * Reset the internal single-flight map. Exported for tests that want a
 * clean slate between cases. Not part of the public API — do not call
 * from production code.
 *
 * @internal
 */
export function __resetWakeChainForTests(): void {
  wakeChain.clear();
}
