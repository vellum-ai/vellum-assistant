/**
 * Public plugin-API types — the canonical contract for
 * `@vellumai/plugin-api`. Adding fields is non-breaking; renaming /
 * removing is breaking and gated on a major bump.
 */

import type { LLMCallSite } from "../config/schemas/llm.js";
import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";

export type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../tools/types.js";
export { RiskLevel } from "../tools/types.js";

// ─── Logger ──────────────────────────────────────────────────────────────────

/**
 * Minimal pino-compatible logger surface handed to plugin hooks. The host
 * supplies a pino child logger bound to `{ plugin: <name> }`; this
 * interface intentionally captures only the two call shapes plugin code
 * needs (structured object + optional message), so the public surface
 * doesn't take a dependency on pino's full type machinery.
 *
 * Each method accepts a structured-fields object followed by an optional
 * message string. Plugin authors that need pino's wider API (`child()`,
 * `level`, etc.) can cast to their own narrower interface in plugin code
 * — but the canonical contract here covers the 99% case.
 */
export interface PluginLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

// ─── Hook function ───────────────────────────────────────────────────────────

/**
 * A plugin lifecycle hook. Receives a per-lifecycle context shape and may
 * either mutate `ctx` in place (returning `void`) or return a *partial*
 * context whose fields are merged onto the threaded context — only the keys
 * it returns are overwritten, every other field is preserved. Returning a
 * partial lets a hook edit just the subset of fields it cares about without
 * having to re-specify the rest. The merged context is threaded to the next
 * hook in the chain (e.g. `user-prompt-submit`).
 *
 * Because an omitted key means "keep the existing value", every field on a
 * context shape is required (no `?`-optional or `| undefined` members): a
 * present key always carries a concrete value, so "absent from the returned
 * partial" is never ambiguous with "explicitly cleared". Fields that can be
 * empty model that with `| null`, not `| undefined`.
 *
 * Each known hook key has a documented context shape:
 *   - `init` — {@link PluginInitContext}
 *   - `shutdown` — {@link PluginShutdownContext}
 *   - `user-prompt-submit` — {@link UserPromptSubmitContext}
 *   - `pre-model-call` — {@link PreModelCallContext}
 *   - `post-tool-use` — {@link PostToolUseContext}
 *   - `stop` — {@link StopContext}
 *   - `post-model-call` — {@link PostModelCallContext}
 */
export type PluginHookFn<TCtx = unknown> = (
  ctx: TCtx,
) => Promise<Partial<TCtx> | void>;

// ─── Init context ────────────────────────────────────────────────────────────

/**
 * Context passed to `Plugin.init()` during bootstrap. Carries resolved
 * config/credentials, a pino-compatible logger scoped to the plugin, a
 * per-plugin writable data directory, and the assistant's version metadata.
 */
export interface PluginInitContext {
  /** Parsed config for this plugin (may be `unknown` until the manifest validates). */
  config: unknown;
  /** Resolved credential values keyed by the entries of `manifest.requiresCredential`. */
  credentials: Record<string, string>;
  /** Pino-compatible child logger bound to `{ plugin: <name> }`. */
  logger: PluginLogger;
  /** Absolute path to `<workspaceDir>/plugins-data/<plugin>/` (created by bootstrap). */
  pluginStorageDir: string;
  /**
   * Assistant semver. Plugins can compare against this for defensive
   * runtime checks — but the canonical compat contract is the host
   * version against the plugin's `peerDependencies["@vellumai/plugin-api"]`
   * semver range, enforced at load time by the external-plugin loader.
   */
  assistantVersion: string;
}

// ─── Shutdown context ────────────────────────────────────────────────────────

/**
 * Context passed to the `shutdown` hook during daemon teardown. Kept
 * intentionally narrower than {@link PluginInitContext} — most teardown
 * paths only need to know which assistant version they're shutting
 * down against (e.g. for version-conditional cleanup of state files
 * written by a previous boot).
 *
 * Additional fields may be added as concrete plugin needs surface; the
 * `assistantVersion` field mirrors the init context's so plugins that
 * stash a version stamp at init can compare against the same name on
 * tear-down without keeping their own copy.
 */
export interface PluginShutdownContext {
  /** Assistant semver for compatibility checks inside the plugin. */
  assistantVersion: string;
}

// ─── User-prompt-submit hook context ─────────────────────────────────────────

/**
 * Context passed to the `user-prompt-submit` hook. Fires once per user
 * turn, after the agent loop has prepared the message list (PKB / NOW /
 * memory-graph injections, overflow reduction all already applied) and
 * immediately before the messages are handed to the agent loop's tool/LLM
 * iteration.
 *
 * The hook may transform `latestMessages` either by mutating it in place
 * (`push` / `splice` / `length = 0`) or by returning a new context with
 * a fresh `latestMessages` array — see {@link PluginHookFn}'s polymorphic
 * return shape. The daemon threads the final `latestMessages` value into
 * `agentLoop.run()` as the run-messages argument.
 *
 * `originalMessages` is the user's original message list, frozen for the
 * hook. Plugins should treat it as a stable reference point if they need
 * to recover from earlier transformations or compare against the pristine
 * state.
 *
 * Multiple plugins' hooks chain in registration order — each plugin's
 * hook sees the previous plugin's mutations (whether by reassignment or
 * in-place mutation).
 */
export interface UserPromptSubmitContext {
  /** Conversation ID the user prompt was submitted on. */
  readonly conversationId: string;
  /**
   * Persisted ID of the user message that triggered this turn. Hooks that
   * attach turn-scoped metadata to the originating message (e.g. recording an
   * injected memory block so it survives a conversation reload) key off this
   * row id rather than the in-memory message arrays, whose entries carry no id.
   */
  readonly userMessageId: string;
  /**
   * Stable ID for the request that drives this turn. Hooks that perform
   * runtime injection forward it onto the injector turn context so the
   * assembled blocks are attributed to the originating request; it is fixed
   * for the turn and cannot be recovered from the message arrays.
   */
  readonly requestId: string;
  /**
   * Active inference profile key to surface in this turn's context, or `null`
   * when the profile is unchanged since the one last announced to the model.
   * Hooks that emit the `model_profile` grounding line resolve the
   * human-readable label (and model id) from this key via the workspace LLM
   * config rather than receiving the rendered string — the key is the minimal
   * turn input the message arrays cannot carry.
   */
  readonly modelProfileKey: string | null;
  /**
   * Whether the turn has no human present to answer clarification questions
   * (e.g. a scheduled, background, or headless run). Resolved once at turn
   * start from the run's interactivity option, falling back to live client
   * presence — a single value the hook reads rather than re-deriving from
   * mutable conversation state that can flip mid-turn. Hooks that assemble the
   * turn's runtime injections forward it so the assembled context reflects the
   * turn's interactivity.
   */
  readonly isNonInteractive: boolean;
  /**
   * The text of the user prompt that triggered this turn — the resolved
   * user message (after slash-command expansion), independent of any
   * internal rewriting applied to the message that flows into the model.
   * Mirrors the `prompt` field Claude Code / Codex pass to their
   * `UserPromptSubmit` hooks, so hooks that key off the submitted text
   * (e.g. title generation) read it directly rather than reconstructing
   * it from the message arrays.
   */
  readonly prompt: string;
  /**
   * The user's original message list, immutable for the hook. Plugins
   * may snapshot or compare against this but MUST NOT mutate it.
   */
  readonly originalMessages: ReadonlyArray<Message>;
  /**
   * The working message list that flows into `agentLoop.run`. Plugins
   * may mutate this in place or replace it by returning a new context.
   */
  latestMessages: Message[];
  /**
   * Logger scoped to the current turn. The same instance is shared by
   * every hook in the chain, so plugins should tag their structured log
   * fields (e.g. `{ plugin: "<name>" }`) for attribution.
   */
  readonly logger: PluginLogger;
}

// ─── Post-compact hook context ───────────────────────────────────────────────

/**
 * Context passed to the `post-compact` hook. Fires after the agent loop
 * compacts a conversation mid-turn — once the running history has been
 * summarized down to fit the context window, and before the turn resumes.
 *
 * Compaction strips the turn's runtime injections (scratchpad, retrieved
 * memory, workspace context, transcript snapshots) along with the raw messages
 * it summarizes. This hook's job is to re-apply whatever injected context must
 * survive onto the freshly compacted history before the next provider call.
 * The default memory-retrieval plugin contributes a hook here that re-injects
 * its memory blocks and re-tracks the memory graph; user hooks can re-apply
 * their own injected context the same way.
 *
 * The hook re-injects by mutating `history` in place (or returning a new
 * context with a replacement `history`) — see {@link PluginHookFn}'s
 * polymorphic return shape. The agent loop reads the settled `history` back off
 * the context and resumes the turn from it. Multiple plugins' hooks chain in
 * registration order, each seeing the previous plugin's edits.
 */
export interface PostCompactContext {
  /**
   * The compacted message history to re-inject onto. Hooks mutate this in
   * place (or return a new context with a replacement) to re-apply context
   * that compaction stripped; the loop resumes the turn from the settled
   * value.
   */
  history: Message[];
  /**
   * Stable ID for the request that drives this turn. Hooks that perform
   * runtime injection forward it onto the injector turn context so the
   * re-applied blocks are attributed to the originating request; it is fixed
   * for the turn and cannot be recovered from the message history.
   */
  readonly requestId: string;
  /** Conversation ID the turn being compacted is scoped to. */
  readonly conversationId: string;
  /**
   * Whether the turn has no human present to answer clarification questions
   * (e.g. a scheduled, background, or headless run). Mirrors the field of the
   * same name on {@link UserPromptSubmitContext}: resolved once at turn start
   * so re-injection reflects the turn's interactivity rather than mutable
   * client-presence state that can flip mid-turn.
   */
  readonly isNonInteractive: boolean;
  /**
   * Active inference profile key to surface in the re-injected context, or
   * `null` when the profile is unchanged since the one last announced to the
   * model. Mirrors {@link UserPromptSubmitContext.modelProfileKey}: hooks that
   * emit the `model_profile` grounding line resolve the human-readable label
   * from this key rather than receiving the rendered string.
   */
  readonly modelProfileKey: string | null;
  /**
   * Volume of runtime injection to re-apply. `"full"` restores the complete
   * runtime context; `"minimal"` is the reduced volume overflow recovery's
   * injection-downgrade rung selects to keep the re-injected prompt small.
   * Defaults to `"full"` when omitted.
   */
  readonly injectionMode?: "full" | "minimal";
}

// ─── Post-tool-use hook context ──────────────────────────────────────────────

/**
 * Context passed to the `post-tool-use` hook. Fires once per tool result —
 * after the tool returns and before the result is appended to the message
 * history sent to the provider. With several tools dispatched in a single
 * turn, the hook fires once per result, in tool-use order.
 *
 * The hook may transform the result either by mutating `toolResponse` in
 * place (e.g. reassigning `toolResponse.content`) or by returning a new
 * context with a fresh `toolResponse` — see {@link PluginHookFn}'s
 * polymorphic return shape. The daemon threads the final `toolResponse`
 * into the provider-bound history.
 *
 * Multiple plugins' hooks chain in registration order — each plugin's hook
 * sees the previous plugin's mutations. The default tool-result-truncate
 * plugin contributes a hook here that tail-drops oversized output to fit the
 * model's context window; the default tool-error plugin sets
 * {@link additionalContext} with retry coaching for failed results. User hooks
 * can swap in a smarter strategy (e.g. a summarizer) or observe results for
 * side effects.
 */
export interface PostToolUseContext {
  /** Conversation ID the tool ran on. */
  readonly conversationId: string;
  /**
   * The tool result block. Plugins may mutate its `content` in place or
   * replace the block by returning a new context.
   */
  toolResponse: ToolResultContent;
  /**
   * Conversation history up to and including the assistant turn that issued
   * this tool call. The current result is not in it yet — it lives in
   * {@link toolResponse}. A hook reasoning about prior tool outcomes (e.g.
   * how many times a tool has failed in a row) derives that from the history
   * content rather than a precomputed counter, so the signal survives mid-run
   * compaction rewriting the array. Read-only: hooks transform the result via
   * {@link toolResponse}, not by mutating history.
   */
  readonly messages: ReadonlyArray<Message>;
  /**
   * Extra guidance for the model that is not part of the tool's output. A hook
   * sets this to surface provider-only context — e.g. retry coaching for a
   * failed result — and the daemon appends it to the provider-bound history as
   * a separate block *after* emitting the tool_result, so it reaches the model
   * without polluting the client-facing or persisted tool output. Mirrors
   * Claude Code's PostToolUse `hookSpecificOutput.additionalContext` and the
   * singular of Codex's `additional_contexts`. `null` means no extra context.
   */
  additionalContext: string | null;
  /**
   * Model id reported by the provider for the assistant turn that issued
   * this tool call (e.g. `claude-opus-4-8`,
   * `accounts/fireworks/models/kimi-k2p6`). Hooks use it to vary coaching by
   * model family — some models need earlier or firmer steering than others.
   */
  readonly model: string;
  /**
   * The model's context-window size in tokens. Plugins derive their own
   * character budget from this (e.g. a share of the window) rather than
   * receiving a precomputed limit.
   */
  readonly maxInputTokens: number;
  /**
   * Logger scoped to the current turn. The same instance is shared by
   * every hook in the chain, so plugins should tag their structured log
   * fields (e.g. `{ plugin: "<name>" }`) for attribution.
   */
  readonly logger: PluginLogger;
}

// ─── Stop hook context ───────────────────────────────────────────────────────

/**
 * Why an agent turn reached a terminal state. Supplied to the `stop` hook via
 * {@link StopContext.exitReason} and emitted on the `agent_loop_exit` event,
 * then persisted onto the final `llm_request_logs` row of the turn (rows from
 * intermediate turns keep a NULL reason, which is how downstream tooling and
 * the LLM Context Inspector tell "loop kept going" from "loop is done").
 *
 * Values are stable wire/DB strings — they are written to SQLite and surfaced
 * over the inspector wire format, so renaming any of them is a breaking change.
 */
export type AgentLoopExitReason =
  /** User cancellation observed before the turn's next provider call. */
  | "aborted_pre_call"
  /** Assistant message had no tool-use blocks (or no tool executor). */
  | "no_tool_calls"
  /** User cancellation observed while building the tool-results message. */
  | "aborted_post_response"
  /** User cancellation observed mid-tool-execution; completed results kept. */
  | "aborted_during_tools"
  /** A tool result requested handing back to the user. */
  | "yield_to_user"
  /** The orchestrator yielded at a checkpoint to process a queued message. */
  | "checkpoint_handoff"
  /** Context-window recovery exhausted and the turn ended with an error. */
  | "context_too_large"
  /**
   * An auto-compress rerun (post-emergency-compaction, post-tier reducer)
   * still yielded at the mid-loop budget checkpoint — the turn terminated with
   * no further recovery layer to re-enter. A pure observability signal so the
   * silent stall is attributable instead of leaving the exit reason NULL.
   */
  | "budget_yield_unrecovered"
  /** Provider stopped because the configured output-token limit was reached. */
  | "max_tokens_reached"
  /** User cancellation landed after a non-terminal checkpoint yield. */
  | "aborted_after_checkpoint"
  /** User cancellation observed while the catch handler synthesized an error turn. */
  | "aborted_via_error"
  /** An unhandled error ended the turn. */
  | "error";

/**
 * Context passed to the `stop` hook — the loop's definitive terminal hook.
 *
 * It fires exactly once per run, after the loop has committed to ending and
 * will not run another iteration this run. Unlike `post-model-call` (which owns
 * the model-call-outcome retry decision), `stop` cannot continue the loop: by
 * the time it runs the turn's outcome is settled. That guarantee makes it the
 * home for teardown — a hook can release per-turn resources or clear per-turn
 * state knowing nothing will re-enter the loop this run.
 *
 * It fires on every terminal exit: a no-tool reply, a max-tokens stop, a
 * yield-to-user, an exhausted context-overflow recovery, a user abort, or an
 * unhandled error. It also fires on a `checkpoint_handoff`, which ends the run
 * for teardown purposes even though the orchestrator resumes the conversation
 * in a fresh run. {@link exitReason} reports which one and {@link error}
 * carries the rejection when the turn ended on one, so a hook that should act
 * only on a particular ending guards on {@link exitReason}.
 *
 * Multiple plugins' hooks chain in registration order over the same context.
 */
export interface StopContext {
  /** Conversation ID the run belongs to. */
  readonly conversationId: string;
  /**
   * Full conversation history at the terminal stop — the inbound conversation
   * followed by every message produced this run. Provided for inspection;
   * mutating it has no effect, since the loop will not run again this turn.
   */
  readonly messages: ReadonlyArray<Message>;
  /**
   * The provider rejection that ended the turn, when it ended on one (e.g. an
   * unrecoverable error after recovery hooks declined to retry). Absent on a
   * clean stop.
   */
  readonly error?: Error;
  /**
   * Which terminal state the turn reached. A `checkpoint_handoff` fires this
   * hook for teardown — the run pauses so the orchestrator can drain a queued
   * message — but is not emitted as an `agent_loop_exit`, since the
   * conversation resumes in a fresh run. `aborted_after_checkpoint` is a
   * control transfer that re-enters the loop and so never reaches this hook.
   */
  readonly exitReason: AgentLoopExitReason;
  /**
   * Logger scoped to the current turn. The same instance is shared by
   * every hook in the chain, so plugins should tag their structured log
   * fields (e.g. `{ plugin: "<name>" }`) for attribution.
   */
  readonly logger: PluginLogger;
}

// ─── Pre-model-call hook context ─────────────────────────────────────────────

/**
 * Context passed to the `pre-model-call` hook. Fires immediately before each
 * provider call — once per model call within a turn, including tool-result
 * follow-up calls. Because it runs for every provider call (background, subagent,
 * and compaction work can share a conversation), hooks MUST self-gate on
 * {@link callSite} / {@link conversationId} before acting.
 *
 * A hook may edit the outbound request by replacing {@link systemPrompt}, and may
 * opt this turn into deferred output streaming via {@link deferAssistantOutput}.
 * Mutate the context in place or return a new one; throwing is contained by the
 * loop (the call proceeds with the original request).
 */
export interface PreModelCallContext {
  /** Conversation ID the call belongs to. */
  readonly conversationId: string;
  /**
   * The call site this provider call serves — `"mainAgent"` for the user-facing
   * reply, or a background/utility site. `null` for call sites that don't tag one.
   */
  readonly callSite: LLMCallSite | null;
  /**
   * The system prompt about to be sent. A hook may replace it (e.g. strip or
   * append a section); the loop sends the resulting value.
   */
  systemPrompt: string | null;
  /**
   * Seeded `false`. When a hook sets it `true`, the loop suppresses this turn's
   * live assistant `text_delta` stream; a `post-model-call` hook is then
   * expected to produce the text the client sees (emitted once, after the reply
   * is finalized). Lets a plugin replace streamed output wholesale — e.g.
   * redaction that needs the full message — instead of leaking the raw stream.
   */
  deferAssistantOutput: boolean;
  /** Logger scoped to the current turn (tag structured fields with `{ plugin }`). */
  readonly logger: PluginLogger;
}

// ─── Post-model-call hook context ────────────────────────────────────────────

/**
 * Binary outcome of the `post-model-call` hook. The agent loop seeds it to
 * `"stop"` and acts on the value the chain settles on:
 *
 * - `"stop"`     — accept the model-call outcome. On a finalized reply the loop
 *                  keeps the (possibly transformed) message; on a rejection it
 *                  surfaces the error. This is the default.
 * - `"continue"` — re-query the model. The hook is responsible for leaving
 *                  {@link PostModelCallContext.messages} as the history the next
 *                  iteration should send (append a follow-up turn, or replace
 *                  the array with a repaired one).
 */
export type PostModelCallDecision = "continue" | "stop";

/**
 * Context passed to the `post-model-call` hook. Fires at every model-call
 * outcome — the seam where the loop reacts to what the provider returned:
 *
 * - **Finalized reply.** The provider returned a message. {@link error} is
 *   absent, {@link content} holds the reply's blocks (mutable — the loop adopts
 *   the hook's result as the persisted and streamed message), and
 *   {@link stopReason} carries the provider's stop reason. Fires once per model
 *   call, including tool-bearing turns (a reply can carry both text and
 *   `tool_use`). A hook should leave blocks it does not own untouched, but it
 *   may **append a `tool_use` block** to invoke a tool as if the model had
 *   called it — the loop executes whatever the finalized content carries (see
 *   {@link content}). This is the supported way for a plugin to drive a tool
 *   (e.g. render a surface via `ui_show`) deterministically after a turn.
 * - **Provider rejection.** The call threw before any reply existed.
 *   {@link error} holds the rejection, {@link content} is empty, and
 *   {@link stopReason} is `null`. A hook that recognizes the rejection may
 *   repair {@link messages} and set {@link decision} to `"continue"` to retry;
 *   hooks that only act on a real reply must guard on {@link error} and return
 *   early.
 *
 * The retry decision is honored only at actionable outcomes — a no-tool reply
 * or a provider rejection — and is ignored on tool-bearing turns (the loop
 * already runs the tools). The loop does not gate the decision on call site, so
 * a hook that should only retry the user-facing turn MUST self-gate on
 * {@link callSite} / {@link conversationId} to avoid re-querying background,
 * subagent, or compaction calls. Mutate in place or return a new
 * context; throwing is contained by the loop (the original content is kept and
 * the outcome is treated as `"stop"`). Multiple plugins' hooks chain in
 * registration order — each sees the previous hook's `decision` and mutations.
 */
export interface PostModelCallContext {
  /** Conversation ID the message belongs to. */
  readonly conversationId: string;
  /** The call site this message serves — `"mainAgent"` for the user-facing reply; `null` when untagged. */
  readonly callSite: LLMCallSite | null;
  /**
   * The finalized message content. Mutable, and the source of truth for both
   * persistence and execution: the loop derives the turn's executable tool
   * calls from this array *after* the hook chain runs. A hook may transform the
   * text blocks, **append a `tool_use` block** to invoke a tool as if the model
   * had called it (executed through the normal tool path — trust rules apply,
   * and its result/surface is appended after any already-streamed text without
   * discarding it), or drop a `tool_use` block to suppress a call. The host
   * assigns an id to any appended `tool_use` block whose `id` is empty or
   * collides. Empty on a provider rejection. Appended `tool_use` blocks are
   * dropped on a truncated (max-tokens) turn, which short-circuits before the
   * executor runs and so cannot pair a tool call with a result.
   */
  content: ContentBlock[];
  /**
   * Full conversation history: the inbound conversation followed by every
   * message produced this run. A hook that sets {@link decision} to
   * `"continue"` leaves this as the history the next iteration should send — a
   * finalized-reply hook appends its follow-up turn (e.g. a nudge `user`
   * message); a rejection-recovery hook replaces the array with a repaired one.
   */
  messages: Message[];
  /** Provider-reported stop reason for the turn; `null` when not reported. */
  readonly stopReason: string | null;
  /**
   * The provider rejection that ended the call, on a rejection outcome. Absent
   * on a finalized reply. A hook that recovers from a specific rejection class
   * inspects this and may repair {@link messages} and set {@link decision} to
   * `"continue"`; hooks that only act on a real reply must return early when it
   * is present.
   */
  readonly error?: Error;
  /**
   * Seeded to `"stop"`. A hook sets it to `"continue"` to force another loop
   * iteration; later hooks in the chain may override it. Honored only at
   * actionable outcomes (see the interface docstring).
   */
  decision: PostModelCallDecision;
  /** Logger scoped to the current turn (tag structured fields with `{ plugin }`). */
  readonly logger: PluginLogger;
}
