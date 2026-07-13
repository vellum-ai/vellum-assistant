import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { BubbleAttachments } from "@/domains/chat/components/chat-attachments/bubble-attachments";
import { resolveAttachmentFilename } from "@vellumai/service-contracts/attachment-naming";

import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments";
import { ToolResultImages } from "@/domains/chat/components/chat-attachments/tool-result-images";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { toast } from "@vellumai/design-library";
import { MessageHoverActions } from "@/domains/chat/components/message-hover-actions/message-hover-actions";
import { MessageLongPressActions } from "@/domains/chat/components/message-hover-actions/message-long-press-actions";
import { SubagentSpawnGroup } from "@/domains/chat/components/subagent-inline-progress-card/subagent-spawn-group";
import { InlineProcessCardRow } from "@/domains/chat/process-registry/inline-process-card-row";
import { WORKFLOW_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/workflow";
import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";
import { BACKGROUND_TASK_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/background-task";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import { MultiActivityGroup } from "@/domains/chat/components/multi-activity-group/multi-activity-group";
import { WEB_TOOL_NAMES } from "@/domains/chat/utils/tool-call-card-utils";
import {
  activityItemsToCardData,
  type ContentBlockActivityItem,
  groupContentBlocks,
  isSubagentSpawnCall,
} from "@/domains/chat/transcript/message-content";
import { parseInlineSurfaces } from "@/domains/chat/utils/parse-inline-surfaces";
import { useSmoothStreamText } from "@/domains/chat/hooks/use-smooth-stream-text";
import { useSupportsRedactedCredentialChips } from "@/lib/backwards-compat/use-supports-redacted-credential-chips";
import { stopAcpRun } from "@/domains/chat/utils/acp-run-actions";
import { stopBackgroundTask } from "@/domains/chat/utils/background-task-actions";
import { captureError } from "@/lib/sentry/capture-error";
import { getExternalLinkUrl } from "@/domains/chat/types/types";
import { wireSurfaceToDisplay } from "@/domains/chat/utils/map-runtime-message";
import { isPointerCoarse } from "@/utils/pointer";
import { useLongPress } from "@/hooks/use-long-press";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ConversationMessageSurface } from "@vellumai/assistant-api";
import {
  computeCardBackedWorkflowRunIds,
  extractBgIdFromResult,
  isInteractiveClickTarget,
  lookupSubagentEntriesForMessage,
  acpRunIdForCall,
  resolveAcpRunIds,
  resolveBackgroundTaskIds,
  resolveSpawnedSubagentIds,
  resolveWorkflowRunIds,
  SlackMessageAttribution,
  SlackReactionLine,
  type TranscriptMessageBodyProps,
  workflowRunIdForCall,
} from "@/domains/chat/transcript/transcript-message-body-shared";
import { workspaceFileContentGet } from "@/generated/daemon/sdk.gen";
import { saveFile } from "@/runtime/native-file";

/**
 * Word-fade cutoff for the streaming trailing text group. The fade wraps
 * every word in a span, and each ~30fps reveal commit re-reconciles the whole
 * group, so cost grows with group length: benchmarked (happy-dom, M-series)
 * at ~1.6ms/commit for a 2k-char group and ~4.8ms at 8k — comfortably inside
 * the 33ms commit budget — but ~14ms avg / 27ms p95 at 24k. Past this cutoff
 * the group streams without the per-word fade (reveal smoothing still
 * applies), trading polish for headroom on outlier-length messages.
 */
const STREAM_WORD_FADE_MAX_CHARS = 12000;

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
  conversationId,
  assistantDisplayName,
  onSurfaceAction,
  onForkConversation,
  onSummarizeUpToHere,
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
  onWorkflowClick,
  onStopWorkflow,
  isStreaming = false,
  isLatestMessage = false,
}: TranscriptMessageBodyProps) {
  const isSlackMessage = Boolean(message.slackMessage);
  const isSlackReaction = message.slackMessage?.eventKind === "reaction";
  const isUser = message.role === "user";
  const hasAttachments = Boolean(message.attachments?.length);
  // Gated on the transcript owner: an older daemon neutralizes nothing, so
  // sentinel-shaped text in its transcripts must never chip-ify, and only the
  // active assistant's version is known (see the gate module).
  const supportsRedactedCredentialChips =
    useSupportsRedactedCredentialChips(assistantId);

  // User-typed thinking tags must render verbatim; only assistant text splits.
  const groups = groupContentBlocks(message.contentBlocks ?? [], {
    splitInlineThinking: !isUser,
  });

  // Only the trailing text group of a streaming assistant message is still
  // growing, so only it gets the typewriter re-pacing; earlier groups (and
  // everything once the turn settles) render their text directly.
  const trailingGroup = groups[groups.length - 1];
  const smoothedTrailingText = useSmoothStreamText(
    isStreaming && !isUser && trailingGroup?.type === "text"
      ? trailingGroup.text
      : null,
  );

  const isTouch = isPointerCoarse();

  const textBubbleClass = isSlackMessage
    ? "max-w-[80%] text-[var(--content-default)] sm:max-w-[640px]"
    : "w-full text-[var(--content-default)]";
  // On touch devices, the long-press gesture opens the message actions sheet.
  // iOS's native text selection (blue highlight + callout bar) otherwise races
  // the 500ms long-press timer, so both surface at once. Suppress native
  // selection/callout on user bubbles for coarse pointers only; desktop keeps
  // text selectable. Assistant text stays selectable everywhere (quote-reply).
  const userBubbleClass = `max-w-[80%] rounded-lg bg-[var(--user-bubble-bg,var(--surface-lift))] px-4 py-3 text-[var(--user-bubble-text,var(--content-default))] flex flex-col gap-2 ${
    isTouch ? "select-none [-webkit-touch-callout:none]" : ""
  } ${isSlackMessage ? "sm:max-w-[420px]" : ""}`;
  const segmentClass = isUser
    ? "break-words text-[15px]"
    : `break-words text-[15px] ${textBubbleClass}`;

  const forkMessageId = message.id;
  const forkHandler =
    forkMessageId && onForkConversation
      ? () => onForkConversation(forkMessageId)
      : undefined;
  const summarizeMessageId = message.id;
  const summarizeHandler =
    summarizeMessageId && onSummarizeUpToHere
      ? () => onSummarizeUpToHere(summarizeMessageId)
      : undefined;
  const inspectMessageId = message.id;
  const inspectHandler =
    inspectMessageId && onInspectMessage
      ? () => onInspectMessage(inspectMessageId)
      : undefined;

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  const slackMessageUrl = getExternalLinkUrl(message.slackMessage?.messageLink);

  const [longPressOpen, setLongPressOpen] = useState(false);
  const longPressFiredRef = useRef(false);

  // Assistant messages own the long-press for quote-reply text selection
  // (see resolve-assistant-selection.ts / useNativeQuoteReply). Suppressing the
  // action sheet there — rather than racing it at the long-press threshold —
  // keeps the two from competing: a long-press on assistant text selects it for
  // Reply, and the sheet never opens. The sheet still arms on user/tool
  // messages, which have no selection affordance.
  const isAssistant = message.role === "assistant";
  const longPressHandlers = useLongPress(
    () => {
      // Set the suppression flag so the compatibility click the browser emits
      // on the following touchend (see handleBubbleClick) is swallowed rather
      // than toggling the inline trailer / opening a Slack URL behind the sheet.
      // The flag is cleared by that click, or — if the click is swallowed by
      // native long-press handling or routed to the portaled sheet — when the
      // sheet closes (handleLongPressOpenChange). It is deliberately NOT expired
      // on a timer: a timer set from activation could fire before the compat
      // click on a long hold, letting that click through as a real tap.
      longPressFiredRef.current = true;
      setLongPressOpen(true);
    },
    undefined,
    { shouldSkip: () => isAssistant },
  );

  const handleLongPressOpenChange = useCallback((open: boolean) => {
    setLongPressOpen(open);
    // Once the sheet closes, the long-press interaction is over; clear the
    // suppression flag so the next genuine tap on the message is honored even
    // if the post-long-press compatibility click never reached this wrapper.
    if (!open) {
      longPressFiredRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!revealed) {
      return;
    }
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        wrapperRef.current &&
        !wrapperRef.current.contains(target)
      ) {
        setRevealed(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [revealed]);

  const handleBubbleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Suppress the click that follows a long-press activation so the
      // inline trailer doesn't toggle open behind the BottomSheet.
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false;
        return;
      }
      const target = e.target as Element | null;
      if (isInteractiveClickTarget(target)) {
        return;
      }

      if (slackMessageUrl && isPointerCoarse()) {
        if (window.getSelection()?.toString()) {
          return;
        }
        window.open(slackMessageUrl, "_blank", "noopener,noreferrer");
        return;
      }

      if (!isPointerCoarse()) {
        return;
      }
      setRevealed((v) => !v);
    },
    [slackMessageUrl],
  );

  const linkedSubagentEntries = useSubagentStore((s) =>
    lookupSubagentEntriesForMessage(s.byParent, message),
  );
  const byToolUseId = useSubagentStore.use.byToolUseId();
  const byToolUseIdWf = useWorkflowStore.use.byToolUseId();
  // The runIds in THIS message whose `run_workflow` chip is suppressed in favor
  // of an inline card ("card-backed"). Subscribed via a narrowed selector that
  // returns a stable key, so the message re-renders only when a card's
  // backed-state flips — an entry appears, or hydration definitively fails —
  // never on every leaf event, honoring the store's reference-stability
  // discipline. A failed call (no runId), a retention-pruned run (404), or a
  // transient hydration failure is NOT card-backed: its tool result keeps
  // rendering instead of vanishing behind a card with no entry to show.
  const cardBackedKey = useWorkflowStore(
    useCallback(
      (s) =>
        [...computeCardBackedWorkflowRunIds(message.toolCalls ?? [], s)].join(
          "|",
        ),
      [message.toolCalls],
    ),
  );
  const cardBackedWorkflowRunIds = useMemo(
    () => new Set(cardBackedKey ? cardBackedKey.split("|") : []),
    [cardBackedKey],
  );
  const byToolUseIdAcp = useAcpRunStore.use.byToolUseId();
  // The acpSessionIds in THIS message whose `acp_spawn` chip is suppressed in
  // favor of an inline card ("card-backed"). Subscribed via a narrowed selector
  // returning a stable key so the message re-renders only when a card's backing
  // flips (an entry appears) — never on every leaf event. A failed call (no id)
  // or a run with no store entry is NOT card-backed: its tool result keeps
  // rendering instead of vanishing behind a card with nothing to show.
  const cardBackedAcpKey = useAcpRunStore(
    useCallback(
      (s) => {
        const ids: string[] = [];
        for (const tc of message.toolCalls ?? []) {
          const id = acpRunIdForCall(tc, s.byToolUseId);
          if (id !== null && s.byId[id] !== undefined) {
            ids.push(id);
          }
        }
        return ids.join("|");
      },
      [message.toolCalls],
    ),
  );
  const cardBackedAcpRunIds = useMemo(
    () => new Set(cardBackedAcpKey ? cardBackedAcpKey.split("|") : []),
    [cardBackedAcpKey],
  );
  // The background-task ids in THIS message whose `bash`/`host_bash` chip is
  // suppressed in favor of an inline card ("card-backed"). Mirrors the ACP gate:
  // a bg id is card-backed only when an entry exists in the store, so a
  // backgrounded call whose start event hasn't landed (or whose store wiring
  // isn't present yet) keeps rendering its tool result instead of vanishing
  // behind a card with nothing to show.
  const cardBackedBgKey = useBackgroundTaskStore(
    useCallback(
      (s) => {
        const ids: string[] = [];
        for (const tc of message.toolCalls ?? []) {
          const id = extractBgIdFromResult(tc);
          if (id !== undefined && s.byId[id] !== undefined) {
            ids.push(id);
          }
        }
        return ids.join("|");
      },
      [message.toolCalls],
    ),
  );
  const cardBackedBackgroundTaskIds = useMemo(
    () => new Set(cardBackedBgKey ? cardBackedBgKey.split("|") : []),
    [cardBackedBgKey],
  );

  const claimedSpawnIds = new Set<string>();
  const claimedWorkflowIds = new Set<string>();
  const claimedAcpIds = new Set<string>();
  const claimedBackgroundTaskIds = new Set<string>();
  const cardBackedWorkflowRunId = (tc: ChatMessageToolCall): string | null => {
    const rid = workflowRunIdForCall(tc, byToolUseIdWf);
    return rid !== null && cardBackedWorkflowRunIds.has(rid) ? rid : null;
  };
  const cardBackedAcpRunId = (tc: ChatMessageToolCall): string | null => {
    const id = acpRunIdForCall(tc, byToolUseIdAcp);
    return id !== null && cardBackedAcpRunIds.has(id) ? id : null;
  };
  const cardBackedBackgroundTaskId = (
    tc: ChatMessageToolCall,
  ): string | null => {
    const id = extractBgIdFromResult(tc);
    return id !== undefined && cardBackedBackgroundTaskIds.has(id) ? id : null;
  };
  const handleAcpRunClick = useCallback((acpSessionId: string) => {
    useViewerStore.getState().openAcpRunDetail(acpSessionId);
  }, []);
  const handleBackgroundTaskClick = useCallback((id: string) => {
    useViewerStore.getState().openBackgroundTaskDetail(id);
  }, []);

  const handleVellumLinkClick = useCallback(
    (href: string, linkText: string) => {
      const rawBasename = href.split("/").pop() ?? "";
      // The daemon percent-decodes vellum:// paths before storing attachment
      // filenames, so match on the decoded basename. Keep the raw form as a
      // defensive fallback for malformed encodings.
      let pathBasename = rawBasename;
      try {
        pathBasename = decodeURIComponent(rawBasename);
      } catch {
        // Malformed percent-encoding: fall back to the raw basename.
      }
      // Mirror the daemon's stored-filename rule (shared contract): a link
      // label is only the stored name when it carries a recognized
      // extension, otherwise the attachment lives under the path basename.
      // Search the expected name first so an unrelated attachment that
      // happens to share the label's text cannot shadow the linked file.
      // The label/basename/raw fallbacks keep older messages working when
      // their stored filenames do not follow the shared naming rule.
      const expectedFilename = resolveAttachmentFilename(
        linkText || undefined,
        pathBasename,
        "label",
      );
      const att =
        message.attachments?.find((a) => a.filename === expectedFilename) ??
        message.attachments?.find((a) => a.filename === linkText) ??
        message.attachments?.find((a) => a.filename === pathBasename) ??
        message.attachments?.find((a) => a.filename === rawBasename);
      if (att) {
        void downloadAttachment(att, assistantId);
      } else if (href.startsWith("vellum://workspace/")) {
        // Fallback for files not registered as message attachments — e.g.
        // files linked only inside component/surface HTML. The daemon's
        // cleanAssistantContent only extracts vellum:// links from assistant
        // TEXT blocks, not from dynamic_page surface HTML, so a file cited
        // only in a component never becomes an attachment. Fetch it by path
        // from the workspace file content endpoint instead — the same route
        // the workspace browser uses. Inlined here to avoid a cross-domain
        // import (chat -> workspace).
        const WORKSPACE_PREFIX = "vellum://workspace/";
        let filePath = href.slice(WORKSPACE_PREFIX.length);
        try {
          filePath = decodeURIComponent(filePath);
        } catch {
          // Malformed percent-encoding — use the raw path.
        }
        const filename = resolveAttachmentFilename(
          linkText || undefined,
          pathBasename,
          "label",
        );
        void (async () => {
          try {
            const { data, error } = await workspaceFileContentGet({
              path: { assistant_id: assistantId ?? "" },
              query: { path: filePath },
              parseAs: "blob",
              throwOnError: false,
            });
            if (error || !(data instanceof Blob)) {
              throw new Error("workspace file content fetch failed");
            }
            await saveFile(data, filename);
          } catch {
            toast.error("Failed to download file", { description: filename });
          }
        })();
      } else {
        const isHost = href.startsWith("vellum://host/");
        toast.error(
          `File not available for download${isHost ? " (host file approval may have timed out)" : ""}`,
          { description: linkText || pathBasename },
        );
      }
    },
    [message.attachments, assistantId],
  );

  const renderTextWithInlineSurfaces = (
    text: string,
    key: string,
    streamWordFade?: "revealing" | "caughtUp",
  ) => {
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
                    onVellumLinkClick={handleVellumLinkClick}
                  />
                </div>
              );
            }
            return (
              <div
                key={`inline-text-${si}`}
                data-message-text=""
                className={segmentClass}
              >
                <ChatMarkdownMessage
                  content={seg.content}
                  hardLineBreaks
                  onVellumLinkClick={handleVellumLinkClick}
                  attachments={message.attachments}
                  assistantId={assistantId}
                  streamWordFade={streamWordFade}
                  redactedCredentialChips={!isUser && supportsRedactedCredentialChips}
                />
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div key={key} data-message-text="" className={segmentClass}>
        <ChatMarkdownMessage
          content={text}
          hardLineBreaks
          onVellumLinkClick={handleVellumLinkClick}
          attachments={message.attachments}
          assistantId={assistantId}
          streamWordFade={streamWordFade}
          redactedCredentialChips={!isUser && supportsRedactedCredentialChips}
        />
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
    if (spawnedIds.length === 0) {
      return null;
    }
    return (
      <SubagentSpawnGroup
        subagentIds={spawnedIds}
        onSubagentClick={onSubagentClick}
        onStopSubagent={onStopSubagent}
      />
    );
  };

  const renderInlineWorkflowCards = (toolCalls: ChatMessageToolCall[]) => {
    const runIds = resolveWorkflowRunIds(
      toolCalls,
      byToolUseIdWf,
      claimedWorkflowIds,
    );
    if (runIds.length === 0) {
      return null;
    }
    return (
      <div className="flex w-full flex-col gap-1.5">
        {runIds.map((runId) => (
          <InlineProcessCardRow
            key={runId}
            descriptor={WORKFLOW_DESCRIPTOR}
            id={runId}
            onOpen={onWorkflowClick ? () => onWorkflowClick(runId) : undefined}
            onStop={onStopWorkflow ? () => onStopWorkflow(runId) : undefined}
            stopAriaLabel="Stop workflow"
            testId="inline-process-card"
          />
        ))}
      </div>
    );
  };

  const renderInlineAcpRunCards = (toolCalls: ChatMessageToolCall[]) => {
    const acpSessionIds = resolveAcpRunIds(
      toolCalls,
      byToolUseIdAcp,
      claimedAcpIds,
    );
    if (acpSessionIds.length === 0) {
      return null;
    }
    return (
      <div className="flex w-full flex-col gap-1.5">
        {acpSessionIds.map((acpSessionId) => (
          <InlineProcessCardRow
            key={acpSessionId}
            descriptor={ACP_RUN_DESCRIPTOR}
            id={acpSessionId}
            onOpen={() => handleAcpRunClick(acpSessionId)}
            onStop={() =>
              void stopAcpRun(acpSessionId).catch((err) => {
                captureError(err, {
                  context: "TranscriptMessageBody.stopAcpRun",
                });
              })
            }
            stopAriaLabel="Stop run"
            testId="inline-process-card"
          />
        ))}
      </div>
    );
  };

  const renderInlineBackgroundTaskCards = (
    toolCalls: ChatMessageToolCall[],
  ) => {
    const taskIds = resolveBackgroundTaskIds(
      toolCalls,
      claimedBackgroundTaskIds,
    );
    if (taskIds.length === 0) {
      return null;
    }
    return (
      <div className="flex w-full flex-col gap-1.5">
        {taskIds.map((id) => (
          <InlineProcessCardRow
            key={id}
            descriptor={BACKGROUND_TASK_DESCRIPTOR}
            id={id}
            onOpen={() => handleBackgroundTaskClick(id)}
            onStop={() =>
              void stopBackgroundTask(id).catch((err) => {
                captureError(err, {
                  context: "TranscriptMessageBody.stopBackgroundTask",
                });
              })
            }
            stopAriaLabel="Stop command"
            testId="inline-process-card"
          />
        ))}
      </div>
    );
  };

  const renderToolResultImages = (toolCalls: ChatMessageToolCall[]) => (
    <ToolResultImages
      toolCalls={toolCalls}
      hasAttachments={hasAttachments}
      assistantId={assistantId}
    />
  );

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
        onVellumLinkClick={handleVellumLinkClick}
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
    groupIndex: number,
  ): ReactNode => {
    const { cardItems, toolCalls: groupToolCalls } =
      activityItemsToCardData(items);
    const thinkingContents = cardItems.flatMap((it) =>
      it.kind === "thinking" ? [it.text] : [],
    );
    const renderableToolCalls = groupToolCalls.filter(
      // Suppress the raw chip only for a card-backed run_workflow / acp_spawn /
      // background bash call (see cardBackedWorkflowRunId / cardBackedAcpRunId /
      // cardBackedBackgroundTaskId). A failed call (no id) or a run with no
      // store entry is not card-backed, so it renders its tool result instead
      // of vanishing.
      (tc) =>
        !isSubagentSpawnCall(tc) &&
        cardBackedWorkflowRunId(tc) === null &&
        cardBackedAcpRunId(tc) === null &&
        cardBackedBackgroundTaskId(tc) === null,
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
          {renderToolResultImages(groupToolCalls)}
          {renderInlineSubagentCards(groupToolCalls)}
          {renderInlineWorkflowCards(groupToolCalls)}
          {renderInlineAcpRunCards(groupToolCalls)}
          {renderInlineBackgroundTaskCards(groupToolCalls)}
        </Fragment>
      );
    }
    if (renderableToolCalls.length > 0) {
      // A card-backed run_workflow / acp_spawn call is shown by its dedicated
      // inline card, so drop it from the steps MultiActivityGroup renders too
      // (the group filters subagent_spawn internally but not the others). A
      // failed or pruned call is not card-backed and is kept, so its tool result
      // still renders as a step; subagent spawns are left for the group to filter.
      const suppressedCardIds = new Set(
        groupToolCalls
          .filter(
            (tc) =>
              cardBackedWorkflowRunId(tc) !== null ||
              cardBackedAcpRunId(tc) !== null ||
              cardBackedBackgroundTaskId(tc) !== null,
          )
          .map((tc) => tc.id),
      );
      const groupCardToolCalls =
        suppressedCardIds.size === 0
          ? groupToolCalls
          : groupToolCalls.filter((tc) => !suppressedCardIds.has(tc.id));
      const groupCardItems =
        suppressedCardIds.size === 0
          ? cardItems
          : cardItems.filter(
              (it) =>
                it.kind !== "toolCall" ||
                !suppressedCardIds.has(it.toolCall.id),
            );
      return (
        <Fragment key={key}>
          <div className="w-full">
            <MultiActivityGroup
              toolCalls={groupCardToolCalls}
              items={groupCardItems}
              messageId={message.id}
              groupIndex={groupIndex}
              onOpenRuleEditor={onOpenRuleEditor}
              onConfirmationSubmit={onConfirmationSubmit}
              onAllowAndCreateRule={onAllowAndCreateRule}
              unknownNudgeToolCallIds={unknownNudgeToolCallIds}
              onDismissUnknownNudge={onDismissUnknownNudge}
            />
          </div>
          {renderToolResultImages(groupToolCalls)}
          {renderInlineSubagentCards(groupToolCalls)}
          {renderInlineWorkflowCards(groupToolCalls)}
          {renderInlineAcpRunCards(groupToolCalls)}
          {renderInlineBackgroundTaskCards(groupToolCalls)}
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
            messageId={message.id}
            groupIndex={groupIndex}
          />
        )}
        {renderToolResultImages(groupToolCalls)}
        {renderInlineSubagentCards(groupToolCalls)}
        {renderInlineWorkflowCards(groupToolCalls)}
        {renderInlineAcpRunCards(groupToolCalls)}
        {renderInlineBackgroundTaskCards(groupToolCalls)}
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
        if (item.node) {
          textRun.push(item.node);
        }
        continue;
      }
      flushTextRun();
      if (item.node) {
        slots.push({ kind: "raw", node: item.node });
      }
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
      const isSmoothedTrailing =
        gi === lastGroupIndex && smoothedTrailingText !== null;
      // `useSmoothStreamText` returns the target string itself (identity,
      // not a copy) once the reveal has drained the backlog — that identity
      // check is what flips the sweep from "revealing" to "caughtUp".
      const fadeMode =
        isSmoothedTrailing && group.text.length <= STREAM_WORD_FADE_MAX_CHARS
          ? smoothedTrailingText === group.text
            ? ("caughtUp" as const)
            : ("revealing" as const)
          : undefined;
      return renderTextWithInlineSurfaces(
        isSmoothedTrailing ? smoothedTrailingText : group.text,
        `b-text-${gi}`,
        fadeMode,
      );
    }
    if (group.type === "surface") {
      return renderSurfaceNode(group.surface, `b-surface-${gi}`);
    }
    return renderActivityGroup(
      group.items,
      `b-activity-${gi}`,
      gi === lastGroupIndex,
      gi,
    );
  };

  const wrapperClass = `group/msg flex ${isUser ? "justify-end" : "justify-start"}`;
  // `min-w-0` lets the column shrink below its content's intrinsic width in the
  // flex row, so long unbreakable content (e.g. an ACP run card's command path)
  // truncates inside the card instead of overflowing the message column.
  const columnClass = `flex w-full min-w-0 flex-col gap-2 ${isUser ? "items-end" : "items-start"}`;

  // See `TranscriptMessageBodyProps.isLatestMessage` for why only the latest
  // message collapses this row instead of reserving its height. `-mt-2`
  // cancels the column's `gap-2` slot while collapsed — a zero-height flex
  // item still incurs the parent gap — and animates back to `mt-0` on reveal.
  const trailerHeightClass = isLatestMessage
    ? "h-0 -mt-2 overflow-hidden group-hover/msg:h-8 group-hover/msg:mt-0 has-[:focus-visible]:h-8 has-[:focus-visible]:mt-0 group-data-[revealed=true]/msg:h-8 group-data-[revealed=true]/msg:mt-0"
    : "h-6 overflow-hidden";

  const trailer = (
    <>
      <SlackMessageAttribution
        message={message}
        assistantDisplayName={assistantDisplayName}
      />
      <div
        className={`${trailerHeightClass} opacity-0 transition-[height,margin,opacity] duration-200 ease-out group-hover/msg:opacity-100 has-[:focus-visible]:opacity-100 group-data-[revealed=true]/msg:opacity-100 motion-reduce:transition-none`}
      >
        <MessageHoverActions
          message={message}
          conversationId={conversationId}
          openInSlackUrl={slackMessageUrl}
          onFork={forkHandler}
          onSummarizeUpToHere={summarizeHandler}
          onInspect={inspectHandler}
        />
      </div>
    </>
  );

  if (isSlackReaction) {
    return (
      <div className="flex justify-start">
        <SlackReactionLine message={message} />
      </div>
    );
  }

  if (isUser) {
    const userItems = groups.map((group, gi) => ({
      kind: group.type === "text" ? ("text" as const) : ("nonText" as const),
      node: renderGroupNode(group, gi),
    }));
    return (
      <div
        ref={wrapperRef}
        data-message-id={message.id || undefined}
        data-message-role={message.role}
        onClick={handleBubbleClick}
        onTouchStart={longPressHandlers.onTouchStart}
        onTouchMove={longPressHandlers.onTouchMove}
        onTouchEnd={longPressHandlers.onTouchEnd}
        onTouchCancel={longPressHandlers.onTouchCancel}
        data-revealed={revealed}
        className={wrapperClass}
      >
        <div className={columnClass}>
          {renderUserContent(userItems)}
          {trailer}
        </div>
        {isTouch && (
          <div onClick={(e) => e.stopPropagation()}>
            <MessageLongPressActions
              message={message}
              conversationId={conversationId}
              openInSlackUrl={slackMessageUrl}
              onFork={forkHandler}
              onSummarizeUpToHere={summarizeHandler}
              onInspect={inspectHandler}
              open={longPressOpen}
              onOpenChange={handleLongPressOpenChange}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      id={message.id ? `msg-${message.id}` : undefined}
      data-message-id={message.id || undefined}
      data-message-role={message.role}
      onClick={handleBubbleClick}
      onTouchStart={longPressHandlers.onTouchStart}
      onTouchMove={longPressHandlers.onTouchMove}
      onTouchEnd={longPressHandlers.onTouchEnd}
      onTouchCancel={longPressHandlers.onTouchCancel}
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
      {isTouch && !isAssistant && (
        <div onClick={(e) => e.stopPropagation()}>
          <MessageLongPressActions
            message={message}
            conversationId={conversationId}
            openInSlackUrl={slackMessageUrl}
            onFork={forkHandler}
            onSummarizeUpToHere={summarizeHandler}
            onInspect={inspectHandler}
            open={longPressOpen}
            onOpenChange={handleLongPressOpenChange}
          />
        </div>
      )}
    </div>
  );
}
