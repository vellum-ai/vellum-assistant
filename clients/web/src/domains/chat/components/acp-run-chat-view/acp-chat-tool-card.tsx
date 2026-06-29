/**
 * A tool call rendered as a card in the ACP chat transcript: a kind glyph +
 * standardized label, a status pill, the command/title as a body line, an
 * output button that opens the nested detail panel (`onOpenOutput`),
 * file-change chips (`onOpenDiff`), and a collapsible raw input/output section.
 */

import {
  Brain,
  ChevronDown,
  ChevronRight,
  Code,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  Repeat,
  Search,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Tag, Typography, type TagTone } from "@vellumai/design-library";

import {
  formatRawValue,
  getAcpFileChanges,
  getAcpToolCommand,
  getAcpToolOutputText,
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
  /** Open this tool's console output in the nested detail panel. */
  onOpenOutput?: (toolCallId: string) => void;
}

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

/** Standardized, human-readable header label per ACP tool kind. */
const KIND_LABEL: Record<string, string> = {
  read: "Read file",
  edit: "Edit file",
  delete: "Delete file",
  move: "Move file",
  search: "Search",
  execute: "Run command",
  think: "Thinking",
  fetch: "Fetch",
  switch_mode: "Switch mode",
};

const DEFAULT_KIND_LABEL = "Tool call";

/** Leading kind glyph per ACP tool kind. */
const KIND_ICON: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Repeat,
};

/** Kinds whose specifics already surface via file chips, so the raw title
 *  would be redundant as a body detail line. */
const FILE_OP_KINDS = new Set(["read", "edit", "delete", "move"]);

function KindIcon({ toolKind }: { toolKind?: string }) {
  const Icon = (toolKind && KIND_ICON[toolKind]) || Code;
  return (
    <Icon
      aria-hidden
      className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
    />
  );
}

/** A labeled, scrollable monospace block for a pretty-printed raw payload. */
function RawBlock({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <div className="mb-1 text-body-small-default text-[var(--content-tertiary)]">
        {label}
      </div>
      <pre className="max-h-60 overflow-auto rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] p-2.5 font-mono text-body-small-default text-[var(--content-secondary)]">
        {value}
      </pre>
    </div>
  );
}

export function AcpChatToolCard({
  block,
  isTerminal = false,
  onOpenDiff,
  onOpenOutput,
}: AcpChatToolCardProps) {
  const [expandedRaw, setExpandedRaw] = useState(false);

  const parsed = useMemo(
    () => parseAcpToolContent(block.content),
    [block.content],
  );

  const outputText = useMemo(
    () => getAcpToolOutputText(block.content),
    [block.content],
  );

  // First non-empty, non-fence line — a glanceable preview on the open button.
  const outputPreview = useMemo(() => {
    const line = outputText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("```"));
    return line || "View output";
  }, [outputText]);

  const fileChanges = useMemo(
    () => getAcpFileChanges(parsed, block.locations),
    [parsed, block.locations],
  );

  const displayStatus: ToolDisplayStatus =
    isTerminal && block.status === "running" ? "ended" : block.status;
  const isRunning = displayStatus === "running";

  const kindLabel =
    (block.toolKind && KIND_LABEL[block.toolKind]) || DEFAULT_KIND_LABEL;
  // Prefer a structured command from rawInput; fall back to the agent's title
  // when rawInput is absent (it is optional).
  const command = getAcpToolCommand(block.rawInput);
  const detailText = command ?? block.title;
  // Surface the command/title when the header label alone hides what the tool
  // did. File-op kinds normally show their path via chips, so suppress it there
  // — but fall back when no chips rendered (a detail-only call with no
  // locations/diff).
  const detailLine =
    detailText &&
    detailText !== kindLabel &&
    (!FILE_OP_KINDS.has(block.toolKind ?? "") || fileChanges.length === 0)
      ? detailText
      : null;

  const rawInputText = formatRawValue(block.rawInput);
  const rawOutputText = formatRawValue(block.rawOutput);
  const hasRaw = rawInputText !== undefined || rawOutputText !== undefined;

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
          {kindLabel}
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

      {detailLine && (
        <div
          data-testid="acp-chat-tool-detail"
          className="mt-1.5 font-mono text-body-small-default whitespace-pre-wrap break-words text-[var(--content-secondary)]"
        >
          {detailLine}
        </div>
      )}

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
        <button
          type="button"
          data-testid="acp-chat-tool-output-open"
          onClick={() => onOpenOutput?.(block.toolCallId)}
          className="mt-2 flex w-full items-center gap-2 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
        >
          <Terminal
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
          />
          <span className="min-w-0 flex-1 truncate font-mono text-body-small-default text-[var(--content-secondary)]">
            {outputPreview}
          </span>
          <ChevronRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
          />
        </button>
      )}

      {hasRaw && (
        <div className="mt-2" data-testid="acp-chat-tool-raw">
          <button
            type="button"
            data-testid="acp-chat-tool-raw-toggle"
            aria-expanded={expandedRaw}
            onClick={() => setExpandedRaw((prev) => !prev)}
            className="flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-default)]"
          >
            {expandedRaw ? (
              <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{expandedRaw ? "Hide raw input/output" : "Show raw input/output"}</span>
          </button>
          {expandedRaw && (
            <div className="mt-1.5 flex flex-col gap-2">
              {rawInputText !== undefined && (
                <RawBlock
                  label="Raw input"
                  value={rawInputText}
                  testId="acp-chat-tool-raw-input"
                />
              )}
              {rawOutputText !== undefined && (
                <RawBlock
                  label="Raw output"
                  value={rawOutputText}
                  testId="acp-chat-tool-raw-output"
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
