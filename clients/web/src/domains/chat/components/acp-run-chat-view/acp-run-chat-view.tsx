/**
 * Devin-style chat view for an ACP run. Assembles the projected chat blocks
 * into a streaming conversation, with the usage meter in the header, a nested
 * file diff opened from tool-card file chips, and a steer composer that posts
 * follow-up instructions while the run is live.
 *
 * Self-contained for reversibility: it copies the detail panel's header /
 * objective / steer markup + tokens rather than importing them, and owns the
 * nested-diff selection in LOCAL state (not the viewer store).
 */

import {
  ArrowDown,
  ArrowLeft,
  ChevronRight,
  Send,
  Square,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { Button, Typography } from "@vellumai/design-library";

import {
  useAcpRunChatBlocks,
  type AcpChatBlock,
} from "@/domains/chat/acp-run-message-projection";
import {
  getAcpFileChanges,
  getAcpToolCommand,
  parseAcpToolContent,
} from "@/domains/chat/acp-tool-content";
import {
  STEER_MARKER_PREFIX,
  useAcpRunStore,
  type AcpRunEntry,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";
import { AcpChatAgentMessage } from "@/domains/chat/components/acp-run-chat-view/acp-chat-agent-message";
import { AcpChatPlanBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-plan-block";
import { AcpChatTerminalBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-terminal-block";
import { AcpChatTimelineBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-timeline-block";
import { AcpChatThinkingBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-thinking-block";
import {
  AcpChatToolCard,
  type AcpFileChange,
} from "@/domains/chat/components/acp-run-chat-view/acp-chat-tool-card";
import { AcpChatUserTurn } from "@/domains/chat/components/acp-run-chat-view/acp-chat-user-turn";
import { AcpUsageMeter } from "@/domains/chat/components/acp-run-chat-view/acp-usage-meter";
import { CommandOutputView } from "@/domains/chat/components/acp-run-chat-view/command-output-view";
import { FileDiffView } from "@/domains/chat/components/acp-run-chat-view/file-diff-view";
import { useStickToBottom } from "@/domains/chat/components/acp-run-chat-view/use-stick-to-bottom";
import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { StatusBadgePill } from "@/domains/chat/components/status-badge-pill";
import { steerAcpRun, stopAcpRun } from "@/domains/chat/utils/acp-run-actions";
import { acpRunStatusBadge, isActiveAcpStatus } from "@/utils/acp-run-status";
import { captureError } from "@/lib/sentry/capture-error";

/** Stable per-block key so React reconciles blocks across streamed re-renders. */
function blockKey(block: AcpChatBlock, index: number): string {
  switch (block.kind) {
    case "user":
      return `user-${block.id || index}`;
    case "agent":
      return `agent-${block.messageId || index}`;
    case "thinking":
      return `thinking-${block.messageId || index}`;
    case "tool":
      return `tool-${block.toolCallId}`;
    case "plan":
      return "plan";
  }
}

const EMPTY_EVENTS: AcpRunRawEvent[] = [];

/** The nested detail panel open over the transcript, if any. */
type ActiveDetail =
  | { kind: "diff"; toolCallId: string; path: string }
  | { kind: "output"; toolCallId: string };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AcpRunChatViewProps {
  entry: AcpRunEntry;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AcpRunChatView({ entry, onClose }: AcpRunChatViewProps) {
  const isRunning = isActiveAcpStatus(entry.status);

  const events = useAcpRunStore(
    (s) => s.byId[entry.acpSessionId]?.events ?? EMPTY_EVENTS,
  );
  const blocks = useAcpRunChatBlocks(events);

  // Nested detail (file diff or console output) in LOCAL state, never the viewer
  // store. We keep only the IDENTITY (which tool + which file) and re-derive the
  // body from live blocks, so it tracks streaming `tool_call_update` content.
  const [activeDetail, setActiveDetail] = useState<ActiveDetail | null>(null);

  // Reset the nested detail on run switch — render-phase guard tracking the prev
  // id. Run-specific subcomponent state (header `stopping`, composer
  // `input`/`pending`) is reset by keying them on `entry.acpSessionId` below.
  const [prevSessionId, setPrevSessionId] = useState(entry.acpSessionId);
  if (prevSessionId !== entry.acpSessionId) {
    setPrevSessionId(entry.acpSessionId);
    setActiveDetail(null);
  }

  const handleOpenDiff = useCallback(
    (toolCallId: string, fileChange: AcpFileChange) =>
      setActiveDetail({ kind: "diff", toolCallId, path: fileChange.path }),
    [],
  );
  const handleOpenOutput = useCallback(
    (toolCallId: string) => setActiveDetail({ kind: "output", toolCallId }),
    [],
  );
  const handleCloseDetail = useCallback(() => setActiveDetail(null), []);

  // The open detail's live tool block, re-found from current blocks so the panel
  // tracks streaming `tool_call_update` content.
  const activeToolBlock = useMemo(() => {
    if (!activeDetail) return null;
    return (
      blocks.find(
        (b): b is Extract<AcpChatBlock, { kind: "tool" }> =>
          b.kind === "tool" && b.toolCallId === activeDetail.toolCallId,
      ) ?? null
    );
  }, [activeDetail, blocks]);

  // Live diff for an open diff detail. `null` once its block is gone or the path
  // no longer resolves (the header then falls back so the view stays open).
  const activeDiff = useMemo<AcpFileChange | null>(() => {
    if (activeDetail?.kind !== "diff" || !activeToolBlock) return null;
    const changes = getAcpFileChanges(
      parseAcpToolContent(activeToolBlock.content),
      activeToolBlock.locations,
    );
    return changes.find((c) => c.path === activeDetail.path) ?? null;
  }, [activeDetail, activeToolBlock]);

  // Breadcrumb label for the open detail: the file path, or the command/title.
  const detailCrumb =
    activeDetail?.kind === "diff"
      ? activeDetail.path
      : activeToolBlock
        ? (getAcpToolCommand(activeToolBlock.rawInput) ??
          activeToolBlock.title ??
          "Output")
        : "Output";

  // The hook re-pins in a layout effect keyed on this content key. `blocks`
  // identity changes on every streamed append; status/completedAt are folded in
  // so the run going terminal also re-pins — the terminal system block renders
  // below the transcript without appending an ACP event, so `blocks` alone
  // wouldn't change and a bottom-pinned user would be stranded above it.
  const scrollContentKey = useMemo(
    () => ({ blocks, status: entry.status, completedAt: entry.completedAt }),
    [blocks, entry.status, entry.completedAt],
  );
  const { scrollRef, showScrollToLatest, scrollToLatest } =
    useStickToBottom(scrollContentKey);

  // Whether the run is terminal — used to force any trailing live agent/thinking
  // block to render as complete (the projection leaves the last block
  // `isComplete: false` until a later block arrives, which never happens once
  // the run ends). Terminal = NOT active.
  const isTerminal = !isRunning;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {activeDetail && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-hover)] px-5 py-3">
          <button
            type="button"
            onClick={handleCloseDetail}
            title={entry.agent}
            className="min-w-0 shrink cursor-pointer truncate text-left text-[var(--content-default)] hover:underline"
          >
            <Typography variant="body-small-default" as="span">
              {entry.agent}
            </Typography>
          </button>
          <ChevronRight
            className="h-2.5 w-2.5 shrink-0 text-[var(--content-tertiary)]"
            aria-hidden
          />
          <Typography
            variant="body-small-default"
            as="span"
            title={detailCrumb}
            className="min-w-0 shrink truncate font-mono text-[var(--content-secondary)]"
          >
            {detailCrumb}
          </Typography>
        </div>
      )}

      <ChatViewHeader
        key={`header-${entry.acpSessionId}`}
        entry={entry}
        isRunning={isRunning}
        onClose={onClose}
        showBack={!!activeDetail}
        onBack={handleCloseDetail}
      />

      {activeDetail ? (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {activeDetail.kind === "diff" ? (
            <FileDiffView
              path={activeDetail.path}
              oldText={activeDiff?.oldText}
              newText={activeDiff?.newText}
            />
          ) : (
            <CommandOutputView content={activeToolBlock?.content} />
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            data-testid="acp-chat-conversation"
            className="flex h-full flex-col gap-4 overflow-y-auto px-5 py-5"
          >
            <ObjectiveSection task={entry.task} />

            {/* Blocks render on a vertical timeline rail with a dot on action
                blocks (tool calls + plan), plus the first and last block so the
                rail is always bracketed top and bottom rather than dangling into
                opening/closing narration. The narration in between — agent
                messages, thinking, user turns — renders inline without a dot, so
                the rail reads as a sparse list of what the agent did. The rail
                owns inter-block spacing via per-row padding, so this container
                drops the parent `gap-4`. */}
            <div className="flex flex-col" data-testid="acp-chat-timeline">
              {blocks.map((block, index) => (
                <AcpChatTimelineBlock
                  key={blockKey(block, index)}
                  showDot={
                    index === 0 ||
                    index === blocks.length - 1 ||
                    block.kind === "tool" ||
                    block.kind === "plan"
                  }
                  isLast={index === blocks.length - 1}
                >
                  <ChatBlock
                    block={block}
                    isTerminal={isTerminal}
                    onOpenDiff={handleOpenDiff}
                    onOpenOutput={handleOpenOutput}
                  />
                </AcpChatTimelineBlock>
              ))}
            </div>

            {!isRunning && (
              <AcpChatTerminalBlock
                status={entry.status}
                stopReason={entry.stopReason}
                error={entry.error}
                completedAt={entry.completedAt}
              />
            )}
          </div>

          {showScrollToLatest && (
            <Button
              variant="outlined"
              size="compact"
              iconOnly={<ArrowDown />}
              onClick={scrollToLatest}
              aria-label="Go to newest"
              tooltip="Go to newest"
              data-testid="acp-chat-scroll-to-latest"
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
            />
          )}
        </div>
      )}

      {isRunning && !activeDetail && (
        <SteerComposer
          key={`steer-${entry.acpSessionId}`}
          acpSessionId={entry.acpSessionId}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ChatViewHeader({
  entry,
  isRunning,
  onClose,
  showBack = false,
  onBack,
}: {
  entry: AcpRunEntry;
  isRunning: boolean;
  onClose: () => void;
  showBack?: boolean;
  onBack?: () => void;
}) {
  const [stopping, setStopping] = useState(false);

  // Stop-reason-aware so a run cancelled mid-flight (completed + cancelled)
  // shows "Cancelled", not a green "Completed".
  const statusBadge = acpRunStatusBadge(entry.status, entry.stopReason);

  const handleStop = useCallback(() => {
    setStopping(true);
    void stopAcpRun(entry.acpSessionId).catch((err) => {
      setStopping(false);
      captureError(err, { context: "AcpRunChatView.stop" });
    });
  }, [entry.acpSessionId]);

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
      {showBack && (
        <Button
          variant="outlined"
          iconOnly={<ArrowLeft />}
          onClick={onBack}
          aria-label="Back to conversation"
          tooltip="Back"
          data-testid="acp-chat-diff-back"
          className="shrink-0 rounded-lg"
        />
      )}
      <AcpAgentIcon agent={entry.agent} className="h-5 w-5 shrink-0" />
      <Typography
        variant="title-medium"
        title={entry.agent}
        className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
      >
        {entry.agent}
      </Typography>
      <StatusBadgePill color={statusBadge.color} label={statusBadge.label} />
      <span className="flex-1" />
      <AcpUsageMeter entry={entry} />
      {isRunning && (
        <button
          type="button"
          aria-label="Stop run"
          onClick={handleStop}
          disabled={stopping}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--system-negative-strong)] bg-transparent px-2.5 py-1.5 text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)] disabled:cursor-default disabled:opacity-50"
        >
          <Square className="h-3 w-3" fill="currentColor" />
          <Typography variant="label-small-default">Stop</Typography>
        </button>
      )}
      <Button
        variant="outlined"
        iconOnly={<X />}
        onClick={onClose}
        aria-label="Close run detail"
        tooltip="Close"
        className="shrink-0 rounded-lg"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

function ObjectiveSection({ task }: { task: string | undefined }) {
  if (!task) return null;
  return (
    <div data-testid="acp-chat-objective">
      <Typography
        variant="body-medium-default"
        as="h3"
        className="mb-1 text-[var(--content-emphasised)]"
      >
        Objective
      </Typography>
      <Typography
        variant="body-medium-lighter"
        as="p"
        className="whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)]"
      >
        {task}
      </Typography>
      <div className="mt-4 h-px w-full bg-[var(--border-hover)]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block dispatch
// ---------------------------------------------------------------------------

function ChatBlock({
  block,
  isTerminal,
  onOpenDiff,
  onOpenOutput,
}: {
  block: AcpChatBlock;
  /** When the run is terminal, force trailing live agent/thinking blocks complete. */
  isTerminal: boolean;
  onOpenDiff: (toolCallId: string, fileChange: AcpFileChange) => void;
  onOpenOutput: (toolCallId: string) => void;
}) {
  switch (block.kind) {
    case "user":
      return <AcpChatUserTurn content={block.content} />;
    case "agent":
      return (
        <AcpChatAgentMessage
          content={block.content}
          isComplete={block.isComplete || isTerminal}
        />
      );
    case "thinking":
      return (
        <AcpChatThinkingBlock
          content={block.content}
          isComplete={block.isComplete || isTerminal}
        />
      );
    case "tool":
      return (
        <AcpChatToolCard
          block={block}
          isTerminal={isTerminal}
          onOpenDiff={onOpenDiff}
          onOpenOutput={onOpenOutput}
        />
      );
    case "plan":
      return <AcpChatPlanBlock entries={block.entries} />;
  }
}

// ---------------------------------------------------------------------------
// Steer composer
// ---------------------------------------------------------------------------

function SteerComposer({ acpSessionId }: { acpSessionId: string }) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const instruction = input.trim();
      if (!instruction || pending) return;
      setPending(true);

      // Optimistic user turn so the steer shows immediately ahead of the
      // daemon's echoed events. Appended without advancing the dedup
      // high-water mark so the daemon's first real post-steer event survives.
      const markerId = useAcpRunStore.getState().appendLocalMarker({
        acpSessionId,
        content: `${STEER_MARKER_PREFIX}${instruction}`,
      });

      void steerAcpRun(acpSessionId, instruction)
        .then(() => setInput(""))
        .catch((err) => {
          // Roll back the optimistic marker so the transcript doesn't keep
          // showing a steer the agent never received.
          if (markerId) {
            useAcpRunStore
              .getState()
              .removeLocalMarker({ acpSessionId, markerId });
          }
          captureError(err, { context: "AcpRunChatView.steer" });
        })
        .finally(() => setPending(false));
    },
    [input, pending, acpSessionId],
  );

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="acp-chat-steer-form"
      // Sticky footer: pinned as a shrink-0 flex child in the bounded side
      // panel, and `sticky bottom-0` keeps it on-screen in any context where an
      // unbounded-height ancestor would otherwise let it scroll past the fold.
      // The solid panel background prevents transcript content showing through.
      className="sticky bottom-0 z-10 shrink-0 border-t border-[var(--border-hover)] bg-[var(--surface-lift)] px-5 py-3"
    >
      <div className="flex items-center gap-2 rounded-md bg-[var(--surface-base)] px-3 py-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Steer the run…"
          disabled={pending}
          aria-label="Steering instruction"
          className="text-body-medium-default min-w-0 flex-1 bg-transparent text-[color:var(--content-default)] placeholder:text-[color:var(--content-tertiary)] focus:outline-none disabled:opacity-50"
        />
        <Button
          type="submit"
          variant="primary"
          size="compact"
          iconOnly={<Send />}
          disabled={pending || input.trim() === ""}
          aria-label="Send steering instruction"
          className="shrink-0"
        />
      </div>
    </form>
  );
}
