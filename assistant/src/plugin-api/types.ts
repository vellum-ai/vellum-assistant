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
 * A plugin lifecycle hook. Receives a per-lifecycle context shape and
 * may return either a transformed context or `void`. Today's runtime
 * consumes only the resolved-or-rejected nature of the promise; the
 * `TCtx` return is reserved for hooks that fan a transformed context out
 * to downstream plugins (e.g. `user-prompt-submit`).
 *
 * Each known hook key has a documented context shape:
 *   - `init` — {@link PluginInitContext}
 *   - `shutdown` — {@link PluginShutdownContext}
 *   - `user-prompt-submit` — {@link UserPromptSubmitContext}
 *   - `pre-model-call` — {@link PreModelCallContext}
 *   - `post-tool-use` — {@link PostToolUseContext}
 *   - `stop` — {@link StopContext}
 *   - `assistant-message` — {@link AssistantMessageContext}
 */
export type PluginHookFn<TCtx = unknown> = (ctx: TCtx) => Promise<TCtx | void>;

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
   * singular of Codex's `additional_contexts`. Unset means no extra context.
   */
  additionalContext?: string;
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
 * Binary outcome of the `stop` hook. The agent loop seeds it to `"stop"`
 * and acts on the value the chain settles on:
 *
 * - `"stop"`     — let the turn end; the loop yields the assistant response
 *                  to the user. This is the default.
 * - `"continue"` — re-query the model. The hook is responsible for appending
 *                  the follow-up turn it wants the model to see to
 *                  {@link StopContext.messages} before returning.
 *
 * To abort with an error a hook should throw — the loop's error handler
 * surfaces it. There is intentionally no error decision value.
 */
export type StopDecision = "continue" | "stop";

/**
 * Context passed to the `stop` hook. Fires when the model yields a response
 * with no tool calls — the run's stop boundary, where the loop is about to
 * hand the turn back to the user. The default empty-response plugin uses it
 * to re-query the model when a turn came back empty or as a provider refusal.
 *
 * The hook decides the outcome by setting {@link decision}. When it sets
 * `"continue"` it must also append the follow-up turn (e.g. a nudge `user`
 * message) to {@link messages}; the loop threads those messages into the next
 * iteration. {@link messages} is the full conversation history, carried back
 * verbatim. A hook that needs to reason about just the current response cycle
 * (e.g. whether an earlier turn already delivered visible text) derives that
 * boundary from the history itself — the messages after the last genuine user
 * prompt — rather than an index, since mid-run compaction can rewrite the
 * array.
 *
 * Multiple plugins' hooks chain in registration order — each sees the
 * previous hook's `decision` and `messages` mutations.
 */
export interface StopContext {
  /** Conversation ID the run belongs to. */
  readonly conversationId: string;
  /**
   * Full conversation history: the inbound conversation followed by every
   * message produced this run. A hook that sets `decision` to `"continue"`
   * appends its follow-up turn here; the loop carries the result into the
   * next iteration.
   */
  messages: Message[];
  /**
   * Content blocks of the assistant turn that triggered the stop. Guaranteed
   * to contain no `tool_use` blocks — the hook only fires at the boundary
   * where the model stopped requesting tools.
   */
  readonly responseContent: ReadonlyArray<ContentBlock>;
  /**
   * Provider-reported stop reason for the assistant turn (e.g. `"refusal"`,
   * `"end_turn"`). `null`/`undefined` when the provider didn't report one.
   */
  readonly stopReason: string | null | undefined;
  /**
   * Seeded to `"stop"`. A hook sets it to `"continue"` to force another loop
   * iteration; later hooks in the chain may override it.
   */
  decision: StopDecision;
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
   * reply, or a background/utility site. Omitted by call sites that don't tag one.
   */
  readonly callSite?: LLMCallSite;
  /**
   * The system prompt about to be sent. A hook may replace it (e.g. strip or
   * append a section); the loop sends the resulting value.
   */
  systemPrompt: string | undefined;
  /**
   * Seeded `false`. When a hook sets it `true`, the loop suppresses this turn's
   * live assistant `text_delta` stream; an `assistant-message` hook is then
   * expected to produce the text the client sees (emitted once, after the reply
   * is finalized). Lets a plugin replace streamed output wholesale — e.g.
   * redaction that needs the full message — instead of leaking the raw stream.
   */
  deferAssistantOutput: boolean;
  /** Logger scoped to the current turn (tag structured fields with `{ plugin }`). */
  readonly logger: PluginLogger;
}

// ─── Assistant-message hook context ──────────────────────────────────────────

/**
 * Context passed to the `assistant-message` hook. Fires for each finalized
 * assistant message — once per model call, at the message-complete boundary —
 * before the message is persisted and (if deferred) streamed-final. Unlike
 * {@link StopContext}'s read-only `responseContent` (which exists for the stop
 * decision), {@link content} is mutable: the loop adopts the hook's result as the
 * persisted and streamed message.
 *
 * Fires on tool-bearing turns too (a reply can carry both text and `tool_use`),
 * so a hook should transform only the blocks it owns and leave others — notably
 * `tool_use` — intact. Runs for every finalized message regardless of call site;
 * hooks MUST self-gate on {@link callSite} / {@link conversationId}. Mutate in
 * place or return a new context; throwing is contained by the loop (the original
 * content is kept).
 */
export interface AssistantMessageContext {
  /** Conversation ID the message belongs to. */
  readonly conversationId: string;
  /** The call site this message serves — `"mainAgent"` for the user-facing reply. */
  readonly callSite?: LLMCallSite;
  /**
   * The finalized message content. Mutable — transform the text blocks and leave
   * `tool_use` (and other non-text blocks) intact.
   */
  content: ContentBlock[];
  /** Provider-reported stop reason for the turn, when reported. */
  readonly stopReason: string | null | undefined;
  /** Logger scoped to the current turn (tag structured fields with `{ plugin }`). */
  readonly logger: PluginLogger;
}
