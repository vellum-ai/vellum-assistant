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
  type ContentBlockActivityItem,
  groupContentBlocks,
  isSubagentSpawnCall,
  isSuppressedUiTool,
} from "@/domains/chat/transcript/message-content";
import { parseInlineSurfaces } from "@/domains/chat/utils/parse-inline-surfaces";
import { getSlackLinkUrl } from "@/domains/chat/types/types";
import { wireSurfaceToDisplay } from "@/domains/chat/utils/map-runtime-message";
import { isPointerCoarse } from "@/utils/pointer";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ConversationMessageSurface } from "@vellumai/assistant-api";
import {
  isInteractiveClickTarget,
  lookupSubagentEntriesForMessage,
  resolveSpawnedSubagentIds,
  SlackMessageAttribution,
  type TranscriptMessageBodyProps,
} from "@/domains/chat/transcript/transcript-message-body-shared";

/**
 * Renders a `DisplayMessage`'s body by walking its unified `contentBlocks`
 * projection — grouped by `groupContentBlocks`. Each block embeds its own
 * referent, so there are no positional resolvers: text comes straight off the
 * block, thinking text and timing off the block, tool calls off
 * `block.toolCall`, and surfaces off `block.surface` (narrowed to the display
 * `Surface` via `wireSurfaceToDisplay`). Leaf components and visual chrome
 * (single/multi activity cards, surface router, user bubbles, attachments,
 * subagent cards, Slack attribution, hover actions) live in
 * `transcript-message-body-shared`.
 */
export function TranscriptMessageBody({
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
  const isSlackMessage = Boolean(message.slackMessage);
  const isUser = message.role === "user";
  const hasAttachments = Boolean(message.attachments?.length);

  const groups = groupContentBlocks(message.contentBlocks ?? []);

  const textBubbleClass = isSlackMessage
    ? "max-w-[80%] text-[var(--content-default)] sm:max-w-[640px]"
    : "w-full text-[var(--content-default)]";
  const userBubbleClass = `max-w-[80%] rounded-lg bg-[var(--surface-lift)] px-4 py-3 text-[var(--content-default)] flex flex-col gap-2 ${
    isSlackMessage ? "sm:max-w-[420px]" : ""
  }`;
  // `text-chat` (16px/400/24px line-height) mirrors the macOS client's
  // VFont.chat, which renders both user and assistant message bodies.
  const segmentClass = isUser
    ? "break-words text-chat"
    : `break-words text-chat ${textBubbleClass}`;

  const forkMessageId = message.id;
  const forkHandler = forkMessageId && onForkConversation
    ? () => onForkConversation(forkMessageId)
    : undefined;
  const inspectMessageId = message.id;
  const inspectHandler = inspectMessageId && onInspectMessage
    ? () => onInspectMessage(inspectMessageId)
    : undefined;

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

  const linkedSubagentEntries = useSubagentStore(
    (s) => lookupSubagentEntriesForMessage(s.byParent, message),
  );
  const byToolUseId = useSubagentStore.use.byToolUseId();
  const claimedSpawnIds = new Set<string>();

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
              <div key={`inline-text-${si}`} className={segmentClass}>
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

  const renderSurfaceNode = (
    surface: ConversationMessageSurface,
    key: string,
  ): ReactNode => (
    <div key={key} className="w-full">
      <SurfaceRouter
        surface={wireSurfaceToDisplay(surface)}
        onAction={onSurfaceAction}
        onOpenApp={onOpenApp}
        onOpenDocument={onOpenDocument}
        assistantId={assistantId}
        toolCalls={message.toolCalls}
      />
    </div>
  );

  // Render one `activity` group (a contiguous thinking + tool run) into its
  // combined `MultiActivityGroup`, a lone inline link, or a bare thinking
  // `SingleActivity` — mirroring the legacy interleaved branch but reading
  // referents straight off the grouped blocks.
  const renderActivityGroup = (
    items: ContentBlockActivityItem[],
    key: string,
    isLastGroup: boolean,
  ): ReactNode => {
    const cardItems: ToolCallCardItem[] = [];
    const groupToolCalls: ChatMessageToolCall[] = [];
    const thinkingContents: string[] = [];
    for (const item of items) {
      if (item.type === "thinking") {
        if (item.thinking) {
          thinkingContents.push(item.thinking);
          cardItems.push({
            kind: "thinking",
            text: item.thinking,
            startedAt: item.startedAt,
            completedAt: item.completedAt,
          });
        }
      } else {
        const tc = item.toolCall;
        if (isSuppressedUiTool(tc)) {
          continue;
        }
        groupToolCalls.push(tc);
        cardItems.push({ kind: "toolCall", toolCall: tc });
      }
    }
    const renderableToolCalls = groupToolCalls.filter(
      (tc) => !isSubagentSpawnCall(tc),
    );
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
        <Fragment key={key}>
          <SingleActivity variant="tool" toolCall={loneTool} />
          {renderInlineSubagentCards(groupToolCalls)}
        </Fragment>
      );
    }
    if (renderableToolCalls.length > 0) {
      return (
        <Fragment key={key}>
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
    // inline thinking `SingleActivity`, plus any spawn cards. A trailing run
    // reads as still-streaming only while the row is live.
    const combinedThinking = thinkingContents.join("\n");
    const showThinking = combinedThinking || (isStreaming && isLastGroup);
    return (
      <Fragment key={key}>
        {showThinking && (
          <SingleActivity
            variant="thinking"
            content={combinedThinking}
            isStreaming={isStreaming && isLastGroup}
          />
        )}
        {renderInlineSubagentCards(groupToolCalls)}
      </Fragment>
    );
  };

  const renderUserContent = (
    items: Array<{ kind: "text" | "nonText"; node: ReactNode }>,
  ): ReactNode => {
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

  const lastGroupIndex = groups.length - 1;
  const renderGroupNode = (
    group: (typeof groups)[number],
    gi: number,
  ): ReactNode => {
    if (group.type === "text") {
      return renderTextWithInlineSurfaces(group.text, `b-text-${gi}`);
    }
    if (group.type === "surface") {
      return renderSurfaceNode(group.surface, `b-surface-${gi}`);
    }
    return renderActivityGroup(group.items, `b-activity-${gi}`, gi === lastGroupIndex);
  };

  const wrapperClass = `group/msg flex ${isUser ? "justify-end" : "justify-start"}`;
  const columnClass = `flex w-full flex-col gap-2 ${isUser ? "items-end" : "items-start"}`;

  const trailer = (
    <>
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
    </>
  );

  if (isUser) {
    const userItems = groups.map((group, gi) => ({
      kind: group.type === "text" ? ("text" as const) : ("nonText" as const),
      node: renderGroupNode(group, gi),
    }));
    return (
      <div
        ref={wrapperRef}
        onClick={handleBubbleClick}
        data-revealed={revealed}
        className={wrapperClass}
      >
        <div className={columnClass}>
          {renderUserContent(userItems)}
          {trailer}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      onClick={handleBubbleClick}
      data-revealed={revealed}
      className={wrapperClass}
    >
      <div className={columnClass}>
        {groups.map((group, gi) => renderGroupNode(group, gi))}
        {hasAttachments && (
          <MessageAttachments
            attachments={message.attachments ?? []}
            assistantId={assistantId}
          />
        )}
        {trailer}
      </div>
    </div>
  );
}
