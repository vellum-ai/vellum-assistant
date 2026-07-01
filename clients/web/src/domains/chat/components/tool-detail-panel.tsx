/**
 * Side-drawer body shown when a tool-call step pill is clicked. Mirrors the
 * macOS "TECHNICAL DETAILS / OUTPUT" detail view and the web
 * `SubagentDetailPanel` shell (outer container, header with leading icon /
 * title / risk badge / close, scrollable body with sections).
 *
 * Driven by the `ToolDetailPayload` opened into `viewer-store`. Both variants
 * subscribe to the chat-session store so an open drawer streams live: the tool
 * variant mirrors `tool_output_chunk` output and the final result via
 * `useLiveToolCall` (see `ToolDetailBody`), the thinking variant the reasoning
 * text via `useLiveThinkingText` (see `ThinkingDetailBody`).
 */

import {
  Bolt,
  Brain,
  Check,
  Code,
  Copy,
  FileText,
  Globe,
  Monitor,
  Pen,
  Plug,
  Sparkles,
  SquareTerminal,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { DetailShell } from "@/domains/chat/components/detail-shell";
import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import { VirtualizedThinkingMarkdown } from "@/domains/chat/components/virtualized-thinking-markdown";
import { useLiveThinkingText } from "@/domains/chat/hooks/use-live-thinking-text";
import { useLiveToolCall } from "@/domains/chat/hooks/use-live-tool-call";
import {
    deriveStepLabelFromName,
    type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * Concrete lucide icon for each `IconName` produced by `deriveStepLabel`.
 * Local copy of the map used by `phase-grouped-step-list` so this panel picks
 * a matching header glyph without importing card internals.
 */
const ICON_MAP: Record<IconName, LucideIcon> = {
  code: Code,
  terminal: SquareTerminal,
  file: FileText,
  globe: Globe,
  pen: Pen,
  monitor: Monitor,
  plug: Plug,
  sparkle: Sparkles,
  "user-plus": UserPlus,
  bolt: Bolt,
  brain: Brain,
};

const COPIED_RESET_MS = 1500;

/**
 * Small ghost button that copies `text` to the clipboard and shows a transient
 * "Copied" confirmation. Positioned by the caller (top-right of a `<pre>`).
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy"}
      className="absolute right-2 top-2 flex items-center gap-1 rounded p-1 text-label-small-default text-[var(--content-tertiary)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--content-default)]"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : null}
    </button>
  );
}

/** A `<pre>` code block with a copy button positioned in the top-right. */
export function CodeBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 font-mono text-xs whitespace-pre-wrap break-words text-[var(--content-default)]">
        {text}
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

/** Uppercase section label in `--content-tertiary`. */
export function SectionLabel({ children }: { children: string }) {
  return (
    <Typography
      variant="label-small-default"
      as="div"
      className="mb-1.5 uppercase tracking-wider text-[var(--content-tertiary)]"
    >
      {children}
    </Typography>
  );
}



/**
 * Thinking variant body. Reuses the shared shell but renders the reasoning
 * markdown live: it re-derives the text from the chat-session store via the
 * payload's stable identity so an open drawer streams as deltas land, falling
 * back to the open-time `thinkingText` snapshot when the source can't be
 * resolved (e.g. message paged out, or an identity-less payload).
 */
function ThinkingDetailBody({
  detail,
  onClose,
}: {
  detail: ToolDetailPayload;
  onClose: () => void;
}) {
  const live = useLiveThinkingText(
    detail.messageId,
    detail.thinkingGroupIndex,
    detail.thinkingItemIndex,
  );
  const content = live ?? detail.thinkingText ?? "";

  return (
    <DetailShell
      Glyph={Brain}
      title={detail.title}
      closeLabel="Close tool details"
      onClose={onClose}
    >
      <VirtualizedThinkingMarkdown content={content} />
    </DetailShell>
  );
}

/**
 * Tool-variant detail sections — the risk-reason note, "Technical details"
 * (input `CodeBlock`), and "Output" — with no surrounding shell, header, or
 * close button. Composed by `ToolDetailPanel` inside its own `DetailShell`, and
 * reused by `SubagentDetailPanel` to show a nested tool call under the
 * subagent's own header.
 *
 * Subscribes to the chat-session store via `useLiveToolCall` so an open drawer
 * streams `tool_output_chunk` output while the call runs and flips to the final
 * `result` when it lands, falling back to the open-time snapshot on `detail`
 * when the call can't be resolved live (e.g. paged out).
 */
export function ToolDetailBody({
  detail,
  showTechnicalDetailsLabel = true,
}: {
  detail: ToolDetailPayload;
  /**
   * Render the "Technical details" section label above the tool name + input.
   * Defaults to true (main-chat `ToolDetailPanel`). `SubagentDetailPanel` passes
   * false — its nested view already sits under the subagent header and a "Back
   * to timeline" affordance, so the extra label reads as redundant there.
   */
  showTechnicalDetailsLabel?: boolean;
}) {
  const liveTc = useLiveToolCall(detail.toolCallId);
  const result = liveTc?.result ?? detail.result;
  const streamedOutput = liveTc?.streamedOutput ?? detail.streamedOutput;

  const hasResult = result !== undefined && result !== "";
  const isRunning = liveTc
    ? isToolCallRunning(liveTc)
    : detail.status === "running";
  const hasStreamedOutput = !!streamedOutput;
  const inputJson = JSON.stringify(detail.input, null, 2);

  return (
    <>
      {detail.riskReason && (
        <Typography
          variant="body-small-default"
          as="p"
          className="mb-4 text-[var(--content-tertiary)]"
        >
          {detail.riskReason}
        </Typography>
      )}

      {/* Technical details section */}
      <div>
        {showTechnicalDetailsLabel && (
          <SectionLabel>Technical details</SectionLabel>
        )}
        <Typography
          variant="body-medium-default"
          as="div"
          className="text-[var(--content-default)]"
        >
          {titleCaseToolName(detail.toolName)}
        </Typography>
        {detail.activity && (
          <Typography
            variant="body-small-default"
            as="p"
            className="mt-0.5 text-[var(--content-secondary)]"
          >
            {detail.activity}
          </Typography>
        )}
        <div className="mt-2">
          <CodeBlock text={inputJson} />
        </div>
      </div>

      {/* Output — the final result once present, else the live streamed tail
          while running, else a bare running placeholder. */}
      {(hasResult || isRunning) && (
        <div className="mt-5">
          <SectionLabel>Output</SectionLabel>
          {hasResult ? (
            <CodeBlock text={result as string} />
          ) : hasStreamedOutput ? (
            <CodeBlock text={streamedOutput as string} />
          ) : (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              Running…
            </Typography>
          )}
        </div>
      )}
    </>
  );
}

export function ToolDetailPanel({
  detail,
  onClose,
  onRiskBadgeClick,
}: {
  detail: ToolDetailPayload;
  onClose: () => void;
  onRiskBadgeClick?: () => void;
}) {
  // Thinking variant — reuse the same shell/header but render the full
  // reasoning markdown with no input/output sections and no risk badge.
  if (detail.kind === "thinking") {
    return <ThinkingDetailBody detail={detail} onClose={onClose} />;
  }

  const { iconName } = deriveStepLabelFromName(detail.toolName, detail.input);
  const Glyph = ICON_MAP[iconName] ?? Bolt;

  const title = detail.activity || detail.title;

  return (
    <DetailShell
      Glyph={Glyph}
      title={title}
      closeLabel="Close tool details"
      onClose={onClose}
      headerTrailing={
        <RiskBadge level={detail.riskLevel} onClick={onRiskBadgeClick} />
      }
    >
      <ToolDetailBody detail={detail} />
    </DetailShell>
  );
}
