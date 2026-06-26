/**
 * A tool call rendered as a card in the ACP chat transcript.
 */

import { ChevronDown, ChevronRight, Code, FileText } from "lucide-react";
import { useMemo, useState } from "react";

import { Tag, Typography, type TagTone } from "@vellumai/design-library";

import {
  getAcpFileChanges,
  parseAcpToolContent,
} from "@/domains/chat/acp-tool-content";
import type { AcpChatBlock } from "@/domains/chat/acp-run-message-projection";
import type { AcpToolStatus } from "@/domains/chat/acp-run-step-projection";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";

type AcpToolBlock = Extract<AcpChatBlock, { kind: "tool" }>;

/** A single file the tool call touched. */
export type AcpFileChange = {
  path: string;
  oldText?: string;
  newText?: string;
};

export interface AcpChatToolCardProps {
  /** The `kind: "tool"` chat block to render. */
  block: AcpToolBlock;
  /**
   * Whether the whole run has reached a terminal state. A tool still
   * `running` at that point was never finalized by the agent (ACP has no
   * cancelled tool status and doesn't require a terminal update on cancel),
   * so it renders as a neutral "Ended" state instead of a live spinner.
   */
  isTerminal?: boolean;
  /**
   * Invoked when a file-change chip is activated. Receives the owning tool's
   * `toolCallId` so the viewer can re-derive a live diff from the current
   * blocks (the chip's `fileChange` is only a snapshot at click time).
   */
  onOpenDiff: (toolCallId: string, fileChange: AcpFileChange) => void;
}

/** Output longer than this (chars) collapses behind a toggle. */
const COLLAPSE_THRESHOLD = 600;

/** Display status: the data model's `AcpToolStatus` plus a terminal-only
 *  "ended" state for a tool the agent never finalized. */
type ToolDisplayStatus = AcpToolStatus | "ended";

const STATUS_TONE: Record<ToolDisplayStatus, TagTone> = {
  running: "neutral",
  completed: "positive",
  error: "negative",
  ended: "neutral",
};

const STATUS_LABEL: Record<ToolDisplayStatus, string> = {
  running: "Running",
  completed: "Completed",
  error: "Failed",
  ended: "Ended",
};

/** Leading kind glyph — file glyph for read/edit, code brackets otherwise. */
function KindIcon({ toolKind }: { toolKind?: string }) {
  const Icon = toolKind === "read" || toolKind === "edit" ? FileText : Code;
  return (
    <Icon
      aria-hidden
      className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
    />
  );
}

export function AcpChatToolCard({
  block,
  isTerminal = false,
  onOpenDiff,
}: AcpChatToolCardProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo(
    () => parseAcpToolContent(block.content),
    [block.content],
  );

  const outputText = useMemo(
    () =>
      parsed
        .filter((b) => b.type === "content" || b.type === "terminal")
        .map((b) => ("text" in b ? (b.text ?? "") : ""))
        .filter((text) => text.length > 0)
        .join("\n"),
    [parsed],
  );

  const fileChanges = useMemo(
    () => getAcpFileChanges(parsed, block.locations),
    [parsed, block.locations],
  );

  const displayStatus: ToolDisplayStatus =
    isTerminal && block.status === "running" ? "ended" : block.status;
  const isRunning = displayStatus === "running";
  const isLong = outputText.length > COLLAPSE_THRESHOLD;
  const showOutput = outputText.length > 0 && (!isLong || expanded);

  return (
    <div
      data-testid="acp-chat-tool-card"
      data-status={block.status}
      className="w-full rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3"
    >
      <div className="flex items-center gap-2">
        <KindIcon toolKind={block.toolKind} />
        <Typography
          variant="body-small-emphasised"
          className="min-w-0 flex-1 truncate text-[var(--content-default)]"
          title={block.title}
        >
          {block.title || "Tool call"}
        </Typography>
        <Tag
          tone={STATUS_TONE[displayStatus]}
          data-testid="acp-chat-tool-status"
        >
          {STATUS_LABEL[displayStatus]}
        </Tag>
        {isRunning && (
          <ThreeDotIndicator
            className="shrink-0"
            data-testid="acp-chat-tool-running"
          />
        )}
      </div>

      {fileChanges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {fileChanges.map((fileChange) => {
            // A change with no `oldText`/`newText` is a location-only reference
            // (e.g. a read/follow-along tool reporting a touched path). There's
            // no diff to open, so render it as a static pill rather than a chip
            // that would open a blank diff panel.
            const hasDiff =
              fileChange.oldText !== undefined ||
              fileChange.newText !== undefined;
            const chipClass =
              "flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1 text-body-small-default text-[var(--content-secondary)]";

            if (!hasDiff) {
              return (
                <span
                  key={fileChange.path}
                  data-testid="acp-chat-tool-file-ref"
                  title={fileChange.path}
                  className={chipClass}
                >
                  <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono">{fileChange.path}</span>
                </span>
              );
            }

            return (
              <button
                key={fileChange.path}
                type="button"
                data-testid="acp-chat-tool-file-chip"
                onClick={() => onOpenDiff(block.toolCallId, fileChange)}
                title={fileChange.path}
                className={`${chipClass} cursor-pointer transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]`}
              >
                <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-mono">{fileChange.path}</span>
              </button>
            );
          })}
        </div>
      )}

      {outputText.length > 0 && (
        <div className="mt-2">
          {isLong && (
            <button
              type="button"
              data-testid="acp-chat-tool-output-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
              className="mb-1.5 flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-default)]"
            >
              {expanded ? (
                <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
              )}
              <span>{expanded ? "Hide output" : "Show output"}</span>
            </button>
          )}
          {showOutput && (
            <pre
              data-testid="acp-chat-tool-output"
              className="max-h-60 overflow-auto rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] p-2.5 font-mono text-body-small-default whitespace-pre-wrap break-words text-[var(--content-default)]"
            >
              {outputText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
