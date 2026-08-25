/**
 * Small presentational primitives shared by side-drawer detail panels: the
 * copy-to-clipboard button, the `<pre>` code block that wraps it, and the
 * uppercase section label.
 *
 * Extracted from `tool-detail-panel.tsx` so tool-specific activity renderers
 * (`domains/chat/components/tool-activity/`) can compose them without importing
 * the panel that in turn imports those renderers. `tool-detail-panel` re-exports
 * `CodeBlock` and `SectionLabel` so its existing consumers are unaffected.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

const COPIED_RESET_MS = 1500;

/**
 * Small ghost button that copies `text` to the clipboard and shows a transient
 * "Copied" confirmation. Positioned by the caller (top-right of a `<pre>`).
 */
export function CopyButton({ text }: { text: string }) {
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
