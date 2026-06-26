/**
 * Devin-style chat view for an ACP run. Assembles the projected chat blocks
 * (PR 3) into a streaming conversation, with the usage meter (PR 11) in the
 * header, a nested file diff (PR 5) opened from tool-card file chips, and a
 * steer composer that posts follow-up instructions while the run is live.
 *
 * Self-contained for reversibility: it copies the detail panel's header /
 * objective / steer markup + tokens rather than importing them, and owns the
 * nested-diff selection in LOCAL state (not the viewer store).
 */

import { ArrowDown, ArrowLeft, ChevronRight, Code, Send, Square, X } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { Button, Typography } from "@vellumai/design-library";

import {
  useAcpRunChatBlocks,
  type AcpChatBlock,
} from "@/domains/chat/acp-run-message-projection";
import {
  STEER_MARKER_PREFIX,
  useAcpRunStore,
  type AcpRunEntry,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";
import { AcpChatAgentMessage } from "@/domains/chat/components/acp-run-chat-view/acp-chat-agent-message";
import { AcpChatPlanBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-plan-block";
import { AcpChatTerminalBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-terminal-block";
import { AcpChatThinkingBlock } from "@/domains/chat/components/acp-run-chat-view/acp-chat-thinking-block";
import {
  AcpChatToolCard,
  type AcpFileChange,
} from "@/domains/chat/components/acp-run-chat-view/acp-chat-tool-card";
import { AcpChatUserTurn } from "@/domains/chat/components/acp-run-chat-view/acp-chat-user-turn";
import { AcpUsageMeter } from "@/domains/chat/components/acp-run-chat-view/acp-usage-meter";
import { FileDiffView } from "@/domains/chat/components/acp-run-chat-view/file-diff-view";
import { useStickToBottom } from "@/domains/chat/components/acp-run-chat-view/use-stick-to-bottom";
import { StatusBadgePill } from "@/domains/chat/components/status-badge-pill";
import {
  steerAcpRun,
  stopAcpRun,
} from "@/domains/chat/utils/acp-run-actions";
import {
  acpRunStatusColor,
  acpRunStatusLabel,
  isActiveAcpStatus,
} from "@/utils/acp-run-status";
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

  // Nested file diff in LOCAL state (never the viewer store). When set, the
  // conversation is replaced by the diff with a Back affordance.
  const [activeDiff, setActiveDiff] = useState<AcpFileChange | null>(null);

  // Reset nested diff (parent-owned state) on run switch — render-phase guard
  // tracking the prev id, mirroring `AcpRunDetailPanel`. Run-specific state that
  // lives inside subcomponents (header `stopping`, composer `input`/`pending`)
  // is reset by keying them on `entry.acpSessionId` below so they remount fresh.
  const [prevSessionId, setPrevSessionId] = useState(entry.acpSessionId);
  if (prevSessionId !== entry.acpSessionId) {
    setPrevSessionId(entry.acpSessionId);
    setActiveDiff(null);
  }

  const handleOpenDiff = useCallback(
    (fileChange: AcpFileChange) => setActiveDiff(fileChange),
    [],
  );
  const handleCloseDiff = useCallback(() => setActiveDiff(null), []);

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
      {activeDiff && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-hover)] px-5 py-3">
          <button
            type="button"
            onClick={handleCloseDiff}
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
            title={activeDiff.path}
            className="min-w-0 shrink truncate font-mono text-[var(--content-secondary)]"
          >
            {activeDiff.path}
          </Typography>
        </div>
      )}

      <ChatViewHeader
        key={`header-${entry.acpSessionId}`}
        entry={entry}
        isRunning={isRunning}
        onClose={onClose}
        showBack={!!activeDiff}
        onBack={handleCloseDiff}
      />

      {activeDiff ? (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <FileDiffView
            path={activeDiff.path}
            oldText={activeDiff.oldText}
            newText={activeDiff.newText}
          />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            data-testid="acp-chat-conversation"
            className="flex h-full flex-col gap-4 overflow-y-auto px-5 py-5"
          >
            <ObjectiveSection task={entry.task} />

            {blocks.map((block, index) => (
              <ChatBlock
                key={blockKey(block, index)}
                block={block}
                isTerminal={isTerminal}
                onOpenDiff={handleOpenDiff}
              />
            ))}

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

      {isRunning && !activeDiff && (
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
      <Code
        aria-hidden
        className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
      />
      <Typography
        variant="title-medium"
        title={entry.agent}
        className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
      >
        {entry.agent}
      </Typography>
      <StatusBadgePill
        color={acpRunStatusColor(entry.status)}
        label={acpRunStatusLabel(entry.status)}
      />
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
}: {
  block: AcpChatBlock;
  /** When the run is terminal, force trailing live agent/thinking blocks complete. */
  isTerminal: boolean;
  onOpenDiff: (fileChange: AcpFileChange) => void;
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
      useAcpRunStore.getState().appendLocalMarker({
        acpSessionId,
        content: `${STEER_MARKER_PREFIX}${instruction}`,
      });

      void steerAcpRun(acpSessionId, instruction)
        .then(() => setInput(""))
        .catch((err) => {
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
      className="shrink-0 border-t border-[var(--border-hover)] px-5 py-3"
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
