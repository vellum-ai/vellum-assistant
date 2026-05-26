
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ExternalLink } from "lucide-react";

import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments.js";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message.js";
import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions.js";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router.js";
import { ToolCallProgressCard } from "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { parseInlineSurfaces } from "@/domains/chat/utils/parse-inline-surfaces.js";
import { getSlackLinkUrl, type Surface } from "@/domains/chat/types/types.js";
import { isPointerCoarse } from "@/utils/pointer.js";
import type { AllowlistOption, ChatMessageToolCall, ConfirmationDecision, DirectoryScopeOption, ScopeOption } from "@/domains/chat/api/event-types.js";

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
 * without updating the legacy path in lockstep — PR 7 wires this component
 * in and will delete the legacy loop.
 */
export interface TranscriptMessageBodyProps {
  message: DisplayMessage;
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
}

function isSurfaceToolCallComplete(message: DisplayMessage): boolean {
  return message.isStreaming !== true;
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

  const url = getSlackLinkUrl(message.slackMessage?.messageLink);
  const className =
    "inline-flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]";
  const content = (
    <>
      <span>{label}</span>
      {url && <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />}
    </>
  );

  if (!url) {
    return (
      <div data-testid="slack-message-attribution" className={className}>
        {content}
      </div>
    );
  }

  return (
    <a
      data-testid="slack-message-attribution"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={`${className} hover:text-[var(--content-default)]`}
    >
      {content}
    </a>
  );
}


export function TranscriptMessageBody({
  message,
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
}: TranscriptMessageBodyProps) {
  const hasInterleavedToolCalls = message.contentOrder?.some(
    (e) => e.type === "toolCall" || e.type === "tool",
  );

  const textBubbleClass =
    message.role === "user"
      ? "max-w-[80%] rounded-lg px-4 py-3 bg-[var(--surface-lift)] text-[var(--content-default)]"
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
  const isToolCallComplete = isSurfaceToolCallComplete(message);

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

    if (slackMessageUrl) {
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
        data-slack-message-link={slackMessageUrl ? "true" : undefined}
        title={slackMessageUrl ? "Open in Slack" : undefined}
        className={`group/msg flex ${slackMessageUrl ? "cursor-pointer" : ""} ${message.role === "user" ? "justify-end" : "justify-start"}`}
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
              return (
                <ToolCallProgressCard
                  key={`tc-${gi}`}
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
                  isStreaming={message.isStreaming ?? false}
                />
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
              isStreaming={message.isStreaming}
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
      data-slack-message-link={slackMessageUrl ? "true" : undefined}
      title={slackMessageUrl ? "Open in Slack" : undefined}
      className={`group/msg flex ${slackMessageUrl ? "cursor-pointer" : ""} ${message.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex w-full flex-col gap-2 ${message.role === "user" ? "items-end" : "items-start"}`}
      >
        {message.toolCalls && message.toolCalls.filter((tc) => !isSuppressedUiTool(tc)).length > 0 && (
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
            isStreaming={message.isStreaming ?? false}
          />
        )}
        {(contentElements.some((el) => !!el) ||
          (!message.toolCalls?.length &&
            !(message.attachments && message.attachments.length > 0))) && (
          <div
            className={`text-[15px] break-words ${textBubbleClass}`}
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
            isStreaming={message.isStreaming}
            onFork={forkHandler}
            onInspect={inspectHandler}
          />
        </div>
      </div>
    </div>
  );
}
