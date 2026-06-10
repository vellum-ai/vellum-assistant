import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { BubbleAttachments } from "@/domains/chat/components/chat-attachments/bubble-attachments";
import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import { SubagentInlineProgressCard } from "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import { MultiActivityGroup } from "@/domains/chat/components/multi-activity-group/multi-activity-group";
import {
  WEB_TOOL_NAMES,
  type ToolCallCardItem,
} from "@/domains/chat/utils/tool-call-card-utils";
import {
  groupMessageActivityRuns,
  isSubagentSpawnCall,
  isSuppressedUiTool,
  resolveThinkingContent,
  resolveThinkingTiming,
  resolveToolCall,
} from "@/domains/chat/transcript/message-content";
import { parseInlineSurfaces } from "@/domains/chat/utils/parse-inline-surfaces";
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";
import { getSlackLinkUrl, type Surface } from "@/domains/chat/types/types";
import { isPointerCoarse } from "@/utils/pointer";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  isInteractiveClickTarget,
  lookupSubagentEntriesForMessage,
  resolveSpawnedSubagentIds,
  SlackMessageAttribution,
  type TranscriptMessageBodyProps,
} from "@/domains/chat/transcript/transcript-message-body-shared";

/**
 * Legacy render tree (flag-OFF). Walks the message's positional
 * `contentOrder` and resolves each entry against the parallel
 * `textSegments`/`thinkingSegments`/`toolCalls`/`surfaces` arrays —
 * `groupMessageActivityRuns` groups the order, `resolveToolCall` /
 * `resolveThinkingContent` / `resolveThinkingTiming` fill content per entry,
 * and surfaces resolve by id-or-index from `message.surfaces`. Leaf components
 * and visual chrome are shared with the blocks-driven tree.
 */
export function TranscriptMessageBodyLegacy({
  message,
  assistantDisplayName,
  onSurfaceAction,
  onForkConversation,
  onInspectMessage,
  onOpenRuleEditor,
  unknownNudgeToolCallIds,
  onDismissUnknownNudge,
  onConfirmationSubmit,
  onAllowAndCreateRule,
  onOpenApp,
  onOpenDocument,
  assistantId,
  onSubagentClick,
  onStopSubagent,
  isStreaming = false,
}: TranscriptMessageBodyProps) {
  const hasInterleavedToolCalls = message.contentOrder?.some(
    (e) => e.type === "toolCall" || e.type === "tool",
  );
  const isSlackMessage = Boolean(message.slackMessage);
  const isUser = message.role === "user";
  const hasAttachments = Boolean(message.attachments?.length);
  // Flat plain-text body derived from the ordered text segments. Used for the
  // copy action and as the render fallback when `contentOrder` carries no text
  // groups (e.g. a tool_use lands before the first assistant_text_delta).
  const messageText = segmentsToPlainText(message.textSegments);

  // `textBubbleClass` applies only to the assistant text path: it carries the
  // text bubble per segment inside `segmentClass`'s assistant branch. User
  // messages get their bubble once at the wrapper via `userBubbleClass`, so the
  // user `segmentClass` carries no bubble background.
  const textBubbleClass = isSlackMessage
    ? "max-w-[80%] text-[var(--content-default)] sm:max-w-[640px]"
    : "w-full text-[var(--content-default)]";

  // User messages render text + attachments inside a single bubble; the bubble
  // background/padding live here at the wrapper rather than per text segment.
  const userBubbleClass = `max-w-[80%] rounded-lg bg-[var(--surface-lift)] px-4 py-3 text-[var(--content-default)] flex flex-col gap-2 ${
    isSlackMessage ? "sm:max-w-[420px]" : ""
  }`;

  // Class applied to each text segment inside `renderTextWithInlineSurfaces`.
  // For users the wrapper provides the bubble, so segments carry no bubble bg.
  const segmentClass = isUser
    ? "break-words text-[15px]"
    : `break-words text-[15px] ${textBubbleClass}`;



  const forkMessageId = message.id;
  const forkHandler = forkMessageId && onForkConversation
    ? () => onForkConversation(forkMessageId)
    : undefined;
  const inspectMessageId = message.id;
  const inspectHandler = inspectMessageId && onInspectMessage
    ? () => onInspectMessage(inspectMessageId)
    : undefined;

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

  // Hard line breaks are enabled for every transcript message regardless of
  // role: single `\n`s in assistant output (not just user Shift+Enter input)
  // should render as `<br>` rather than collapse to a space — see JARVIS-1007.
  const renderTextWithInlineSurfaces = (text: string, key: string) => {
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
                    assistantDisplayName={assistantDisplayName}
                    toolCalls={message.toolCalls}
                  />
                </div>
              );
            }
            return (
              <div
                key={`inline-text-${si}`}
                className={segmentClass}
              >
                <ChatMarkdownMessage content={seg.content} hardLineBreaks />
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div key={key} className={segmentClass}>
        <ChatMarkdownMessage content={text} hardLineBreaks />
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

  // Render the user-message content from an ordered, tagged list. Walks the
  // items in canonical `contentOrder` sequence, grouping CONTIGUOUS runs of
  // text into one `userBubbleClass` bubble while each non-text element (surface
  // / tool-call group) renders OUTSIDE any bubble in its canonical position —
  // preserving `contentOrder` and keeping non-text out of the bubble chrome.
  // Attachments aren't part of `contentOrder`: they append to the last text
  // bubble (so "text then image" is one bubble) or, when there is no text, get
  // their own bubble. Empty text runs are skipped so no empty padded box shows.
  const renderUserContent = (
    items: Array<{ kind: "text" | "nonText"; node: ReactNode }>,
  ): ReactNode => {
    // Plan slots first, then emit JSX once, so trailing attachments can be
    // pushed into the last text bubble's node array before its element is
    // created (React captures children at creation time).
    type Slot =
      | { kind: "bubble"; nodes: ReactNode[] }
      | { kind: "raw"; node: ReactNode };
    const slots: Slot[] = [];
    let textRun: ReactNode[] = [];

    const flushTextRun = () => {
      if (textRun.length > 0) {
        slots.push({ kind: "bubble", nodes: textRun });
        textRun = [];
      }
    };

    for (const item of items) {
      if (item.kind === "text") {
        if (item.node) textRun.push(item.node);
        continue;
      }
      flushTextRun();
      if (item.node) slots.push({ kind: "raw", node: item.node });
    }
    flushTextRun();

    if (hasAttachments && message.attachments) {
      const attachmentsNode = (
        <BubbleAttachments
          key="user-attachments"
          attachments={message.attachments}
          assistantId={assistantId}
        />
      );
      const lastBubble = slots.findLast((slot) => slot.kind === "bubble");
      if (lastBubble) {
        lastBubble.nodes.push(attachmentsNode);
      } else {
        slots.push({ kind: "bubble", nodes: [attachmentsNode] });
      }
    }

    let bubbleIndex = 0;
    return slots.map((slot, i) =>
      slot.kind === "raw" ? (
        <Fragment key={`user-slot-${i}`}>{slot.node}</Fragment>
      ) : (
        <div key={`user-bubble-${bubbleIndex++}`} className={userBubbleClass}>
          {slot.nodes}
        </div>
      ),
    );
  };

  // Render a single contentOrder surface (shared by both interleaved render
  // paths). Surfaces — including task-progress surfaces — always render inline
  // in their natural position (no hoist, no suppression).
  const renderSurfaceNode = (id: string, key: string): ReactNode => {
    const surface = resolveSurface(id);
    if (!surface) {
      return null;
    }
    return (
      <div key={key} className="w-full">
        <SurfaceRouter
          surface={surface}
          onAction={onSurfaceAction}
          onOpenApp={onOpenApp}
          onOpenDocument={onOpenDocument}
          assistantId={assistantId}
          toolCalls={message.toolCalls}
        />
      </div>
    );
  };

  // Resolve a `text` contentOrder id against `textSegments`.
  const resolveTextSegment = (id: string): string | undefined => {
    const textSegments = message.textSegments ?? [];
    const numericIdx = parseInt(id, 10);
    return !isNaN(numericIdx) ? textSegments[numericIdx] : undefined;
  };

  // ---- Merged activity runs ----
  if (hasInterleavedToolCalls && message.contentOrder) {
    // This branch is assistant-only: `hasInterleavedToolCalls` is true only
    // when `contentOrder` carries `toolCall`/`tool` entries, and tool calls
    // only ever come from the assistant — user messages have no tool calls.
    //
    // Contiguous thinking + tool-call entries merge into one combined
    // `MultiActivityGroup` (or a compact inline link for lone thinking / lone
    // simple tools). Task-progress and other surfaces render inline in
    // position.
    const mergedGroups = groupMessageActivityRuns(message);
    const mergedGroupElements: ReactNode[] = mergedGroups.map((group, gi) => {
      const isLastGroup = gi === mergedGroups.length - 1;
      if (group.type === "text") {
        const text = resolveTextSegment(group.id);
        if (!text) return null;
        return renderTextWithInlineSurfaces(text, `m-text-${gi}`);
      }
      if (group.type === "surface") {
        return renderSurfaceNode(group.id, `m-surface-${gi}`);
      }
      // group.type === "activity"
      const cardItems: ToolCallCardItem[] = [];
      const groupToolCalls: ChatMessageToolCall[] = [];
      const thinkingContents: string[] = [];
      for (const item of group.items) {
        if (item.kind === "thinking") {
          const text = resolveThinkingContent(message, item.ids);
          if (text) {
            thinkingContents.push(text);
            const { startedAt, completedAt } = resolveThinkingTiming(
              message,
              item.ids,
            );
            cardItems.push({ kind: "thinking", text, startedAt, completedAt });
          }
        } else {
          const tc = resolveToolCall(message, item.id);
          if (!tc || isSuppressedUiTool(tc)) continue;
          groupToolCalls.push(tc);
          cardItems.push({ kind: "toolCall", toolCall: tc });
        }
      }
      const renderableToolCalls = groupToolCalls.filter(
        (tc) => !isSubagentSpawnCall(tc),
      );
      // Single-tool-inline: a lone run that resolves to exactly ONE simple
      // renderable tool — no thinking, no web rich-rendering, no inline
      // confirmation UI. Render the compact inline chip instead of the boxed
      // card (mirrors the lone thinking `SingleActivity`).
      const loneTool =
        cardItems.length === 1 &&
        cardItems[0]?.kind === "toolCall" &&
        renderableToolCalls.length === 1 &&
        !WEB_TOOL_NAMES.has(renderableToolCalls[0]!.name) &&
        !renderableToolCalls[0]!.pendingConfirmation
          ? renderableToolCalls[0]!
          : null;
      if (loneTool) {
        return (
          <Fragment key={`m-activity-${gi}`}>
            <SingleActivity variant="tool" toolCall={loneTool} />
            {renderInlineSubagentCards(groupToolCalls)}
          </Fragment>
        );
      }
      if (renderableToolCalls.length > 0) {
        return (
          <Fragment key={`m-activity-${gi}`}>
            <div className="w-full">
              <MultiActivityGroup
                toolCalls={groupToolCalls}
                items={cardItems}
                onOpenRuleEditor={onOpenRuleEditor}
                onConfirmationSubmit={onConfirmationSubmit}
                onAllowAndCreateRule={onAllowAndCreateRule}
                unknownNudgeToolCallIds={unknownNudgeToolCallIds}
                onDismissUnknownNudge={onDismissUnknownNudge}
              />
            </div>
            {renderInlineSubagentCards(groupToolCalls)}
          </Fragment>
        );
      }
      // No renderable tool call — render the combined thinking as a minimal
      // inline thinking `SingleActivity` that opens the full reasoning in the
      // side drawer, plus any spawn cards.
      const combinedThinking = thinkingContents.join("\n");
      return (
        <Fragment key={`m-activity-${gi}`}>
          {combinedThinking && (
            <SingleActivity
              variant="thinking"
              content={combinedThinking}
              isStreaming={isStreaming && isLastGroup}
            />
          )}
          {renderInlineSubagentCards(groupToolCalls)}
        </Fragment>
      );
    });

    // Fallback: if derived text exists but no text groups rendered
    // (e.g. tool_use_start before any assistant_text_delta), show the text.
    const interleavedFallback =
      !mergedGroups.some((g) => g.type === "text") && messageText
        ? renderTextWithInlineSurfaces(messageText, "fallback")
        : null;

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
          <>
            {mergedGroupElements}
            {interleavedFallback}
            {hasAttachments && (
              <MessageAttachments
                attachments={message.attachments ?? []}
                assistantId={assistantId}
              />
            )}
          </>
          <SlackMessageAttribution
            message={message}
            assistantDisplayName={assistantDisplayName}
          />
          <div className="h-6 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 has-[:focus-visible]:opacity-100 group-data-[revealed=true]/msg:opacity-100">
            <MessageHoverActions
              message={message}
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
  // calls first, then text content. Each element is tagged "text" or
  // "surface" so the user branch can keep text in the bubble and render
  // surfaces outside it.
  const contentEntries: Array<{
    type: "text" | "surface" | "thinking";
    node: ReactNode;
  }> = [];
  if (message.contentOrder && message.contentOrder.length > 0) {
    const textSegmentsArr = message.textSegments ?? [];
    // Buffer consecutive `thinking` ids so a run of reasoning renders as a
    // single thinking `SingleActivity` (matching the interleaved path and macOS
    // grouping). The buffer is flushed before any non-thinking entry and once
    // more after the loop. A trailing run reads as still-streaming only while
    // the row is actually live; a completed turn that ends in reasoning
    // (history reload, message_complete, cancellation) renders as a finished
    // "Thought process".
    let pendingThinkingIds: string[] = [];
    const flushThinking = (isStreaming: boolean) => {
      if (pendingThinkingIds.length === 0) {
        return;
      }
      const ids = pendingThinkingIds;
      pendingThinkingIds = [];
      const thinkingContent = resolveThinkingContent(message, ids);
      // While streaming, render even before reasoning text lands so the link is
      // the single thinking affordance from the start; once settled an empty
      // run has nothing to show. The thinking `SingleActivity` itself no-ops
      // when `content` is empty and not streaming.
      if (!thinkingContent && !isStreaming) {
        return;
      }
      contentEntries.push({
        type: "thinking",
        node: (
          <div key={`thinking-${ids[0]}`} className="w-full">
            <SingleActivity
              variant="thinking"
              content={thinkingContent}
              isStreaming={isStreaming}
            />
          </div>
        ),
      });
    };
    for (const entry of message.contentOrder) {
      if (entry.type === "thinking") {
        pendingThinkingIds.push(entry.id);
        continue;
      }
      flushThinking(false);
      if (entry.type === "text") {
        const segIndex = parseInt(entry.id, 10);
        const seg = !isNaN(segIndex) ? textSegmentsArr[segIndex] : undefined;
        const segText = seg ?? entry.id;
        contentEntries.push({
          type: "text",
          node: renderTextWithInlineSurfaces(segText, `text-${entry.id}`),
        });
      } else if (entry.type === "surface") {
        const node = renderSurfaceNode(entry.id, `surface-${entry.id}`);
        if (node) {
          contentEntries.push({ type: "surface", node });
        }
      }
    }
    // Trailing reasoning reads as still-streaming only while the row is live.
    flushThinking(isStreaming);
    if (contentEntries.length === 0 && messageText) {
      contentEntries.push({
        type: "text",
        node: renderTextWithInlineSurfaces(messageText, "fallback"),
      });
    }
  } else {
    contentEntries.push({
      type: "text",
      node: messageText
        ? renderTextWithInlineSurfaces(messageText, "content")
        : null,
    });
  }
  // Order-preserving flat list for the assistant branch.
  const contentElements = contentEntries.map((e) => e.node);
  // For the user branch: walk the entries in canonical order, tagging text as
  // bubble content and surfaces as non-text so `renderUserContent` can split
  // the bubble around them while preserving `contentOrder`.
  const legacyUserItems: Array<{
    kind: "text" | "nonText";
    node: ReactNode;
  }> = contentEntries.map((e) => ({
    kind: e.type === "text" ? "text" : "nonText",
    node: e.node,
  }));
  const legacyToolCalls =
    message.toolCalls?.filter((tc) => !isSuppressedUiTool(tc)) ?? [];
  // Render the legacy tool card only when a renderable (non-spawn) tool call
  // exists. A spawn-only legacy turn has no renderable step —
  // `MultiActivityGroup` filters the spawns out and renders nothing — so
  // wrapping it in the flex child would emit a stray empty `gap-2` gap before
  // the inline subagent cards.
  const hasRenderableLegacyToolCall = legacyToolCalls.some(
    (tc) => !isSubagentSpawnCall(tc),
  );
  const hasVisibleLegacyContent = contentElements.some((el) => !!el);

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
        {legacyToolCalls.length > 0 && (
          <>
            {hasRenderableLegacyToolCall && (
              <div className="w-full">
                <MultiActivityGroup
                  toolCalls={legacyToolCalls}
                  onOpenRuleEditor={onOpenRuleEditor}
                  onConfirmationSubmit={onConfirmationSubmit}
                  onAllowAndCreateRule={onAllowAndCreateRule}
                  unknownNudgeToolCallIds={unknownNudgeToolCallIds}
                  onDismissUnknownNudge={onDismissUnknownNudge}
                />
              </div>
            )}
            {renderInlineSubagentCards(legacyToolCalls)}
          </>
        )}
        {isUser ? (
          // User messages render contiguous text runs (plus attachments) inside
          // surface-lift bubbles; surfaces (rare for user messages) render
          // outside any bubble in their canonical position so `contentOrder` is
          // preserved (see `renderUserContent`).
          renderUserContent(legacyUserItems)
        ) : (
          <>
            {(hasVisibleLegacyContent ||
              (!message.toolCalls?.length && !hasAttachments)) && (
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
            {hasAttachments && message.attachments && (
              <MessageAttachments
                attachments={message.attachments}
                assistantId={assistantId}
              />
            )}
          </>
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
                assistantDisplayName={assistantDisplayName}
                toolCalls={message.toolCalls}
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
            message={message}
            openInSlackUrl={slackMessageUrl}
            onFork={forkHandler}
            onInspect={inspectHandler}
          />
        </div>
      </div>
    </div>
  );
}
