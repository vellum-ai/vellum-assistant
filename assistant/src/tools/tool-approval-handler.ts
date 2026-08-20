import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import {
  getGuardianRequestOrNull,
  updateGuardianRequest,
} from "../channels/gateway-guardian-requests.js";
import { isToolAllowedInChannel } from "../channels/permission-profiles.js";
import type { ChannelId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { isMemoryEnabled } from "../config/memory-v3-gate.js";
import type { AutoApproveThreshold } from "../permissions/approval-policy.js";
import {
  buildChannelPermissionCellQuery,
  effectiveChannelCellThreshold,
} from "../permissions/channel-permission-query.js";
import {
  isDynamicSkillLoadInvocation,
  isToolOwnerSkillBundled,
} from "../permissions/checker.js";
import {
  channelNoCellDefault,
  resolveChannelPermissionCell,
} from "../permissions/gateway-threshold-reader.js";
import {
  isControlPlaneWorkspaceWrite,
  isOutOfWorkspaceFileInvocation,
  isWorkspaceWriteTool,
} from "../permissions/workspace-policy.js";
import {
  isUnparseableToolArgs,
  unparseableToolArgsMessage,
} from "../providers/unparseable-tool-args.js";
import {
  resolveCapabilities,
  type SensitiveToolApproval,
} from "../runtime/capabilities.js";
import { createOrReuseToolGrantRequest } from "../runtime/tool-grant-request-helper.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { recordToolDenied, recordToolError } from "../telemetry/tool-audit.js";
import { getLogger } from "../util/logger.js";
import { resolveExecutionTarget } from "./execution-target.js";
import { safeTimeoutMs } from "./execution-timeout.js";
import { channelCoordinatesFromToolContext } from "./policy-context.js";
import { getAllTools, getTool, getToolOwner } from "./registry.js";
import { isSideEffectTool } from "./side-effects.js";
import { parseToolInput } from "./tool-input-schemas.js";
import { summarizeToolInput } from "./tool-input-summary.js";
import { suggestToolName } from "./tool-name-aliases.js";
import { recordToolCompletion } from "./tool-profiler.js";
import type { ExecutionTarget } from "./tool-types.js";
import {
  isDiskPressureCleanupToolName,
  type OwnerInfo,
  type Tool,
  type ToolContext,
  type ToolExecutionResult,
} from "./types.js";
import { enforceVerificationControlPlanePolicy } from "./verification-control-plane-policy.js";

const log = getLogger("tool-approval-handler");

/**
 * Compose the guardian-facing approval question. The question is about the
 * tool — phrased with the same `Approve tool:` pattern the
 * confirmation-request bridge uses — and the requester appears only as
 * parenthetical context, never as the subject of the decision.
 */
function buildToolGrantQuestionText(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): string {
  const requesterLabel =
    context.requesterDisplayName ||
    context.requesterIdentifier ||
    context.requesterExternalUserId;
  const requesterNote = requesterLabel
    ? ` (requested by ${requesterLabel})`
    : "";
  const inputSummary = redactSecrets(summarizeToolInput(toolName, input));
  const summaryPart = inputSummary ? ` — ${inputSummary}` : "";
  return `Approve tool: ${toolName}${summaryPart}${requesterNote}`;
}

/**
 * Compose the error message for a registered tool that is not part of the
 * current turn's active tool set, naming the gate that actually excluded it.
 * Ordered most-specific first:
 *
 * 1. Subagent allowlist — loading a skill cannot widen a subagent's
 *    allowlist, so this outranks the skill hint.
 * 2. Skill-owned tool whose skill is not loaded — the one case where
 *    "load the skill" is the correct instruction.
 * 3. Plugin-owned tool filtered by plugin enablement.
 * 4. `remember` while memory is disabled.
 * 5. Context gating (no connected client, channel capabilities, …) — no
 *    load hint; list the active tools so the model can re-plan with what
 *    actually exists this turn.
 */
export function buildInactiveToolMessage(args: {
  name: string;
  owner: OwnerInfo | undefined;
  subagentAllowedTools: ReadonlySet<string> | undefined;
  memoryEnabled: boolean;
  activeToolNames: ReadonlySet<string>;
}): string {
  const { name, owner, subagentAllowedTools, memoryEnabled, activeToolNames } =
    args;
  if (subagentAllowedTools && !subagentAllowedTools.has(name)) {
    const allowed = [...subagentAllowedTools].sort().join(", ");
    return `Tool "${name}" is not available to this subagent. This subagent may only use: ${allowed}.`;
  }
  if (owner?.kind === "skill") {
    return `Tool "${name}" is not currently active. Load the "${owner.id}" skill that provides this tool first.`;
  }
  if (owner?.kind === "plugin") {
    return `Tool "${name}" belongs to the "${owner.id}" plugin, which is not enabled for this conversation.`;
  }
  if (name === "remember" && !memoryEnabled) {
    return `Tool "remember" is unavailable because memory is disabled for this assistant.`;
  }
  if (activeToolNames.size === 0) {
    return `Tool "${name}" is not available in this context. No tools are active this turn.`;
  }
  const available = [...activeToolNames].sort().join(", ");
  return `Tool "${name}" is not available in this context. Available tools: ${available}`;
}

/** Default polling interval for inline grant wait (ms). */
const TC_GRANT_WAIT_INTERVAL_MS = 500;
/**
 * Fallback maximum wait for the inline grant wait (ms), used only when the
 * deployed config cannot be read. The governing budget is
 * `timeouts.permissionTimeoutSec` (see {@link resolveInlineGrantWaitMs}).
 */
export const TC_GRANT_WAIT_MAX_MS = 60_000;

/**
 * Resolve how long one approval decision stays open, in milliseconds.
 *
 * Every actor deciding a gated tool call is making the same decision as a
 * local user answering a permission prompt, so every path spends the same
 * budget: `timeouts.permissionTimeoutSec` (read by `permissions/prompter.ts`).
 * If anything, an off-channel path needs the larger share of it: the
 * prompter's user already has the prompt on screen, while a guardian is
 * notified out-of-band and has to context-switch before deciding.
 *
 * Falls back to {@link TC_GRANT_WAIT_MAX_MS} rather than the tool-execution
 * default on a non-positive value, so a bad config can never collapse the
 * window to zero and auto-deny every escalation.
 *
 * This is the one owner of that budget, and every clock measuring the same
 * window reads it here rather than restating the number:
 *
 * - the inline grant wait, which spends it directly;
 * - the grant resolver's `inline_wait_active` staleness threshold, because if
 *   the two drift, an approval arriving while a waiter is still live gets
 *   misread as a dead waiter and the requester is told to retry a call that is
 *   about to resume on its own;
 * - the `tool_approval` row deadline, so the card stops offering a decision at
 *   the same moment the prompt stops waiting for one.
 */
export function resolveInlineGrantWaitMs(): number {
  return safeTimeoutMs(
    getConfig().timeouts.permissionTimeoutSec,
    TC_GRANT_WAIT_MAX_MS,
  );
}

/**
 * Inline wait result for trusted-contact grant polling.
 * - `granted`: a grant was minted and consumed within the wait window.
 * - `denied`: the guardian explicitly rejected the request.
 * - `timeout`: the wait budget expired without a decision.
 * - `aborted`: the session was cancelled during the wait.
 * - `escalation_failed`: the grant request could not be created.
 */
export type InlineGrantWaitOutcome =
  | { outcome: "granted"; grant: { id: string } }
  | { outcome: "denied"; requestId: string }
  | { outcome: "timeout"; requestId: string }
  | { outcome: "aborted" }
  | { outcome: "escalation_failed"; reason: string };

/**
 * Wait bounded for a guardian to approve a tool grant request and for the
 * resulting grant to become consumable. Polls both the gateway request
 * status (to detect early rejection) and the grant store (to detect approval
 * and atomically consume the grant).
 *
 * Only called for trusted_contact actors with valid guardian bindings.
 *
 * `options.maxWaitMs` overrides the wait budget; omitting it spends the
 * configured one from {@link resolveInlineGrantWaitMs}.
 */
export async function waitForInlineGrant(
  escalationRequestId: string,
  consumeParams: Parameters<typeof consumeGrantForInvocation>[0],
  options?: { maxWaitMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<InlineGrantWaitOutcome> {
  const maxWait = options?.maxWaitMs ?? resolveInlineGrantWaitMs();
  const interval = options?.intervalMs ?? TC_GRANT_WAIT_INTERVAL_MS;
  const signal = options?.signal;
  const deadline = Date.now() + maxWait;

  log.info(
    {
      event: "tc_inline_grant_wait_start",
      escalationRequestId,
      toolName: consumeParams.toolName,
      maxWaitMs: maxWait,
      intervalMs: interval,
    },
    "Starting inline wait for guardian grant decision",
  );

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { outcome: "aborted" };
    }

    await new Promise((resolve) => setTimeout(resolve, interval));

    if (signal?.aborted) {
      return { outcome: "aborted" };
    }

    // Check if the guardian request was rejected - exit early without
    // waiting for the full timeout. Degrades to null on gateway failure so
    // one bad read never aborts the wait; grant consumption stays the
    // authoritative approval signal.
    const request = await getGuardianRequestOrNull(escalationRequestId);
    if (request && request.status === "denied") {
      log.info(
        {
          event: "tc_inline_grant_wait_denied",
          escalationRequestId,
          toolName: consumeParams.toolName,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Guardian denied tool grant request during inline wait",
      );
      return { outcome: "denied", requestId: escalationRequestId };
    }

    // Try to consume the grant - if the guardian approved, the guardian
    // decision primitive will have minted a scoped grant by now.
    const grantResult = await consumeGrantForInvocation(consumeParams, {
      maxWaitMs: 0,
    });
    if (grantResult.ok) {
      log.info(
        {
          event: "tc_inline_grant_wait_granted",
          escalationRequestId,
          toolName: consumeParams.toolName,
          grantId: grantResult.grant.id,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Grant found during inline wait - tool execution proceeding",
      );
      return { outcome: "granted", grant: { id: grantResult.grant.id } };
    }
  }

  log.info(
    {
      event: "tc_inline_grant_wait_timeout",
      escalationRequestId,
      toolName: consumeParams.toolName,
      maxWaitMs: maxWait,
    },
    "Inline grant wait timed out - no guardian decision within budget",
  );
  return { outcome: "timeout", requestId: escalationRequestId };
}

/**
 * Stamp `followupState` on the escalation's gateway row. Best-effort: the
 * stamp only steers the resolver's retry notification, never the decision,
 * so a failed write logs and the invocation proceeds.
 */
async function stampFollowupState(
  requestId: string,
  followupState: string | null,
): Promise<void> {
  try {
    await updateGuardianRequest(requestId, { followupState });
  } catch (err) {
    log.warn(
      { err, requestId, followupState },
      "Failed to stamp inline-wait followup state on guardian request",
    );
  }
}

const UI_SURFACE_TOOLS = new Set(["ui_show", "ui_update", "ui_dismiss"]);

/**
 * How far a sensitive invocation reaches — the axis that decides whether a
 * channel's approval cell may lift its floor. See {@link sensitiveToolReach}.
 */
export type SensitiveToolReach = "none" | "sandbox" | "host";

/**
 * Classify how far a sensitive invocation reaches. This is about the tool,
 * where it executes, and — for `skill_load` — whether the invocation will
 * execute embedded shell at load time (inline command expansions run outside
 * the tool pipeline, so they must be gated like other code execution). Actor
 * identity never feeds in here; it enters the decision only through the
 * `CapabilitySet` floor, see {@link resolveSensitiveToolDecision}.
 *
 * - `"none"`: not sensitive.
 * - `"sandbox"`: side effects confined to the assistant's own workspace. An
 *   owner can delegate these per room, so a cell may lift the floor.
 * - `"host"`: reaches the guardian's own machine and accounts — host
 *   execution, and sandbox file tools escaping the workspace, which the
 *   host-fallback path policy turns into real host access. No cell lifts
 *   this: a room-level posture is about what the assistant may do in that
 *   room, never a grant of the owner's own machine.
 */
export function sensitiveToolReach(
  toolName: string,
  executionTarget: ExecutionTarget,
  input?: Record<string, unknown>,
  workingDir?: string,
): SensitiveToolReach {
  // UI surface tools are passive, user-visible operations (cards, forms,
  // tables). User input is voluntary and user-controlled — they are not
  // sensitive, so they work during fresh onboarding before trust is
  // established.
  if (UI_SURFACE_TOOLS.has(toolName)) {
    return "none";
  }

  // An inline-command ("dynamic") skill_load executes embedded shell at load
  // time. skill_load is not a side-effect tool, so without this it would skip
  // the capability floor entirely. Routing it through the gate makes a
  // non-guardian's dynamic load escalate to the guardian like any other code
  // execution — the floor is deterministic, so neither Full access nor a
  // covering trust rule lifts it. (The guardian self-approves; the trust-rule
  // escape hatch still applies to the guardian's own load in the risk lane.)
  if (
    toolName === "skill_load" &&
    input &&
    isDynamicSkillLoadInvocation(toolName, input)
  ) {
    return "host";
  }

  // A sandbox file tool targeting a path outside the workspace reaches the
  // host filesystem on non-containerized installs (the host-fallback path
  // policy executes the escape once the permission lane approves). That is
  // host-equivalent access — a read-only escape can leak local secrets — so
  // it carries the same capability floor as executionTarget === "host":
  // non-guardian actors escalate to the guardian, and no risk threshold or
  // trust rule lifts it.
  if (
    input &&
    workingDir &&
    isOutOfWorkspaceFileInvocation(toolName, input, workingDir)
  ) {
    return "host";
  }

  // Read-only host execution is sensitive too, because it can leak sensitive
  // local information (e.g. shell/file reads).
  if (executionTarget === "host") {
    return "host";
  }

  // Extension-owned code that is not first-party bundled is unvetted: its
  // manifest declares its own risk, and nothing reviewed it. It is sensitive
  // whatever it is named — a novel name is in no side-effect list, so without
  // this it would not be gated at all, and the risk its own manifest claims
  // would be the only thing standing between it and an auto-approval.
  if (isUnvettedExtensionTool(toolName)) {
    return "sandbox";
  }

  // Side-effect tools are sensitive, and what is left here acts only on the
  // assistant's own workspace.
  return isSideEffectTool(toolName) ? "sandbox" : "none";
}

/**
 * Whether a tool comes from code nobody in-repo reviewed. Vetted is an
 * allowlist — the built-in default set and first-party bundled skills —
 * and every other owner is unvetted: third-party and workspace skills,
 * plugins, workspace tools (arbitrary on-disk code imported into the
 * daemon), MCP servers, and owner kinds that do not exist yet. An
 * allowlist fails closed when the owner vocabulary grows, the same reason
 * the read-only subagent gate (`conversation-tool-setup.ts`) allowlists
 * names and verifies `ownerKind === "default"` rather than naming the
 * kinds it distrusts.
 *
 * An absent owner record is the built-in registration path, so it reads
 * as `default`; a tool that is not registered at all cannot execute.
 */
function isUnvettedExtensionTool(toolName: string): boolean {
  const kind = getToolOwner(toolName)?.kind;
  if (kind === undefined || kind === "default") {
    return false;
  }
  if (kind === "skill") {
    return !isToolOwnerSkillBundled(getTool(toolName));
  }
  return true;
}

/**
 * Threshold for the approval cell governing an invocation — the matrix axis
 * of the sensitive-tool composition. Shares the auto-approve threshold
 * vocabulary defined in `permissions/approval-policy.ts`.
 */
export type ApprovalCellThreshold = AutoApproveThreshold;

/**
 * Outcome of the sensitive-tool composition:
 * - `proceed`: no scoped grant needed (tool not sensitive, or the actor's
 *   capability set self-approves; lane-B risk/threshold policy in
 *   `permissions/approval-policy.ts` still applies downstream).
 * - `escalate-and-wait`: a scoped grant is required; on a grant miss,
 *   escalate to the guardian and wait inline.
 * - `deny`: a scoped grant is required; on a grant miss, fail closed.
 */
export type SensitiveToolDecision = "proceed" | "escalate-and-wait" | "deny";

/**
 * Single composition point for the sensitive-tool approval decision:
 * `CapabilitySet` floor × the actor's approval-matrix cell.
 *
 * The floor is the starting point — a sensitive invocation by a non-guardian
 * needs a scoped grant. The cell is what can lift it: an owner who has given
 * this contact type a non-`none` level in this room has said the assistant
 * may act there without minting a per-call grant.
 *
 * Three things no cell lifts:
 * - `host` reach. A room-level posture says what the assistant may do in that
 *   room; it is never a grant of the owner's own machine or accounts, so host
 *   execution and workspace escapes stay floored at every level.
 * - `deny` — an actor with no established identity has no cell to stand on.
 * - A `none` cell authorizes nothing, so the floor stands unchanged.
 *
 * Lifting is not approval. It decides only that a scoped grant is not the
 * mechanism; the risk/threshold policy in `permissions/approval-policy.ts`
 * then applies that same cell against the fully-classified risk. Whatever the
 * cell does not cover still reaches the guardian — a lane-B `"prompt"` is
 * promoted to a guardian-bound `tool_approval` request
 * (`permissions/confirmation-guardian-request.ts`), the same principal the
 * escalation path would have asked.
 */
export function resolveSensitiveToolDecision(input: {
  /** How far the invocation reaches; see {@link sensitiveToolReach}. */
  reach: SensitiveToolReach;
  /**
   * Threshold of the approval-matrix cell governing this invocation.
   * `undefined` when no cell covers it — including when the cell could not be
   * read, since an unreadable cell must never lift the floor.
   */
  cellThreshold: ApprovalCellThreshold | undefined;
  sensitiveToolApproval: SensitiveToolApproval;
}): SensitiveToolDecision {
  if (input.reach === "none" || input.sensitiveToolApproval === "self") {
    return "proceed";
  }
  if (input.sensitiveToolApproval === "deny" || input.reach === "host") {
    return input.sensitiveToolApproval;
  }
  if (input.cellThreshold === undefined || input.cellThreshold === "none") {
    return input.sensitiveToolApproval;
  }
  return "proceed";
}

/**
 * Sandbox tools that execute code. Running code in the workspace is how you
 * write everything else in it — including the directories
 * {@link isControlPlaneWorkspaceWrite} covers — so a cell that lifted one of
 * these would lift those by the back door.
 *
 * `skill_execute` is deliberately absent rather than overlooked: it is
 * dispatch indirection, and `conversation-tool-setup` resolves it to its inner
 * tool name before the gate runs, so the gate already classifies the tool the
 * skill actually calls rather than the wrapper.
 */
const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/**
 * Whether an invocation reaches the private network — localhost, which is the
 * daemon's own HTTP surface, the gateway, and whatever else listens on the
 * guardian's machine. Keyed on the input rather than the tool, because the
 * same tool is delegable against a public URL.
 */
function reachesPrivateNetwork(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  return toolName === "web_fetch" && input.allow_private_network === true;
}

/**
 * Whether a channel's approval cell may lift the floor for this invocation.
 *
 * The cell delegates ordinary work in the assistant's own workspace. Three
 * sandbox side effects are not ordinary, because each is a way back out of
 * the sandbox — and excluding only some of them would be a false safeguard,
 * since any one reaches the others:
 *
 * - `bash` runs code. A room that can run code in the workspace can write
 *   anything into it, including the executable directories below, so lifting
 *   bash would lift those by the back door.
 * - Control-plane workspace writes ({@link isControlPlaneWorkspaceWrite}) —
 *   the directories the daemon imports and executes, and the prompt surfaces
 *   it reads as its own instructions. Approving the write approves the later
 *   execution.
 * - Unvetted extension-owned tools ({@link isUnvettedExtensionTool}). Nothing
 *   reviewed them, so the risk their own manifest claims must not be what
 *   decides whether a room may run them unattended.
 * - `web_fetch` with `allow_private_network`. The private network is the
 *   guardian's own machine — the daemon's HTTP surface, the gateway, whatever
 *   else is listening on it. Fetching a public URL is delegable; reaching
 *   localhost is the machine floor by another door.
 *
 * Each stays on the capability floor, so a channel actor escalates to the
 * guardian for them at every level. None of this touches the guardian's own
 * lane — it decides what a *cell* may delegate, not how risk is classified.
 */
function isChannelLiftable(
  reach: SensitiveToolReach,
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string | undefined,
): boolean {
  if (reach !== "sandbox") {
    return false;
  }
  if (CODE_EXECUTION_TOOLS.has(toolName)) {
    return false;
  }
  // A write is liftable only when its target can be resolved and resolves
  // outside the control plane. With no workingDir there is no way to see
  // where the write lands, so the check fails closed rather than being
  // skipped.
  if (
    isWorkspaceWriteTool(toolName) &&
    (!workingDir || isControlPlaneWorkspaceWrite(toolName, input, workingDir))
  ) {
    return false;
  }
  if (isUnvettedExtensionTool(toolName)) {
    return false;
  }
  if (reachesPrivateNetwork(toolName, input)) {
    return false;
  }
  return true;
}

/**
 * Threshold of the approval-matrix cell governing this invocation, read only
 * when it can change the outcome: a channel-liftable invocation whose actor
 * sits on the escalate floor. Guardians, non-sensitive tools, host reach,
 * everything {@link isChannelLiftable} excludes, and identity-less actors
 * return early, so the gateway lookup never lands on the paths where it could
 * only add latency — grant consumption for an already-approved call, and voice
 * abort handling.
 *
 * The permission checker reads this same cell later in the turn, within the
 * reader's cache window, so the lift costs at most one lookup per turn.
 *
 * Returns `undefined` when the turn has no channel coordinates or a lookup
 * fails — nothing lifts the floor then. A successful walk that finds no cell
 * resolves the room's default — the owner's global setting collapsed to the
 * channel's two levels — so an unconfigured room behaves exactly as the
 * picker's "· default" marker and the legend present it
 * ({@link effectiveChannelCellThreshold}).
 */
async function resolveApprovalCellThreshold(
  reach: SensitiveToolReach,
  toolName: string,
  input: Record<string, unknown>,
  sensitiveToolApproval: SensitiveToolApproval,
  context: ToolContext,
): Promise<ApprovalCellThreshold | undefined> {
  if (
    sensitiveToolApproval !== "escalate-and-wait" ||
    !isChannelLiftable(reach, toolName, input, context.workingDir)
  ) {
    return undefined;
  }
  const query = buildChannelPermissionCellQuery(
    channelCoordinatesFromToolContext(context),
  );
  if (!query) {
    return undefined;
  }
  const cell = await resolveChannelPermissionCell(query);
  return effectiveChannelCellThreshold(
    cell,
    query.contactType,
    await channelNoCellDefault(cell, query.contactType),
  );
}

/**
 * Denial copy is about the tool (an action requiring guardian approval),
 * never about who the requester is.
 */
function sensitiveToolDeniedMessage(
  decision: SensitiveToolDecision,
  toolName: string,
): string {
  if (decision === "deny") {
    return `Permission denied for "${toolName}": this action requires guardian approval from a verified channel identity.`;
  }
  return `Permission denied for "${toolName}": this action requires guardian approval before it can run.`;
}

export type PreExecutionGateResult =
  | {
      allowed: true;
      tool: Tool;
      grantConsumed?: boolean;
      /**
       * Input parsed against the tool's registered schema in
       * `TOOL_INPUT_SCHEMAS` (with `.catch()` recoveries applied). Set only
       * for built-in tools with a registered schema; the executor substitutes
       * it for the raw input so validation and execution see the same value.
       */
      parsedInput?: Record<string, unknown>;
    }
  | { allowed: false; result: ToolExecutionResult };

/**
 * Overrides for the inline grant wait behavior. Production leaves this empty
 * so the wait spends the configured budget; tests inject short waits to keep
 * escalation cases fast.
 */
export interface InlineGrantWaitConfig {
  /**
   * Maximum time to wait for guardian approval (ms). Defaults to the budget
   * from {@link resolveInlineGrantWaitMs}.
   */
  maxWaitMs?: number;
  /** Polling interval during the wait (ms). Defaults to TC_GRANT_WAIT_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Handles pre-execution approval gates: abort checks, guardian policy,
 * allowed-tool-set gating, and task-run preflight checks.
 * These run before the interactive permission prompt flow.
 */
export class ToolApprovalHandler {
  private inlineGrantWaitConfig: InlineGrantWaitConfig;

  constructor(config?: { inlineGrantWait?: InlineGrantWaitConfig }) {
    this.inlineGrantWaitConfig = config?.inlineGrantWait ?? {};
  }

  /**
   * Evaluate all pre-execution approval gates for a tool invocation.
   * Returns the resolved Tool if all gates pass, or an early-return
   * ToolExecutionResult if any gate blocks execution.
   */
  /**
   * Audit a gate that failed the invocation with an error (never executed).
   * All pre-execution gate errors are anticipated control flow (abort, unknown
   * tool, disk pressure, unparseable args), so they audit as expected failures.
   */
  private auditGateError(
    context: ToolContext,
    name: string,
    input: Record<string, unknown>,
    riskLevel: string,
    startTime: number,
    errorMessage: string,
  ): void {
    const durationMs = Date.now() - startTime;
    recordToolError({
      conversationId: context.conversationId,
      requestId: context.requestId,
      toolName: name,
      input,
      errorMessage,
      isExpected: true,
      riskLevel,
      durationMs,
      attribution: context.attribution ?? null,
    });
    recordToolCompletion(context.conversationId, name, durationMs, true);
  }

  /** Audit a gate that blocked the invocation (deterministic, no user prompt). */
  private auditGateDenied(
    context: ToolContext,
    name: string,
    input: Record<string, unknown>,
    riskLevel: string,
    startTime: number,
    reason: string,
  ): void {
    recordToolDenied({
      conversationId: context.conversationId,
      toolName: name,
      input,
      reason,
      riskLevel,
      durationMs: Date.now() - startTime,
      wasPrompted: false,
    });
  }

  async checkPreExecutionGates(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext,
    riskLevel: string,
    startTime: number,
  ): Promise<PreExecutionGateResult> {
    // Bail out immediately if the session was aborted before this tool started.
    if (context.signal?.aborted) {
      this.auditGateError(
        context,
        name,
        input,
        riskLevel,
        startTime,
        "Cancelled",
      );
      return {
        allowed: false,
        result: { content: "Cancelled", isError: true },
      };
    }

    // Reject tool calls whose arguments failed JSON parsing in the provider
    // layer (wrapped under the `_raw` marker). Executing with the marker
    // object would feed garbage input to the tool — and worse, a tool that
    // tolerates missing fields can "succeed" (e.g. ui_show creating a
    // typeless surface), so the model never learns its arguments were
    // mangled. Fail loudly instead so the model retries.
    if (isUnparseableToolArgs(input)) {
      const msg = unparseableToolArgsMessage(name, input._raw);
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Reject tool invocations targeting guardian control-plane endpoints from non-guardian actors.
    const guardianCheck = enforceVerificationControlPlanePolicy(
      name,
      input,
      context.trustClass,
    );
    if (guardianCheck.denied) {
      log.warn(
        {
          toolName: name,
          conversationId: context.conversationId,
          trustClass: context.trustClass,
          reason: "guardian_only_policy",
        },
        "Guardian-only policy blocked tool invocation",
      );
      this.auditGateDenied(
        context,
        name,
        input,
        riskLevel,
        startTime,
        guardianCheck.reason!,
      );
      return {
        allowed: false,
        result: { content: guardianCheck.reason!, isError: true },
      };
    }

    // Resolve the tool once, up front. Its manifest execution target
    // (sandbox/host) gates the sensitive-tool check below; its absence is the
    // "unknown tool" gate further down. Looking it up here also means the
    // sandbox/host routing reflects the tool actually registered under this
    // name at execution time.
    const tool = getTool(name);
    const executionTarget = resolveExecutionTarget(tool ?? { name });

    // Determine whether this invocation requires a scoped grant. Capture
    // the consume params now but defer the actual atomic consumption until
    // after all downstream policy gates (allowedToolNames, task-run
    // preflight, tool registry) pass. This prevents wasting a one-time-use
    // grant when a subsequent gate rejects the invocation.
    let needsGrantConsumption = false;
    let deferredConsumeParams:
      | Parameters<typeof consumeGrantForInvocation>[0]
      | null = null;

    const reach = sensitiveToolReach(
      name,
      executionTarget,
      input,
      context.workingDir,
    );
    const { sensitiveToolApproval } = resolveCapabilities(context.trustClass);
    const sensitiveDecision = resolveSensitiveToolDecision({
      reach,
      cellThreshold: await resolveApprovalCellThreshold(
        reach,
        name,
        input,
        sensitiveToolApproval,
        context,
      ),
      sensitiveToolApproval,
    });

    if (sensitiveDecision !== "proceed") {
      const inputDigest = computeToolApprovalDigest(name, input);
      needsGrantConsumption = true;
      deferredConsumeParams = {
        requestId: context.requestId,
        toolName: name,
        inputDigest,
        consumingRequestId:
          context.requestId ??
          `preexec-${context.conversationId}-${Date.now()}`,
        executionChannel: context.executionChannel,
        conversationId: context.conversationId,
        callSessionId: context.callSessionId,
        requesterExternalUserId: context.requesterExternalUserId,
      };
    }

    if (
      context.diskPressureCleanupModeActive === true &&
      !isDiskPressureCleanupToolName(name)
    ) {
      const msg = `Tool "${name}" is not available during disk pressure cleanup mode.`;
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Reject a name no tool provides before the allowedToolNames gate, so it
    // surfaces as "Unknown tool" (with the real list) instead of the
    // misleading "load the skill" hint. (`tool` was resolved up front.)
    if (!tool) {
      const allowedToolNames = context.allowedToolNames;
      // List every registered tool. Tools that need an external resolver
      // (computer-use, ui-surface, etc.) now return a structured error
      // from their `execute()` when no resolver is connected, rather than
      // being filtered out here — listing them surfaces a clearer path
      // than hiding their names entirely.
      const availableNames = getAllTools()
        .map((t) => t.name)
        .filter((n) => !allowedToolNames || allowedToolNames.has(n))
        .sort();
      const suggestion = suggestToolName(name, availableNames);
      const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
      const msg = `Unknown tool: ${name}.${didYouMean} Available tools: ${availableNames.join(", ")}`;
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Gate tools not active for the current turn
    if (context.allowedToolNames && !context.allowedToolNames.has(name)) {
      let memoryEnabled = true;
      try {
        memoryEnabled = isMemoryEnabled(getConfig());
      } catch {
        // Config unavailable — leave the memory hint out rather than guess.
      }
      const msg = buildInactiveToolMessage({
        name,
        owner: getToolOwner(name),
        subagentAllowedTools: context.subagentAllowedTools,
        memoryEnabled,
        activeToolNames: context.allowedToolNames,
      });
      this.auditGateError(context, name, input, riskLevel, startTime, msg);
      return { allowed: false, result: { content: msg, isError: true } };
    }

    // Enforce channel-scoped permission profiles (deterministic gate).
    // When the session originates from a Slack channel with a configured
    // permission profile, blocked tools and category restrictions are
    // enforced here rather than relying on model compliance with hints.
    if (
      context.executionChannel === "slack" &&
      context.channelPermissionChannelId
    ) {
      if (
        !isToolAllowedInChannel(
          context.channelPermissionChannelId,
          name,
          tool.category,
        )
      ) {
        const msg = `Tool "${name}" is not allowed in this channel per channel permission policy.`;
        log.warn(
          {
            toolName: name,
            channelId: context.channelPermissionChannelId,
            category: tool.category,
            conversationId: context.conversationId,
            reason: "channel_permission_policy",
          },
          "Channel permission policy blocked tool invocation",
        );
        this.auditGateDenied(context, name, input, riskLevel, startTime, msg);
        return { allowed: false, result: { content: msg, isError: true } };
      }
    }

    // All deterministic policy gates passed. Parse model-generated input for
    // built-in tools with a registered schema BEFORE the grant consumption
    // and guardian escalation below: a malformed invocation can never
    // execute, so failing it here means it cannot burn a one-time grant or
    // interrupt the guardian with an approval card (and up to a 60s inline
    // wait) for a call validation would reject anyway. Extension-owned and
    // workspace-override tools own their input contracts and are skipped.
    let parsedInput: Record<string, unknown> | undefined;
    if (getToolOwner(name)?.kind === "default") {
      const parsed = parseToolInput(name, input);
      if (!parsed.ok) {
        this.auditGateError(
          context,
          name,
          input,
          riskLevel,
          startTime,
          parsed.message,
        );
        return {
          allowed: false,
          result: { content: parsed.message, isError: true },
        };
      }
      parsedInput = parsed.data;
    }

    // Now consume the scoped grant if one is required. Deferring consumption
    // to this point ensures a prior gate rejection (allowedToolNames, input
    // validation, registry lookup) does not waste the one-time-use grant.
    //
    // Retry polling is scoped to the voice channel where a race condition
    // exists between fire-and-forget turn execution and LLM fallback grant
    // minting (2-5s). Non-voice channels get an instant sync lookup so
    // normal denials are not delayed.
    if (needsGrantConsumption && deferredConsumeParams) {
      const isVoice = context.executionChannel === "phone";
      const grantResult = await consumeGrantForInvocation(
        deferredConsumeParams,
        isVoice ? { signal: context.signal } : { maxWaitMs: 0 },
      );

      if (grantResult.ok) {
        log.info(
          {
            toolName: name,
            conversationId: context.conversationId,
            trustClass: context.trustClass,
            executionTarget,
            grantId: grantResult.grant.id,
          },
          "Scoped grant consumed - allowing untrusted actor tool invocation",
        );

        return { allowed: true, tool, grantConsumed: true, parsedInput };
      }

      // Treat abort as a cancellation - not a grant denial. This matches
      // the abort check at the top of checkPreExecutionGates so the caller
      // sees a consistent "Cancelled" result instead of a spurious
      // guardian_approval_required denial during voice barge-in.
      if (grantResult.reason === "aborted") {
        this.auditGateError(
          context,
          name,
          input,
          riskLevel,
          startTime,
          "Cancelled",
        );
        return {
          allowed: false,
          result: { content: "Cancelled", isError: true },
        };
      }

      // No matching grant or race condition - deny or wait inline.
      //
      // For non-guardian actors with established identity (trusted_contact
      // or unverified_contact) and sufficient context, escalate to the
      // guardian by creating a tool_grant_request guardian request. Then wait
      // bounded for the grant to become available - this lets the tool call
      // succeed inline after guardian approval without the requester having
      // to retry manually.
      //
      // Actors with no identity (unknown) remain fail-closed with no
      // escalation or wait.
      if (
        sensitiveDecision === "escalate-and-wait" &&
        context.assistantId &&
        context.executionChannel &&
        context.requesterExternalUserId
      ) {
        const inputDigest =
          deferredConsumeParams?.inputDigest ??
          computeToolApprovalDigest(name, input);
        const escalation = await createOrReuseToolGrantRequest({
          assistantId: context.assistantId,
          sourceChannel: context.executionChannel as ChannelId,
          conversationId: context.conversationId,
          requesterExternalUserId: context.requesterExternalUserId,
          requesterChatId: context.requesterChatId,
          sourceMessageId: context.sourceMessageId,
          sourceThreadId: context.sourceThreadId,
          toolName: name,
          inputDigest,
          questionText: buildToolGrantQuestionText(name, input, context),
          requesterIdentifier:
            context.requesterDisplayName || context.requesterIdentifier,
        });

        // Only wait inline if the escalation succeeded (created or deduped).
        // If escalation failed (no binding, missing identity), fall through
        // to the generic denial path.
        if ("created" in escalation || "deduped" in escalation) {
          // Stamp the guardian request so the approval resolver knows an
          // inline consumer is waiting. Without this, the resolver would
          // send a stale "please retry" notification even though the
          // original invocation is about to resume inline.
          await stampFollowupState(
            escalation.requestId,
            "inline_wait_active:" + Date.now(),
          );

          const waitResult = await waitForInlineGrant(
            escalation.requestId,
            deferredConsumeParams!,
            {
              maxWaitMs: this.inlineGrantWaitConfig.maxWaitMs,
              intervalMs: this.inlineGrantWaitConfig.intervalMs,
              signal: context.signal,
            },
          );

          if (waitResult.outcome === "granted") {
            // Clear the inline-wait stamp now that the grant has been consumed.
            await stampFollowupState(escalation.requestId, null);
            log.info(
              {
                toolName: name,
                conversationId: context.conversationId,
                trustClass: context.trustClass,
                executionTarget,
                grantId: waitResult.grant.id,
                escalationRequestId: escalation.requestId,
              },
              "Inline grant wait succeeded - allowing trusted contact tool invocation",
            );
            return { allowed: true, tool, grantConsumed: true, parsedInput };
          }

          if (waitResult.outcome === "aborted") {
            // Clear the inline-wait stamp so a later guardian approval
            // (if the request is still pending) will send the retry notification.
            await stampFollowupState(escalation.requestId, null);
            this.auditGateError(
              context,
              name,
              input,
              riskLevel,
              startTime,
              "Cancelled",
            );
            return {
              allowed: false,
              result: { content: "Cancelled", isError: true },
            };
          }

          // Clear the inline-wait stamp so a later guardian approval
          // (if the request is still pending after timeout) will send
          // the retry notification as expected.
          await stampFollowupState(escalation.requestId, null);

          const codeSuffix = escalation.requestCode
            ? ` (request code: ${escalation.requestCode})`
            : "";

          let escalationMessage: string;
          if (waitResult.outcome === "denied") {
            escalationMessage = `Permission denied for "${name}": the guardian rejected the request${codeSuffix}.`;
          } else {
            // timeout
            escalationMessage =
              `Permission denied for "${name}": guardian approval was not received in time${codeSuffix}. ` +
              `Please retry after the guardian approves.`;
          }

          log.warn(
            {
              toolName: name,
              conversationId: context.conversationId,
              trustClass: context.trustClass,
              executionTarget,
              reason: "guardian_approval_required",
              grantMissReason: grantResult.reason,
              waitOutcome: waitResult.outcome,
              escalationRequestId: escalation.requestId,
            },
            "Inline grant wait ended without approval - denying trusted contact tool invocation",
          );
          this.auditGateDenied(
            context,
            name,
            input,
            riskLevel,
            startTime,
            escalationMessage,
          );
          return {
            allowed: false,
            result: { content: escalationMessage, isError: true },
          };
        }
        // escalation.failed - fall through to generic denial.
      }

      // Unknown/unverified actors or escalation failures - generic denial.
      const reason = sensitiveToolDeniedMessage(sensitiveDecision, name);
      log.warn(
        {
          toolName: name,
          conversationId: context.conversationId,
          trustClass: context.trustClass,
          executionTarget,
          reason: "guardian_approval_required",
          grantMissReason: grantResult.reason,
          escalated: false,
        },
        "Guardian approval gate blocked untrusted actor tool invocation (no matching grant)",
      );
      this.auditGateDenied(context, name, input, riskLevel, startTime, reason);
      return { allowed: false, result: { content: reason, isError: true } };
    }

    return { allowed: true, tool, parsedInput };
  }
}
