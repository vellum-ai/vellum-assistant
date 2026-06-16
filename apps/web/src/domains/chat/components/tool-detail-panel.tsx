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
import { useEffect, useRef, useState, type Ref, type ReactNode } from "react";

import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import {
    deriveStepLabelFromName,
    type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  activityThinkingTexts,
  groupContentBlocks,
} from "@/domains/chat/transcript/message-content";
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
  bodyRef,
}: {
  Glyph: LucideIcon;
  title: string;
  headerTrailing?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Ref to the scrollable body, so callers can drive auto-scroll. */
  bodyRef?: Ref<HTMLDivElement>;
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
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-5 py-5">
        {children}
      </div>
    </div>
  );
}

/**
 * Live reasoning text for a thinking payload. Re-derives the text from the
 * source message's `contentBlocks` on every store change so the drawer streams
 * in place as `assistant_thinking_delta` events land — keyed by the message +
 * group (+ item) address the pill captured, never a frozen string. Falls back
 * to the `thinkingText` snapshot when the source message is no longer in the
 * store (e.g. after a conversation switch).
 */
function useLiveThinkingText(detail: ToolDetailPayload): string {
  return useChatSessionStore((s) => {
    const fallback = detail.thinkingText ?? "";
    const id = detail.thinkingMessageId;
    if (id == null) return fallback;
    const message = s.messages.find((m) => m.id === id);
    if (!message) return fallback;
    const groups = groupContentBlocks(message.contentBlocks ?? [], {
      splitInlineThinking: message.role !== "user",
    });
    const group = groups[detail.thinkingGroupIndex ?? -1];
    if (!group || group.type !== "activity") return fallback;
    const texts = activityThinkingTexts(group.items);
    if (detail.thinkingItemIndex != null) {
      return texts[detail.thinkingItemIndex] ?? fallback;
    }
    return texts.length > 0 ? texts.join("\n") : fallback;
  });
}

/**
 * Reasoning view of the detail drawer. Streams live thinking
 * ({@link useLiveThinkingText}) and keeps the latest text in view while it
 * grows, unless the user has scrolled up to read earlier reasoning.
 */
function ThinkingDetail({
  detail,
  onClose,
}: {
  detail: ToolDetailPayload;
  onClose: () => void;
}) {
  const text = useLiveThinkingText(detail);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Whether to pin to the bottom as new reasoning streams in. Starts pinned;
  // toggled by the user's own scrolling.
  const stickToBottom = useRef(true);
  // Previous text, to scroll only when reasoning GROWS. `null` until the first
  // effect run so opening a completed thought starts at the top, not pinned to
  // the bottom.
  const prevText = useRef<string | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    const prev = prevText.current;
    prevText.current = text;
    if (prev === null) return;
    if (el && stickToBottom.current && text.length > prev.length) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  return (
    <DetailShell
      Glyph={Brain}
      title={detail.title}
      onClose={onClose}
      bodyRef={bodyRef}
    >
      <ChatMarkdownMessage content={text} hardLineBreaks />
    </DetailShell>
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
    return <ThinkingDetail detail={detail} onClose={onClose} />;
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
