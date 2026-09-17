/**
 * Small presentational primitives shared by side-drawer detail panels: the
 * block long content sits on, the `<pre>` code block built on it, the
 * monospace text every machine value is set in, and the uppercase section
 * label.
 *
 * Extracted from `tool-detail-panel.tsx` so tool-specific activity renderers
 * (`domains/chat/components/tool-activity/`) can compose them without importing
 * the panel that in turn imports those renderers. Every consumer imports them
 * from here.
 */

import { useState, type ReactNode } from "react";

import { Typography, type TypographyAs } from "@vellumai/design-library";

import { CopyButton } from "@/components/copy-button";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

/**
 * Content longer than this collapses behind "Show more". Roughly a dozen lines
 * of prose: enough to tell what the block holds, short enough that whatever
 * sits above it stays on screen.
 */
const CLAMP_CHARS = 700;

/** Collapsed height of a clamped block, in px. */
const CLAMP_HEIGHT = 260;

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
 * It owns the conditions its parts depend on. The clamp's fade is painted in
 * `--surface-overlay`, so the block is that colour. The copy button is
 * absolutely positioned, so the block is its containing block, and it reserves
 * the button's room so it neither covers text nor overhangs the block: 24px on
 * the right on desktop, and where the button grows to a 40px touch target,
 * 40px on the right plus a height that holds it below its 8px inset.
 */
export function DetailBlock({
  variant = "outlined",
  length,
  copyText,
  children,
}: DetailBlockProps) {
  const { t } = useTranslation();
  const hasCopy = copyText !== undefined;

  return (
    <div
      className={cn(
        "relative bg-[var(--surface-overlay)] p-3",
        DETAIL_BLOCK_VARIANT_CLASSES[variant],
        hasCopy && "pr-10 touch-mobile:min-h-14 touch-mobile:pr-14",
      )}
    >
      <ClampedContent length={length}>{children}</ClampedContent>
      {hasCopy && (
        <CopyButton
          text={copyText}
          ariaLabel={t("detailPrimitives.copy")}
          className="absolute right-2 top-2"
        />
      )}
    </div>
  );
}

const MACHINE_TEXT_TONE_CLASSES = {
  default: "text-[var(--content-default)]",
  muted: "text-[var(--content-tertiary)]",
  error: "text-[var(--system-negative-strong)]",
} as const;

type MachineTextTone = keyof typeof MACHINE_TEXT_TONE_CLASSES;

/** The type every machine value in a detail panel is set in, by tone. */
function machineTextClassName(tone: MachineTextTone): string {
  return cn("font-mono", MACHINE_TEXT_TONE_CLASSES[tone]);
}

interface MachineTextProps {
  as?: TypographyAs;
  tone?: MachineTextTone;
  /** Layout and wrapping for this spot, such as `truncate`. */
  className?: string;
  title?: string;
  children: ReactNode;
}

/**
 * Text a tool reads or writes: an argument, a path, a command, a tool id. It is
 * always monospace at the panel's code size, whether it sits inline or in a
 * {@link CodeBlock}, so a value reads the same wherever it appears and however
 * long it is. Whether it is shown inline or as a block is the caller's call.
 */
export function MachineText({
  as = "span",
  tone = "default",
  className,
  title,
  children,
}: MachineTextProps) {
  return (
    <Typography
      variant="body-small-lighter"
      as={as}
      title={title}
      className={cn(machineTextClassName(tone), className)}
    >
      {children}
    </Typography>
  );
}

/**
 * Preformatted machine text: line breaks and spacing kept, long lines wrapped.
 * The body of a {@link CodeBlock}, and of any block that frames its own.
 */
export function CodePre({
  text,
  tone = "default",
}: {
  text: string;
  tone?: Exclude<MachineTextTone, "muted">;
}) {
  return (
    <Typography
      variant="body-small-lighter"
      asChild
      className={cn(
        machineTextClassName(tone),
        "whitespace-pre-wrap break-words",
      )}
    >
      <pre>{text}</pre>
    </Typography>
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
      <CodePre text={text} tone={tone} />
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
