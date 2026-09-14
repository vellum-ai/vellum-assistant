/**
 * Small presentational primitives shared by side-drawer detail panels: the
 * block long content sits on, the `<pre>` code block built on it, and the
 * uppercase section label.
 *
 * Extracted from `tool-detail-panel.tsx` so tool-specific activity renderers
 * (`domains/chat/components/tool-activity/`) can compose them without importing
 * the panel that in turn imports those renderers. Every consumer imports them
 * from here.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

const COPIED_RESET_MS = 1500;

/**
 * Content longer than this collapses behind "Show more". Roughly a dozen lines
 * of prose: enough to tell what the block holds, short enough that whatever
 * sits above it stays on screen.
 */
const CLAMP_CHARS = 700;

/** Collapsed height of a clamped block, in px. */
const CLAMP_HEIGHT = 260;

/**
 * Small ghost button that copies `text` to the clipboard and shows a transient
 * "Copied" confirmation. Positioned in the top-right corner of the
 * {@link DetailBlock} that holds it.
 */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = () => {
    copyToClipboard(text, {
      errorMessage: "Couldn't copy.",
      onCopied: () => {
        setCopied(true);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(
          () => setCopied(false),
          COPIED_RESET_MS,
        );
      },
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={
        copied ? t("detailPrimitives.copied") : t("detailPrimitives.copy")
      }
      className="absolute right-2 top-2 flex items-center gap-1 rounded p-1 text-label-small-default text-[var(--content-tertiary)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--content-default)]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? t("detailPrimitives.copied") : null}
    </button>
  );
}

/**
 * Collapses `children` to a readable height when `length` exceeds the clamp,
 * with a fade over the cut and a Show more control. Callers pass the length of
 * the text they are rendering rather than the node, because the decision is
 * about how much there is to read, not how it is marked up.
 *
 * The fade is painted in `--surface-overlay`, which {@link DetailBlock} paints
 * behind it, so the gradient disappears into the block.
 */
function ClampedContent({
  length,
  children,
}: {
  length: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const clampable = length > CLAMP_CHARS;
  const clamped = clampable && !expanded;

  return (
    <>
      <div
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: CLAMP_HEIGHT } : undefined}
      >
        {children}
        {clamped && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--surface-overlay)] to-transparent"
          />
        )}
      </div>
      {clampable && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mt-2 w-full border-t border-[var(--border-base)] pt-2 text-left"
        >
          <Typography
            variant="body-medium-default"
            as="span"
            className="text-[var(--content-default)]"
          >
            {expanded
              ? t("detailPrimitives.showLess")
              : t("detailPrimitives.showMore")}
          </Typography>
        </button>
      )}
    </>
  );
}

const DETAIL_BLOCK_VARIANT_CLASSES = {
  outlined: "rounded-lg border border-[var(--border-base)]",
  filled: "rounded-xl",
} as const;

interface DetailBlockProps {
  /** `outlined` carries a hairline border; `filled` is the bare surface. */
  variant?: keyof typeof DETAIL_BLOCK_VARIANT_CLASSES;
  /** Length of the text shown, which decides whether the block clamps. */
  length: number;
  /** Text the copy button copies. Without it the block has no copy button. */
  copyText?: string;
  children: ReactNode;
}

/**
 * The surface long content sits on in a detail panel: clamped behind Show more
 * when it runs long, with a copy button in its top-right corner when there is
 * text to copy.
 *
 * It owns the two conditions its parts depend on. The clamp's fade is painted in
 * `--surface-overlay`, so the block is that colour, and the copy button is
 * absolutely positioned, so the block is its containing block.
 */
export function DetailBlock({
  variant = "outlined",
  length,
  copyText,
  children,
}: DetailBlockProps) {
  return (
    <div
      className={`relative ${DETAIL_BLOCK_VARIANT_CLASSES[variant]} bg-[var(--surface-overlay)] p-3`}
    >
      <ClampedContent length={length}>{children}</ClampedContent>
      {copyText !== undefined && <CopyButton text={copyText} />}
    </div>
  );
}

/**
 * A `<pre>` code block with a copy button positioned in the top-right, clamped
 * when the text is long. Tool results reach the panel at up to
 * `HARD_MAX_TOOL_RESULT_CHARS` (400,000), which is not a height any panel can
 * absorb.
 */
export function CodeBlock({
  text,
  tone = "default",
}: {
  text: string;
  /** `error` tints the text, so a failed result reads as one at a glance. */
  tone?: "default" | "error";
}) {
  return (
    <DetailBlock length={text.length} copyText={text}>
      <pre
        className={`font-mono text-xs whitespace-pre-wrap break-words ${
          tone === "error"
            ? "text-[var(--system-negative-strong)]"
            : "text-[var(--content-default)]"
        }`}
      >
        {text}
      </pre>
    </DetailBlock>
  );
}

/**
 * Uppercase section label in `--content-tertiary`.
 *
 * `leading-4` is deliberate: the `label-small-default` token ships
 * `line-height: 1`, which leaves no room below the baseline and clips glyph
 * tails. Size is unchanged.
 */
export function SectionLabel({
  children,
  className = "mb-2",
}: {
  children: string;
  /** Margin override for rows that manage their own spacing. */
  className?: string;
}) {
  return (
    <Typography
      variant="label-small-default"
      as="div"
      className={`uppercase leading-4 tracking-wider text-[var(--content-tertiary)] ${className}`}
    >
      {children}
    </Typography>
  );
}
