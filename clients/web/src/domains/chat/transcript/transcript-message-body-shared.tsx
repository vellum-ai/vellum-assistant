import {
  DOCUMENT_EDIT_TOOL_NAMES,
  REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES,
} from "@vellumai/assistant-api";
import {
  isAcpSpawnCall,
  isBackgroundBashCall,
  isRunWorkflowCall,
  isSubagentSpawnCall,
} from "@/domains/chat/transcript/message-content";
import {
  EMPTY_SUBAGENT_ENTRIES,
  type SubagentEntry,
} from "@/domains/chat/subagent-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useEmojiLookup } from "@/domains/chat/components/chat-composer/emoji-catalog";
import type { ConfirmationDecision } from "@/types/event-types";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  ScopeOption,
} from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { isInteractiveTarget } from "@/utils/interactive-target";

export interface OpenRuleEditorContext {
  toolName: string;
  riskLevel?: string;
  riskReason?: string;
  input?: Record<string, unknown>;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
}

/**
 * Props for a single chat message body, shared by both render trees (the
 * legacy positional walk and the blocks-driven walk) so the render seam can
 * forward one prop shape to whichever tree the flag selects.
 */
export interface TranscriptMessageBodyProps {
  message: DisplayMessage;
  /** Conversation the message belongs to. Forwarded to the hover actions so
   *  the bookmark toggle can key on (messageId, conversationId). */
  conversationId?: string | null;
  assistantDisplayName?: string | null;

  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onForkConversation?: (messageId: string) => void;
  onSummarizeUpToHere?: (messageId: string) => void;
  /** Opens the "Retry" confirm dialog. Bound to the hover-actions row only on
   *  the latest assistant message (see the `retryHandler` derivation). */
  onRetryLatestTurn?: () => void;
  onInspectMessage?: (messageId: string) => void;
  onOpenRuleEditor?: (context: OpenRuleEditorContext) => void;
  /** Tool-call ids whose chip should display the "command not recognized"
   *  nudge. Optional — when undefined no nudge ever shows. */
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (
    decision: ConfirmationDecision,
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: (
    toolCall: ChatMessageToolCall,
  ) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  /** Forwarded to inline app surfaces so they can render live preview iframes. */
  assistantId?: string | null;
  /** Click handler when the user clicks a subagent's open-timeline button on
   *  an inline subagent card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
  /** Click handler when the user clicks a workflow's open button on an inline
   *  workflow progress card. */
  onWorkflowClick?: (runId: string) => void;
  /** Callback to abort/stop a running workflow from an inline card. */
  onStopWorkflow?: (runId: string) => void;
  /**
   * Ids of the documents this message's whole response changed, resolved by
   * `Transcript` (see `resolveResponseDocumentIds`) and set only on the message
   * that ends a completed response. Each one renders a reopen link below the
   * message body, so a response closes with one link per document however many
   * of its messages wrote to it.
   */
  changedDocumentIds?: string[];
  /**
   * True when this message belongs to the turn that is actively streaming.
   * Set by `LatestTurnRow` for the in-progress response cluster; history
   * rows leave it `false`. Keeps the message's last tool-call group expanded
   * for the whole stream — not just the instants a tool reports `running` —
   * so the latest activity stays visible while the model fills in the rest
   * of the turn. Collapses back to the compact default once the turn ends.
   */
  isStreaming?: boolean;
  /**
   * True only for the last message of the latest turn — the one that sits
   * directly above the parked assistant avatar (trailing non-message rows
   * like the thinking slot don't count). Collapses the hover-actions
   * row to zero height so the avatar hugs the message, then animates it open
   * on hover/focus/tap-reveal (the avatar slides down to make room). History
   * rows leave it `false` and keep the always-reserved row height so hovering
   * mid-transcript never shifts layout.
   */
  isLatestMessage?: boolean;
}

/**
 * Extract the spawned `subagentId` from a `subagent_spawn` tool call's result.
 * The daemon's spawn tool returns `JSON.stringify({ subagentId, label, ... })`
 * (see `assistant/src/tools/subagent/spawn.ts`). Returns `undefined` when the
 * result hasn't landed yet or the payload is malformed — callers fall back to
 * a subagent-store lookup so `running` spawns still render an inline card.
 */
function extractSubagentIdFromResult(
  toolCall: ChatMessageToolCall,
): string | undefined {
  if (!isSubagentSpawnCall(toolCall)) {
    return undefined;
  }
  if (typeof toolCall.result !== "string" || !toolCall.result) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(toolCall.result) as { subagentId?: unknown };
    return typeof parsed.subagentId === "string"
      ? parsed.subagentId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look up the subagent-store entries spawned by `message` via the indexed
 * `byParent` map. Under single-id semantics the message's `id` is its only
 * identity, and both live-streaming (`parentMessageStableId`) and
 * history-reconstructed (`parentMessageId`) entries are keyed by that same
 * parent id — so a single bucket lookup finds them all.
 *
 * The matching bucket is returned by reference so unrelated subagent
 * mutations do not change the selector output.
 */
export function lookupSubagentEntriesForMessage(
  byParent: Map<string, SubagentEntry[]>,
  message: DisplayMessage,
): readonly SubagentEntry[] {
  // Fast path for messages with no spawned subagents — avoids the lookup in
  // the hot per-render selector.
  if (byParent.size === 0) {
    return EMPTY_SUBAGENT_ENTRIES;
  }

  // `byParent` never stores empty buckets, so a present bucket always has
  // entries and can be returned by reference.
  return byParent.get(message.id) ?? EMPTY_SUBAGENT_ENTRIES;
}

/**
 * Resolve the spawned `subagentId` for each `subagent_spawn` tool call in
 * `toolCalls`. Resolution priority per tool call:
 *
 *  1. `byToolUseId.get(tc.id)` — the deterministic, reconcile-proof anchor.
 *     During streaming `tc.id === parentToolUseId` (see `tool-call-handlers.ts`
 *     where the tool-call id is set to `event.toolUseId`), and `reconcile.ts`
 *     preserves local tool-call ids (`keepLocalToolState`), so this match holds
 *     the instant the spawn lands and survives message reconcile — no dependence
 *     on `message.id` or the tool result.
 *  2. The id encoded in `toolCall.result` — present once the spawn tool result
 *     has landed.
 *  3. A positional match against `linkedEntries` (subagent-store entries
 *     already filtered to those spawned by the current message, sorted by
 *     `spawnedAt`) — covers older daemons, history-synthesized tool ids, and
 *     forks where no tool-use id is available.
 *
 * Positional fallback: the caller owns the `claimed` Set so it persists
 * across every invocation within a single message — that's what stops two
 * non-consecutive spawn tool-call groups (each producing a separate
 * `MultiActivityGroup` mount) from both pulling the same first unclaimed
 * entry and rendering duplicate cards. The by-id matches also feed `claimed`
 * so a later positional match can't re-pick an already-anchored entry.
 */
export function resolveSpawnedSubagentIds(
  toolCalls: ChatMessageToolCall[],
  linkedEntries: readonly SubagentEntry[],
  byToolUseId: Map<string, string>,
  claimed: Set<string>,
): string[] {
  const spawnToolCalls = toolCalls.filter(isSubagentSpawnCall);
  if (spawnToolCalls.length === 0) {
    return [];
  }

  const ids: string[] = [];

  for (const tc of spawnToolCalls) {
    const byId = byToolUseId.get(tc.id);
    if (byId && !claimed.has(byId)) {
      ids.push(byId);
      claimed.add(byId);
      continue;
    }
    const fromResult = extractSubagentIdFromResult(tc);
    if (fromResult) {
      ids.push(fromResult);
      claimed.add(fromResult);
      continue;
    }
    const next = linkedEntries.find((entry) => !claimed.has(entry.subagentId));
    if (next) {
      ids.push(next.subagentId);
      claimed.add(next.subagentId);
    }
  }

  return ids;
}

/**
 * Extract the launched `runId` from a `run_workflow` tool call's result. The
 * daemon's workflow tool returns `JSON.stringify({ runId, status, message })`.
 * Returns `null` when the result hasn't landed yet or the payload is malformed
 * — callers fall back to the `byToolUseId` anchor so `running` workflows still
 * render an inline card.
 */
function extractRunIdFromResult(toolCall: ChatMessageToolCall): string | null {
  if (!isRunWorkflowCall(toolCall)) {
    return null;
  }
  if (typeof toolCall.result !== "string" || !toolCall.result) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolCall.result) as { runId?: unknown };
    return typeof parsed.runId === "string" ? parsed.runId : null;
  } catch {
    return null;
  }
}

/**
 * The `runId` a single `run_workflow` tool call resolves to — its
 * `byToolUseId` anchor (from the `workflow_started` event), else the id encoded
 * in its result — or `null` when none is available, e.g. the call FAILED before
 * returning a `runId` (bad manifest, run cap, invalid meta). The transcript
 * suppresses the raw tool chip ONLY for calls that resolve to a card; a failed
 * call (`null`) keeps rendering its tool result so the error stays visible.
 */
export function workflowRunIdForCall(
  toolCall: ChatMessageToolCall,
  byToolUseId: Map<string, string>,
): string | null {
  if (!isRunWorkflowCall(toolCall)) {
    return null;
  }
  return byToolUseId.get(toolCall.id) ?? extractRunIdFromResult(toolCall);
}

/**
 * Resolve the launched `runId` for each `run_workflow` tool call in
 * `toolCalls`. Resolution priority per tool call:
 *
 *  1. `byToolUseId.get(tc.id)` — the deterministic, reconcile-proof anchor
 *     carried on the `workflow_started` event.
 *  2. The id encoded in `toolCall.result` — present once the workflow tool
 *     result has landed.
 *
 * The caller owns the `claimed` Set so it persists across every invocation
 * within a single message, stopping two non-consecutive launch tool-call
 * groups from both anchoring the same run id.
 */
export function resolveWorkflowRunIds(
  toolCalls: ChatMessageToolCall[],
  byToolUseId: Map<string, string>,
  claimed: Set<string>,
): string[] {
  const ids: string[] = [];

  for (const tc of toolCalls) {
    if (!isRunWorkflowCall(tc)) {
      continue;
    }
    const byId = byToolUseId.get(tc.id);
    if (byId && !claimed.has(byId)) {
      ids.push(byId);
      claimed.add(byId);
      continue;
    }
    const fromResult = extractRunIdFromResult(tc);
    if (fromResult && !claimed.has(fromResult)) {
      ids.push(fromResult);
      claimed.add(fromResult);
    }
  }

  return ids;
}

/**
 * The slice of workflow-store state that decides whether a `run_workflow`
 * tool call's raw chip is suppressed in favor of its inline card. Only
 * membership / key-presence is read, so the value types are intentionally
 * opaque — the full store satisfies this structurally.
 */
export interface WorkflowCardBackingState {
  byId: Record<string, unknown>;
  byToolUseId: Map<string, string>;
  notFoundRunIds: Set<string>;
  hydrationFailedRunIds: Set<string>;
}

/**
 * The set of `run_workflow` runIds in `toolCalls` whose inline card is
 * "card-backed" — i.e. the raw tool chip should be suppressed because the card
 * will render something. A runId is card-backed when an entry already exists
 * (`byId`) OR hydration is still pending. It is NOT card-backed once hydration
 * has definitively failed — a confirmed 404 (`notFoundRunIds`) or a transient
 * failure (`hydrationFailedRunIds`) leaves no entry, so the raw result must stay
 * visible instead of a blank card. `byId` is checked first so a later-arriving
 * entry (a live event after a transient failure) overrides a stale failure mark.
 */
export function computeCardBackedWorkflowRunIds(
  toolCalls: ChatMessageToolCall[],
  state: WorkflowCardBackingState,
): Set<string> {
  const backed = new Set<string>();
  for (const tc of toolCalls) {
    const rid = workflowRunIdForCall(tc, state.byToolUseId);
    if (rid === null) {
      continue;
    }
    if (state.byId[rid] !== undefined) {
      backed.add(rid);
      continue;
    }
    if (state.notFoundRunIds.has(rid)) {
      continue;
    }
    if (state.hydrationFailedRunIds.has(rid)) {
      continue;
    }
    backed.add(rid);
  }
  return backed;
}

/**
 * Extract the spawned `acpSessionId` from an `acp_spawn` tool call's result.
 * The daemon's spawn tool returns `JSON.stringify({ acpSessionId, ... })`.
 * Returns `null` when the result hasn't landed yet or the payload is malformed
 * — callers fall back to the `byToolUseId` anchor so `running` runs still
 * render an inline card.
 */
function extractAcpSessionIdFromResult(
  toolCall: ChatMessageToolCall,
): string | null {
  if (!isAcpSpawnCall(toolCall)) {
    return null;
  }
  if (typeof toolCall.result !== "string" || !toolCall.result) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolCall.result) as { acpSessionId?: unknown };
    return typeof parsed.acpSessionId === "string" ? parsed.acpSessionId : null;
  } catch {
    return null;
  }
}

/**
 * Extract the `bg-…` id from a backgrounded `bash`/`host_bash` tool call's
 * synchronous result. The daemon returns `JSON.stringify({ backgrounded: true,
 * id })` when the command is launched in the background. Returns `undefined`
 * for a foreground command or a non-JSON/malformed result so callers can anchor
 * only on real background runs.
 */
export function extractBgIdFromResult(
  toolCall: ChatMessageToolCall,
): string | undefined {
  if (!isBackgroundBashCall(toolCall)) {
    return undefined;
  }
  if (typeof toolCall.result !== "string" || !toolCall.result) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(toolCall.result) as {
      backgrounded?: unknown;
      id?: unknown;
    };
    return parsed.backgrounded === true && typeof parsed.id === "string"
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `bg-…` id for each backgrounded `bash`/`host_bash` tool call in
 * `toolCalls`. Unlike the subagent/workflow/ACP triad there is no `byToolUseId`
 * anchor — the id is carried only on the call's synchronous result, so each id
 * resolves via {@link extractBgIdFromResult}. A foreground command or a call
 * whose result hasn't landed resolves to nothing and is skipped.
 *
 * The caller owns the `claimed` Set so it persists across every invocation
 * within a single message, stopping two non-consecutive background tool-call
 * groups from both anchoring the same task id.
 */
export function resolveBackgroundTaskIds(
  toolCalls: ChatMessageToolCall[],
  claimed: Set<string>,
): string[] {
  const ids: string[] = [];

  for (const tc of toolCalls) {
    if (!isBackgroundBashCall(tc)) {
      continue;
    }
    const id = extractBgIdFromResult(tc);
    if (id && !claimed.has(id)) {
      ids.push(id);
      claimed.add(id);
    }
  }

  return ids;
}

/** The mutating document tools that leave the document openable. */
const DOCUMENT_MUTATION_TOOLS: ReadonlySet<string> = new Set(
  REOPENABLE_DOCUMENT_MUTATION_TOOL_NAMES,
);

/** The mutating document tools that write into an already-created document. */
const DOCUMENT_EDIT_TOOLS: ReadonlySet<string> = new Set(
  DOCUMENT_EDIT_TOOL_NAMES,
);

/**
 * Detect a call to one of `tools`. Document tools ship in the bundled
 * `document-editor` skill, so a call arrives either under its raw tool name or
 * inside a `skill_execute` envelope whose `input.tool` names it.
 */
function isDocumentToolCall(
  toolCall: ChatMessageToolCall,
  tools: ReadonlySet<string>,
): boolean {
  if (tools.has(toolCall.name)) {
    return true;
  }
  if (toolCall.name !== "skill_execute") {
    return false;
  }
  const input = toolCall.input;
  if (input == null || typeof input !== "object") {
    return false;
  }
  const tool = (input as Record<string, unknown>).tool;
  return typeof tool === "string" && tools.has(tool);
}

/**
 * Extract the `surface_id` a call to one of `tools` wrote to. The executors
 * return `JSON.stringify({ ..., surface_id })` (see
 * `assistant/src/tools/document/document-tool.ts`). Returns `undefined` for a
 * call outside `tools`, a call that failed, a replace that matched nothing, or
 * a non-JSON/malformed result, so callers anchor only on documents that really
 * changed.
 *
 * Only `document_replace_text` reports `content_changed`, and it succeeds with
 * `content_changed: false` when `find` matched nothing. `document_create` and
 * `document_update` omit the field and always write, so an absent field reads
 * as changed and only an explicit `false` rejects the call. That matches the
 * daemon, which emits `document_editor_update` on the same condition.
 */
function extractDocumentSurfaceIdFromResult(
  toolCall: ChatMessageToolCall,
  tools: ReadonlySet<string>,
): string | undefined {
  if (!isDocumentToolCall(toolCall, tools) || toolCall.isError === true) {
    return undefined;
  }
  if (typeof toolCall.result !== "string" || !toolCall.result) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(toolCall.result) as {
      surface_id?: unknown;
      content_changed?: unknown;
    };
    if (parsed.content_changed === false) {
      return undefined;
    }
    return typeof parsed.surface_id === "string" && parsed.surface_id !== ""
      ? parsed.surface_id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the ids of the documents `toolCalls` changed, in first-changed order.
 * Each id rides on its call's persisted `result`, so it survives a history
 * reseed, unlike the ephemeral `document_editor_update` event.
 *
 * The caller owns the `claimed` Set so it persists across every invocation
 * within a single response. That collapses repeated edits of one document into
 * a single entry, whether they ran in one message or spread across several.
 */
export function resolveChangedDocuments(
  toolCalls: ChatMessageToolCall[],
  claimed: Set<string>,
): string[] {
  const surfaceIds: string[] = [];

  for (const tc of toolCalls) {
    const surfaceId = extractDocumentSurfaceIdFromResult(
      tc,
      DOCUMENT_MUTATION_TOOLS,
    );
    if (surfaceId && !claimed.has(surfaceId)) {
      surfaceIds.push(surfaceId);
      claimed.add(surfaceId);
    }
  }

  return surfaceIds;
}

/**
 * The ids of the documents `toolCalls` wrote into with `document_update` or
 * `document_replace_text`, ignoring the create that opened them.
 *
 * An inline `document_preview` card renders where its tool ran, so it stands in
 * for the end-of-response reopen link only on a document the response leaves
 * alone afterwards. A document the response keeps writing to is changed below
 * its card and still owes a link at the end.
 */
export function resolveEditedDocuments(
  toolCalls: ChatMessageToolCall[],
): Set<string> {
  const surfaceIds = new Set<string>();

  for (const tc of toolCalls) {
    const surfaceId = extractDocumentSurfaceIdFromResult(
      tc,
      DOCUMENT_EDIT_TOOLS,
    );
    if (surfaceId) {
      surfaceIds.add(surfaceId);
    }
  }

  return surfaceIds;
}

/**
 * The `acpSessionId` a single `acp_spawn` tool call resolves to — its
 * `byToolUseId` anchor (from the `acp_session_spawned` event), else the id
 * encoded in its result — or `null` when none is available (e.g. the call
 * FAILED before returning a session id). The transcript suppresses the raw tool
 * chip ONLY for calls that resolve to a card; a failed call (`null`) keeps
 * rendering its tool result so the error stays visible.
 */
export function acpRunIdForCall(
  toolCall: ChatMessageToolCall,
  byToolUseId: Map<string, string>,
): string | null {
  if (!isAcpSpawnCall(toolCall)) {
    return null;
  }
  return (
    byToolUseId.get(toolCall.id) ?? extractAcpSessionIdFromResult(toolCall)
  );
}

/**
 * Resolve the spawned `acpSessionId` for each `acp_spawn` tool call in
 * `toolCalls`. Resolution priority per tool call:
 *
 *  1. `byToolUseId.get(tc.id)` — the deterministic, reconcile-proof anchor
 *     carried on the `acp_session_spawned` event.
 *  2. The id encoded in `toolCall.result` — present once the spawn tool result
 *     has landed.
 *
 * The caller owns the `claimed` Set so it persists across every invocation
 * within a single message, stopping two non-consecutive spawn tool-call groups
 * from both anchoring the same session id.
 */
export function resolveAcpRunIds(
  toolCalls: ChatMessageToolCall[],
  byToolUseId: Map<string, string>,
  claimed: Set<string>,
): string[] {
  const ids: string[] = [];

  for (const tc of toolCalls) {
    if (!isAcpSpawnCall(tc)) {
      continue;
    }
    const byId = byToolUseId.get(tc.id);
    if (byId && !claimed.has(byId)) {
      ids.push(byId);
      claimed.add(byId);
      continue;
    }
    const fromResult = extractAcpSessionIdFromResult(tc);
    if (fromResult && !claimed.has(fromResult)) {
      ids.push(fromResult);
      claimed.add(fromResult);
    }
  }

  return ids;
}

function fallbackRoleLabel(
  role: DisplayMessage["role"],
  assistantDisplayName?: string | null,
): string {
  if (role === "assistant") {
    return firstPresentLabel(assistantDisplayName) ?? "Assistant";
  }
  return "User";
}

function firstPresentLabel(
  ...candidates: Array<string | null | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function getSlackSenderLabel(
  message: DisplayMessage,
  assistantDisplayName?: string | null,
): string | null {
  if (!message.slackMessage) {
    return null;
  }
  const sender = message.slackMessage.sender;
  return (
    firstPresentLabel(
      sender?.displayName,
      sender?.name,
      sender?.username,
      sender?.externalUserId,
    ) ?? fallbackRoleLabel(message.role, assistantDisplayName)
  );
}

export function isInteractiveClickTarget(target: Element | null): boolean {
  return isInteractiveTarget(target);
}

export function SlackMessageAttribution({
  message,
  assistantDisplayName,
}: {
  message: DisplayMessage;
  assistantDisplayName?: string | null;
}) {
  const label = getSlackSenderLabel(message, assistantDisplayName);
  if (!label) {
    return null;
  }

  const className =
    "inline-flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]";
  return (
    <div data-testid="slack-message-attribution" className={className}>
      <span>{label}</span>
    </div>
  );
}

/**
 * Compact inline rendering of a Slack reaction event. Shows the emoji
 * character (or `:shortcode:` fallback) plus the actor name and verb.
 */
export function SlackReactionLine({ message }: { message: DisplayMessage }) {
  const lookupEmoji = useEmojiLookup();
  const reaction = message.slackMessage?.reaction;
  if (!reaction) {
    return null;
  }

  const emojiChar = lookupEmoji(reaction.emoji);
  const emojiDisplay = emojiChar ?? `:${reaction.emoji}:`;
  const actor =
    reaction.actorDisplayName ??
    message.slackMessage?.sender?.displayName ??
    message.slackMessage?.sender?.name;
  const verb = reaction.op === "added" ? "reacted" : "removed reaction";

  return (
    <div
      data-testid="slack-reaction-line"
      className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]"
    >
      <span className="text-base">{emojiDisplay}</span>
      {actor && <span>{actor}</span>}
      <span>{verb}</span>
    </div>
  );
}
