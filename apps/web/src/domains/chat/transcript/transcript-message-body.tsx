
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import { SubagentInlineProgressCard } from "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import { ToolCallProgressCard } from "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card";
import {
  getLeadingThinkingText,
  getLegacyLeadingThinkingText,
} from "@/domains/chat/components/tool-progress-card/get-leading-thinking-text";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { parseInlineSurfaces } from "@/domains/chat/utils/parse-inline-surfaces";
import { getSlackLinkUrl, type Surface } from "@/domains/chat/types/types";
import { isPointerCoarse } from "@/utils/pointer";
import {
  EMPTY_SUBAGENT_ENTRIES,
  useSubagentStore,
  type SubagentEntry,
} from "@/domains/chat/subagent-store";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

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
 * Renders a single chat message bubble — a careful copy of the per-message
 * branch of the `messages.map(...)` loop in `AssistantPageClient.tsx`. The
 * grouping rules for tool calls / text / inline surfaces are duplicated
 * verbatim so the virtualized transcript produces byte-identical markup to
 * the legacy rendering path. Do NOT change the grouping rules in this file
 * without updating the legacy path in lockstep.
 */
export interface TranscriptMessageBodyProps {
  message: DisplayMessage;
  /** Whether this row is the live, not-yet-finalized assistant bubble of
   *  the active turn. Derived by the transcript from the conversation's
   *  processing state and message position — drives streaming animations
   *  and gates hover actions while the turn is in flight. */
  isStreaming?: boolean;
  assistantDisplayName?: string | null;
  /**
   * Persistent set of expanded tool-call ids. Passed straight through to
   * `ToolCallChip` so expansion state survives virtualization unmounts.
   * Callers should reuse a single ref for the lifetime of the transcript.
   */
  expandedToolCallIds: Set<string>;
  /**
   * Persistent set of expanded progress-card ids (keyed by first tool-call id
   * in the group). Survives component remounts so card expansion state is
   * not lost when items transition from latest-turn to history.
   */
  expandedCardIds: Map<string, boolean>;
  onSurfaceAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onForkConversation?: (messageId: string) => void;
  onInspectMessage?: (messageId: string) => void;
  onOpenRuleEditor?: (context: OpenRuleEditorContext) => void;
  /** Tool-call ids whose chip should display the "command not recognized"
   *  nudge. Optional — when undefined no nudge ever shows. */
  unknownNudgeToolCallIds?: Set<string>;
  onDismissUnknownNudge?: (toolCallId: string) => void;
  /** Whether the confirmation action is currently being submitted. */
  isSubmittingConfirmation?: boolean;
  /** Callback when the user clicks Allow or Deny on an inline confirmation. */
  onConfirmationSubmit?: (decision: ConfirmationDecision) => void;
  /** Callback when the user picks "Allow & Create Rule" from the split button. */
  onAllowAndCreateRule?: () => void;
  /** The tool call id that currently has the active pending confirmation.
   *  Only the matching chip renders the inline confirmation UI. */
  pendingConfirmationToolCallId?: string;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
  /** Forwarded to inline app surfaces so they can render live preview iframes. */
  assistantId?: string | null;
  /** Click handler when the user clicks a subagent's open-timeline button on
   *  an inline subagent card. */
  onSubagentClick?: (subagentId: string) => void;
  /** Callback to abort/stop a running subagent from an inline card. */
  onStopSubagent?: (subagentId: string) => void;
}

/**
 * Detect whether a tool call is a `subagent_spawn` invocation. The daemon
 * exposes `subagent_spawn` as a bundled-skill tool, which means the LLM
 * actually emits a `skill_execute` call with `input.tool === "subagent_spawn"`
 * — the daemon's `skill_execute` interceptor (see
 * `assistant/src/daemon/conversation-tool-setup.ts`) re-dispatches to the
 * real executor, but the `tool_use_start` event the frontend receives still
 * carries `toolName: "skill_execute"`. Matching on the raw `toolName` would
 * miss every spawn and leave inline subagent cards unrendered.
 */
export function isSubagentSpawnCall(toolCall: ChatMessageToolCall): boolean {
  if (toolCall.toolName === "subagent_spawn") return true;
  if (toolCall.toolName !== "skill_execute") return false;
  const input = toolCall.input;
  if (input == null || typeof input !== "object") return false;
  return (input as Record<string, unknown>).tool === "subagent_spawn";
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
  if (!isSubagentSpawnCall(toolCall)) return undefined;
  if (typeof toolCall.result !== "string" || !toolCall.result) return undefined;
  try {
    const parsed = JSON.parse(toolCall.result) as { subagentId?: unknown };
    return typeof parsed.subagentId === "string" ? parsed.subagentId : undefined;
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
function lookupSubagentEntriesForMessage(
  byParent: Map<string, SubagentEntry[]>,
  message: DisplayMessage,
): readonly SubagentEntry[] {
  // Fast path for messages with no spawned subagents — avoids the lookup in
  // the hot per-render selector.
  if (byParent.size === 0) return EMPTY_SUBAGENT_ENTRIES;

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
 * `ToolCallProgressCard` mount) from both pulling the same first unclaimed
 * entry and rendering duplicate cards. The by-id matches also feed `claimed`
 * so a later positional match can't re-pick an already-anchored entry.
 */
function resolveSpawnedSubagentIds(
  toolCalls: ChatMessageToolCall[],
  linkedEntries: readonly SubagentEntry[],
  byToolUseId: Map<string, string>,
  claimed: Set<string>,
): string[] {
  const spawnToolCalls = toolCalls.filter(isSubagentSpawnCall);
  if (spawnToolCalls.length === 0) return [];

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

function latestMessageActivityTimestamp(
  message: DisplayMessage,
): number | undefined {
  const latestToolTimestamp = message.toolCalls?.reduce<number | undefined>(
    (latest, toolCall) => {
      const toolTimestamp = toolCall.completedAt ?? toolCall.startedAt;
      if (toolTimestamp == null) {
        return latest;
      }
      return latest == null ? toolTimestamp : Math.max(latest, toolTimestamp);
    },
    undefined,
  );

  if (latestToolTimestamp == null) {
    return message.timestamp;
  }

  if (message.timestamp == null) {
    return latestToolTimestamp;
  }

  return Math.max(message.timestamp, latestToolTimestamp);
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
    if (normalized) return normalized;
  }
  return undefined;
}

function getSlackSenderLabel(
  message: DisplayMessage,
  assistantDisplayName?: string | null,
): string | null {
  if (!message.slackMessage) return null;
  const sender = message.slackMessage.sender;
  return firstPresentLabel(
    sender?.displayName,
    sender?.name,
    sender?.username,
    sender?.externalUserId,
  ) ?? fallbackRoleLabel(message.role, assistantDisplayName);
}

function isInteractiveClickTarget(target: Element | null): boolean {
  return Boolean(
    target?.closest('a, button, [role="button"], input, textarea, select'),
  );
}

function SlackMessageAttribution({
  message,
  assistantDisplayName,
}: {
  message: DisplayMessage;
  assistantDisplayName?: string | null;
}) {
  const label = getSlackSenderLabel(message, assistantDisplayName);
  if (!label) return null;

  const className =
    "inline-flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]";
  return (
    <div
      data-testid="slack-message-attribution"
      className={className}
    >
      <span>{label}</span>
    </div>
  );
}


export function TranscriptMessageBody({
  message,
  isStreaming = false,
  assistantDisplayName,
  expandedToolCallIds,
  expandedCardIds,
  onSurfaceAction,
  onForkConversation,
  onInspectMessage,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  isSubmittingConfirmation,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  pendingConfirmationToolCallId,
  onOpenApp,
  onOpenDocument,
  assistantId,
  onSubagentClick,
  onStopSubagent,
}: TranscriptMessageBodyProps) {
  const hasInterleavedToolCalls = message.contentOrder?.some(
    (e) => e.type === "toolCall" || e.type === "tool",
  );
  const isSlackMessage = Boolean(message.slackMessage);

  const textBubbleClass =
    message.role === "user"
      ? `max-w-[80%] rounded-lg bg-[var(--surface-lift)] px-4 py-3 text-[var(--content-default)] ${
          isSlackMessage ? "sm:max-w-[420px]" : ""
        }`
      : isSlackMessage
        ? "max-w-[80%] text-[var(--content-default)] sm:max-w-[640px]"
        : "w-full text-[var(--content-default)]";

  const handleExpandChange = (toolCallId: string, isExpanded: boolean) => {
    if (isExpanded) {
      expandedToolCallIds.add(toolCallId);
    } else {
      expandedToolCallIds.delete(toolCallId);
    }
  };

  const forkMessageId = message.id;
  const forkHandler = forkMessageId && onForkConversation
    ? () => onForkConversation(forkMessageId)
    : undefined;
  const inspectMessageId = message.id;
  const inspectHandler = inspectMessageId && onInspectMessage
    ? () => onInspectMessage(inspectMessageId)
    : undefined;
  const isToolCallComplete = !isStreaming;

  // Touch-only tap-to-reveal for the hover actions row. Desktop uses
  // group-hover (unchanged); on coarse pointers a tap on the bubble toggles
  // the controls and a tap outside dismisses them. Interactive children
  // (links, buttons) are skipped so they handle their own clicks.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  const slackMessageUrl = getSlackLinkUrl(message.slackMessage?.messageLink);

  useEffect(() => {
    if (!revealed) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && wrapperRef.current && !wrapperRef.current.contains(target)) {
        setRevealed(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [revealed]);

  const handleBubbleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as Element | null;
    if (isInteractiveClickTarget(target)) {
      return;
    }

    if (slackMessageUrl && isPointerCoarse()) {
      if (window.getSelection()?.toString()) return;
      window.open(slackMessageUrl, "_blank", "noopener,noreferrer");
      return;
    }

    if (!isPointerCoarse()) return;
    setRevealed((v) => !v);
  }, [slackMessageUrl]);

  // Resolve a surface from a contentOrder id. Surfaces are stored directly
  // on the message's surfaces[] array. The streaming path uses the UUID
  // directly; the server contentOrder uses index-based IDs ("0", "1").
  const resolveSurface = (id: string): Surface | undefined => {
    if (!message.surfaces) return undefined;
    // Direct surfaceId match
    const direct = message.surfaces.find((s) => s.surfaceId === id);
    if (direct) return direct;
    // Index-based fallback (server contentOrder uses "0", "1", etc.)
    const idx = parseInt(id, 10);
    if (!isNaN(idx) && idx < message.surfaces.length) {
      return message.surfaces[idx];
    }
    return undefined;
  };

  // UI surface tools are rendered by the inline surface widget, not as
  // tool call chips — unless they have a pending confirmation attached,
  // in which case the chip must render so the inline confirmation card
  // is visible.
  const isSuppressedUiTool = (tc: ChatMessageToolCall) =>
    !tc.pendingConfirmation &&
    (tc.toolName === "ui_show" || tc.toolName === "ui_update" || tc.toolName === "ui_dismiss");
  const messageTimestamp = latestMessageActivityTimestamp(message);

  const renderTextWithInlineSurfaces = (text: string, key: string, hardLineBreaks: boolean) => {
    const inlineSegments = parseInlineSurfaces(text);
    if (inlineSegments) {
      return (
        <div key={key} className="w-full">
          {inlineSegments.map((seg, si) => {
            if (seg.type === "surface") {
              return (
                <div key={`inline-surface-${si}`} className="my-2 w-full">
                  <SurfaceRouter
                    surface={seg.surface}
                    onAction={() => {}}
                    onOpenApp={onOpenApp}
                    onOpenDocument={onOpenDocument}
                    assistantId={assistantId}
                    isToolCallComplete={true}
                  />
                </div>
              );
            }
            return (
              <div
                key={`inline-text-${si}`}
                className={`break-words text-[15px] ${textBubbleClass}`}
              >
                <ChatMarkdownMessage content={seg.content} hardLineBreaks={hardLineBreaks} />
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div key={key} className={`break-words text-[15px] ${textBubbleClass}`}>
        <ChatMarkdownMessage content={text} hardLineBreaks={hardLineBreaks} />
      </div>
    );
  };

  // Subscribe to the subagent-store's `byParent` index entry for *this*
  // message so unrelated subagent changes (status/event mutations on a
  // different message's subagents, or new spawns under a different message)
  // don't re-render every visible message body. The bucket reference is
  // stable across per-event mutations; it only changes when an entry is
  // added or removed for the matching parent id.
  //
  // The `subagent_spawned` SSE event lands before the tool_result, so the
  // store entry already exists during the running window — that's what lets
  // `resolveSpawnedSubagentIds` render an inline card even when the spawn
  // tool call has no `result` yet.
  const linkedSubagentEntries = useSubagentStore(
    (s) => lookupSubagentEntriesForMessage(s.byParent, message),
  );

  // Subscribe to the tool-use-id index alongside the per-message bucket above.
  // Spawns are infrequent, so subscribing to the whole map is acceptable; the
  // store keeps the map reference stable across non-spawn mutations, so this
  // does not re-render message bodies on unrelated subagent activity. This
  // anchors each `subagent_spawn` tool call to its subagent by `tc.id`,
  // independent of the (optimistic→server) message id.
  const byToolUseId = useSubagentStore.use.byToolUseId();

  // Message-scoped: two non-consecutive `subagent_spawn` tool-call groups
  // must not both positional-match the same linked entry. Accumulates across
  // every `renderInlineSubagentCards` invocation within a single render.
  const claimedSpawnIds = new Set<string>();

  // Render an inline `SubagentInlineProgressCard` per `subagent_spawn` tool
  // call in the given list. IDs come from `resolveSpawnedSubagentIds`, which
  // prefers `toolCall.result` and falls back to a positional match against
  // `linkedSubagentEntries` when the result hasn't arrived yet. The card
  // subscribes to the subagent store directly via `useSubagentCardData`, so
  // we only need to forward the id and the click/stop callbacks.
  //
  // Stacked with a 6px gap to match the existing card rhythm. The wrapper
  // returns `null` when no spawn tool calls are present so the rendered tree
  // is unchanged for non-subagent flows.
  const renderInlineSubagentCards = (toolCalls: ChatMessageToolCall[]) => {
    const spawnedIds = resolveSpawnedSubagentIds(
      toolCalls,
      linkedSubagentEntries,
      byToolUseId,
      claimedSpawnIds,
    );
    if (spawnedIds.length === 0) return null;
    return (
      <div className="flex w-full flex-col gap-1.5">
        {spawnedIds.map((subagentId) => (
          <SubagentInlineProgressCard
            key={subagentId}
            subagentId={subagentId}
            onSubagentClick={onSubagentClick}
            onStopSubagent={onStopSubagent}
          />
        ))}
      </div>
    );
  };

  if (hasInterleavedToolCalls && message.contentOrder) {
    // Group consecutive entries: merge adjacent toolCall/tool entries into a
    // single group (mirrors macOS `groupContentBlocks`).
    type ContentGroup =
      | { type: "text"; id: string }
      | { type: "toolCalls"; ids: string[] }
      | { type: "surface"; id: string };

    const groups: ContentGroup[] = [];
    for (const entry of message.contentOrder) {
      if (entry.type === "toolCall" || entry.type === "tool") {
        const lastGroup = groups[groups.length - 1];
        if (lastGroup?.type === "toolCalls") {
          lastGroup.ids.push(entry.id);
        } else {
          groups.push({ type: "toolCalls", ids: [entry.id] });
        }
      } else if (entry.type === "text") {
        groups.push({ type: "text", id: entry.id });
      } else if (entry.type === "surface") {
        groups.push({ type: "surface", id: entry.id });
      }
    }

    const resolveToolCall = (id: string): ChatMessageToolCall | undefined => {
      const tc = message.toolCalls?.find((t) => t.id === id);
      if (tc) {
        return tc;
      }
      const idx = parseInt(id, 10);
      if (!isNaN(idx) && message.toolCalls && idx < message.toolCalls.length) {
        return message.toolCalls[idx];
      }
      return undefined;
    };

    return (
      <div
        ref={wrapperRef}
        onClick={handleBubbleClick}
        data-revealed={revealed}
        className={`group/msg flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
      >
        <div
          className={`flex w-full flex-col gap-2 ${message.role === "user" ? "items-end" : "items-start"}`}
        >
          {groups.map((group, gi) => {
            if (group.type === "toolCalls") {
              const toolCalls = group.ids
                .map(resolveToolCall)
                .filter((tc): tc is ChatMessageToolCall => tc != null && !isSuppressedUiTool(tc));
              if (toolCalls.length === 0) {
                return null;
              }
              // A group whose only tool calls are subagent spawns renders
              // exclusively through the inline subagent cards below. The
              // unified progress card would have no renderable steps (spawns
              // are filtered out of its body) and would surface just the
              // leading-thinking preamble — redundant noise, since that text
              // already renders as its own message text group.
              const hasRenderableToolCall = toolCalls.some(
                (tc) => !isSubagentSpawnCall(tc),
              );
              return (
                <Fragment key={`tc-${gi}`}>
                  {hasRenderableToolCall && (
                    <ToolCallProgressCard
                      toolCalls={toolCalls}
                      expandedToolCallIds={expandedToolCallIds}
                      onExpandChange={handleExpandChange}
                      expandedCardIds={expandedCardIds}
                      onOpenRuleEditor={onOpenRuleEditor}
                      isSubmittingConfirmation={isSubmittingConfirmation}
                      onConfirmationSubmit={onConfirmationSubmit}
                      onAllowAndCreateRule={onAllowAndCreateRule}
                      pendingConfirmationToolCallId={pendingConfirmationToolCallId}
                      unknownNudgeToolCallIds={unknownNudgeToolCallIds}
                      onDismissUnknownNudge={onDismissUnknownNudge}
                      isStreaming={isStreaming}
                      leadingThinkingText={getLeadingThinkingText(message, gi)}
                    />
                  )}
                  {renderInlineSubagentCards(toolCalls)}
                </Fragment>
              );
            }
            if (group.type === "text") {
              const textSegments = message.textSegments ?? [];
              const numericIdx = parseInt(group.id, 10);
              const seg = !isNaN(numericIdx)
                ? textSegments[numericIdx]
                : textSegments.find(
                    (s) => (s as Record<string, unknown>).id === group.id,
                  );
              const text = seg?.content;
              if (!text) {
                return null;
              }
              return renderTextWithInlineSurfaces(text, `text-${gi}`, message.role === "user");
            }
            if (group.type === "surface") {
              const surface = resolveSurface(group.id);
              if (!surface) {
                return null;
              }
              return (
                <div key={`surface-${gi}`} className="w-full">
                  <SurfaceRouter
                    surface={surface}
                    onAction={onSurfaceAction}
                    onOpenApp={onOpenApp}
                    onOpenDocument={onOpenDocument}
                    assistantId={assistantId}
                    isToolCallComplete={isToolCallComplete}
                  />
                </div>
              );
            }
            return null;
          })}
          {/* Fallback: if message.content exists but no text groups rendered
              (e.g. tool_use_start before any assistant_text_delta), show the
              content. */}
          {!groups.some((g) => g.type === "text") && message.content &&
            renderTextWithInlineSurfaces(message.content, "fallback", message.role === "user")
          }
          {message.attachments && message.attachments.length > 0 && (
            <MessageAttachments
              attachments={message.attachments}
              assistantId={assistantId}
            />
          )}
          <SlackMessageAttribution
            message={message}
            assistantDisplayName={assistantDisplayName}
          />
          <div className="h-6 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 has-[:focus-visible]:opacity-100 group-data-[revealed=true]/msg:opacity-100">
            <MessageHoverActions
              content={message.content}
              timestamp={messageTimestamp}
              role={message.role}
              isStreaming={isStreaming}
              openInSlackUrl={slackMessageUrl}
              onFork={forkHandler}
              onInspect={inspectHandler}
            />
          </div>
        </div>
      </div>
    );
  }

  // Legacy path: no interleaved tool calls in contentOrder. Render all tool
  // calls first, then text content.
  const contentElements: ReactNode[] = [];
  if (message.contentOrder && message.contentOrder.length > 0) {
    const textSegmentsArr = message.textSegments ?? [];
    for (const entry of message.contentOrder) {
      if (entry.type === "text") {
        const segIndex = parseInt(entry.id, 10);
        const seg = !isNaN(segIndex)
          ? textSegmentsArr[segIndex]
          : textSegmentsArr.find(
              (s) => (s as Record<string, unknown>).id === entry.id,
            );
        const segText = seg?.content ?? entry.id;
        contentElements.push(
          renderTextWithInlineSurfaces(segText, `text-${entry.id}`, message.role === "user"),
        );
      } else if (entry.type === "surface") {
        const surface = resolveSurface(entry.id);
        if (surface) {
          contentElements.push(
            <div key={`surface-${entry.id}`} className="w-full">
              <SurfaceRouter
                surface={surface}
                onAction={onSurfaceAction}
                onOpenApp={onOpenApp}
                onOpenDocument={onOpenDocument}
                assistantId={assistantId}
                isToolCallComplete={isToolCallComplete}
              />
            </div>,
          );
        }
      }
    }
    if (contentElements.length === 0 && message.content) {
      contentElements.push(
        renderTextWithInlineSurfaces(message.content, "fallback", message.role === "user"),
      );
    }
  } else {
    contentElements.push(
      message.content
        ? renderTextWithInlineSurfaces(message.content, "content", message.role === "user")
        : null,
    );
  }

  return (
    <div
      ref={wrapperRef}
      onClick={handleBubbleClick}
      data-revealed={revealed}
      className={`group/msg flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex w-full flex-col gap-2 ${message.role === "user" ? "items-end" : "items-start"}`}
      >
        {message.toolCalls && message.toolCalls.filter((tc) => !isSuppressedUiTool(tc)).length > 0 && (
          <>
            <ToolCallProgressCard
              toolCalls={message.toolCalls.filter((tc) => !isSuppressedUiTool(tc))}
              expandedToolCallIds={expandedToolCallIds}
              onExpandChange={handleExpandChange}
              expandedCardIds={expandedCardIds}
              onOpenRuleEditor={onOpenRuleEditor}
              isSubmittingConfirmation={isSubmittingConfirmation}
              onConfirmationSubmit={onConfirmationSubmit}
              onAllowAndCreateRule={onAllowAndCreateRule}
              pendingConfirmationToolCallId={pendingConfirmationToolCallId}
              unknownNudgeToolCallIds={unknownNudgeToolCallIds}
              onDismissUnknownNudge={onDismissUnknownNudge}
              isStreaming={isStreaming}
              leadingThinkingText={getLegacyLeadingThinkingText(message)}
            />
            {renderInlineSubagentCards(
              message.toolCalls.filter((tc) => !isSuppressedUiTool(tc)),
            )}
          </>
        )}
        {(contentElements.some((el) => !!el) ||
          (!message.toolCalls?.length &&
            !(message.attachments && message.attachments.length > 0))) && (
          // Layout-only column: the bubble styling (textBubbleClass) is applied
          // per text segment inside renderTextWithInlineSurfaces, mirroring the
          // interleaved path above. Applying textBubbleClass here too would
          // double-wrap text in two nested bubbles (doubled padding/background).
          <div
            className={`flex w-full flex-col gap-2 ${message.role === "user" ? "items-end" : "items-start"}`}
          >
            {contentElements}
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments
            attachments={message.attachments}
            assistantId={assistantId}
          />
        )}
        {/* Render surfaces attached to this message that aren't in contentOrder */}
        {(() => {
          if (!message.surfaces || message.surfaces.length === 0) return null;
          const renderedSurfaceIds = new Set(
            message.contentOrder
              ?.filter((e) => e.type === "surface")
              .map((e) => e.id) ?? [],
          );
          const unrendered = message.surfaces.filter(
            (s) => !renderedSurfaceIds.has(s.surfaceId),
          );
          if (unrendered.length === 0) return null;
          return unrendered.map((surface) => (
            <div key={surface.surfaceId} className="w-full">
              <SurfaceRouter
                surface={surface}
                onAction={onSurfaceAction}
                onOpenApp={onOpenApp}
                onOpenDocument={onOpenDocument}
                assistantId={assistantId}
                isToolCallComplete={isToolCallComplete}
              />
            </div>
          ));
        })()}
        <SlackMessageAttribution
          message={message}
          assistantDisplayName={assistantDisplayName}
        />
        <div className="h-6 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 has-[:focus-visible]:opacity-100 group-data-[revealed=true]/msg:opacity-100">
          <MessageHoverActions
            content={message.content}
            timestamp={messageTimestamp}
            role={message.role}
            isStreaming={isStreaming}
            openInSlackUrl={slackMessageUrl}
            onFork={forkHandler}
            onInspect={inspectHandler}
          />
        </div>
      </div>
    </div>
  );
}
