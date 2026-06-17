/**
 * Side-drawer body shown when a tool-call step pill is clicked. Mirrors the
 * macOS "TECHNICAL DETAILS / OUTPUT" detail view and the web
 * `SubagentDetailPanel` shell (outer container, header with leading icon /
 * title / risk badge / close, scrollable body with sections).
 *
 * Driven by the `ToolDetailPayload` opened into `viewer-store`. Purely
 * presentational: it reads the payload and reports `onClose`.
 */

import {
  Bolt,
  Brain,
  Check,
  Code,
  Copy,
  FileText,
  Monitor,
  Pen,
  Plug,
  Sparkles,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import {
    deriveStepLabelFromName,
    type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * Concrete lucide icon for each `IconName` produced by `deriveStepLabel`.
 * Local copy of the map used by `phase-grouped-step-list` so this panel picks
 * a matching header glyph without importing card internals.
 */
const ICON_MAP: Record<IconName, LucideIcon> = {
  code: Code,
  file: FileText,
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
function CodeBlock({ text }: { text: string }) {
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
function SectionLabel({ children }: { children: string }) {
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
 * Shared outer container + header shell for both the tool and thinking detail
 * variants: rounded lift surface, header row with a leading glyph, truncating
 * title, an optional trailing slot (risk badge for tools), and the close
 * button. The scrollable body is supplied by the caller as `children`.
 */
function DetailShell({
  Glyph,
  title,
  headerTrailing,
  onClose,
  children,
}: {
  Glyph: LucideIcon;
  title: string;
  headerTrailing?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] px-5 py-4">
        <Glyph
          className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
          aria-hidden
        />
        <Typography
          variant="title-medium"
          // `title-medium` ships a tight line-height; combined with `truncate`
          // (overflow:hidden) it clips descenders (e.g. the "p" in "process").
          // Bump leading + small vertical padding so glyphs get breathing room.
          className="min-w-0 shrink truncate py-0.5 leading-snug text-[var(--content-default)]"
        >
          {title}
        </Typography>
        {headerTrailing}
        <span className="flex-1" />
        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close tool details"
          tooltip="Close"
          className="shrink-0"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </div>
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
    return (
      <DetailShell Glyph={Brain} title={detail.title} onClose={onClose}>
        <ChatMarkdownMessage content={detail.thinkingText ?? ""} hardLineBreaks />
      </DetailShell>
    );
  }

  const { iconName } = deriveStepLabelFromName(detail.toolName, detail.input);
  const Glyph = ICON_MAP[iconName] ?? Bolt;

  const title = detail.activity || detail.title;
  const hasResult = detail.result !== undefined && detail.result !== "";
  const isRunning = detail.status === "running";
  const inputJson = JSON.stringify(detail.input, null, 2);

  return (
    <DetailShell
      Glyph={Glyph}
      title={title}
      onClose={onClose}
      headerTrailing={
        <RiskBadge level={detail.riskLevel} onClick={onRiskBadgeClick} />
      }
    >
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
          <SectionLabel>Technical details</SectionLabel>
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

        {/* Output section — omitted entirely when there's no result */}
        {(hasResult || isRunning) && (
          <div className="mt-5">
            <SectionLabel>Output</SectionLabel>
            {hasResult ? (
              <CodeBlock text={detail.result as string} />
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
    </DetailShell>
  );
}
