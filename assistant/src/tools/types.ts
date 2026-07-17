import { z } from "zod";

import type { InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";
import type { SecretPromptResult } from "../permissions/secret-prompt-types.js";
import type { ContentBlock } from "../providers/types.js";
import type { TrustClass } from "../runtime/trust-class.js";
import type { UsageAttributionSnapshot } from "../usage/attribution.js";
import type {
  DiffInfo,
  ProxyApprovalCallback,
  SensitiveOutputBinding,
} from "./tool-types.js";
import { RiskLevel } from "./tool-types.js";

export const DISK_PRESSURE_CLEANUP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "host_bash",
  "file_read",
  "file_list",
  "host_file_read",
  "skill_load",
  "background_tool_list",
  "background_tool_cancel",
]);

export function isDiskPressureCleanupToolName(name: string): boolean {
  return DISK_PRESSURE_CLEANUP_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Concrete overlays for types that live in ./tool-types.js.
//
// The canonical declarations live in the neutral leaf module `./tool-types.js`.
// The interfaces below (`Tool`, `ToolContext`, `ToolExecutionResult`,
// `ProxyToolResolver`) reference daemon-internal types (CES client, host-proxy
// classes, `ContentBlock`, `ApprovalRequired`, `TrustClass`, `InterfaceId`,
// `SecretPromptResult`, `UsageAttributionSnapshot`) that can't move into a
// neutral package. For those, the contracts version uses opaque placeholders
// (`unknown`, broadened `string`) and the assistant redeclares the interface
// here with the concrete types. The two sides are structurally independent —
// no inheritance, no intersection.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assistant-side concrete overlays
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  /** Textual result shown to the model in the tool-result block. Empty string is valid. */
  content: string;
  /** When true, the agent loop treats `content` as an error and may surface it / retry. */
  isError: boolean;
  /**
   * Stable, machine-readable classification for an error result (e.g.
   * `acp_claude_oauth_missing`). Threaded to the client on the `tool_result`
   * event so surfaces can render a structured affordance for a known failure
   * instead of re-parsing the human `content` string. Only meaningful when
   * `isError` is true.
   */
  errorCode?: string;
  /** Optional short status message for client display (e.g. `"truncated"`, `"timed out"`). */
  status?: string;
  /**
   * When true, the agent loop should yield control back to the user after
   * returning this result — tool results are pushed to history and the loop
   * breaks without another LLM call. Two callers set this: interactive
   * surfaces (tables with action buttons, file uploads) that force-stop the
   * loop so the LLM cannot bypass the "wait for user action" instruction,
   * and tools like `remember` that expose a `finish_turn` parameter letting
   * the LLM voluntarily end its turn.
   */
  yieldToUser?: boolean;
  diff?: DiffInfo;
  /** Optional rich content blocks (e.g. images) to include alongside text in the tool result. */
  contentBlocks?: ContentBlock[];
  /**
   * Runtime-internal sensitive output bindings (placeholder -> real value).
   * Populated by the executor when tool output contains
   * `<vellum-sensitive-output>` directives. The agent loop merges these
   * into a per-run substitution map for deterministic post-generation
   * replacement. MUST NOT be emitted in client-facing events or logs.
   */
  sensitiveBindings?: SensitiveOutputBinding[];
  /** Risk level from the classifier (populated during permission check). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** How the decision was reached: prompted, auto, blocked, or unknown (legacy). */
  approvalMode?: string;
  /** Why the decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at the time of execution. */
  riskThreshold?: string;
  /** Whether the daemon is running in a containerized (Docker) environment. */
  isContainerized?: boolean;
  /**
   * Display-only ladder of scope option labels for the rule editor
   * (narrowest to broadest). The `pattern` field here is a regex-style
   * descriptor used internally by the daemon and is NOT a valid trust
   * rule pattern. Use `riskAllowlistOptions` for the pattern that gets
   * saved as a trust rule.
   */
  riskScopeOptions?: Array<{ pattern: string; label: string }>;
  /**
   * Allowlist options for the rule editor save path (narrowest to
   * broadest). Each `pattern` is a Minimatch-glob compatible string
   * (e.g. raw command for exact match, `action:<program>` for command
   * wildcards) — what the gateway actually matches against. Mirrors
   * the `allowlistOptions` field on `ConfirmationRequest` SSE events.
   */
  riskAllowlistOptions?: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  /** Directory scope ladder for the rule editor (narrowest to broadest). */
  riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
  /** Structured activity metadata for client rendering (web search, web fetch, etc).
   *  Populated by daemon-internal tools; plugins must not set this. */
  activityMetadata?: ToolActivityMetadata;
}

export type ProxyToolResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

/**
 * Canonical serialization used for tool-input byte sizing. Shared by the
 * executor (raw pre-sanitization sizing) and the audit terminals (stored
 * `input` column + fallback sizing) so the two always measure the same
 * serialization.
 */
export function stringifyToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "[unserializable-input]";
  }
}

/**
 * Runtime context passed as the second argument to every tool's `execute`.
 *
 * The fields fall into two groups:
 *
 * - A small, stable core that we are comfortable exposing to any tool —
 *   including workspace- and plugin-authored tools via `@vellumai/plugin-api`:
 *   `conversationId`, `workingDir`, `requestId`, `signal`, `onOutput`,
 *   `assistantId`, `isInteractive`.
 * - Everything tagged `@legacy` below: host-internal routing, permission,
 *   trust, requester-identity, proxy, and telemetry metadata that historically
 *   accreted on this single context. These are NOT a surface we want third-party
 *   tools to depend on; we are triaging them post-launch with the goal of
 *   moving them off the public context (or removing them) over time. Grep for
 *   `@legacy` to enumerate the set. Do not add new fields here — extend the
 *   stable core only when a field is genuinely safe and stable to expose.
 *
 * The daemon constructs and passes the full object to every tool at runtime; a
 * tool that only reads the stable core is unaffected by the eventual cleanup.
 */
export interface ToolContext {
  /** Identifier of the conversation this tool invocation belongs to. */
  conversationId: string;
  /** Working directory the daemon was launched from. */
  workingDir: string;
  /** Per-turn request id for cross-component log correlation. */
  requestId?: string;
  /** Cooperative cancellation signal for long-running tools. Tools should check `signal.aborted` periodically (or forward `signal` to fetch / child-process options). */
  signal?: AbortSignal;
  /** Optional incremental-output callback for streaming tools. Streaming tools should fall back to returning the full result in `content` when this is absent. */
  onOutput?: (chunk: string) => void;
  /** Logical assistant scope for multi-assistant routing. */
  assistantId?: string;
  /** True when an interactive client is connected (not just a no-op callback). */
  isInteractive?: boolean;
  /**
   * When set, the tool execution is part of a task run. Used to retrieve ephemeral permission rules.
   * @legacy
   */
  taskRunId?: string;
  /**
   * Model attribution snapshot for the conversation at invocation time
   * (provider/model/profile that issued this tool call). Used by tool
   * telemetry; never sent to the tool itself.
   * @legacy
   */
  attribution?: UsageAttributionSnapshot | null;
  /**
   * Optional resolver for proxy tools - delegates execution to an external client.
   * @legacy
   */
  proxyToolResolver?: ProxyToolResolver;
  /**
   * When set, only tools in this set may execute. Tools outside the set are blocked with an error.
   * @legacy
   */
  allowedToolNames?: Set<string>;
  /**
   * When the conversation runs as a subagent, the parent-imposed tool
   * allowlist (see `SubagentRoleConfig.allowedTools`). Carried so
   * availability errors can name the allowlist as the gate instead of
   * suggesting a skill load that cannot widen it.
   */
  subagentAllowedTools?: ReadonlySet<string>;
  /**
   * True when this turn is restricted to storage cleanup-safe tools.
   * @legacy
   */
  diskPressureCleanupModeActive?: boolean;
  /**
   * Prompt the user for a secret value via native SecureField UI.
   * @legacy
   */
  requestSecret?: (params: {
    service: string;
    field: string;
    label: string;
    description?: string;
    placeholder?: string;
    purpose?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
  }) => Promise<SecretPromptResult>;
  /**
   * Optional callback to send a message to the connected client (e.g. open_url).
   * @legacy
   */
  sendToClient?: (msg: { type: string; [key: string]: unknown }) => void;
  /**
   * When true, tools with side effects should always prompt for confirmation.
   * @legacy
   */
  forcePromptSideEffects?: boolean;
  /**
   * When true, the tool requires a fresh interactive approval for every
   * invocation - no cached grants, temporary overrides, persistent
   * "Always Allow" rules, or non-interactive auto-approve shortcuts may
   * bypass the prompt. This flag is independently sufficient: it
   * promotes allow → prompt decisions on its own and suppresses
   * temporary override options in the prompt UI. Used by the `run_workflow`
   * launch path so a human consents to a run whose capability manifest grants
   * side-effecting tools.
   * @legacy
   */
  requireFreshApproval?: boolean;
  /**
   * Approval callback for proxy policy decisions that require user confirmation.
   * @legacy
   */
  proxyApprovalCallback?: ProxyApprovalCallback;
  /**
   * Optional principal identifier propagated to sub-tool confirmation flows.
   * @legacy
   */
  principal?: string;
  /**
   * Trust classification of the actor who initiated this tool invocation.
   * Determines permission level: guardians self-approve, trusted contacts
   * may escalate to guardian for approval, unknown actors are fail-closed.
   * See {@link TrustClass} in actor-trust-resolver.ts for value semantics.
   * @legacy
   */
  trustClass: TrustClass;
  /**
   * Channel through which the tool invocation originates (e.g. 'telegram', 'phone'). Used for scoped grant consumption.
   * @legacy
   */
  executionChannel?: string;
  /**
   * Origin tag of the turn driving this tool invocation (the conversation's
   * `TitleOrigin`, e.g. "memory_retrospective"). Set for background-job turns
   * that pass `requestOrigin` to `runBackgroundJob`, and for the
   * memory-retrospective wake (which pins it via {@link WakeToolContextPin}).
   * `buildPolicyContext` copies it onto the `PolicyContext` so the permission
   * checker can scope narrow non-interactive auto-grants (e.g. retrospective
   * skill authoring) to a specific internal origin. Unset for normal
   * interactive turns.
   */
  requestOrigin?: string;
  /**
   * Voice/call session ID, if the invocation originates from a call. Used for scoped grant consumption.
   * @legacy
   */
  callSessionId?: string;
  /**
   * True when the tool invocation was triggered by a user clicking a surface action button (not a regular message).
   * @legacy
   */
  triggeredBySurfaceAction?: boolean;
  /**
   * True when the user explicitly approved this tool invocation via the interactive permission prompt (not auto-approved by trust rules or temporary overrides).
   * @legacy
   */
  approvedViaPrompt?: boolean;
  /**
   * True when the invocation is inside a scheduled task run whose
   * `required_tools` array pre-authorized this tool at task-creation time.
   * Tools that normally require a surface-action click (e.g. bulk archive,
   * unsubscribe) may treat this as equivalent consent, since the user
   * already reviewed the tool list when the task was saved.
   * @legacy
   */
  batchAuthorizedByTask?: boolean;
  /**
   * External user ID of the requester (non-guardian actor). Used for scoped grant consumption.
   * @legacy
   */
  requesterExternalUserId?: string;
  /**
   * Chat ID of the requester (non-guardian actor). Used for tool grant request escalation notifications.
   * @legacy
   */
  requesterChatId?: string;
  /**
   * Human-readable identifier for the requester (e.g., @username).
   * @legacy
   */
  requesterIdentifier?: string;
  /**
   * Preferred display name for the requester.
   * @legacy
   */
  requesterDisplayName?: string;
  /**
   * Conversation type of the current channel chat on the permission-matrix
   * axis (dm | private | public). Feeds the channel-type tier of matrix cell
   * resolution; undefined when the chat type is unknown or ambiguous.
   * @legacy
   */
  channelConversationType?: "dm" | "private" | "public";
  /**
   * External channel/conversation ID of the current chat (the binding's
   * external chat id — Slack channel, Telegram chat, …). Keys the channel
   * tier of permission-matrix cell resolution for every channel adapter;
   * for Slack it also drives the legacy per-tool channel gate.
   * @legacy
   */
  channelPermissionChannelId?: string;
  /**
   * The tool_use block ID from the LLM response, used to correlate confirmation prompts with specific tool invocations.
   * @legacy
   */
  toolUseId?: string;
  /**
   * True when the assistant is running as a platform-managed remote instance. Used to auto-approve sandboxed bash tools.
   * @legacy
   */
  isPlatformHosted?: boolean;
  /**
   * The interface ID of the connected client driving the current turn (e.g.
   * "macos", "chrome-extension"). Browser backend policy uses this to decide
   * transport preference — for example, macOS-originated turns prefer the
   * user's real Chrome session via the paired extension before falling back
   * to cdp-inspect or local Playwright.
   * @legacy
   */
  transportInterface?: InterfaceId;
  /**
   * The per-turn inference-profile override the agent loop is currently
   * running under, propagated through tool context so subagent-spawn tools
   * can forward it when spawning nested subagents. Without this, sub-subagent
   * spawns silently lose inheritance because their own conversation row never
   * has `inferenceProfile` set — the override only flows through the
   * in-memory `SubagentConfig.overrideProfile` chain. See
   * `executeSubagentSpawn` in tools/subagent/spawn.ts.
   * @legacy
   */
  overrideProfile?: string;
  /**
   * The LLM call site of the turn currently executing this tool (`mainAgent`,
   * `heartbeatAgent`, scheduled work, etc.). `subagent_spawn` reads it to
   * default a spawned subagent's inference profile to the profile the invoking
   * turn resolved to, so subagents match whatever agent invoked them rather
   * than always falling back to the static `subagentSpawn` call-site default.
   * @legacy
   */
  invokingCallSite?: LLMCallSite;
  /**
   * Canonical principal ID of the actor on whose behalf this tool invocation
   * is running. Sourced from `conversation.trustContext.guardianPrincipalId`.
   * Used by host proxies to bind cross-client targeted execution to the same
   * authenticated user identity. May be undefined for legacy/internal flows
   * with no resolved actor identity.
   * @legacy
   */
  sourceActorPrincipalId?: string;
  /**
   * The conversation's effective per-chat plugin scope, as produced by
   * `getEffectiveEnabledPluginSet`: `null` means no per-chat restriction;
   * otherwise a Set of allowed plugin ids (the user's selection unioned with
   * the always-on first-party defaults). Skill-surface tools that resolve
   * skills by id outside the per-turn projection — `skill_load` (body load)
   * and `find_similar_skills` (discovery) — read this to drop skills owned by
   * plugins outside the conversation's scope. Populated per tool call from the
   * live conversation state.
   * @legacy
   */
  enabledPluginSet?: Set<string> | null;
}

/**
 * Schema describing the shape of a {@link ToolDefinition}. All fields are
 * optional — loaders fill documented defaults for omitted fields via
 * `finalizeTool` in `tool-defaults.ts`. The IPC layer parses incoming
 * skill tools against this same schema and re-finalizes them locally,
 * so author shape and wire shape are one schema.
 *
 * `input_schema` is `z.custom<object>(...)` rather than
 * `z.record(z.string(), z.unknown())` so that authors can assign a typed
 * JSON-schema literal (`{ type: "object", properties: { ... } }`)
 * without `as Record<...>` gymnastics. The custom check still rejects
 * `null`, primitives, and arrays at runtime.
 *
 * `execute` is `z.custom<(input, context) => Promise<ToolExecutionResult>>()`
 * for the same reason — the wire path drops closures (they can't cross
 * IPC) and `finalizeTool` synthesizes a no-op error closure on arrival.
 * The custom shape gives `ToolDefinition.execute` a fully-typed
 * signature via `z.infer` without an overlay type.
 *
 * Result: `ToolDefinition = z.infer<typeof ToolDefinitionSchema>` —
 * one declaration, both `input_schema` and `execute` typed correctly.
 */
export const ToolDefinitionSchema = z.object({
  /**
   * Name the model sees when calling this tool. Loaders default to the
   * source file basename (e.g. `tools/read.ts` → `read`) when omitted,
   * so the literal only needs to set this when overriding the
   * file-derived name.
   */
  name: z.string().min(1).optional(),
  /** Human-readable description shown to the model in the tool catalog. */
  description: z.string().optional(),
  /** JSON schema describing the tool's input arguments. */
  input_schema: z
    .custom<object>(
      (val) => val !== null && typeof val === "object" && !Array.isArray(val),
      { message: "input_schema must be a plain object" },
    )
    .optional(),
  /** Author-asserted risk band — low / medium / high. Drives default permission gating. */
  defaultRiskLevel: z.enum(RiskLevel).optional(),
  /** Tool category used for Slack channel `allowedToolCategories` enforcement. */
  category: z.string().min(1).optional(),
  /** Where the tool runs — sandbox (assistant container) or host (guardian device via proxy). Resolved by `resolveExecutionTarget` if omitted. */
  executionTarget: z.enum(["sandbox", "host"]).optional(),
  /**
   * Implementation invoked when the model calls the tool. Optional
   * because some `ToolDefinition` instances are schema-only (e.g.
   * {@link ../memory/graph/tools.graphRememberDefinition},
   * {@link ../messaging/style-analyzer.storeStyleAnalysisTool},
   * {@link ../memory/v2/sweep-job.SWEEP_TOOL}) — handed to providers as
   * a function-calling schema without ever being registered for
   * execution. Closures can't cross IPC, so the wire path drops this
   * and `finalizeTool` synthesizes a no-op error closure on arrival.
   * Tool sources use `satisfies ToolDefinition` (not `: ToolDefinition`)
   * so the inferred export type preserves `execute` as required at
   * call sites that statically import the literal.
   */
  execute: z
    .custom<
      (
        input: Record<string, unknown>,
        context: ToolContext,
      ) => Promise<ToolExecutionResult>
    >()
    .optional(),
  /**
   * When true, this tool runs alone in its turn. If the model emits it
   * alongside other tool calls, the agent loop executes only this one and
   * defers the siblings — returning them un-run with a benign notice — so the
   * model incorporates this tool's output before acting on anything else. The
   * `advisor` tool sets this so its guidance lands before the agent commits to
   * a path. Default false (the loop runs sibling calls concurrently as usual).
   */
  exclusive: z.boolean().optional(),
});

/**
 * Author-facing tool spec — re-exported from `@vellumai/plugin-api`.
 * Loaders fill documented defaults for omitted fields via `finalizeTool`
 * in `tool-defaults.ts`. The type is a direct `z.infer` of
 * {@link ToolDefinitionSchema} — both `input_schema` and `execute` are
 * typed correctly by the schema itself, no overlay needed.
 */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * Tool after the loader has derived its name and filled defaults. Every field
 * is required except `exclusive`, which stays optional — most tools never set
 * it, and the agent loop reads it as `?.exclusive === true`, so forcing every
 * hand-built `Tool` (MCP/meet/test fixtures) to carry it would be noise.
 */
export type Tool = Required<Omit<ToolDefinition, "exclusive">> &
  Pick<ToolDefinition, "exclusive">;

/**
 * The kind of entity that owns a tool. `"default"` is the built-in tool set
 * that ships with the assistant; the others are extension surfaces. Every
 * *registered* tool has an owner — {@link ../tools/registry.getToolOwner}
 * returns `undefined` only for a name that is not registered at all.
 */
export type OwnerKind = "default" | "skill" | "mcp" | "plugin" | "workspace";

/**
 * Identifies what owns a tool: the built-in default set, or a skill / plugin /
 * MCP server / workspace override. Tracked by the tool registry keyed by tool
 * name, not stored on the `Tool` object itself — query via
 * {@link ../tools/registry.getToolOwner}.
 */
export interface OwnerInfo {
  kind: OwnerKind;
  /** ID of the owner: skill id / plugin name / MCP server id / workspace path, or `"default"` for built-ins. */
  id: string;
}
