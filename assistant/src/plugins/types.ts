/**
 * Plugin core types.
 *
 * A plugin may contribute lifecycle hooks ({@link PluginHooks}) that the
 * runtime invokes at named events, and model-visible capabilities (`tools`,
 * `routes`, `skills`). The registry tracks every registered plugin in
 * registration order.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import type { CompactionCircuitClosedEvent } from "../api/events/compaction-circuit-closed.js";
import type { CompactionCircuitOpenEvent } from "../api/events/compaction-circuit-open.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ContextWindowManager } from "../context/window-manager.js";
import type {
  ChannelCapabilities,
  InboundActorContext,
  InjectionMode,
} from "../daemon/conversation-runtime-assembly.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import type { PluginHookFn } from "../plugin-api/types.js";
import type { Message } from "../providers/types.js";
import type { SkillRoute } from "../runtime/skill-route-registry.js";
import type { Tool } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Static metadata describing a plugin — declared at module load time and
 * validated by the registry (duplicate-name check, API-version compatibility).
 *
 * `provides` and `requires` are capability → semantic-version maps. The
 * registry checks each entry in `requires` against the assistant's exposed
 * capability table and refuses to register plugins that ask for a version the
 * assistant does not expose. `provides` is currently declared-but-unused —
 * see the field docstring below.
 */
export interface PluginManifest {
  /** Unique plugin identifier (kebab-case). Duplicate names fail registration. */
  name: string;
  /**
   * Plugin version (semver). Informational. Host-compat negotiation lives
   * in the plugin's `package.json` `peerDependencies["@vellumai/plugin-api"]`
   * range — checked by the external-plugin loader against the assistant's
   * own version at load time.
   */
  version: string;
  /** Credential keys the plugin needs resolved before `init()` runs. */
  requiresCredential?: string[];
  /**
   * Assistant feature-flag keys that must all be enabled for this plugin to
   * activate. Checked by `bootstrapPlugins` via `isAssistantFeatureFlagEnabled`
   * — if any listed flag is disabled, the plugin is skipped entirely for the
   * boot (no `init()`, no tool/route/skill contributions, no shutdown hook).
   */
  requiresFlag?: string[];
  /**
   * Zod-compatible validator (or any parser-like object) for the plugin's
   * config block under `plugins.<name>`. Typed as `unknown` here — concrete
   * validators land in M2/M3 PRs.
   */
  config?: unknown;
}

// ─── Public plugin-API types ─────────────────────────────────────────────────
// Defined in `assistant/src/plugin-api/types.ts` and re-exported here so
// existing internal call sites keep working. Plugin authors import these from
// `@vellumai/plugin-api`.
export type {
  PluginHookFn,
  PluginInitContext,
  PluginShutdownContext,
} from "../plugin-api/types.js";

// ─── Memory-graph result ─────────────────────────────────────────────────────

/**
 * Full output of a single memory-graph retrieval — the object returned by
 * {@link ConversationGraphMemory.prepareMemory} (injected messages, query
 * vectors, metrics). The agent loop consumes these fields directly to drive
 * PKB hint search and runtime injection.
 */
export type GraphMemoryResult = Awaited<
  ReturnType<ConversationGraphMemory["prepareMemory"]>
>;

/**
 * The complete set of compaction circuit-breaker transition events:
 * `compaction_circuit_open` when the breaker trips and `compaction_circuit_closed`
 * on the open→closed transition. Both are a subset of `ServerMessage`, so any
 * existing `ServerMessage` sink remains assignable to a
 * `(msg: CompactionCircuitEvent) => void` parameter.
 */
export type CompactionCircuitEvent =
  | CompactionCircuitOpenEvent
  | CompactionCircuitClosedEvent;

// ─── TurnContext ─────────────────────────────────────────────────────────────

/**
 * Per-turn execution context threaded to the injector chain and to hook
 * consumers that need turn-level identity.
 *
 * Combines turn-level identifiers (`requestId`, `conversationId`,
 * `turnIndex`) and the canonical {@link TrustContext} (trust class and
 * channel identity for the inbound actor) with the per-turn injection inputs
 * consumed by the default {@link Injector} chain — the text, gating state,
 * and timezone/actor parameters that drive each injector's
 * {@link InjectionBlock} output.
 *
 * `applyRuntimeInjections` resolves the injection fields once per turn and
 * layers them onto the caller's context right before
 * {@link collectInjectorBlocks}. Call sites that synthesize a context outside
 * the agent loop (tests, overflow-reducer reinjection, etc.) may omit them —
 * every injection field is optional and every default injector treats a
 * missing input as "no injection on this turn".
 *
 * `TrustContext` is re-exposed here (rather than redefined) so the plugin
 * surface always stays in sync with the assistant's trust model.
 */
export interface TurnContext {
  /** Stable ID for the current request (one per inbound message). */
  requestId: string;
  /** Conversation ID the turn is scoped to. */
  conversationId: string;
  /** 0-based turn index within the conversation. */
  turnIndex: number;
  /** Trust classification and channel identity for the inbound actor. */
  trust: TrustContext;
  /**
   * Optional handle to the conversation's {@link ContextWindowManager}.
   *
   * Attached by the orchestrator so the default compaction implementation can
   * defer to the real compaction machinery via `context.manager`. Call sites
   * that never touch compaction may omit it.
   *
   * Declared as an optional typed field so plugin code can read it without a
   * lenient cast. The optional shape is load-bearing: synthesized handler
   * contexts and other non-compaction call sites still construct valid
   * `TurnContext` literals without attaching a manager.
   */
  contextWindowManager?: ContextWindowManager;
  /**
   * Controls which runtime injections are applied. `"full"` (default) runs
   * every gating branch; `"minimal"` skips high-token optional blocks
   * (workspace, PKB, NOW.md, subagent status) and only emits safety-critical
   * context (unified turn context, etc.). Drives per-injector gating.
   */
  readonly mode?: InjectionMode;
  /**
   * Wall-clock timestamp for the turn, formatted in the actor's effective
   * timezone. Drives the `current_time` line of the `<turn_context>` block;
   * when absent the `unified-turn-context` injector emits nothing.
   */
  readonly timestamp?: string;
  /** Human-readable interface label (e.g. "vellum", "telegram"). */
  readonly interfaceName?: string;
  /** Channel label gating response-discretion guidance in `<turn_context>`. */
  readonly channelName?: string;
  /**
   * Inbound actor identity and trust fields. Populated only on non-guardian
   * turns; `null`/absent suppresses the actor section of `<turn_context>`.
   */
  readonly actorContext?: InboundActorContext | null;
  /** Guardian-configured timezone, used to detect a client/config mismatch. */
  readonly configuredUserTimezone?: string | null;
  /** Client-reported timezone, used to detect a client/config mismatch. */
  readonly clientTimezone?: string | null;
  /** Server-detected timezone fallback when the client does not report one. */
  readonly detectedTimezone?: string | null;
  /**
   * Human-readable gap since the previous user message (e.g. "14h ago"), only
   * set when the gap exceeds the long-absence threshold.
   */
  readonly timeSinceLastMessage?: string | null;
  /**
   * Human-readable active inference profile, only set when it changed since
   * the last turn (or on the first turn).
   */
  readonly modelProfile?: string | null;
  /** Pre-built `<active_subagents>` block or null to skip. */
  readonly subagentStatusBlock?: string | null;
  /** Channel capabilities — drives slack gating. */
  readonly channelCapabilities?: ChannelCapabilities | null;
  /**
   * Pre-rendered Slack chronological transcript that overrides `runMessages`
   * for any Slack conversation (channels and DMs alike). Null/undefined means
   * the default `runMessages` array is used unchanged.
   */
  readonly slackChronologicalMessages?: Message[] | null;
  /**
   * Pre-rendered `<active_thread>` focus block to append to the final user
   * turn when the inbound lives inside a Slack thread. Null/undefined means
   * no focus block is appended.
   */
  readonly slackActiveThreadFocusBlock?: string | null;
  /**
   * When true, inject the `<non_interactive_context>` block so the model
   * knows no human is present to answer clarification questions.
   */
  readonly isNonInteractive?: boolean;
  /**
   * True when the active conversation's type is "background" or "scheduled"
   * (see `isBackgroundConversationType`). Read by the `background-turn`
   * injector to wrap the tail user message with a contextual reminder when
   * the turn is also non-interactive.
   */
  readonly isBackgroundConversation?: boolean;
  /**
   * Active documents open in this conversation — surfaced by the
   * `active-documents` injector so the assistant can target existing docs
   * with `document_update` instead of creating duplicates.
   */
  readonly activeDocuments?: ReadonlyArray<{
    surfaceId: string;
    title: string;
    wordCount: number;
    updatedAt: number;
  }> | null;
  /**
   * The {@link LLMCallSite} this turn belongs to — `"mainAgent"` for the
   * user-facing conversational reply, or the specific background/utility site
   * (`"compactionAgent"`, `"subagentSpawn"`, `"memoryConsolidation"`,
   * `"conversationTitle"`, …) when the agent loop is driving non-main work
   * that happens to share the same `conversationId`.
   *
   * Lets {@link Injector}s scope their behaviour to the main reply and stay
   * out of background turns, which `onEvent` presence alone cannot distinguish
   * (compaction and subagent loops also stream). Omitted by call sites that
   * don't tag a site (synthesized test contexts); consumers should treat
   * absence conservatively.
   */
  callSite?: LLMCallSite;
}

// ─── Injectors ───────────────────────────────────────────────────────────────

/**
 * Where an {@link InjectionBlock} should be grafted onto the per-turn
 * `runMessages` array.
 *
 * - `"prepend-user-tail"` — prepend the block as a `text` content block to
 *   the tail user message's `content` array. Used when the block should
 *   appear before any other user content on this turn (e.g. the unified
 *   turn context, workspace top-level context).
 * - `"append-user-tail"` — append the block as a `text` content block to
 *   the tail user message. Used for blocks that should sit *after* the
 *   user's typed text (e.g. subagent status, slack active-thread focus).
 * - `"after-memory-prefix"` — insert the block immediately after any leading
 *   memory-prefix blocks (`<memory_context>`, `<memory __injected>`) on the
 *   tail user message. Keeps memory/PKB/NOW in their canonical relative
 *   order regardless of how many after-memory-prefix blocks are spliced.
 * - `"replace-run-messages"` — replace the full `runMessages` array with the
 *   block's `messagesOverride`. Used by the Slack chronological-transcript
 *   injector (the transcript is a whole new message list rendered from the
 *   persisted rows, not a tail-block mutation).
 */
export type InjectionPlacement =
  | "prepend-user-tail"
  | "append-user-tail"
  | "after-memory-prefix"
  | "replace-run-messages";

/**
 * A structured fragment contributed by an {@link Injector}.
 *
 * Each block carries the rendered `text` plus a {@link InjectionPlacement}
 * that tells `applyRuntimeInjections` where to graft it onto the per-turn
 * message array. The placement vocabulary preserves the positional
 * semantics of the hardcoded `inject*` helpers the default injectors
 * replaced — prepends, appends, and splices relative to memory-prefix
 * blocks all remain expressible.
 *
 * `placement` defaults to `"append-user-tail"` when omitted so the existing
 * ordering-contract tests (PR 21) that produce `{ id, text }` blocks
 * continue to compose via `composeInjectorChain` into a single
 * blank-line-separated string.
 *
 * `messagesOverride` is only consulted for `"replace-run-messages"` — other
 * placements ignore it.
 */
export interface InjectionBlock {
  /** Stable block identifier (used for dedupe/ordering). */
  readonly id: string;
  /** Plain-text body to insert. */
  readonly text: string;
  /**
   * Position within the tail user message (or the full runMessages array,
   * for `"replace-run-messages"`). Defaults to `"append-user-tail"` when
   * omitted.
   */
  readonly placement?: InjectionPlacement;
  /**
   * Replacement `runMessages` value for `"replace-run-messages"` placements.
   * Required when `placement === "replace-run-messages"`; ignored otherwise.
   */
  readonly messagesOverride?: Message[];
  /** Optional metadata the renderer may use. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * A named producer of {@link InjectionBlock}s.
 *
 * `order` sorts injectors ascending within each turn. Producers return
 * `null` to opt out for the current turn.
 */
export interface Injector {
  /** Stable name (distinct across all registered injectors). */
  name: string;
  /** Ascending sort key — lower runs first. */
  order: number;
  /**
   * Produce a block, or `null` to contribute nothing on this turn.
   *
   * `runMessages` is the turn's working message array — the same array the
   * chain's blocks are spliced onto — passed explicitly so injectors that
   * need the current prompt contents (e.g. the PKB reminder, which scans for
   * already-loaded `file_read` paths) read it from a parameter rather than a
   * field on the shared {@link TurnContext}. Absent for text-only chain
   * consumers ({@link composeInjectorChain}) that drive injectors without a
   * message array.
   */
  produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null>;
}

// ─── Model-visible capability slots ──────────────────────────────────────────
// Concrete shapes are defined by the tool/route/skill registries. Tool
// contributions (PR 31) use the canonical `Tool` interface; route
// contributions (PR 32) use the `SkillRoute` shape from the skill-route
// registry; skill contributions (PR 33) ship with the concrete
// `PluginSkillRegistration` shape below so plugins can declare
// catalog-discoverable skills today.

/**
 * HTTP route registration contributed by a plugin. Plugins express routes as
 * {@link SkillRoute} values — the same shape the skill-route registry
 * consumes — so `registerSkillRoute` can accept them directly. Bootstrap
 * wires the registrations after `init()` succeeds, retains the opaque
 * handle returned by each `registerSkillRoute` call, and uses those handles
 * (not the regex patterns themselves) to unregister the plugin's routes on
 * shutdown. Identity-keyed unregistration is what keeps sibling owners that
 * happen to register the same regex from evicting each other's routes.
 */
export type PluginRouteRegistration = SkillRoute;

/**
 * A skill contributed by a plugin.
 *
 * When a plugin declares {@link Plugin.skills}, the bootstrap registers each
 * entry into an in-memory side catalog that {@link loadSkillCatalog} merges
 * into its output. The entry is then discoverable by the model's `skill_load`
 * / `skill_execute` flow under `source: "plugin"` — the same code paths used
 * for filesystem-backed skills.
 *
 * The fields mirror the subset of `SkillSummary` / `SkillDefinition` that
 * makes sense for an in-memory contribution. Inline commands and reference
 * files are out of scope for plugin skills in this PR — add them later if a
 * real plugin needs them.
 */
export interface PluginSkillRegistration {
  /** Stable skill id (kebab-case). Must be unique across the catalog. */
  id: string;
  /**
   * Skill "name" as surfaced to the model. Matches the SKILL.md frontmatter
   * `name` field for filesystem skills.
   */
  name: string;
  /**
   * Human-readable display name shown in UI lists. Defaults to `name` when
   * omitted — matches the filesystem-skill default.
   */
  displayName?: string;
  /** One-line description shown by `skill_load` / UI. */
  description: string;
  /** Full skill body returned when `skill_load` fires for this skill. */
  body: string;
  /** Optional emoji shown beside the skill in UI surfaces. */
  emoji?: string;
  /** Optional assistant feature-flag key — when set and the flag is OFF, the skill is filtered out. */
  featureFlag?: string;
  /** Compact routing cues injected into `<available_skills>` to guide selection. */
  activationHints?: string[];
  /** Conditions under which this skill should NOT be loaded. */
  avoidWhen?: string[];
  /** IDs of child skills that this skill includes (metadata-only, not auto-activated). */
  includes?: string[];
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

/**
 * Map of lifecycle hooks contributed by a plugin. Keys match file
 * basenames under `<plugin>/hooks/` — the external loader populates one
 * entry per `hooks/<name>.{ts,js}` it finds. The runtime invokes
 * known keys (`init`, `shutdown`) at the matching lifecycle event;
 * unknown keys are forward-compat scaffolding.
 *
 * See `assistant/src/daemon/external-plugins-bootstrap.ts` for the
 * full lifecycle, and {@link PluginHookFn} for the per-entry signature.
 */
// The map stores hooks for arbitrary keys with arbitrary context shapes.
// `any` (rather than `unknown`) is required so concrete plugin signatures
// like `(ctx: PluginInitContext) => Promise<void>` and `() => Promise<void>`
// both assign in/out of slot entries under strict-function-types contravariance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginHooks = Record<string, PluginHookFn<any>>;

/**
 * A registered plugin. Every field besides `manifest` is optional — a plugin
 * may contribute any combination of lifecycle hooks and model-visible
 * capabilities. Lifecycle hooks live under `hooks`.
 */
export interface Plugin {
  /** Static manifest validated by the registry. */
  manifest: PluginManifest;
  /** Lifecycle hooks (init, shutdown). See {@link PluginHooks}. */
  hooks?: PluginHooks;
  /**
   * Tool registrations visible to the model. External plugin authors
   * declare the nameless `ToolDefinition` file shape (from
   * `@vellumai/plugin-api`); the loader derives `name` from the
   * `tools/<name>.ts` basename and runs the definition through
   * `finalizeTool` to fill omitted required fields, producing the
   * `Tool` values stored here. Category / ownership metadata is
   * stamped by `registerPluginTools` at registration time.
   */
  tools?: Tool[];
  /** HTTP route registrations served by the assistant. */
  routes?: PluginRouteRegistration[];
  /** Skill registrations loaded at startup. */
  skills?: PluginSkillRegistration[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by registry and bootstrap for plugin lifecycle errors — registration
 * validation failures, API-version mismatches, init throw-outs.
 */
export class PluginExecutionError extends AssistantError {
  constructor(
    message: string,
    public readonly pluginName: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, ErrorCode.INTERNAL_ERROR, options);
    this.name = "PluginExecutionError";
  }
}
